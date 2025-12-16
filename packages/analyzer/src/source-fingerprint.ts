/**
 * Source code fingerprinting for npm package version detection.
 *
 * @packageDocumentation
 *
 * This module compares extracted source code against published npm package versions
 * to find the best matching version. It uses multiple strategies to handle both
 * minified and unminified code.
 *
 * Key features:
 * - Checks ALL versions by default (unless maxVersionsToCheck is specified)
 * - Better entry point discovery using npm package.json metadata
 * - Multi-file comparison for higher accuracy with modular packages
 * - Source-to-dist comparison using AST-based signatures
 * - Disk caching for faster repeated runs
 * - Structural fingerprinting for packages with many small files
 *
 * @example
 * ```typescript
 * import { findMatchingVersion, findMatchingVersions } from '@web2local/analyzer';
 *
 * // Find version for a single package
 * const result = await findMatchingVersion('react', extractedFiles);
 * if (result) {
 *   console.log(`Found version ${result.version} with ${result.similarity} similarity`);
 * }
 *
 * // Find versions for multiple packages
 * const results = await findMatchingVersions(packageMap, {
 *   minSimilarity: 0.8,
 *   onProgress: (pkg, result) => console.log(`${pkg}: ${result?.version}`)
 * });
 * ```
 */

import { createHash } from 'crypto';
import { VersionResult } from './version-detector.js';
import type { ExtractedSource } from '@web2local/types';
import {
    FingerprintCache,
    getCache,
    computeNormalizedHash,
    extractCodeSignature,
    type PackageMetadataCache,
    type ContentFingerprintCache,
    type PackageFileListCache,
} from '@web2local/cache';
import { robustFetch } from '@web2local/http';
import { runConcurrent } from '@web2local/utils';

// Re-export for external use
export { computeNormalizedHash, extractCodeSignature };

/** Default number of packages to process concurrently */
const DEFAULT_PACKAGE_CONCURRENCY = 5;

/** Default number of versions to check concurrently within a single package */
const DEFAULT_VERSION_CHECK_CONCURRENCY = 10;

/** Default number of entry paths to try concurrently when fetching from CDN */
const DEFAULT_PATH_CONCURRENCY = 5;

/**
 * Result of fingerprint-based version detection.
 *
 * Extends {@link VersionResult} with similarity metrics for assessing
 * match quality.
 */
export interface FingerprintResult extends VersionResult {
    /** Similarity score between 0 and 1 (1 = exact match) */
    similarity: number;
    /** Number of files that contributed to the match */
    matchedFiles: number;
    /** Total number of files analyzed */
    totalFiles: number;
}

/**
 * Options for fingerprint-based version detection.
 */
export interface FingerprintOptions {
    /**
     * Maximum number of versions to check per package.
     * Set to 0 to check all available versions.
     * @defaultValue 0
     */
    maxVersionsToCheck?: number;
    /**
     * Minimum similarity threshold for accepting a match.
     * Values range from 0 (no similarity) to 1 (exact match).
     * @defaultValue 0.7
     */
    minSimilarity?: number;
    /**
     * Number of packages to process concurrently.
     * @defaultValue 5
     */
    concurrency?: number;
    /**
     * Number of versions to check concurrently within each package.
     * @defaultValue 10
     */
    versionConcurrency?: number;
    /**
     * Number of entry paths to try concurrently when fetching from CDN.
     * @defaultValue 5
     */
    pathConcurrency?: number;
    /**
     * Whether to include pre-release versions in the search.
     * Pre-release versions include alpha, beta, rc, nightly, canary, etc.
     * @defaultValue false
     */
    includePrereleases?: boolean;
    /**
     * Callback invoked when a package finishes processing.
     * @param packageName - The name of the package that was processed
     * @param result - The fingerprint result, or null if no match found
     */
    onProgress?: (
        packageName: string,
        result: FingerprintResult | null,
    ) => void;
    /**
     * Callback invoked for each version being checked.
     * Useful for detailed progress reporting.
     * @param packageName - The name of the package
     * @param version - The version being checked
     * @param versionIndex - Current version index (1-based)
     * @param versionTotal - Total number of versions to check
     */
    onDetailedProgress?: (
        packageName: string,
        version: string,
        versionIndex: number,
        versionTotal: number,
    ) => void;
}

/**
 * Result of fetching package metadata with existence check
 */
export interface PackageMetadataResult {
    /** Whether the package exists on npm */
    exists: boolean;
    /** Package metadata (only present if exists is true) */
    metadata?: PackageMetadataCache;
}

/**
 * Fetches package metadata from npm registry, also determining if the package exists.
 * This consolidates the existence check and metadata fetch into a single HTTP request.
 * Results are cached for both existence and metadata.
 *
 * @param packageName - The npm package name
 * @param cache - The fingerprint cache instance
 * @returns Object with exists boolean and optional metadata
 */
export async function fetchPackageMetadataWithExistence(
    packageName: string,
    cache: FingerprintCache,
): Promise<PackageMetadataResult> {
    // Check metadata cache first - if we have metadata, package exists
    const cachedMetadata = await cache.getMetadata(packageName);
    if (cachedMetadata) {
        return { exists: true, metadata: cachedMetadata };
    }

    // Check existence cache - if we know it doesn't exist, return early
    const cachedExistence = await cache.getNpmPackageExistence(packageName);
    if (cachedExistence && !cachedExistence.exists) {
        return { exists: false };
    }

    try {
        const response = await robustFetch(
            `https://registry.npmjs.org/${encodeURIComponent(packageName)}`,
            {
                headers: { Accept: 'application/json' },
            },
        );

        if (response.status === 404) {
            // Package doesn't exist - cache this fact
            await cache.setNpmPackageExistence({
                packageName,
                exists: false,
                fetchedAt: Date.now(),
            });
            return { exists: false };
        }

        if (!response.ok) {
            // Other error (e.g., 500) - don't cache, return as if it might exist
            return { exists: true };
        }

        const data: NpmPackageMetadata = await response.json();

        // Extract and cache the metadata we need
        const versions = Object.keys(data.versions || {});
        const versionDetails: PackageMetadataCache['versionDetails'] = {};

        for (const [version, info] of Object.entries(data.versions || {})) {
            versionDetails[version] = {
                main: info.main,
                module: info.module,
                exports: info.exports,
                types: info.types,
                peerDependencies: info.peerDependencies,
                dependencies: info.dependencies,
            };
        }

        // Extract version publish times for smart ordering
        const versionTimes: Record<string, number> = {};
        if (data.time) {
            for (const [version, timeStr] of Object.entries(data.time)) {
                // Skip 'created' and 'modified' meta-keys
                if (version !== 'created' && version !== 'modified') {
                    versionTimes[version] = new Date(timeStr).getTime();
                }
            }
        }

        const metadata: PackageMetadataCache = {
            name: packageName,
            versions,
            versionDetails,
            distTags: data['dist-tags'] || {},
            versionTimes,
            fetchedAt: Date.now(),
        };

        // Cache both metadata and existence
        await cache.setMetadata(metadata);
        await cache.setNpmPackageExistence({
            packageName,
            exists: true,
            fetchedAt: Date.now(),
        });

        return { exists: true, metadata };
    } catch {
        // Network error - assume package might exist, don't cache
        return { exists: true };
    }
}

/**
 * Tries multiple fetcher functions in parallel and returns the first successful result.
 * Useful for trying multiple entry paths concurrently.
 *
 * @param fetchers - Array of functions that return a promise of T or null
 * @param concurrency - Maximum number of fetchers to run in parallel (default: 5)
 * @returns The first non-null result, or null if all fetchers return null/fail
 */
async function fetchFirstSuccessful<T>(
    fetchers: Array<() => Promise<T | null>>,
    concurrency: number = DEFAULT_PATH_CONCURRENCY,
): Promise<T | null> {
    if (fetchers.length === 0) return null;

    // Process in batches to respect concurrency limit
    for (let i = 0; i < fetchers.length; i += concurrency) {
        const batch = fetchers.slice(i, i + concurrency);

        // Launch all fetchers in this batch in parallel
        const results = await Promise.all(
            batch.map(async (fetcher) => {
                try {
                    return await fetcher();
                } catch {
                    return null;
                }
            }),
        );

        // Return the first non-null result
        for (const result of results) {
            if (result !== null) {
                return result;
            }
        }
    }

    return null;
}

