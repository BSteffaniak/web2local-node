/**
 * Version detection pipeline with confidence-based ranking
 * Tries multiple detection methods and returns the highest confidence result
 */

import type { ExtractedSource } from '@web2local/types';

export type VersionConfidence =
    | 'exact'
    | 'high'
    | 'medium'
    | 'low'
    | 'unverified';

export type VersionSource =
    | 'package.json'
    | 'banner'
    | 'lockfile-path'
    | 'version-constant'
    | 'sourcemap-path'
    | 'peer-dep'
    | 'fingerprint'
    | 'fingerprint-minified'
    | 'custom-build'
    | 'npm-latest';

export interface VersionResult {
    version: string;
    confidence: VersionConfidence;
    source: VersionSource;
}

/**
 * Patterns for detecting lockfile-style paths that include versions
 */
const LOCKFILE_PATH_PATTERNS = [
    // pnpm: node_modules/.pnpm/react@18.2.0/node_modules/react/index.js
    /node_modules\/\.pnpm\/(@?[^@/]+(?:@[^@/]+)?)@(\d+\.\d+\.\d+[^/]*)\//,

    // yarn berry: node_modules/.yarn/cache/lodash-npm-4.17.21-abc123.zip/...
    /node_modules\/\.yarn\/cache\/([^-]+(?:-[^-]+)*)-npm-(\d+\.\d+\.\d+[^-]*)-/,

    // yarn classic with version in path: node_modules/lodash/4.17.21/...
    /node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(\d+\.\d+\.\d+[^/]*)\//,

    // Some bundlers include version in webpack:// paths
    /webpack:\/\/[^/]*\/node_modules\/(@?[^@/]+(?:\/[^@/]+)?)@(\d+\.\d+\.\d+[^/]*)\//,
];

/**
 * Patterns for detecting version in source map paths (without lockfile structure)
 */
const SOURCEMAP_VERSION_PATTERNS = [
    // Direct version in path: ../node_modules/package@1.2.3/index.js
    /node_modules\/(@?[^@/]+(?:\/[^@/]+)?)@(\d+\.\d+\.\d+[^/]*)\//,

    // Version as directory: ../node_modules/package/1.2.3/index.js
    /node_modules\/(@?[^/]+(?:\/[^/]+)?)\/v?(\d+\.\d+\.\d+[^/]*)\//,
];

/**
 * Patterns for detecting VERSION constants in source code
 */