interface NpmPackageMetadata {
    name: string;
    versions: Record<
        string,
        {
            main?: string;
            module?: string;
            exports?: Record<string, unknown>;
            types?: string;
            peerDependencies?: Record<string, string>;
            dependencies?: Record<string, string>;
        }
    >;
    time?: Record<string, string>;
    'dist-tags'?: Record<string, string>;
}

/**
 * Fetches package metadata from npm registry (with caching)
 */
async function fetchPackageMetadata(
    packageName: string,
    cache: FingerprintCache,
): Promise<PackageMetadataCache | null> {
    // Check cache first
    const cached = await cache.getMetadata(packageName);
    if (cached) {
        return cached;
    }

    try {
        const response = await robustFetch(
            `https://registry.npmjs.org/${encodeURIComponent(packageName)}`,
            {
                headers: { Accept: 'application/json' },
            },
        );

        if (!response.ok) {
            return null;
        }

        const data: NpmPackageMetadata = await response.json();

        // Extract and cache the metadata we need
        const versions = Object.keys(data.versions || {});
        const versionDetails: PackageMetadataCache['versionDetails'] = {};

        for (const [version, info] of Object.entries(data.versions || {})) {
            versionDetails[version] = {
                main: info.main,
                module: info.module,
                exports: info.exports,
                types: info.types,
                peerDependencies: info.peerDependencies,
                dependencies: info.dependencies,
            };
        }

        // Extract version publish times for smart ordering
        const versionTimes: Record<string, number> = {};
        if (data.time) {
            for (const [version, timeStr] of Object.entries(data.time)) {
                // Skip 'created' and 'modified' meta-keys
                if (version !== 'created' && version !== 'modified') {
                    versionTimes[version] = new Date(timeStr).getTime();
                }
            }
        }

        const metadata: PackageMetadataCache = {
            name: packageName,
            versions,
            versionDetails,
            distTags: data['dist-tags'] || {},
            versionTimes,
            fetchedAt: Date.now(),
        };

        await cache.setMetadata(metadata);
        return metadata;
    } catch {
        return null;
    }
}

/**
 * Gets all versions for a package, sorted by semver (most recent first)
 * By default only returns stable versions (no pre-releases)
 */
async function getAllVersions(
    packageName: string,
    cache: FingerprintCache,
    limit: number = 0,
    includePrereleases: boolean = false,
): Promise<string[]> {
    const metadata = await fetchPackageMetadata(packageName, cache);
    if (!metadata) {
        return [];
    }

    // Filter out pre-release versions (alpha, beta, rc, nightly, canary, etc.)
    const stableVersions = metadata.versions.filter(
        (v: string) => !v.includes('-'),
    );
    const preReleaseVersions = metadata.versions.filter((v: string) =>
        v.includes('-'),
    );

    // Sort by semver (descending) - simple implementation
    const sortSemver = (a: string, b: string) => {
        const partsA = a.replace(/-.*$/, '').split('.').map(Number);
        const partsB = b.replace(/-.*$/, '').split('.').map(Number);

        for (let i = 0; i < 3; i++) {
            if ((partsA[i] || 0) !== (partsB[i] || 0)) {
                return (partsB[i] || 0) - (partsA[i] || 0);
            }
        }
        return 0;
    };

    stableVersions.sort(sortSemver);

    // If not including prereleases, only return stable versions
    if (!includePrereleases) {
        if (limit > 0) {
            return stableVersions.slice(0, limit);
        }
        return stableVersions;
    }

    // Include prereleases: stable first, then pre-release
    preReleaseVersions.sort(sortSemver);
    const allVersions = [...stableVersions, ...preReleaseVersions];

    if (limit > 0) {
        return allVersions.slice(0, limit);
    }

    return allVersions;
}

/**
 * Finds the index of the version closest to the hint in a list of versions.
 * The hint can be a full version like "1.2.3" or a partial like "1.2" or "1.x".
 */
function findClosestVersionIndex(versions: string[], hint: string): number {
    // Parse hint - remove .x suffix and split into parts
    const hintParts = hint
        .replace(/\.x$/i, '')
        .split('.')
        .map((p) => parseInt(p, 10) || 0);

    let bestIndex = -1;
    let bestDistance = Infinity;

    for (let i = 0; i < versions.length; i++) {
        const vParts = versions[i]
            .replace(/-.*$/, '') // Remove prerelease suffix
            .split('.')
            .map((p) => parseInt(p, 10) || 0);

        // Calculate weighted distance (major has highest weight)
        let distance = 0;
        for (let j = 0; j < 3; j++) {
            const weight = Math.pow(1000, 2 - j); // 1000000, 1000, 1
            const diff = Math.abs((vParts[j] || 0) - (hintParts[j] || 0));
            distance += diff * weight;
        }

        if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = i;
        }
    }

    return bestIndex;
}

/**
 * Returns versions ordered for efficient searching:
 * 1. dist-tags (latest, next, etc.) - most likely matches
 * 2. If versionHint provided, versions close to it (outward search)
 * 3. Remaining versions by publish date (newest first)
 */
function getVersionsInSearchOrder(
    allVersions: string[],
    metadata: PackageMetadataCache,
    versionHint?: string | null,
): string[] {
    const ordered: string[] = [];
    const seen = new Set<string>();

    // Priority 1: dist-tags (latest, next, etc.) - these are most commonly used
    if (metadata.distTags) {
        for (const tagVersion of Object.values(metadata.distTags) as string[]) {
            if (allVersions.includes(tagVersion) && !seen.has(tagVersion)) {
                ordered.push(tagVersion);
                seen.add(tagVersion);
            }
        }
    }

    // Priority 2: If we have a version hint, search outward from it
    if (versionHint) {
        const hintIndex = findClosestVersionIndex(allVersions, versionHint);
        if (hintIndex >= 0) {
            // Interleave versions before and after the hint for binary-search-like behavior
            for (let offset = 0; offset < allVersions.length; offset++) {
                const after = hintIndex + offset;
                const before = hintIndex - offset - 1;

                if (
                    after < allVersions.length &&
                    !seen.has(allVersions[after])
                ) {
                    ordered.push(allVersions[after]);
                    seen.add(allVersions[after]);
                }
                if (before >= 0 && !seen.has(allVersions[before])) {
                    ordered.push(allVersions[before]);
                    seen.add(allVersions[before]);
                }
            }
        }
    }

    // Priority 3: Remaining versions by publish date (newest first)
    const remaining = allVersions.filter((v) => !seen.has(v));
    if (
        metadata.versionTimes &&
        Object.keys(metadata.versionTimes).length > 0
    ) {
        remaining.sort((a, b) => {
            const timeA = metadata.versionTimes?.[a] ?? 0;
            const timeB = metadata.versionTimes?.[b] ?? 0;
            return timeB - timeA; // Descending (newest first)
        });
    }

    ordered.push(...remaining);
    return ordered;
}

/**
 * Pre-fetches metadata for multiple packages in parallel.
 * This eliminates metadata fetch latency from the critical path.
 */
async function prefetchPackageMetadata(
    packageNames: string[],
    cache: FingerprintCache,
    concurrency: number = 10,
): Promise<void> {
    // Filter to packages not already in cache
    const needsFetch: string[] = [];
    for (const name of packageNames) {
        const cached = await cache.getMetadata(name);
        if (!cached) {
            needsFetch.push(name);
        }
    }

    if (needsFetch.length === 0) return;

    // Fetch in parallel batches
    for (let i = 0; i < needsFetch.length; i += concurrency) {
        const batch = needsFetch.slice(i, i + concurrency);
        await Promise.all(
            batch.map((name) => fetchPackageMetadata(name, cache)),
        );
    }
}

/**
 * Resolves the entry point paths for a package version using its package.json
 */
function resolveEntryPoints(
    packageName: string,
    versionDetails: PackageMetadataCache['versionDetails'][string] | undefined,
): string[] {
    const paths: string[] = [];
    const baseName = packageName.split('/').pop() || packageName;

    if (versionDetails) {
        // Priority 1: ESM module field
        if (versionDetails.module) {
            paths.push(versionDetails.module.replace(/^\.\//, ''));
        }

        // Priority 2: Main field
        if (versionDetails.main) {
            paths.push(versionDetails.main.replace(/^\.\//, ''));
        }

        // Priority 3: Exports field
        if (versionDetails.exports) {
            const exportsField = versionDetails.exports as unknown;

            // Handle various export formats
            if (typeof exportsField === 'string') {
                paths.push(exportsField.replace(/^\.\//, ''));
            } else if (
                typeof exportsField === 'object' &&
                exportsField !== null
            ) {
                const exportsObj = exportsField as Record<string, unknown>;
                // Check for '.' or 'import' or 'require' or 'default'
                const dotExport = exportsObj['.'];
                if (dotExport) {
                    if (typeof dotExport === 'string') {
                        paths.push(dotExport.replace(/^\.\//, ''));
                    } else if (
                        typeof dotExport === 'object' &&
                        dotExport !== null
                    ) {
                        const exp = dotExport as Record<string, unknown>;
                        for (const key of [
                            'import',
                            'module',
                            'require',
                            'default',
                        ]) {
                            if (typeof exp[key] === 'string') {
                                paths.push(
                                    (exp[key] as string).replace(/^\.\//, ''),
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    // Fallback paths if nothing found in package.json
    if (paths.length === 0) {
        paths.push(
            'dist/index.js',
            'dist/index.mjs',
            'lib/index.js',
            'es/index.js',
            'esm/index.js',
            `dist/${baseName}.js`,
            `dist/${baseName}.mjs`,
            `dist/${baseName}.min.js`,
            `dist/${baseName}.esm.js`,
            `dist/${baseName}.cjs.js`,
            'index.js',
            'index.mjs',
            'src/index.js',
            'build/index.js',
            'cjs/index.js',
            'umd/index.js',
        );
    }

    // Always add these common paths as fallbacks
    const fallbacks = ['dist/index.js', 'lib/index.js', 'index.js'];

    for (const fb of fallbacks) {
        if (!paths.includes(fb)) {
            paths.push(fb);
        }
    }

    return paths;
}

/**
 * Gets minified/production entry point paths for a package
 * Derived dynamically from the package name - no hardcoding
 */
function getMinifiedEntryPaths(packageName: string): string[] {
    const baseName = packageName.split('/').pop() || packageName;
    const scopelessName = packageName.replace(/^@[^/]+\//, '');

    // Generate common minified patterns from package name
    return [
        // Standard minified builds
        `dist/${baseName}.min.js`,
        `dist/${scopelessName}.min.js`,
        `dist/${baseName}.umd.min.js`,
        `dist/${baseName}.cjs.min.js`,
        `dist/${baseName}.esm.min.js`,
        `dist/${baseName}.production.min.js`,
        // UMD builds
        `umd/${baseName}.min.js`,
        `umd/${baseName}.production.min.js`,
        // CJS production builds (React-style)
        `cjs/${baseName}.production.min.js`,
        // Root level minified
        `${baseName}.min.js`,
        `${scopelessName}.min.js`,
        // Generic minified index
        `dist/index.min.js`,
        `bundle.min.js`,
        // Non-minified dist (some packages don't have .min versions)
        `dist/${baseName}.js`,
        `dist/${baseName}.umd.js`,
        `dist/${baseName}.cjs.js`,
        `dist/${baseName}.esm.js`,
        `dist/${baseName}.bundle.js`,
        `dist/${scopelessName}.js`,
        // Browser builds
        `browser/${baseName}.js`,
        `browser/index.js`,
        // Build output
        `build/${baseName}.js`,
        `build/index.js`,
    ];
}

/**
 * Detects if code content is minified using generic heuristics
 * No hardcoded package names - purely content-based analysis
 */
function detectIfMinified(content: string): boolean {
    const lines = content.split('\n').filter((l) => l.trim());
    if (lines.length === 0) return false;

    // Heuristic 1: Average line length (minified = very long lines)
    const avgLineLength = content.length / Math.max(lines.length, 1);

    // Heuristic 2: Whitespace ratio (minified = low whitespace)
    const whitespaceCount = (content.match(/\s/g) || []).length;
    const whitespaceRatio = whitespaceCount / content.length;

    // Heuristic 3: Single-character variable density
    // Minified code has many single-char vars like: function(a,b,c){...}
    const singleCharVars = (content.match(/[(,]\s*[a-z]\s*[,)]/gi) || [])
        .length;
    const singleCharDensity = singleCharVars / (content.length / 1000);

    // Heuristic 4: Semicolon density per line (minified has many statements per line)
    const semicolons = (content.match(/;/g) || []).length;
    const semicolonDensity = lines.length > 0 ? semicolons / lines.length : 0;

    // Heuristic 5: Lack of comments (minified code strips comments)
    const hasComments = /\/\*[\s\S]*?\*\/|\/\/.*$/m.test(
        content.slice(0, 5000),
    );
    const commentRatio = hasComments ? 0.5 : 0;

    // Combined score - if any strong signal, consider it minified
    return (
        avgLineLength > 200 ||
        whitespaceRatio < 0.08 ||
        singleCharDensity > 3 ||
        (semicolonDensity > 8 && !hasComments) ||
        (avgLineLength > 100 && whitespaceRatio < 0.15 && commentRatio < 0.3)
    );
}

/**
 * Extracts string literals from code (survives minification)
 */
function extractStringLiterals(content: string): Set<string> {
    const strings = new Set<string>();
    // Match strings longer than 5 chars (skip short variable names)
    const regex = /(['"`])(?:(?!\1)[^\\]|\\.){5,}?\1/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
        // Store the string content without quotes, normalized
        const str = match[0].slice(1, -1).trim();
        if (str.length > 5) {
            strings.add(str);
        }
    }
    return strings;
}

/**
 * Extracts function call patterns (survives minification with name mangling)
 * Returns patterns like "functionName:argCount"
 */
function extractFunctionCallPatterns(content: string): Set<string> {
    const calls = new Set<string>();
    // Match function calls - name followed by parentheses
    const regex = /\b([a-zA-Z_$][a-zA-Z0-9_$]{2,})\s*\(\s*([^)]*)\)/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
        const name = match[1];
        const args = match[2].trim();
        // Count arguments by splitting on commas (rough approximation)
        const arity = args ? args.split(',').length : 0;
        // Store pattern as "name:arity" - even if names are mangled, arity survives
        calls.add(`${name}:${arity}`);
    }
    return calls;
}

/**
 * Extracts numeric constants from code (survives minification)
 */
function extractNumericConstants(content: string): Set<string> {
    const numbers = new Set<string>();
    // Match numbers that look like constants (not simple 0, 1, 2)
    const regex = /\b(\d{3,}|\d+\.\d+)\b/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
        numbers.add(match[1]);
    }
    return numbers;
}

/**
 * Computes Jaccard similarity between two sets
 */
function computeJaccardSimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 0;
    if (a.size === 0 || b.size === 0) return 0;

    const intersection = new Set([...a].filter((x) => b.has(x)));
    const union = new Set([...a, ...b]);
    return intersection.size / union.size;
}

/**
 * Enhanced similarity computation for minified code comparison
 * Uses features that survive minification
 */
function computeMinifiedSimilarity(
    extractedContent: string,
    extractedFingerprint: {
        contentHash: string;
        normalizedHash: string;
        contentLength: number;
    },
    npmFingerprint: ContentFingerprintCache,
    npmContent?: string,
): number {
    // Strategy 1: Exact hash matches (ideal case)
    if (extractedFingerprint.contentHash === npmFingerprint.contentHash)
        return 1.0;
    if (extractedFingerprint.normalizedHash === npmFingerprint.normalizedHash)
        return 0.99;

    // If we don't have npm content to compare, fall back to length-based heuristic
    if (!npmContent) {
        const lenRatio =
            Math.min(
                extractedFingerprint.contentLength,
                npmFingerprint.contentLength,
            ) /
            Math.max(
                extractedFingerprint.contentLength,
                npmFingerprint.contentLength,
            );
        return lenRatio * 0.5;
    }

    // Strategy 2: String literals matching (survives minification)
    const extractedStrings = extractStringLiterals(extractedContent);
    const npmStrings = extractStringLiterals(npmContent);
    const stringSim = computeJaccardSimilarity(extractedStrings, npmStrings);

    // Strategy 3: Function call patterns
    const extractedCalls = extractFunctionCallPatterns(extractedContent);
    const npmCalls = extractFunctionCallPatterns(npmContent);
    const callSim = computeJaccardSimilarity(extractedCalls, npmCalls);

    // Strategy 4: Numeric constants
    const extractedNums = extractNumericConstants(extractedContent);
    const npmNums = extractNumericConstants(npmContent);
    const numSim = computeJaccardSimilarity(extractedNums, npmNums);

    // Strategy 5: Length ratio (minified versions should be similar length)
    const lenRatio =
        Math.min(
            extractedFingerprint.contentLength,
            npmFingerprint.contentLength,
        ) /
        Math.max(
            extractedFingerprint.contentLength,
            npmFingerprint.contentLength,
        );

    // Weighted combination - strings and function patterns are most reliable
    const similarity =
        stringSim * 0.35 + callSim * 0.35 + numSim * 0.15 + lenRatio * 0.15;

    // Boost score if multiple signals agree
    const agreementBonus = stringSim > 0.5 && callSim > 0.5 ? 0.1 : 0;

    return Math.min(similarity + agreementBonus, 1.0);
}

// ============================================================================
// STRUCTURAL FINGERPRINTING
// For packages with many small files, compare file structure instead of content
// ============================================================================

/**
 * Extracts structural fingerprint from extracted package files.
 * Returns a set of normalized filenames that represent the package structure.
 */
function extractStructuralFingerprint(files: ExtractedSource[]): Set<string> {
    const filenames = new Set<string>();

    for (const file of files) {
        // Extract the filename without extension
        const parts = file.path.split(/[/\\]/);
        const basename = parts[parts.length - 1];

        // Remove extension
        const nameWithoutExt = basename.replace(/\.(m?[jt]sx?|json)$/i, '');

        if (nameWithoutExt && nameWithoutExt.length > 0) {
            // Normalize: lowercase, but preserve underscore prefix for internal files
            filenames.add(nameWithoutExt.toLowerCase());
        }
    }

    return filenames;
}

/**
 * Fetches the file list for a package version from unpkg ?meta API.
 * Results are cached.
 */
async function fetchPackageFileList(
    packageName: string,
    version: string,
    cache: FingerprintCache,
): Promise<Set<string> | null> {
    // Check cache first
    const cached = await cache.getFileList(packageName, version);
    if (cached) {
        return new Set(cached.files);
    }

    try {
        const url = `https://unpkg.com/${packageName}@${version}/?meta`;
        const response = await robustFetch(url, {
            headers: {
                Accept: 'application/json',
            },
        });

        if (!response.ok) {
            return null;
        }

        const data = await response.json();

        if (!data.files || !Array.isArray(data.files)) {
            return null;
        }

        // Extract filenames from the file list
        const filenames: string[] = [];
        for (const file of data.files) {
            if (file.path && typeof file.path === 'string') {
                // Only include JS files
                if (/\.(m?js|json)$/i.test(file.path)) {
                    const parts = file.path.split('/');
                    const basename = parts[parts.length - 1];
                    const nameWithoutExt = basename.replace(
                        /\.(m?js|json)$/i,
                        '',
                    );
                    if (nameWithoutExt && nameWithoutExt.length > 0) {
                        filenames.push(nameWithoutExt.toLowerCase());
                    }
                }
            }
        }

        // Cache the result
        const fileListCache: PackageFileListCache = {
            packageName,
            version,
            files: filenames,
            fetchedAt: Date.now(),
        };
        await cache.setFileList(fileListCache);

        return new Set(filenames);
    } catch {
        return null;
    }
}

/**
 * Computes structural similarity between extracted files and npm package file list.
 * Uses Jaccard similarity with weighting for public vs internal files.
 */
function computeStructuralSimilarity(
    extractedFiles: Set<string>,
    npmFiles: Set<string>,
): number {
    if (extractedFiles.size === 0 || npmFiles.size === 0) {
        return 0;
    }

    // Separate public and internal files (internal files start with _)
    const extractedPublic = new Set(
        [...extractedFiles].filter((f) => !f.startsWith('_')),
    );
    const extractedInternal = new Set(
        [...extractedFiles].filter((f) => f.startsWith('_')),
    );
    const npmPublic = new Set([...npmFiles].filter((f) => !f.startsWith('_')));
    const npmInternal = new Set([...npmFiles].filter((f) => f.startsWith('_')));

    // Compute Jaccard similarity for public files (weighted higher)
    const publicIntersection = new Set(
        [...extractedPublic].filter((x) => npmPublic.has(x)),
    );
    const publicUnion = new Set([...extractedPublic, ...npmPublic]);
    const publicSimilarity =
        publicUnion.size > 0 ? publicIntersection.size / publicUnion.size : 0;

    // Compute Jaccard similarity for internal files
    const internalIntersection = new Set(
        [...extractedInternal].filter((x) => npmInternal.has(x)),
    );
    const internalUnion = new Set([...extractedInternal, ...npmInternal]);
    const internalSimilarity =
        internalUnion.size > 0
            ? internalIntersection.size / internalUnion.size
            : 0;

    // Weighted combination: public files are more important (they're the API)
    // But internal files provide strong confirmation when they match
    const publicWeight = 0.6;
    const internalWeight = 0.4;

    let similarity =
        publicSimilarity * publicWeight + internalSimilarity * internalWeight;

    // Boost if both public AND internal files match well
    if (publicSimilarity > 0.5 && internalSimilarity > 0.5) {
        similarity = Math.min(similarity + 0.1, 1.0);
    }

    // Also check overall match rate - if most extracted files are in npm, that's good
    const allIntersection = new Set(
        [...extractedFiles].filter((x) => npmFiles.has(x)),
    );
    const extractedMatchRate = allIntersection.size / extractedFiles.size;

    // If extracted files mostly match npm files, boost similarity
    if (extractedMatchRate > 0.7) {
        similarity = Math.min(similarity + 0.15, 1.0);
    }

    return similarity;
}

/**
 * Finds the best matching version using structural fingerprinting.
 * This is a fallback for packages with many small files where content fingerprinting fails.
 */
async function findMatchingVersionByStructure(
    packageName: string,
    extractedFiles: ExtractedSource[],
    versions: string[],
    options: {
        minSimilarity?: number;
        cache?: FingerprintCache;
        onVersionCheck?: (
            version: string,
            index: number,
            total: number,
        ) => void;
    } = {},
): Promise<FingerprintResult | null> {
    const {
        minSimilarity = 0.5, // Lower threshold for structural matching
        cache = getCache(),
        onVersionCheck,
    } = options;

    // Extract structural fingerprint from extracted files
    const extractedStructure = extractStructuralFingerprint(extractedFiles);

    if (extractedStructure.size < 5) {
        // Too few files for reliable structural matching
        return null;
    }

    let bestMatch: FingerprintResult | null = null;

    for (let i = 0; i < versions.length; i++) {
        const version = versions[i];
        onVersionCheck?.(version, i + 1, versions.length);

        // Fetch npm package file list
        const npmStructure = await fetchPackageFileList(
            packageName,
            version,
            cache,
        );
        if (!npmStructure || npmStructure.size === 0) {
            continue;
        }

        const similarity = computeStructuralSimilarity(
            extractedStructure,
            npmStructure,
        );

        // Exact structural match
        if (similarity >= 0.95) {
            return {
                version,
                confidence: 'high',
                source: 'fingerprint',
                similarity,
                matchedFiles: extractedFiles.length,
                totalFiles: extractedFiles.length,
            };
        }

        // Track best match
        if (
            similarity >= minSimilarity &&
            (!bestMatch || similarity > bestMatch.similarity)
        ) {
            bestMatch = {
                version,
                confidence:
                    similarity >= 0.8
                        ? 'high'
                        : similarity >= 0.65
                          ? 'medium'
                          : 'low',
                source: 'fingerprint',
                similarity,
                matchedFiles: extractedFiles.length,
                totalFiles: extractedFiles.length,
            };
        }

        // Good enough match - stop early
        if (bestMatch && bestMatch.similarity >= 0.85) {
            break;
        }
    }

    return bestMatch;
}

/**
 * Fetches a file from unpkg CDN with caching
 */
async function fetchFileFromUnpkg(
    packageName: string,
    version: string,
    filePath: string,
    cache: FingerprintCache,
): Promise<ContentFingerprintCache | null> {
    // Check cache first
    const cached = await cache.getFingerprint(packageName, version);
    if (cached) {
        return cached;
    }

    try {
        const url = `https://unpkg.com/${packageName}@${version}/${filePath}`;
        const response = await robustFetch(url, {
            headers: {
                Accept: 'text/plain,application/javascript,*/*',
            },
        });

        if (!response.ok) {
            return null;
        }

        const content = await response.text();

        const fingerprint: ContentFingerprintCache = {
            packageName,
            version,
            entryPath: filePath,
            contentHash: createHash('md5').update(content).digest('hex'),
            normalizedHash: computeNormalizedHash(content),
            signature: extractCodeSignature(content),
            contentLength: content.length,
            fetchedAt: Date.now(),
        };

        await cache.setFingerprint(fingerprint);
        return fingerprint;
    } catch {
        return null;
    }
}

/**
 * Fetches a minified/production file from unpkg CDN with caching
 * Tries multiple minified entry paths derived from package name (in parallel)
 */
async function fetchMinifiedFromUnpkg(
    packageName: string,
    version: string,
    cache: FingerprintCache,
    pathConcurrency: number = DEFAULT_PATH_CONCURRENCY,
): Promise<{ fingerprint: ContentFingerprintCache; content: string } | null> {
    // Check cache first
    const cached = await cache.getMinifiedFingerprint(packageName, version);
    if (cached) {
        // For cached results, we don't have the content, but that's okay for hash matching
        return { fingerprint: cached, content: '' };
    }

    const minifiedPaths = getMinifiedEntryPaths(packageName);

    // Create fetchers for each path that will be tried in parallel
    const fetchers = minifiedPaths.map(
        (entryPath) =>
            async (): Promise<{
                fingerprint: ContentFingerprintCache;
                content: string;
            } | null> => {
                try {
                    const url = `https://unpkg.com/${packageName}@${version}/${entryPath}`;
                    const response = await robustFetch(url, {
                        headers: {
                            Accept: 'text/plain,application/javascript,*/*',
                        },
                    });

                    if (!response.ok) {
                        return null;
                    }

                    const content = await response.text();

                    // Verify this looks like actual JS content (not error page)
                    if (
                        content.length < 100 ||
                        content.includes('<!DOCTYPE') ||
                        content.includes('<html')
                    ) {
                        return null;
                    }

                    const fingerprint: ContentFingerprintCache = {
                        packageName,
                        version,
                        entryPath,
                        contentHash: createHash('md5')
                            .update(content)
                            .digest('hex'),
                        normalizedHash: computeNormalizedHash(content),
                        signature: extractCodeSignature(content),
                        contentLength: content.length,
                        isMinified: detectIfMinified(content),
                        fetchedAt: Date.now(),
                    };

                    await cache.setMinifiedFingerprint(fingerprint);
                    return { fingerprint, content };
                } catch {
                    return null;
                }
            },
    );

    return fetchFirstSuccessful(fetchers, pathConcurrency);
}

/**
 * Computes fingerprint for extracted source file
 */
function computeExtractedFingerprint(file: ExtractedSource): {
    contentHash: string;
    normalizedHash: string;
    signature: string;
    contentLength: number;
} {
    return {
        contentHash: createHash('md5').update(file.content).digest('hex'),
        normalizedHash: computeNormalizedHash(file.content),
        signature: extractCodeSignature(file.content),
        contentLength: file.content.length,
    };
}

/**
 * Computes similarity between two fingerprints
 * Uses multiple strategies for robust matching
 */
function computeSimilarity(
    extracted: ReturnType<typeof computeExtractedFingerprint>,
    npm: ContentFingerprintCache,
): number {
    // Strategy 1: Exact normalized hash match
    if (extracted.normalizedHash === npm.normalizedHash) {
        return 1.0;
    }

    // Strategy 2: Content hash match (before normalization)
    if (extracted.contentHash === npm.contentHash) {
        return 0.99;
    }

    // Strategy 3: Signature-based matching
    // Good for source-to-dist comparison where code structure is preserved
    if (extracted.signature && npm.signature) {
        const extractedSigSet = new Set(extracted.signature.split('|'));
        const npmSigSet = new Set(npm.signature.split('|'));

        if (extractedSigSet.size > 0 && npmSigSet.size > 0) {
            // Jaccard similarity
            const intersection = new Set(
                [...extractedSigSet].filter((x) => npmSigSet.has(x)),
            );
            const union = new Set([...extractedSigSet, ...npmSigSet]);
            const jaccardSim = intersection.size / union.size;

            // If signatures are very similar, this is likely the right version
            if (jaccardSim >= 0.8) {
                return 0.85 + (jaccardSim - 0.8) * 0.5; // Scale to 0.85-0.95
            }

            if (jaccardSim >= 0.5) {
                return 0.7 + (jaccardSim - 0.5) * 0.3; // Scale to 0.7-0.85
            }
        }
    }

    // Strategy 4: Length-based heuristic
    const lenRatio =
        Math.min(extracted.contentLength, npm.contentLength) /
        Math.max(extracted.contentLength, npm.contentLength);

    // TypeScript source is usually longer than compiled JS due to types
    // But not by a huge margin after minification is considered
    if (lenRatio < 0.1) {
        return lenRatio * 0.3; // Very different sizes = very low similarity
    }

    // Base similarity on length ratio for fallback
    return lenRatio * 0.5;
}

/**
 * Finds the entry point file from extracted package files
 */
function findExtractedEntryPoint(
    files: ExtractedSource[],
): ExtractedSource | null {
    const priorities = [
        /src\/index\.(m?[jt]sx?)$/,
        /dist\/index\.(m?js)$/,
        /lib\/index\.js$/,
        /es\/index\.js$/,
        /index\.(m?[jt]sx?)$/,
        /src\/main\.(m?[jt]sx?)$/,
        /src\/[^/]+\.(m?[jt]sx?)$/,
        /\.(m?[jt]sx?)$/,
    ];

    for (const pattern of priorities) {
        for (const file of files) {
            if (pattern.test(file.path)) {
                return file;
            }
        }
    }

    // Return largest source file as fallback
    const sourceFiles = files.filter(
        (f) => /\.(m?[jt]sx?)$/.test(f.path) && !f.path.includes('.d.ts'),
    );

    if (sourceFiles.length > 0) {
        return sourceFiles.reduce((a, b) =>
            a.content.length > b.content.length ? a : b,
        );
    }

    return files[0] || null;
}

/**
 * Collects combined features from all package files for multi-file fingerprinting.
 * This is useful for packages split into many small files (like lodash, date-fns).
 */
function collectPackageFeatures(files: ExtractedSource[]): {
    strings: Set<string>;
    functionCalls: Set<string>;
    numbers: Set<string>;
    totalLength: number;
    fileCount: number;
} {
    const strings = new Set<string>();
    const functionCalls = new Set<string>();
    const numbers = new Set<string>();
    let totalLength = 0;

    for (const file of files) {
        // Skip non-JS files
        if (!/\.(m?[jt]sx?)$/.test(file.path)) continue;
        if (file.path.includes('.d.ts')) continue;

        totalLength += file.content.length;

        // Collect string literals
        for (const str of extractStringLiterals(file.content)) {
            strings.add(str);
        }

        // Collect function call patterns
        for (const call of extractFunctionCallPatterns(file.content)) {
            functionCalls.add(call);
        }

        // Collect numeric constants
        for (const num of extractNumericConstants(file.content)) {
            numbers.add(num);
        }
    }

    return {
        strings,
        functionCalls,
        numbers,
        totalLength,
        fileCount: files.filter(
            (f) => /\.(m?[jt]sx?)$/.test(f.path) && !f.path.includes('.d.ts'),
        ).length,
    };
}

/**
 * Computes similarity between collected package features and npm content.
 * Used for multi-file packages without clear entry points.
 */
function computeMultiFileSimilarity(
    features: ReturnType<typeof collectPackageFeatures>,
    npmContent: string,
): number {
    if (features.fileCount === 0) return 0;

    // Extract features from npm content
    const npmStrings = extractStringLiterals(npmContent);
    const npmCalls = extractFunctionCallPatterns(npmContent);
    const npmNums = extractNumericConstants(npmContent);

    // Compute similarities
    const stringSim = computeJaccardSimilarity(features.strings, npmStrings);
    const callSim = computeJaccardSimilarity(features.functionCalls, npmCalls);
    const numSim = computeJaccardSimilarity(features.numbers, npmNums);

    // Weighted combination
    const similarity = stringSim * 0.4 + callSim * 0.4 + numSim * 0.2;

    // Boost if multiple signals agree
    const agreementBonus = stringSim > 0.4 && callSim > 0.4 ? 0.1 : 0;

    return Math.min(similarity + agreementBonus, 1.0);
}

/**
 * Result from checking a single version's similarity
 */
interface VersionCheckResult {
    version: string;
    similarity: number;
    matchSource: 'fingerprint' | 'fingerprint-minified';
}

/**
 * Checks similarity between extracted source and a specific npm package version.
 * Extracted as a helper to enable parallel version checking.
 */
async function checkVersionSimilarity(
    packageName: string,
    version: string,
    extractedFingerprint: ReturnType<typeof computeExtractedFingerprint>,
    extractedContent: string,
    isExtractedMinified: boolean,
    packageFeatures: ReturnType<typeof collectPackageFeatures> | null,
    metadata: PackageMetadataCache,
    cache: FingerprintCache,
    pathConcurrency: number = DEFAULT_PATH_CONCURRENCY,
): Promise<VersionCheckResult | null> {
    const versionDetails = metadata.versionDetails[version];
    const entryPaths = resolveEntryPoints(packageName, versionDetails);

    let bestSimilarityForVersion = 0;
    let matchSource: 'fingerprint' | 'fingerprint-minified' = 'fingerprint';

    // Strategy 1: Try clean source fingerprint (parallel path fetching)
    const npmFingerprint = await fetchFirstSuccessful(
        entryPaths.map(
            (entryPath) => () =>
                fetchFileFromUnpkg(packageName, version, entryPath, cache),
        ),
        pathConcurrency,
    );

    if (npmFingerprint) {
        const similarity = computeSimilarity(
            extractedFingerprint,
            npmFingerprint,
        );
        if (similarity > bestSimilarityForVersion) {
            bestSimilarityForVersion = similarity;
            matchSource = 'fingerprint';
        }
    }

    // Strategy 2: If extracted is minified OR clean match wasn't great, try minified versions
    if (isExtractedMinified || bestSimilarityForVersion < 0.9) {
        const minifiedResult = await fetchMinifiedFromUnpkg(
            packageName,
            version,
            cache,
        );
        if (minifiedResult) {
            // Use enhanced minified similarity algorithm
            const minifiedSimilarity = computeMinifiedSimilarity(
                extractedContent,
                extractedFingerprint,
                minifiedResult.fingerprint,
                minifiedResult.content,
            );

            if (minifiedSimilarity > bestSimilarityForVersion) {
                bestSimilarityForVersion = minifiedSimilarity;
                matchSource = 'fingerprint-minified';
            }

            // Strategy 3: Multi-file fingerprinting for packages split into many files
            if (
                packageFeatures &&
                minifiedResult.content &&
                bestSimilarityForVersion < 0.8
            ) {
                const multiFileSimilarity = computeMultiFileSimilarity(
                    packageFeatures,
                    minifiedResult.content,
                );
                if (multiFileSimilarity > bestSimilarityForVersion) {
                    bestSimilarityForVersion = multiFileSimilarity;
                    matchSource = 'fingerprint-minified';
                }
            }
        }
    }

    // Return null if no fingerprint found at all
    if (bestSimilarityForVersion === 0) {
        return null;
    }

    return {
        version,
        similarity: bestSimilarityForVersion,
        matchSource,
    };
}

/**
 * Finds the best matching npm package version for extracted source files.
 *
 * Uses a dual fingerprinting strategy:
 * 1. Tries clean source fingerprinting first
 * 2. Falls back to minified version comparison if needed
 * 3. For packages with many small files, uses structural fingerprinting
 *
 * Results are cached to speed up repeated lookups.
 *
 * @param packageName - The npm package name to find a version for
 * @param extractedFiles - Source files extracted from the target (e.g., from source maps)
 * @param options - Optional configuration for version detection
 * @returns The best matching version result, or null if no suitable match found
 *
 * @example
 * ```typescript
 * const result = await findMatchingVersion('lodash', extractedFiles, {
 *   minSimilarity: 0.8,
 *   onVersionCheck: (v, i, t) => console.log(`Checking ${v} (${i}/${t})`)
 * });
 * if (result) {
 *   console.log(`Matched ${result.version} with ${result.similarity} similarity`);
 * }
 * ```
 */
export async function findMatchingVersion(
    packageName: string,
    extractedFiles: ExtractedSource[],
    options: {
        maxVersionsToCheck?: number;
        minSimilarity?: number;
        includePrereleases?: boolean;
        /** Number of versions to check concurrently (default: 10) */
        versionConcurrency?: number;
        /** Number of entry paths to try concurrently when fetching from CDN (default: 5) */
        pathConcurrency?: number;
        /** Optional version hint for smarter search ordering */
        versionHint?: string | null;
        cache?: FingerprintCache;
        onVersionCheck?: (
            version: string,
            index: number,
            total: number,
        ) => void;
    } = {},
): Promise<FingerprintResult | null> {
    const {
        maxVersionsToCheck = 0, // 0 = all versions
        minSimilarity = 0.7,
        includePrereleases = false,
        versionConcurrency = DEFAULT_VERSION_CHECK_CONCURRENCY,
        pathConcurrency = DEFAULT_PATH_CONCURRENCY,
        versionHint = null,
        cache = getCache(),
        onVersionCheck,
    } = options;

    if (extractedFiles.length === 0) {
        return null;
    }

    // Find the main entry point from extracted files
    const entryPoint = findExtractedEntryPoint(extractedFiles);
    if (!entryPoint) {
        return null;
    }

    const extractedFingerprint = computeExtractedFingerprint(entryPoint);
    const isExtractedMinified = detectIfMinified(entryPoint.content);

    // Determine if this is a multi-file package (like lodash, date-fns)
    // that needs aggregate/structural fingerprinting
    // Conditions:
    // 1. Many files (>20) - typical of modular packages
    // 2. No clear index.js entry point found (entry point is just the largest file)
    // 3. OR entry point is small (<10KB) relative to total files
    const hasStandardEntryPoint = /(?:index|main)\.(m?[jt]sx?)$/.test(
        entryPoint.path,
    );
    const isMultiFilePackage =
        extractedFiles.length > 20 &&
        (!hasStandardEntryPoint || entryPoint.content.length < 10000);
    let packageFeatures: ReturnType<typeof collectPackageFeatures> | null =
        null;

    if (isMultiFilePackage) {
        packageFeatures = collectPackageFeatures(extractedFiles);
    }

    // Check for cached match result first
    const cachedMatch = await cache.getMatchResult(
        packageName,
        extractedFingerprint.normalizedHash,
    );
    if (cachedMatch) {
        // Return cached result - skip all version iteration
        // If matchedVersion is null, this was a cached "no match" result
        if (cachedMatch.matchedVersion === null) {
            return null;
        }
        return {
            version: cachedMatch.matchedVersion,
            confidence: cachedMatch.confidence!,
            source: 'fingerprint',
            similarity: cachedMatch.similarity,
            matchedFiles: 1,
            totalFiles: extractedFiles.length,
        };
    }

    // Get package metadata
    const metadata = await fetchPackageMetadata(packageName, cache);
    if (!metadata) {
        return null;
    }

    // Get versions to check (stable only by default)
    const allVersions = await getAllVersions(
        packageName,
        cache,
        maxVersionsToCheck,
        includePrereleases,
    );
    if (allVersions.length === 0) {
        return null;
    }

    // Order versions for efficient searching (dist-tags first, then by hint, then by date)
    const versions = getVersionsInSearchOrder(
        allVersions,
        metadata,
        versionHint,
    );

    let bestMatch: FingerprintResult | null = null;

    // Check versions concurrently with incremental progress reporting
    const versionResults = await runConcurrent(
        versions,
        versionConcurrency,
        async (version) => {
            return checkVersionSimilarity(
                packageName,
                version,
                extractedFingerprint,
                entryPoint.content,
                isExtractedMinified,
                packageFeatures,
                metadata,
                cache,
                pathConcurrency,
            );
        },
        (result, index, completed, total) => {
            onVersionCheck?.(versions[index], completed, total);
        },
    );

    // Process all results to find the best match
    for (const result of versionResults) {
        if (!result) continue;

        // Exact match - cache and return immediately
        if (result.similarity >= 0.99) {
            const exactResult: FingerprintResult = {
                version: result.version,
                confidence: 'exact',
                source: result.matchSource,
                similarity: result.similarity,
                matchedFiles: isMultiFilePackage ? extractedFiles.length : 1,
                totalFiles: extractedFiles.length,
            };

            // Cache the match result
            await cache.setMatchResult({
                packageName,
                extractedContentHash: extractedFingerprint.normalizedHash,
                matchedVersion: result.version,
                similarity: result.similarity,
                confidence: 'exact',
                fetchedAt: Date.now(),
            });

            return exactResult;
        }

        // Track best match
        if (
            result.similarity >= minSimilarity &&
            (!bestMatch || result.similarity > bestMatch.similarity)
        ) {
            bestMatch = {
                version: result.version,
                confidence:
                    result.similarity >= 0.9
                        ? 'high'
                        : result.similarity >= 0.8
                          ? 'medium'
                          : 'low',
                source: result.matchSource,
                similarity: result.similarity,
                matchedFiles: isMultiFilePackage ? extractedFiles.length : 1,
                totalFiles: extractedFiles.length,
            };
        }
    }

    // Strategy 4: If no good match found and this is a multi-file package,
    // try structural fingerprinting (comparing file names instead of content)
    if (
        (!bestMatch || bestMatch.similarity < minSimilarity) &&
        isMultiFilePackage
    ) {
        const structuralMatch = await findMatchingVersionByStructure(
            packageName,
            extractedFiles,
            versions,
            {
                minSimilarity: 0.5, // Lower threshold for structural matching
                cache,
                onVersionCheck,
            },
        );

        if (
            structuralMatch &&
            (!bestMatch || structuralMatch.similarity > bestMatch.similarity)
        ) {
            bestMatch = structuralMatch;
        }
    }

    // Cache the result (including "no match" for negative caching)
    await cache.setMatchResult({
        packageName,
        extractedContentHash: extractedFingerprint.normalizedHash,
        matchedVersion: bestMatch?.version ?? null,
        similarity: bestMatch?.similarity ?? 0,
        confidence: bestMatch
            ? (bestMatch.confidence as 'exact' | 'high' | 'medium' | 'low')
            : null,
        fetchedAt: Date.now(),
    });

    return bestMatch;
}

/**
 * Batch fingerprint matching for multiple packages.
 *
 * Processes multiple packages concurrently, pre-fetching npm metadata to
 * minimize latency. Results are cached for faster subsequent runs.
 *
 * @param packages - Map of package names to their extracted source files
 * @param options - Configuration options for the fingerprinting process
 * @returns Map of package names to their best matching version results
 *
 * @example
 * ```typescript
 * const packages = new Map([
 *   ['react', reactFiles],
 *   ['lodash', lodashFiles]
 * ]);
 * const results = await findMatchingVersions(packages, {
 *   concurrency: 3,
 *   onProgress: (pkg, result) => console.log(`${pkg}: ${result?.version}`)
 * });
 * ```
 */
export async function findMatchingVersions(
    packages: Map<string, ExtractedSource[]>,
    options: FingerprintOptions = {},
): Promise<Map<string, FingerprintResult>> {
    const {
        maxVersionsToCheck = 0,
        minSimilarity = 0.7,
        concurrency = DEFAULT_PACKAGE_CONCURRENCY,
        versionConcurrency = DEFAULT_VERSION_CHECK_CONCURRENCY,
        pathConcurrency = DEFAULT_PATH_CONCURRENCY,
        includePrereleases = false,
        onProgress,
        onDetailedProgress,
    } = options;

    const cache = getCache();
    const packageNames = Array.from(packages.keys());

    // Pre-fetch all package metadata in parallel before version checking
    // This eliminates metadata fetch latency from the critical path
    await prefetchPackageMetadata(packageNames, cache, 10);

    const results = new Map<string, FingerprintResult>();
    const entries = Array.from(packages.entries());

    // Process packages concurrently with incremental progress reporting
    const packageResults = await runConcurrent(
        entries,
        concurrency,
        async ([packageName, files]) => {
            const result = await findMatchingVersion(packageName, files, {
                maxVersionsToCheck,
                minSimilarity,
                includePrereleases,
                versionConcurrency,
                pathConcurrency,
                cache,
                onVersionCheck: (version, index, total) => {
                    onDetailedProgress?.(packageName, version, index, total);
                },
            });
            return { packageName, result };
        },
        (packageResult, _index, _completed, _total) => {
            onProgress?.(packageResult.packageName, packageResult.result);
        },
    );

    for (const { packageName, result } of packageResults) {
        if (result) {
            results.set(packageName, result);
        }
    }

    return results;
}

/**
 * Gets package metadata from npm registry with caching.
 *
 * Exposes cached metadata access for external use, primarily for
 * peer dependency inference.
 *
 * @param packageName - The npm package name to look up
 * @returns Cached package metadata, or null if the package doesn't exist
 */
export async function getPackageMetadata(
    packageName: string,
): Promise<PackageMetadataCache | null> {
    const cache = getCache();
    return fetchPackageMetadata(packageName, cache);
}

/**
 * Represents a minified vendor bundle for fingerprinting.
 *
 * Used when analyzing bundles without source maps, where the only
 * option is to compare minified code against published npm versions.
 */
export interface VendorBundleInput {
    /** The minified bundle content */
    content: string;
    /** Inferred package name from filename (optional) */
    inferredPackage?: string;
    /** Bundle filename (for context) */
    filename?: string;
}

/**
 * Attempts to identify a package from a minified vendor bundle.
 *
 * Compares the minified bundle against minified versions from npm's CDN
 * using features that survive minification (string literals, function patterns,
 * numeric constants).
 *
 * This is specifically for vendor bundles WITHOUT source maps.
 *
 * @param vendorBundle - The minified bundle to identify
 * @param candidatePackages - List of potential package names to check
 * @param options - Configuration options for the fingerprinting process
 * @returns The best matching version with package name, or null if no match found
 *
 * @example
 * ```typescript
 * const result = await fingerprintVendorBundle(
 *   { content: minifiedCode, filename: 'vendor-123abc.js' },
 *   ['react', 'lodash', 'axios'],
 *   { minSimilarity: 0.7 }
 * );
 * if (result) {
 *   console.log(`Identified ${result.packageName}@${result.version}`);
 * }
 * ```
 */
export async function fingerprintVendorBundle(
    vendorBundle: VendorBundleInput,
    candidatePackages: string[],
    options: {
        maxVersionsToCheck?: number;
        minSimilarity?: number;
        includePrereleases?: boolean;
        /** Number of versions to check concurrently (default: 10) */
        versionConcurrency?: number;
        /** Called when a match is found */
        onProgress?: (
            packageName: string,
            version: string,
            result: FingerprintResult | null,
        ) => void;
        /** Called for each version being checked - provides detailed progress */
        onDetailedProgress?: (
            packageName: string,
            version: string,
            versionIndex: number,
            versionTotal: number,
        ) => void;
    } = {},
): Promise<(FingerprintResult & { packageName: string }) | null> {
    const {
        maxVersionsToCheck = 0,
        minSimilarity = 0.6, // Lower threshold for minified comparison
        includePrereleases = false,
        versionConcurrency = DEFAULT_VERSION_CHECK_CONCURRENCY,
        onProgress,
        onDetailedProgress,
    } = options;

    const cache = getCache();
    const extractedContent = vendorBundle.content;

    // Pre-extract features that survive minification (done once, reused for all versions)
    const extractedStrings = extractStringLiterals(extractedContent);
    const extractedCalls = extractFunctionCallPatterns(extractedContent);
    const extractedNums = extractNumericConstants(extractedContent);
    const extractedLength = extractedContent.length;

    let bestMatch: (FingerprintResult & { packageName: string }) | null = null;
    let foundExactMatch = false;

    // Try inferred package first if available
    const packagesToTry = vendorBundle.inferredPackage
        ? [
              vendorBundle.inferredPackage,
              ...candidatePackages.filter(
                  (p) => p !== vendorBundle.inferredPackage,
              ),
          ]
        : candidatePackages;

    // Helper to check a single version and compute similarity
    async function checkVersion(
        packageName: string,
        version: string,
    ): Promise<(FingerprintResult & { packageName: string }) | null> {
        // Fetch minified version from CDN
        const minifiedResult = await fetchMinifiedFromUnpkg(
            packageName,
            version,
            cache,
        );
        if (!minifiedResult || !minifiedResult.content) {
            return null;
        }

        // Compare using minified-specific similarity
        const npmStrings = extractStringLiterals(minifiedResult.content);
        const npmCalls = extractFunctionCallPatterns(minifiedResult.content);
        const npmNums = extractNumericConstants(minifiedResult.content);

        // Compute similarities for each feature type
        const stringSim = computeJaccardSimilarity(
            extractedStrings,
            npmStrings,
        );
        const callSim = computeJaccardSimilarity(extractedCalls, npmCalls);
        const numSim = computeJaccardSimilarity(extractedNums, npmNums);

        // Length ratio
        const lenRatio =
            Math.min(extractedLength, minifiedResult.content.length) /
            Math.max(extractedLength, minifiedResult.content.length);

        // Weighted combination
        const similarity =
            stringSim * 0.35 + callSim * 0.35 + numSim * 0.15 + lenRatio * 0.15;

        // Boost if multiple signals agree
        const agreementBonus = stringSim > 0.5 && callSim > 0.5 ? 0.1 : 0;
        const finalSimilarity = Math.min(similarity + agreementBonus, 1.0);

        if (finalSimilarity < minSimilarity) {
            return null;
        }

        return {
            packageName,
            version,
            confidence:
                finalSimilarity >= 0.95
                    ? 'exact'
                    : finalSimilarity >= 0.8
                      ? 'high'
                      : finalSimilarity >= 0.7
                        ? 'medium'
                        : 'low',
            source: 'fingerprint-minified',
            similarity: finalSimilarity,
            matchedFiles: 1,
            totalFiles: 1,
        };
    }

    // Process packages sequentially (allows early exit on exact match)
    for (const packageName of packagesToTry) {
        if (foundExactMatch) {
            break;
        }

        // Get versions to check (already sorted by semver descending - latest first)
        const versions = await getAllVersions(
            packageName,
            cache,
            maxVersionsToCheck,
            includePrereleases,
        );
        if (versions.length === 0) {
            continue;
        }

        // Check versions concurrently with incremental progress reporting
        const versionResults = await runConcurrent(
            versions,
            versionConcurrency,
            async (version, _index) => {
                return checkVersion(packageName, version);
            },
            (result, index, completed, total) => {
                const version = versions[index];
                onDetailedProgress?.(packageName, version, completed, total);
                onProgress?.(packageName, version, result);

                // Track if we found an exact match (to skip remaining packages)
                if (result && result.similarity >= 0.95) {
                    foundExactMatch = true;
                }
            },
        );

        // Find best match from this package's results
        // Since versions are sorted by semver descending, on equal similarity
        // we naturally prefer the latest version (first encountered)
        for (const result of versionResults) {
            if (!result) continue;

            if (!bestMatch || result.similarity > bestMatch.similarity) {
                bestMatch = result;
            }
        }

        // If we found an exact match in this package, no need to check more packages
        if (foundExactMatch) {
            break;
        }
    }

    if (bestMatch) {
        onProgress?.(bestMatch.packageName, bestMatch.version, bestMatch);
    }

    return bestMatch;
}

/**
 * Batch fingerprint multiple vendor bundles against candidate packages.
 *
 * Processes multiple minified bundles concurrently, attempting to identify
 * which npm package each bundle originated from.
 *
 * @param vendorBundles - Array of minified bundles to identify
 * @param candidatePackages - List of potential package names to check against
 * @param options - Configuration options for the fingerprinting process
 * @returns Map of bundle filenames to their best matching version results
 *
 * @example
 * ```typescript
 * const bundles = [
 *   { content: bundle1, filename: 'vendor-a.js' },
 *   { content: bundle2, filename: 'vendor-b.js' }
 * ];
 * const results = await fingerprintVendorBundles(bundles, ['react', 'lodash'], {
 *   onBundleComplete: (i, t, f, r) => console.log(`${f}: ${r?.packageName}`)
 * });
 * ```
 */
export async function fingerprintVendorBundles(
    vendorBundles: VendorBundleInput[],
    candidatePackages: string[],
    options: {
        maxVersionsToCheck?: number;
        minSimilarity?: number;
        includePrereleases?: boolean;
        /** Number of bundles to process concurrently (default: 2) */
        concurrency?: number;
        /** Number of versions to check concurrently per bundle (default: 10) */
        versionConcurrency?: number;
        /** Called when a bundle completes processing */
        onBundleComplete?: (
            bundleIndex: number,
            bundleTotal: number,
            bundleFilename: string,
            result: (FingerprintResult & { packageName: string }) | null,
        ) => void;
        /** Called for each version being checked within a bundle */
        onDetailedProgress?: (
            bundleFilename: string,
            packageName: string,
            version: string,
            versionIndex: number,
            versionTotal: number,
        ) => void;
        /** @deprecated Use onBundleComplete and onDetailedProgress instead */
        onProgress?: (
            bundleFilename: string,
            packageName: string | null,
            result: FingerprintResult | null,
        ) => void;
    } = {},
): Promise<Map<string, FingerprintResult & { packageName: string }>> {
    const {
        maxVersionsToCheck = 0,
        minSimilarity = 0.6,
        includePrereleases = false,
        concurrency = 2,
        versionConcurrency = DEFAULT_VERSION_CHECK_CONCURRENCY,
        onProgress,
        onBundleComplete,
        onDetailedProgress,
    } = options;

    const results = new Map<
        string,
        FingerprintResult & { packageName: string }
    >();

    const bundleTotal = vendorBundles.length;
    let bundlesCompleted = 0;

    // Process in batches
    for (let i = 0; i < vendorBundles.length; i += concurrency) {
        const batch = vendorBundles.slice(i, i + concurrency);

        const batchResults = await Promise.all(
            batch.map(async (bundle) => {
                const filename = bundle.filename || 'unknown';

                // For each bundle, prioritize the inferred package if available
                const candidates = bundle.inferredPackage
                    ? [
                          bundle.inferredPackage,
                          ...candidatePackages.filter(
                              (p) => p !== bundle.inferredPackage,
                          ),
                      ]
                    : candidatePackages;

                const result = await fingerprintVendorBundle(
                    bundle,
                    candidates,
                    {
                        maxVersionsToCheck,
                        minSimilarity,
                        includePrereleases,
                        versionConcurrency,
                        onProgress: (pkg, ver, res) => {
                            onProgress?.(filename, pkg, res);
                        },
                        onDetailedProgress: (pkg, ver, verIdx, verTotal) => {
                            onDetailedProgress?.(
                                filename,
                                pkg,
                                ver,
                                verIdx,
                                verTotal,
                            );
                        },
                    },
                );

                return { filename, result };
            }),
        );

        for (const { filename, result } of batchResults) {
            bundlesCompleted++;
            onBundleComplete?.(bundlesCompleted, bundleTotal, filename, result);
            if (result) {
                results.set(filename, result);
            }
        }
    }

    return results;
}