const VERSION_CONSTANT_PATTERNS = [
    // VERSION = "1.2.3" or VERSION = '1.2.3'
    /\bVERSION\s*=\s*['"](\d+\.\d+\.\d+(?:-[\w.]+)?)['"]/,

    // version = "1.2.3" (lowercase)
    /\bversion\s*=\s*['"](\d+\.\d+\.\d+(?:-[\w.]+)?)['"]/,

    // version: "1.2.3" (object property)
    /\bversion\s*:\s*['"](\d+\.\d+\.\d+(?:-[\w.]+)?)['"]/,

    // __VERSION__ = "1.2.3"
    /__VERSION__\s*=\s*['"](\d+\.\d+\.\d+(?:-[\w.]+)?)['"]/,

    // exports.version = "1.2.3"
    /exports\.version\s*=\s*['"](\d+\.\d+\.\d+(?:-[\w.]+)?)['"]/,

    // module.exports.version = "1.2.3"
    /module\.exports\.version\s*=\s*['"](\d+\.\d+\.\d+(?:-[\w.]+)?)['"]/,

    // this.version = "1.2.3"
    /this\.version\s*=\s*['"](\d+\.\d+\.\d+(?:-[\w.]+)?)['"]/,

    // Package.VERSION = "1.2.3" (e.g., React.version, _.VERSION)
    /\w+\.VERSION\s*=\s*['"](\d+\.\d+\.\d+(?:-[\w.]+)?)['"]/i,

    // "version": "1.2.3" in JSON-like structures
    /["']version["']\s*:\s*["'](\d+\.\d+\.\d+(?:-[\w.]+)?)['"]/,
];

/**
 * Strips URL-like content and JSDoc parameter defaults from text to avoid false positive version matches
 * (e.g., matching "version=1.1.1" in a WMS URL query string or @param {String} [options.version='1.1.1'])
 */
function stripUrlContent(content: string): string {
    return (
        content
            // Remove full URLs (http:// and https://)
            .replace(/https?:\/\/[^\s'"<>]+/g, '')
            // Remove URL query parameters that might contain version-like strings
            .replace(/[?&][\w-]+=[\w.-]+/g, '')
            // Remove data URIs
            .replace(/data:[^;]+;[^\s'"]+/g, '')
            // Remove JSDoc @param default values like [options.version='1.1.1']
            .replace(/\[[\w.]+=['"][^'"]*['"]\]/g, '')
            // Remove JSDoc @param tags entirely to avoid false matches
            .replace(/@param\s+\{[^}]*\}\s+\[[^\]]*\]/g, '')
    );
}

/**
 * Checks if a match at the given position appears to be inside a URL or other non-version context
 * Returns true if the context looks valid for a version declaration
 */
function isValidVersionContext(content: string, matchIndex: number): boolean {
    // Get surrounding context (100 chars before and after)
    const start = Math.max(0, matchIndex - 100);
    const end = Math.min(content.length, matchIndex + 100);
    const contextBefore = content.slice(start, matchIndex);
    const contextAround = content.slice(start, end);

    // Reject if we're likely inside a URL
    if (/https?:\/\/[^\s]*$/.test(contextBefore)) return false;

    // Reject if preceded by URL query param indicators (? or &) without closing
    if (/[?&][\w-]*=?\s*$/.test(contextBefore)) return false;

    // Reject if inside what looks like a URL path
    if (
        /\/[\w.-]+\/[\w.-]+$/.test(contextBefore) &&
        contextBefore.includes('://')
    )
        return false;

    // Reject if inside a JSDoc @param with default value like [options.version='1.1.1']
    if (
        /\[[\w.]*version/.test(contextBefore) ||
        /\[options\./.test(contextBefore)
    )
        return false;

    // Reject if we see @param nearby (likely a JSDoc comment)
    if (/@param\s+\{/.test(contextAround)) return false;

    return true;
}

/**
 * License banner patterns (already in dependency-analyzer but duplicated for completeness)
 */
const BANNER_PATTERNS = [
    // @license Package vX.X.X or @license Package X.X.X
    /@license\s+(\S+)\s+v?(\d+\.\d+\.\d+(?:-[\w.]+)?)/i,

    // /*! package vX.X.X */ or /*! package X.X.X */
    /\/\*!\s*(\S+)\s+v?(\d+\.\d+\.\d+(?:-[\w.]+)?)/i,

    // * Package vX.X.X (in JSDoc style comments)
    /\*\s+(\w+(?:-\w+)*)\s+v(\d+\.\d+\.\d+(?:-[\w.]+)?)/i,

    // @version X.X.X
    /@version\s+(\d+\.\d+\.\d+(?:-[\w.]+)?)/i,
];

/**
 * Extracts package name from a node_modules path
 */
function extractPackageNameFromPath(filePath: string): string | null {
    // Handle scoped packages: node_modules/@scope/package/...
    const scopedMatch = filePath.match(/node_modules\/(@[^/]+\/[^/]+)/);
    if (scopedMatch) {
        return scopedMatch[1];
    }

    // Handle regular packages: node_modules/package/...
    const regularMatch = filePath.match(/node_modules\/([^@/][^/]*)/);
    if (regularMatch) {
        return regularMatch[1];
    }

    return null;
}

/**
 * Detect version from lockfile-style paths (pnpm, yarn, etc.)
 */
export function detectVersionFromLockfilePath(
    filePath: string,
    packageName: string,
): VersionResult | null {
    for (const pattern of LOCKFILE_PATH_PATTERNS) {
        const match = filePath.match(pattern);
        if (match) {
            const detectedName = match[1].replace(/^@/, '').toLowerCase();
            const normalizedPackageName = packageName
                .replace(/^@/, '')
                .toLowerCase();

            // Check if the detected name matches the package we're looking for
            if (
                detectedName === normalizedPackageName ||
                detectedName.endsWith('/' + normalizedPackageName) ||
                normalizedPackageName.endsWith('/' + detectedName)
            ) {
                return {
                    version: match[2],
                    confidence: 'exact',
                    source: 'lockfile-path',
                };
            }
        }
    }
    return null;
}

/**
 * Detect version from source map paths
 */
export function detectVersionFromSourceMapPath(
    filePath: string,
    packageName: string,
): VersionResult | null {
    for (const pattern of SOURCEMAP_VERSION_PATTERNS) {
        const match = filePath.match(pattern);
        if (match) {
            const detectedName = match[1].toLowerCase();
            const normalizedPackageName = packageName.toLowerCase();

            if (detectedName === normalizedPackageName) {
                return {
                    version: match[2],
                    confidence: 'high',
                    source: 'sourcemap-path',
                };
            }
        }
    }
    return null;
}

/**
 * Detect version from VERSION constants in source code
 */
export function detectVersionFromConstants(
    content: string,
    _packageName: string,
): VersionResult | null {
    // Only check the first 5000 chars and last 1000 chars where version constants usually are
    const searchContent = content.slice(0, 5000) + content.slice(-1000);
    // Strip URL content to avoid false positives
    const cleanedContent = stripUrlContent(searchContent);

    for (const pattern of VERSION_CONSTANT_PATTERNS) {
        const match = cleanedContent.match(pattern);
        if (match && match.index !== undefined) {
            // Validate context in original content
            const originalMatch = searchContent.match(pattern);
            if (originalMatch && originalMatch.index !== undefined) {
                if (
                    !isValidVersionContext(searchContent, originalMatch.index)
                ) {
                    continue; // Skip this match, likely inside a URL
                }
            }
            return {
                version: match[1],
                confidence: 'medium',
                source: 'version-constant',
            };
        }
    }
    return null;
}

/**
 * Detect version from license banners
 */
export function detectVersionFromBanner(
    content: string,
    packageName: string,
): VersionResult | null {
    // Only check the first 1500 chars where banners usually are
    const header = content.slice(0, 1500);
    // Strip URL content to avoid false positives
    const cleanedHeader = stripUrlContent(header);

    for (const pattern of BANNER_PATTERNS) {
        const match = cleanedHeader.match(pattern);
        if (match && match.index !== undefined) {
            // Validate context in original content
            const originalMatch = header.match(pattern);
            if (originalMatch && originalMatch.index !== undefined) {
                if (!isValidVersionContext(header, originalMatch.index)) {
                    continue; // Skip this match, likely inside a URL
                }
            }

            // Pattern with package name
            if (match.length === 3) {
                const bannerName = match[1].toLowerCase();
                const pkgNameLower = packageName.toLowerCase();
                const pkgBaseName =
                    pkgNameLower.split('/').pop() || pkgNameLower;

                // Check if banner name matches package name
                if (
                    bannerName === pkgNameLower ||
                    bannerName === pkgBaseName ||
                    pkgBaseName.includes(bannerName) ||
                    bannerName.includes(pkgBaseName)
                ) {
                    return {
                        version: match[2],
                        confidence: 'high',
                        source: 'banner',
                    };
                }
            }
            // Pattern with just version (@version X.X.X)
            else if (match.length === 2) {
                return {
                    version: match[1],
                    confidence: 'medium',
                    source: 'banner',
                };
            }
        }
    }
    return null;
}

/**
 * Get all files belonging to a specific package from extracted sources
 * Enhanced to detect vendor bundles and custom build directories generically
 */
export function getPackageFiles(
    files: ExtractedSource[],
    packageName: string,
): ExtractedSource[] {
    const packageFiles: ExtractedSource[] = [];
    const normalizedName = packageName.toLowerCase();
    const baseName = packageName.replace(/^@[^/]+\//, '').toLowerCase();

    // Escape special regex chars in package name for pattern matching
    const escapedBaseName = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Generic patterns for vendor bundles (derived from package name)
    const vendorPatterns = [
        // Package name followed by hash: "lodash-Abc123.js", "react-dom-AbC1d2.js"
        new RegExp(`[/\\\\]${escapedBaseName}-[a-zA-Z0-9]{4,}\\.(m?js)$`, 'i'),
        // Package name with version in directory: "package-1.2.3/"
        new RegExp(
            `[/\\\\]${escapedBaseName}-\\d+\\.\\d+\\.\\d+[^/\\\\]*[/\\\\]`,
            'i',
        ),
        // Package name as standalone directory with source
        new RegExp(
            `[/\\\\]${escapedBaseName}[/\\\\](?:src|lib|dist|es|esm)[/\\\\]`,
            'i',
        ),
    ];

    for (const file of files) {
        const pathLower = file.path.toLowerCase();

        // Strategy 1: Check node_modules/ paths (existing logic)
        if (pathLower.includes('node_modules/')) {
            const extractedPkgName = extractPackageNameFromPath(file.path);
            if (
                extractedPkgName &&
                extractedPkgName.toLowerCase() === normalizedName
            ) {
                packageFiles.push(file);
                continue;
            }
        }

        // Strategy 2: Check for vendor bundle patterns derived from package name
        for (const pattern of vendorPatterns) {
            if (pattern.test(file.path)) {
                packageFiles.push(file);
                break;
            }
        }
    }

    return packageFiles;
}

/**
 * Detects custom build version from directory structure or file headers
 * Generic approach - derives patterns from package name
 */
export function detectCustomBuild(
    packageName: string,
    packageFiles: ExtractedSource[],
): VersionResult | null {
    const baseName = packageName.replace(/^@[^/]+\//, '');
    const escapedBaseName = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Pattern: package-name-X.Y.Z/ or package-name-X.Y.Z-something/ in path
    const versionInPathPattern = new RegExp(
        `${escapedBaseName}-(\\d+\\.\\d+\\.\\d+[^/\\\\]*)`,
        'i',
    );

    // Check file paths for version in directory structure
    for (const file of packageFiles) {
        const match = file.path.match(versionInPathPattern);
        if (match) {
            return {
                version: match[1],
                confidence: 'high',
                source: 'custom-build',
            };
        }
    }

    // Generic patterns: Look for version in file headers (comments)
    // These are generic patterns that work across packages
    const headerPatterns = [
        // @version X.Y.Z
        /@version\s+v?(\d+\.\d+\.\d+(?:-[\w.]+)?)/i,
        // * vX.Y.Z or * X.Y.Z (JSDoc style)
        /\*\s+v?(\d+\.\d+\.\d+(?:-[\w.]+)?)\s/,
        // version: "X.Y.Z" or version = "X.Y.Z"
        /version\s*[:=]\s*['"]v?(\d+\.\d+\.\d+(?:-[\w.]+)?)['"]/i,
        // PackageName vX.Y.Z (generic banner)
        new RegExp(
            `${escapedBaseName}\\s+v?(\\d+\\.\\d+\\.\\d+(?:-[\\w.]+)?)`,
            'i',
        ),
    ];

    for (const file of packageFiles) {
        // Only check the first 2000 chars where version info usually is
        const header = file.content.slice(0, 2000);
        // Strip URL content to avoid false positives like "version=1.1.1" in query strings
        const cleanedHeader = stripUrlContent(header);

        for (const pattern of headerPatterns) {
            const match = cleanedHeader.match(pattern);
            if (match && match.index !== undefined) {
                // Additional validation: check the original content context
                // Find where this match would be in the original header
                const originalMatch = header.match(pattern);
                if (originalMatch && originalMatch.index !== undefined) {
                    // Validate context in original content
                    if (!isValidVersionContext(header, originalMatch.index)) {
                        continue; // Skip this match, likely inside a URL
                    }
                }

                return {
                    version: match[1],
                    confidence: 'medium',
                    source: 'custom-build',
                };
            }
        }
    }

    return null;
}

/**
 * Main version detection function - tries all methods in order of confidence
 */
export function detectVersion(
    packageName: string,
    packageFiles: ExtractedSource[],
    _allFiles: ExtractedSource[],
): VersionResult | null {
    // Try each detection method in order of confidence

    // 1. Check lockfile paths (exact confidence)
    for (const file of packageFiles) {
        const result = detectVersionFromLockfilePath(file.path, packageName);
        if (result) return result;
    }

    // 2. Check source map paths for version info (high confidence)
    for (const file of packageFiles) {
        const result = detectVersionFromSourceMapPath(file.path, packageName);
        if (result) return result;
    }

    // 3. Check for custom build version in directory/path (high confidence)
    const customBuildResult = detectCustomBuild(packageName, packageFiles);
    if (customBuildResult) return customBuildResult;

    // 4. Check for license banners (high confidence)
    // DISABLED: Banner attribution is too flaky - banners in nested node_modules
    // (e.g., hoist-non-react-statics/node_modules/react-is/) get incorrectly
    // attributed to the parent package.
    // for (const file of packageFiles) {
    //   const result = detectVersionFromBanner(file.content, packageName);
    //   if (result) return result;
    // }

    // 5. Check for VERSION constants (medium confidence)
    for (const file of packageFiles) {
        const result = detectVersionFromConstants(file.content, packageName);
        if (result) return result;
    }

    return null;
}

/**
 * Detect versions for multiple packages
 */
export function detectVersions(
    packageNames: string[],
    allFiles: ExtractedSource[],
    onProgress?: (packageName: string, result: VersionResult | null) => void,
): Map<string, VersionResult> {
    const results = new Map<string, VersionResult>();

    for (const packageName of packageNames) {
        const packageFiles = getPackageFiles(allFiles, packageName);
        const result = detectVersion(packageName, packageFiles, allFiles);

        if (result) {
            results.set(packageName, result);
        }

        onProgress?.(packageName, result);
    }

    return results;
}
