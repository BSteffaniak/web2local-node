/**
 * Dependency analysis and npm package detection.
 *
 * @packageDocumentation
 *
 * This module provides comprehensive dependency analysis for extracted source code.
 * It identifies npm packages used in the code, detects their versions, and generates
 * manifest files for package reconstruction.
 *
 * Key capabilities:
 * - Extract bare module imports from source files
 * - Detect package versions using multiple strategies (lockfiles, fingerprinting, peer deps)
 * - Verify packages exist on npm registry
 * - Infer missing versions from peer dependency relationships
 * - Generate dependency manifests for build tooling
 *
 * @example
 * ```typescript
 * import { analyzeDependencies, extractBareImports } from '@web2local/analyzer';
 *
 * // Get all npm packages imported in source files
 * const imports = extractBareImports(sourceFiles);
 *
 * // Full analysis with version detection
 * const result = await analyzeDependencies(sourceFiles, {
 *   useFingerprinting: true,
 *   onProgress: (msg) => console.log(msg)
 * });
 * ```
 */

import { readFile, readdir, writeFile } from 'fs/promises';
import { join, extname } from 'path';
import { runConcurrent } from '@web2local/utils';
import {
    detectVersions,
    getPackageFiles,
    type VersionResult,
    type VersionConfidence,
} from './version-detector.js';
import type {
    ExtractedSource,
    DependencyInfo,
    AnalysisResult,
} from '@web2local/types';
import {
    findMatchingVersions,
    fingerprintVendorBundles,
    fetchPackageMetadataWithExistence,
    type VendorBundleInput,
} from './source-fingerprint.js';
import { inferPeerDependencyVersions } from './peer-dependencies.js';
import {
    getCache,
    computeExtractionHash,
    computeOptionsHash,
    computeUrlHash,
    type ExtractedFile,
} from '@web2local/cache';
import {
    extractImportSourcesFromAST,
    hasJSXElements,
    detectFrameworkImports,
    detectModuleSystem,
    detectEnvironmentAPIs,
    detectESFeatures,
} from '@web2local/ast';
import { robustFetch } from '@web2local/http';

// Re-export for backwards compatibility
export type { DependencyInfo, AnalysisResult } from '@web2local/types';

/**
 * Pattern to match node_modules paths with versions in source map sources
 *
 * @example
 * ```
 * ../node_modules/react@18.2.0/index.js
 * node_modules/@tanstack/react-query@5.0.0/build/index.js
 * ../../node_modules/lodash-es/lodash.js (no version)
 * ```
 */
const NODE_MODULES_VERSION_PATTERN =
    /node_modules\/(@[^/]+\/[^@/]+|[^@/]+)(?:@(\d+\.\d+\.\d+[^/]*))?/;

/**
 * Extracts the package name from an import specifier
 *
 * @example
 * ```
 * 'lodash' -> 'lodash'
 * 'lodash/merge' -> 'lodash'
 * '@scope/pkg' -> '@scope/pkg'
 * '@scope/pkg/sub' -> '@scope/pkg'
 * ```
 */
function getPackageName(importSpecifier: string): string {
    if (importSpecifier.startsWith('@')) {
        // Scoped package: @scope/package/subpath -> @scope/package
        const parts = importSpecifier.split('/');
        return parts.slice(0, 2).join('/');
    }
    // Regular package: package/subpath -> package
    return importSpecifier.split('/')[0];
}

/**
 * Checks if an import specifier is likely a Node.js built-in module
 */
function isBuiltinModule(name: string): boolean {
    const builtins = new Set([
        'assert',
        'buffer',
        'child_process',
        'cluster',
        'console',
        'constants',
        'crypto',
        'dgram',
        'dns',
        'domain',
        'events',
        'fs',
        'http',
        'https',
        'module',
        'net',
        'os',
        'path',
        'perf_hooks',
        'process',
        'punycode',
        'querystring',
        'readline',
        'repl',
        'stream',
        'string_decoder',
        'sys',
        'timers',
        'tls',
        'tty',
        'url',
        'util',
        'v8',
        'vm',
        'wasi',
        'worker_threads',
        'zlib',
        // Node.js prefixed versions
        'node:assert',
        'node:buffer',
        'node:child_process',
        'node:cluster',
        'node:console',
        'node:constants',
        'node:crypto',
        'node:dgram',
        'node:dns',
        'node:domain',
        'node:events',
        'node:fs',
        'node:http',
        'node:https',
        'node:module',
        'node:net',
        'node:os',
        'node:path',
        'node:perf_hooks',
        'node:process',
        'node:punycode',
        'node:querystring',
        'node:readline',
        'node:repl',
        'node:stream',
        'node:string_decoder',
        'node:sys',
        'node:timers',
        'node:tls',
        'node:tty',
        'node:url',
        'node:util',
        'node:v8',
        'node:vm',
        'node:wasi',
        'node:worker_threads',
        'node:zlib',
    ]);
    return builtins.has(name) || builtins.has(name.split('/')[0]);
}

/**
 * Extracts all external package imports from a source file using AST parsing.
 * This properly handles imports/exports and ignores code inside strings/comments.
 */
function extractImportsFromSource(
    content: string,
    filePath: string,
): Set<string> {
    const imports = new Set<string>();

    // Use AST-based extraction for robust parsing
    const importSources = extractImportSourcesFromAST(content, filePath);

    for (const importSpecifier of importSources) {
        // Skip relative imports (start with . or /)
        if (
            importSpecifier.startsWith('.') ||
            importSpecifier.startsWith('/')
        ) {
            continue;
        }

        const packageName = getPackageName(importSpecifier);

        // Skip built-in modules
        if (isBuiltinModule(packageName)) {
            continue;
        }

        imports.add(packageName);
    }

    return imports;
}

/**
 * Extracts all bare (non-relative) imports from source files.
 * Returns a Set of package names that are imported as bare modules.
 *
 * This is useful for determining which directory names actually need aliases.
 * If a package name is never imported as a bare module, it doesn't need an alias.
 *
 * @param sourceFiles - Source files to analyze
 * @returns Set of package names that are imported as bare modules
 */
export function extractBareImports(
    sourceFiles: ExtractedSource[],
): Set<string> {
    const allImports = new Set<string>();

    for (const file of sourceFiles) {
        // Skip files in node_modules
        if (file.path.includes('node_modules/')) continue;
        if (!file.content) continue;

        const imports = extractImportsFromSource(file.content, file.path);
        for (const imp of imports) {
            allImports.add(imp);
        }
    }

    return allImports;
}

/**
 * Extracts all bare (non-relative) import specifiers with their full paths (including subpaths).
 * Unlike extractBareImports which only returns package names, this returns the full specifier.
 *
 * @example
 * ```
 * 'lodash/merge' is returned as 'lodash/merge' (not just 'lodash')
 * '@scope/pkg/sub' is returned as '@scope/pkg/sub' (not just '@scope/pkg')
 * ```
 *
 * @param sourceFiles - Source files to analyze
 * @returns Set of full import specifiers
 */
export function extractFullImportSpecifiers(
    sourceFiles: ExtractedSource[],
): Set<string> {
    const allImports = new Set<string>();

    for (const file of sourceFiles) {
        // Skip files in node_modules
        if (file.path.includes('node_modules/')) continue;
        if (!file.content) continue;

        // Use AST-based extraction for robust parsing
        const importSources = extractImportSourcesFromAST(
            file.content,
            file.path,
        );

        for (const importSpecifier of importSources) {
            // Skip relative imports (start with . or /)
            if (
                importSpecifier.startsWith('.') ||
                importSpecifier.startsWith('/')
            ) {
                continue;
            }

            const packageName = getPackageName(importSpecifier);

            // Skip built-in modules
            if (isBuiltinModule(packageName)) {
                continue;
            }

            allImports.add(importSpecifier);
        }
    }

    return allImports;
}

/**
 * Resolves path segments, handling `../` and `./` properly.
 *
 * This function needs to match the behavior of the reconstruction sanitizePath,
 * which processes the path AFTER the bundleName prefix. So for a path like
 * `assets/../../app-jotai.ts`, the bundleName is `assets` and the original
 * source map path was `../../app-jotai.ts`. After sanitization, the original
 * path becomes `app-jotai.ts`, and it's written to `assets/app-jotai.ts`.
 *
 * We need to replicate this: take the first segment as bundleName, sanitize
 * the rest, then rejoin.
 *
 * @example
 * ```
 * 'assets/../../app-jotai.ts' -> 'assets/app-jotai.ts'
 * 'assets/foo/../bar.ts' -> 'assets/bar.ts'
 * 'bundle/node_modules/pkg/index.ts' -> 'bundle/node_modules/pkg/index.ts'
 * ```
 */
function resolvePathSegments(inputPath: string): string {
    const segments = inputPath.split('/');

    if (segments.length === 0) {
        return '.';
    }

    // First segment is the bundleName
    const bundleName = segments[0];
    const restSegments = segments.slice(1);

    // Sanitize the rest (matching reconstruction's sanitizePath behavior)
    const resolved: string[] = [];
    for (const segment of restSegments) {
        if (segment === '..') {
            if (resolved.length > 0) {
                resolved.pop();
            }
            // Can't go above root, skip
        } else if (segment !== '.' && segment !== '') {
            resolved.push(segment);
        }
    }

    // Rejoin with bundleName
    if (resolved.length === 0) {
        return bundleName;
    }
    return bundleName + '/' + resolved.join('/');
}

/**
 * Inferred alias mapping from import/file path analysis
 */
export interface InferredAlias {
    /** The alias name (e.g., 'excalidraw-app') */
    alias: string;
    /** The target directory path (e.g., './assets') */
    targetPath: string;
    /** Import specifiers that led to this inference */
    evidence: string[];
    /** Confidence: 'high' if all subpaths resolve to same dir, 'medium' if majority */
    confidence: 'high' | 'medium' | 'low';
}

/**
 * Infers alias mappings by matching import specifiers to actual file locations.
 *
 * Algorithm:
 * 1. Extract all bare import specifiers with subpaths (e.g., 'excalidraw-app/app-jotai')
 * 2. For each unique alias name, collect all subpaths imported from it
 * 3. For each subpath, find files in extracted sources that match
 * 4. Find the directory that satisfies all (or most) subpaths
 * 5. That directory is the alias target
 *
 * @param sourceFiles - Extracted source files with their paths and content
 * @param existingAliases - Set of alias names that are already resolved (to skip)
 * @returns Array of inferred alias mappings
 */
export function inferAliasesFromImports(
    sourceFiles: ExtractedSource[],
    existingAliases: Set<string> = new Set(),
): InferredAlias[] {
    const result: InferredAlias[] = [];

    // Step 1: Extract all full import specifiers
    const fullImports = extractFullImportSpecifiers(sourceFiles);

    // Step 2: Group imports by alias name (first segment for non-scoped, first two for scoped)
    // Only consider imports with subpaths
    const aliasImports = new Map<string, Set<string>>(); // alias -> set of full specifiers

    for (const specifier of fullImports) {
        const packageName = getPackageName(specifier);

        // Skip if already resolved
        if (existingAliases.has(packageName)) continue;

        // Only consider imports with subpaths
        if (specifier === packageName) continue;

        // Extract the subpath (part after package name)
        const subpath = specifier.slice(packageName.length + 1); // +1 for the '/'
        if (!subpath) continue;

        if (!aliasImports.has(packageName)) {
            aliasImports.set(packageName, new Set());
        }
        aliasImports.get(packageName)!.add(specifier);
    }

    // Step 3: Build a map of filename -> list of directories containing it
    // Also handle nested paths like 'data/types' -> look for files at */data/types.{ts,tsx,...}
    const fileLocationMap = new Map<string, string[]>(); // subpath -> [dir1, dir2, ...]

    for (const file of sourceFiles) {
        // Skip node_modules
        if (file.path.includes('node_modules/')) continue;

        // Normalize path - resolve any ../ segments
        // Source map paths can have ../ segments like 'assets/../../app-jotai.ts'
        // which should resolve to 'app-jotai.ts' (going up from 'assets' twice)
        const normalizedPath = resolvePathSegments(file.path);

        // Get the path without extension
        const pathWithoutExt = normalizedPath.replace(
            /\.(tsx?|jsx?|mjs|cjs)$/,
            '',
        );

        // For a file at 'assets/data/types.ts', we want to map:
        // - 'types' -> 'assets/data'
        // - 'data/types' -> 'assets'
        // - 'assets/data/types' -> '.'
        const parts = pathWithoutExt.split('/');

        for (let i = parts.length - 1; i >= 0; i--) {
            const subpath = parts.slice(i).join('/');
            const directory = parts.slice(0, i).join('/') || '.';

            if (!fileLocationMap.has(subpath)) {
                fileLocationMap.set(subpath, []);
            }

            const dirs = fileLocationMap.get(subpath)!;
            if (!dirs.includes(directory)) {
                dirs.push(directory);
            }
        }

        // Also handle index files: 'assets/data/index.ts' should match 'data'
        const basename = parts[parts.length - 1];
        if (basename === 'index') {
            const dirParts = parts.slice(0, -1);
            if (dirParts.length > 0) {
                const subpath = dirParts[dirParts.length - 1];
                const directory = dirParts.slice(0, -1).join('/') || '.';

                if (!fileLocationMap.has(subpath)) {
                    fileLocationMap.set(subpath, []);
                }
                const dirs = fileLocationMap.get(subpath)!;
                if (!dirs.includes(directory)) {
                    dirs.push(directory);
                }
            }
        }
    }

    // Step 4: For each alias, find the directory that satisfies all subpaths
    for (const [aliasName, specifiers] of aliasImports) {
        // Collect all subpaths for this alias
        const subpaths: string[] = [];
        for (const specifier of specifiers) {
            const subpath = specifier.slice(aliasName.length + 1);
            subpaths.push(subpath);
        }

        // For each subpath, find candidate directories
        const subpathCandidates = new Map<string, string[]>(); // subpath -> candidate dirs

        for (const subpath of subpaths) {
            const candidates = fileLocationMap.get(subpath) || [];
            subpathCandidates.set(subpath, candidates);
        }

        // Find directories that satisfy the most subpaths
        const directoryCounts = new Map<string, number>();
        const directoryEvidence = new Map<string, string[]>();

        for (const [subpath, candidates] of subpathCandidates) {
            for (const dir of candidates) {
                directoryCounts.set(dir, (directoryCounts.get(dir) || 0) + 1);

                if (!directoryEvidence.has(dir)) {
                    directoryEvidence.set(dir, []);
                }
                directoryEvidence.get(dir)!.push(`${aliasName}/${subpath}`);
            }
        }

        if (directoryCounts.size === 0) {
            // No candidates found for any subpath
            continue;
        }

        // Sort directories by count (descending), then by path length (ascending, prefer shorter)
        const sortedDirs = Array.from(directoryCounts.entries()).sort(
            (a, b) => {
                // First by count (more matches = better)
                if (b[1] !== a[1]) return b[1] - a[1];
                // Then by path length (shorter = better)
                return a[0].length - b[0].length;
            },
        );

        const bestDir = sortedDirs[0][0];
        const bestCount = sortedDirs[0][1];
        const totalSubpaths = subpaths.length;

        // Determine confidence
        let confidence: 'high' | 'medium' | 'low';
        if (bestCount === totalSubpaths) {
            confidence = 'high';
        } else if (bestCount >= totalSubpaths * 0.5) {
            confidence = 'medium';
        } else {
            confidence = 'low';
        }

        // Format the path
        const targetPath = bestDir === '.' ? '.' : `./${bestDir}`;

        result.push({
            alias: aliasName,
            targetPath,
            evidence: directoryEvidence.get(bestDir) || [],
            confidence,
        });
    }

    return result;
}

/**
 * Recursively walks a directory and yields file paths
 */
async function* walkDirectory(dir: string): AsyncGenerator<string> {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            // Skip node_modules directories
            if (entry.name === 'node_modules') {
                continue;
            }
            yield* walkDirectory(fullPath);
        } else if (entry.isFile()) {
            yield fullPath;
        }
    }
}

/**
 * Checks if a file should be analyzed for imports
 */
function shouldAnalyzeFile(filePath: string): boolean {
    const ext = extname(filePath).toLowerCase();
    return ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext);
}

/**
 * Extracts version information from source map paths in the manifest
 */
export function extractVersionsFromManifest(
    manifestBundles: Array<{ files: string[] }>,
): Map<string, string> {
    const versions = new Map<string, string>();

    for (const bundle of manifestBundles) {
        for (const filePath of bundle.files) {
            const match = filePath.match(NODE_MODULES_VERSION_PATTERN);
            if (match) {
                const packageName = match[1];
                const version = match[2];
                if (version && !versions.has(packageName)) {
                    versions.set(packageName, version);
                }
            }
        }
    }

    return versions;
}

/**
 * Analyzes all source files in a directory and extracts dependencies.
 * NOTE: This skips node_modules directories. For complete analysis including
 * internal packages, use analyzeDependenciesFromSourceFiles instead.
 */
export async function analyzeDependencies(
    sourceDir: string,
    onProgress?: (file: string) => void,
): Promise<AnalysisResult> {
    const result: AnalysisResult = {
        dependencies: new Map(),
        localImports: new Set(),
        errors: [],
    };

    try {
        for await (const filePath of walkDirectory(sourceDir)) {
            if (!shouldAnalyzeFile(filePath)) {
                continue;
            }

            onProgress?.(filePath);

            try {
                const content = await readFile(filePath, 'utf-8');
                const imports = extractImportsFromSource(content, filePath);

                for (const packageName of imports) {
                    if (result.dependencies.has(packageName)) {
                        result.dependencies
                            .get(packageName)!
                            .importedFrom.push(filePath);
                    } else {
                        result.dependencies.set(packageName, {
                            name: packageName,
                            version: null,
                            importedFrom: [filePath],
                        });
                    }
                }
            } catch (error) {
                result.errors.push(`Failed to analyze ${filePath}: ${error}`);
            }
        }
    } catch (error) {
        result.errors.push(`Failed to walk directory ${sourceDir}: ${error}`);
    }

    return result;
}

/**
 * Analyzes dependencies directly from source files (including those in node_modules).
 * This is the preferred method when we have extracted source files, as it includes
 * internal packages that were extracted from source maps.
 *
 * Unlike analyzeDependencies which skips node_modules, this function analyzes ALL
 * provided source files, which properly detects dependencies of internal packages
 * like `@fp/sarsaparilla` that import react-stately, react-modal, etc.
 */
export function analyzeDependenciesFromSourceFiles(
    sourceFiles: ExtractedSource[],
    onProgress?: (file: string) => void,
): AnalysisResult {
    const result: AnalysisResult = {
        dependencies: new Map(),
        localImports: new Set(),
        errors: [],
    };

    for (const file of sourceFiles) {
        // Check if file extension is analyzable
        const ext = extname(file.path).toLowerCase();
        if (!['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext)) {
            continue;
        }

        // Skip files without content
        if (!file.content) {
            continue;
        }

        onProgress?.(file.path);

        try {
            const imports = extractImportsFromSource(file.content, file.path);

            for (const packageName of imports) {
                if (result.dependencies.has(packageName)) {
                    result.dependencies
                        .get(packageName)!
                        .importedFrom.push(file.path);
                } else {
                    result.dependencies.set(packageName, {
                        name: packageName,
                        version: null,
                        importedFrom: [file.path],
                    });
                }
            }
        } catch (error) {
            result.errors.push(`Failed to analyze ${file.path}: ${error}`);
        }
    }

    return result;
}

/**
 * Merges version information into dependency analysis results
 */
export function mergeVersionInfo(
    dependencies: Map<string, DependencyInfo>,
    versions: Map<string, string>,
): void {
    for (const [packageName, info] of dependencies) {
        if (versions.has(packageName)) {
            info.version = versions.get(packageName)!;
        }
    }
}

/**
 * Pattern to match package.json files in node_modules
 *
 * @example
 * ```
 * node_modules/react/package.json
 * node_modules/@reduxjs/toolkit/package.json
 * ```
 */
const NODE_MODULES_PACKAGE_JSON_PATTERN =
    /node_modules\/(@[^/]+\/[^/]+|[^/]+)\/package\.json$/;

/**
 * Extracts package versions from package.json files found in source map
 * This gives us the actual versions used in the bundle
 */
export function extractVersionsFromSourceFiles(
    files: Array<{ path: string; content: string }>,
): Map<string, string> {
    const versions = new Map<string, string>();

    for (const file of files) {
        const match = file.path.match(NODE_MODULES_PACKAGE_JSON_PATTERN);
        if (!match) {
            continue;
        }

        try {
            const pkg = JSON.parse(file.content);
            if (pkg.name && pkg.version) {
                // Use the name from package.json as it's authoritative
                versions.set(pkg.name, pkg.version);
            }
        } catch {
            // Ignore parse errors
        }
    }

    return versions;
}

/**
 * Also try to extract versions from license headers/banners in source files
 * Many libraries include version info like:
 *
 * @example
 * ```text
 * /** \@license React v18.2.0 * /
 * /*! lodash v4.17.21 * /
 * ```
 */
export function extractVersionsFromBanners(
    files: Array<{ path: string; content: string }>,
): Map<string, string> {
    const versions = new Map<string, string>();

    // Patterns for common version banners
    const bannerPatterns = [
        // @license Package vX.X.X or @license Package X.X.X
        /@license\s+(\S+)\s+v?(\d+\.\d+\.\d+(?:-[\w.]+)?)/gi,
        // /*! package vX.X.X */ or /*! package X.X.X */
        /\/\*!\s*(\S+)\s+v?(\d+\.\d+\.\d+(?:-[\w.]+)?)/gi,
        // * Package vX.X.X (in JSDoc style comments)
        /\*\s+(\w+(?:-\w+)*)\s+v(\d+\.\d+\.\d+(?:-[\w.]+)?)/gi,
    ];

    for (const file of files) {
        // Only check the first 1000 chars where banners usually are
        const header = file.content.slice(0, 1000);

        for (const pattern of bannerPatterns) {
            pattern.lastIndex = 0;
            let match;
            while ((match = pattern.exec(header)) !== null) {
                const name = match[1].toLowerCase();
                const version = match[2];

                // Skip if we already have this package (package.json is more authoritative)
                if (!versions.has(name)) {
                    versions.set(name, version);
                }
            }
        }
    }

    return versions;
}

/**
 * Tries to match banner-extracted package names to actual dependency names
 * Handles cases like: `fingerprintjs` to `\@fingerprintjs/fingerprintjs`
 */
export function matchBannerVersionsToDependencies(
    dependencies: Map<string, DependencyInfo>,
    bannerVersions: Map<string, string>,
): void {
    for (const [bannerName, version] of bannerVersions) {
        // Direct match
        if (dependencies.has(bannerName)) {
            const dep = dependencies.get(bannerName)!;
            if (!dep.version) {
                dep.version = version;
            }
            continue;
        }

        // Try to find a scoped package that ends with this name
        // e.g., "fingerprintjs" matches "@fingerprintjs/fingerprintjs"
        for (const [depName, depInfo] of dependencies) {
            if (depInfo.version) continue; // Already has version

            // Check if it's a scoped package where the package name matches
            if (depName.startsWith('@')) {
                const scopedParts = depName.split('/');
                if (scopedParts.length === 2) {
                    const pkgName = scopedParts[1].toLowerCase();
                    if (
                        pkgName === bannerName ||
                        pkgName.includes(bannerName)
                    ) {
                        depInfo.version = version;
                        break;
                    }
                }
            }

            // Also check for partial matches (e.g., "react-dom" banner for "react-dom" dep)
            if (depName.toLowerCase() === bannerName) {
                depInfo.version = version;
                break;
            }
        }
    }
}

/**
 * Fetches the latest version of a package from npm registry
 */
async function fetchNpmVersion(packageName: string): Promise<string | null> {
    try {
        const response = await robustFetch(
            `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
            {
                headers: { Accept: 'application/json' },
            },
        );
        if (!response.ok) {
            return null;
        }
        const data = await response.json();
        return data.version || null;
    } catch {
        return null;
    }
}

/**
 * Fetches versions for multiple packages from npm registry
 */
export async function fetchNpmVersions(
    packageNames: string[],
    concurrency: number = 10,
    onProgress?: (
        completed: number,
        total: number,
        packageName: string,
    ) => void,
): Promise<Map<string, string>> {
    const versions = new Map<string, string>();

    const results = await runConcurrent(
        packageNames,
        concurrency,
        async (name) => {
            const version = await fetchNpmVersion(name);
            return { name, version };
        },
        (result, _index, completed, total) => {
            onProgress?.(completed, total, result.name);
        },
    );

    for (const { name, version } of results) {
        if (version) {
            versions.set(name, version);
        }
    }

    return versions;
}

/**
 * Checks if a package exists on npm registry (cached)
 * Returns true if public (exists on npm), false if internal/private (not on npm)
 *
 * This function uses the unified metadata fetch which also pre-warms the
 * metadata cache for later fingerprinting operations.
 */
export async function isPublicNpmPackage(
    packageName: string,
): Promise<boolean> {
    const cache = getCache();

    // Check metadata cache first - if we have metadata, package exists
    const cachedMetadata = await cache.getMetadata(packageName);
    if (cachedMetadata) {
        return true;
    }

    // Check existence cache
    const cachedExistence = await cache.getNpmPackageExistence(packageName);
    if (cachedExistence) {
        return cachedExistence.exists;
    }

    // Use unified fetch which caches both metadata and existence
    // This pre-warms the metadata cache for later fingerprinting
    const result = await fetchPackageMetadataWithExistence(packageName, cache);
    return result.exists;
}

/**
 * Validates if a specific version of a package exists on npm registry (cached)
 * Returns true if version exists, false if not found
 */
export async function validateNpmVersion(
    packageName: string,
    version: string,
): Promise<boolean> {
    const cache = getCache();

    // Check cache first
    const cached = await cache.getNpmVersionValidation(packageName, version);
    if (cached) {
        return cached.valid;
    }

    // Fetch from npm registry - check if this specific version exists
    try {
        const response = await robustFetch(
            `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`,
            {
                method: 'HEAD',
            },
        );
        const valid = response.ok;

        // Cache the result
        await cache.setNpmVersionValidation({
            packageName,
            version,
            valid,
            fetchedAt: Date.now(),
        });

        return valid;
    } catch {
        // Network error - don't cache, assume valid to be safe
        return true;
    }
}

/**
 * Validates versions for multiple packages in batches
 * Returns a map of `package@version` to isValid
 * Also returns replacement versions for invalid ones (fetched from npm latest)
 */
export async function validateNpmVersionsBatch(
    packages: Array<{ name: string; version: string }>,
    concurrency: number = 10,
    onProgress?: (
        completed: number,
        total: number,
        packageName: string,
        version: string,
        valid: boolean,
    ) => void,
): Promise<{
    validations: Map<string, boolean>;
    replacements: Map<string, string>;
}> {
    const validations = new Map<string, boolean>();
    const invalidPackages: string[] = [];

    const results = await runConcurrent(
        packages,
        concurrency,
        async ({ name, version }) => {
            const valid = await validateNpmVersion(name, version);
            return { name, version, valid };
        },
        (result, _index, completed, total) => {
            onProgress?.(
                completed,
                total,
                result.name,
                result.version,
                result.valid,
            );
        },
    );

    for (const { name, version, valid } of results) {
        const key = `${name}@${version}`;
        validations.set(key, valid);
        if (!valid) {
            invalidPackages.push(name);
        }
    }

    // Fetch latest versions for invalid packages
    const replacements = new Map<string, string>();
    if (invalidPackages.length > 0) {
        const latestVersions = await fetchNpmVersions(
            invalidPackages,
            concurrency,
        );
        for (const [name, latestVersion] of latestVersions) {
            replacements.set(name, latestVersion);
        }
    }

    return { validations, replacements };
}

/**
 * Extracts unique package names from node_modules paths in source files
 */
export function extractNodeModulesPackages(
    files: Array<{ path: string }>,
): string[] {
    const packages = new Set<string>();

    for (const file of files) {
        // Match node_modules/@scope/pkg or node_modules/pkg
        const match = file.path.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)/);
        if (match) {
            packages.add(match[1]);
        }
    }

    return Array.from(packages);
}

/**
 * Identifies which packages from node_modules are internal (not on npm)
 * Checks npm registry in parallel with concurrency limit
 */
export async function identifyInternalPackages(
    packageNames: string[],
    onProgress?: (
        checked: number,
        total: number,
        packageName: string,
        isInternal: boolean,
    ) => void,
): Promise<Set<string>> {
    const internalPackages = new Set<string>();
    const concurrency = 10;

    await runConcurrent(
        packageNames,
        concurrency,
        async (pkg) => {
            const isPublic = await isPublicNpmPackage(pkg);
            return { pkg, isPublic };
        },
        (result, _index, completed, total) => {
            if (!result.isPublic) {
                internalPackages.add(result.pkg);
            }
            onProgress?.(completed, total, result.pkg, !result.isPublic);
        },
    );

    return internalPackages;
}

/**
 * Result of classifying dependencies as internal or external
 */
export interface DependencyClassification {
    /** Packages confirmed to be external (on npm) */
    external: Set<string>;
    /** Packages confirmed to be internal (workspace or private registry) */
    internal: Set<string>;
    /** Classification details for debugging */
    details: Map<
        string,
        {
            reason:
                | 'workspace'
                | 'private-registry'
                | 'npm'
                | 'unknown-internal'
                | 'unknown-external';
            sourceLocation?:
                | 'outside-node-modules'
                | 'in-node-modules'
                | 'no-source';
        }
    >;
}

/**
 * Detects workspace package roots from source file paths.
 *
 * A package root is identified by looking for structural indicators:
 * - `{package}/package.json`
 * - `{package}/src/index.{ts,tsx,js,jsx}`
 * - `{package}/index.{ts,tsx,js,jsx}`
 * - `{package}/src/...` (directory containing source files)
 *
 * Returns a map of package name to package root path
 */
function detectWorkspacePackageRoots(
    sourceFiles: ExtractedSource[],
): Map<string, string> {
    const packageRoots = new Map<string, string>();

    // Patterns that indicate a package root (the directory directly containing these)
    // We look for paths like:
    //   - something/site-kit/package.json -> "site-kit" is a package
    //   - something/site-kit/src/index.ts -> "site-kit" is a package
    //   - something/site-kit/index.ts -> "site-kit" is a package

    for (const file of sourceFiles) {
        // Skip node_modules - we handle those separately
        if (file.path.includes('node_modules/')) {
            continue;
        }

        const pathParts = file.path.split('/');

        // Look for package.json files
        if (
            file.path.endsWith('/package.json') ||
            file.path === 'package.json'
        ) {
            // The package root is the directory containing package.json
            const packageDir = pathParts.slice(0, -1).join('/');
            const packageName = pathParts[pathParts.length - 2];
            if (packageName && !packageRoots.has(packageName)) {
                packageRoots.set(packageName, packageDir);
            }
            continue;
        }

        // Look for src/index.* pattern: something/package-name/src/index.ts
        const srcIndexMatch = file.path.match(
            /^(.+)\/([^/]+)\/src\/index\.[tj]sx?$/,
        );
        if (srcIndexMatch) {
            const packageName = srcIndexMatch[2];
            const packageDir = `${srcIndexMatch[1]}/${packageName}`;
            if (!packageRoots.has(packageName)) {
                packageRoots.set(packageName, packageDir);
            }
            continue;
        }

        // Look for direct index.* pattern: something/package-name/index.ts
        const directIndexMatch = file.path.match(
            /^(.+)\/([^/]+)\/index\.[tj]sx?$/,
        );
        if (directIndexMatch) {
            const packageName = directIndexMatch[2];
            const packageDir = `${directIndexMatch[1]}/${packageName}`;
            if (!packageRoots.has(packageName)) {
                packageRoots.set(packageName, packageDir);
            }
            continue;
        }
    }

    // Second pass: look for directories with /src/ that might be packages
    // but didn't have an explicit index file (e.g., package-name/src/components/...)
    const potentialPackages = new Map<string, Set<string>>();

    for (const file of sourceFiles) {
        if (file.path.includes('node_modules/')) {
            continue;
        }

        // Match pattern: .../package-name/src/...
        const srcMatch = file.path.match(/^(.*)\/([^/]+)\/src\/.+$/);
        if (srcMatch) {
            const packageName = srcMatch[2];
            // Don't override if we already have a stronger signal
            if (!packageRoots.has(packageName)) {
                if (!potentialPackages.has(packageName)) {
                    potentialPackages.set(packageName, new Set());
                }
                potentialPackages
                    .get(packageName)!
                    .add(`${srcMatch[1]}/${packageName}`);
            }
        }
    }

    // Add potential packages that have consistent paths (all files under same root)
    for (const [packageName, paths] of potentialPackages) {
        if (paths.size === 1 && !packageRoots.has(packageName)) {
            packageRoots.set(packageName, Array.from(paths)[0]);
        }
    }

    // Third pass: look for packages with subdirectory index files
    // e.g., shared-ui/auth/index.ts -> "shared-ui" is a package
    // This catches packages without src/ that have index files in subdirectories
    for (const file of sourceFiles) {
        if (file.path.includes('node_modules/')) {
            continue;
        }

        // Match pattern: .../package-name/subdir/index.{ts,tsx,js,jsx}
        // But NOT: .../package-name/src/subdir/index.ts (already handled)
        const subdirIndexMatch = file.path.match(
            /^(.+)\/([^/]+)\/([^/]+)\/index\.[tj]sx?$/,
        );
        if (subdirIndexMatch) {
            const parentPath = subdirIndexMatch[1];
            const packageName = subdirIndexMatch[2];
            const subdir = subdirIndexMatch[3];

            // Skip if subdir is 'src' (handled above) or if already detected
            if (subdir === 'src' || packageRoots.has(packageName)) {
                continue;
            }

            // This is a potential package with structure like shared-ui/auth/index.ts
            const packageDir = `${parentPath}/${packageName}`;
            if (!potentialPackages.has(packageName)) {
                potentialPackages.set(packageName, new Set());
            }
            potentialPackages.get(packageName)!.add(packageDir);
        }
    }

    // Re-check potential packages after third pass
    for (const [packageName, paths] of potentialPackages) {
        if (paths.size === 1 && !packageRoots.has(packageName)) {
            packageRoots.set(packageName, Array.from(paths)[0]);
        }
    }

    // Fourth pass: detect parent packages of detected workspace packages
    // e.g., if we detected "r1s" at "navigation/site-kit/r1s", then
    // "site-kit" at "navigation/site-kit" is likely also a package
    const detectedRoots = Array.from(packageRoots.entries());
    for (const [, packagePath] of detectedRoots) {
        // Get the parent directory
        const pathParts = packagePath.split('/');
        if (pathParts.length >= 2) {
            const parentName = pathParts[pathParts.length - 2];
            const parentPath = pathParts.slice(0, -1).join('/');

            // Skip if parent is a common non-package name
            if (
                ['src', 'lib', 'dist', 'build', 'node_modules'].includes(
                    parentName,
                )
            ) {
                continue;
            }

            // Skip if already detected
            if (packageRoots.has(parentName)) {
                continue;
            }

            // Check if the parent path has multiple detected children (more likely to be a package)
            // or if the parent looks like a package name (not a generic dir like "packages")
            const siblingPackages = detectedRoots.filter(([, path]) => {
                const parts = path.split('/');
                return (
                    parts.length >= 2 &&
                    parts.slice(0, -1).join('/') === parentPath
                );
            });

            // If there's at least one sibling, or the name looks like a package name
            // (contains hyphen or is a known pattern like "site-kit")
            if (
                siblingPackages.length >= 1 ||
                parentName.includes('-') ||
                /^[a-z]+-[a-z]+$/i.test(parentName)
            ) {
                packageRoots.set(parentName, parentPath);
            }
        }
    }

    return packageRoots;
}

/**
 * Classifies dependencies as internal (workspace/private) or external (npm).
 *
 * Classification logic:
 * 1. Package detected as workspace package root → Internal (workspace package)
 * 2. Package has files in node_modules:
 *    - npm 404 → Internal (private registry)
 *    - npm 200 → External (public npm)
 * 3. No source files found:
 *    - npm 404 → Internal
 *    - npm 200 → External (probably tree-shaken)
 */
export async function classifyDependencies(
    importedPackages: string[],
    sourceFiles: ExtractedSource[],
    onProgress?: (
        checked: number,
        total: number,
        packageName: string,
        classification: string,
    ) => void,
): Promise<DependencyClassification> {
    const result: DependencyClassification = {
        external: new Set(),
        internal: new Set(),
        details: new Map(),
    };

    // Step 1: Detect workspace package roots (packages outside node_modules)
    const workspacePackageRoots = detectWorkspacePackageRoots(sourceFiles);

    // Step 2: Find all packages in node_modules paths
    const packagesInNodeModules = new Set<string>();
    for (const file of sourceFiles) {
        const nodeModulesMatch = file.path.match(
            /node_modules\/(@[^/]+\/[^/]+|[^/]+)/,
        );
        if (nodeModulesMatch) {
            packagesInNodeModules.add(nodeModulesMatch[1]);
        }
    }

    // Step 3: Check which imported packages match detected workspace roots
    const packagesOutsideNodeModules = new Set<string>();
    for (const pkg of importedPackages) {
        if (workspacePackageRoots.has(pkg)) {
            packagesOutsideNodeModules.add(pkg);
        }
    }

    // Step 2: Classify each package
    const packagesNeedingNpmCheck: string[] = [];

    for (const pkg of importedPackages) {
        if (packagesOutsideNodeModules.has(pkg)) {
            // Source files outside node_modules → Internal (workspace)
            result.internal.add(pkg);
            result.details.set(pkg, {
                reason: 'workspace',
                sourceLocation: 'outside-node-modules',
            });
        } else if (packagesInNodeModules.has(pkg)) {
            // Source files in node_modules → Need npm check
            packagesNeedingNpmCheck.push(pkg);
        } else {
            // No source files found → Need npm check
            packagesNeedingNpmCheck.push(pkg);
        }
    }

    // Step 3: Check npm registry for packages that need it
    const concurrency = 10;
    const totalToCheck = packagesNeedingNpmCheck.length;

    await runConcurrent(
        packagesNeedingNpmCheck,
        concurrency,
        async (pkg) => {
            const isPublic = await isPublicNpmPackage(pkg);
            return { pkg, isPublic };
        },
        (checkResult, _index, completed, _total) => {
            const { pkg, isPublic } = checkResult;
            const inNodeModules = packagesInNodeModules.has(pkg);
            const sourceLocation = inNodeModules
                ? 'in-node-modules'
                : 'no-source';

            if (isPublic) {
                result.external.add(pkg);
                result.details.set(pkg, {
                    reason: 'npm',
                    sourceLocation: sourceLocation as
                        | 'in-node-modules'
                        | 'no-source',
                });
                onProgress?.(completed, totalToCheck, pkg, 'external');
            } else {
                result.internal.add(pkg);
                result.details.set(pkg, {
                    reason: inNodeModules
                        ? 'private-registry'
                        : 'unknown-internal',
                    sourceLocation: sourceLocation as
                        | 'in-node-modules'
                        | 'no-source',
                });
                onProgress?.(completed, totalToCheck, pkg, 'internal');
            }
        },
    );

    // Also report workspace packages that were already classified
    const workspaceCount = packagesOutsideNodeModules.size;
    if (workspaceCount > 0 && onProgress) {
        // Report these as already done
        for (const pkg of packagesOutsideNodeModules) {
            onProgress(totalToCheck, totalToCheck, pkg, 'workspace');
        }
    }

    return result;
}

/**
 * Represents a mapping from import aliases to actual package names
 * e.g., `sarsaparilla` to `\@fp/sarsaparilla`
 */
export interface AliasMap {
    /** Map from alias to actual package name */
    aliases: Map<string, string>;
    /** Evidence for each alias mapping (for debugging) */
    evidence: Map<string, { importingFile: string; resolvedPath: string }[]>;
}

/**
 * Detects import aliases by correlating import statements with resolved source map paths.
 *
 * When a source file imports from `sarsaparilla` but the source map shows the file
 * resolved to `node_modules/@fp/sarsaparilla/...`, we've discovered an alias.
 *
 * @param sourceFiles - All extracted source files with their paths and content
 * @returns Map of aliases to their actual package names
 */
export function detectImportAliases(sourceFiles: ExtractedSource[]): AliasMap {
    const aliasMap: AliasMap = { aliases: new Map(), evidence: new Map() };

    // Step 1: Build a map of all packages found in node_modules paths
    // e.g., '@fp/sarsaparilla' from 'node_modules/@fp/sarsaparilla/src/...'
    const nodeModulesPackages = new Map<string, Set<string>>(); // package -> set of file paths

    for (const file of sourceFiles) {
        const pkgMatch = file.path.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)/);
        if (pkgMatch) {
            const pkg = pkgMatch[1];
            if (!nodeModulesPackages.has(pkg)) {
                nodeModulesPackages.set(pkg, new Set());
            }
            nodeModulesPackages.get(pkg)!.add(file.path);
        }
    }

    // Step 2: For each source file NOT in node_modules, extract imports
    // and check if those imports map to different package names in node_modules
    for (const file of sourceFiles) {
        if (file.path.includes('node_modules/')) continue;
        if (!file.content) continue;

        const imports = extractImportsFromSource(file.content, file.path);

        for (const importedPkg of imports) {
            // If this import matches a node_modules package exactly, no alias needed
            if (nodeModulesPackages.has(importedPkg)) continue;

            // Already found this alias
            if (aliasMap.aliases.has(importedPkg)) continue;

            // Check if any node_modules package could be the alias target
            // Strategy: Look for scoped packages where the unscoped name matches the import
            for (const [actualPkg] of nodeModulesPackages) {
                // Only consider scoped packages as potential alias targets
                if (!actualPkg.startsWith('@')) continue;

                // Extract unscoped name: @scope/name -> name
                const unscopedName = actualPkg.split('/')[1];

                // Match if the alias equals the unscoped package name
                // e.g., 'sarsaparilla' matches '@fp/sarsaparilla'
                if (importedPkg === unscopedName) {
                    aliasMap.aliases.set(importedPkg, actualPkg);

                    // Record evidence
                    if (!aliasMap.evidence.has(importedPkg)) {
                        aliasMap.evidence.set(importedPkg, []);
                    }
                    const paths = nodeModulesPackages.get(actualPkg)!;
                    aliasMap.evidence.get(importedPkg)!.push({
                        importingFile: file.path,
                        resolvedPath: Array.from(paths)[0],
                    });
                    break;
                }
            }
        }
    }

    return aliasMap;
}

/**
 * Generates a package.json object from analysis results
 */
export function generatePackageJson(
    name: string,
    dependencies: Map<string, DependencyInfo>,
    aliasMap?: AliasMap,
    projectConfig?: DetectedProjectConfig,
    onVerbose?: (message: string) => void,
): object {
    const deps: Record<string, string> = {};
    const privateDeps: Record<string, string> = {};
    const devDeps: Record<string, string> = {};
    const scripts: Record<string, string> = {};
    const versionMeta: Record<string, { confidence: string; source: string }> =
        {};

    // Sort dependencies alphabetically
    const sortedDeps = Array.from(dependencies.entries()).sort((a, b) =>
        a[0].localeCompare(b[0]),
    );

    for (const [packageName, info] of sortedDeps) {
        const target = info.isPrivate ? privateDeps : deps;

        if (info.version) {
            // Use exact version when confidence is 'exact' (from fingerprinting),
            // otherwise use caret range for flexibility.
            // This prevents installing a newer (potentially broken) patch version
            // when we know the exact version that was running in production.
            const isExact = info.confidence === 'exact';
            if (isExact) {
                target[packageName] = info.version;
            } else {
                target[packageName] = `^${info.version}`;
            }

            // Debug: log when exact versions are used
            if (isExact) {
                onVerbose?.(
                    `[version] Using exact version for ${packageName}: ${info.version} (confidence: ${info.confidence})`,
                );
            }

            // Track version metadata
            if (info.confidence && info.versionSource) {
                versionMeta[packageName] = {
                    confidence: info.confidence,
                    source: info.versionSource,
                };
            }
        } else if (info.isPrivate) {
            // Private packages get a workspace or local reference hint
            target[packageName] = 'workspace:*';
        } else {
            // Mark as unknown for manual resolution
            target[packageName] = '*';
        }
    }

    // Add dev dependencies based on detected project config
    if (projectConfig?.hasTypeScript) {
        devDeps['typescript'] = 'latest';
        scripts['typecheck'] = 'tsc --noEmit';
        scripts['build'] = 'tsc';
    }

    // Add type definitions for detected frameworks
    // Match @types/react version to the detected React version to avoid type mismatches
    // (e.g., React 19 changed RefObject<T> to be non-generic, breaking React 18 code)
    if (projectConfig?.jsxFramework === 'react' && !deps['@types/react']) {
        const reactVersion = deps['react'];
        let typesVersion = 'latest'; // Default fallback

        if (reactVersion && reactVersion !== '*') {
            // Extract major version (e.g., "^18.2.0" -> "18", "~17.0.0" -> "17")
            const majorMatch = reactVersion.match(/(\d+)/);
            if (majorMatch) {
                typesVersion = `^${majorMatch[1]}.0.0`;
            }
        }

        devDeps['@types/react'] = typesVersion;
        devDeps['@types/react-dom'] = typesVersion;
    }

    // Add Node types if Node environment detected
    if (
        (projectConfig?.environment === 'node' ||
            projectConfig?.environment === 'both') &&
        projectConfig?.hasTypeScript
    ) {
        devDeps['@types/node'] = 'latest';
    }

    const result: Record<string, unknown> = {
        name: name,
        version: '0.0.0-reconstructed',
        private: true,
        description: 'Reconstructed from source maps',
    };

    // Add scripts if any
    if (Object.keys(scripts).length > 0) {
        result.scripts = scripts;
    }

    // Add dependencies
    result.dependencies = deps;

    // Add devDependencies if any
    if (Object.keys(devDeps).length > 0) {
        result.devDependencies = devDeps;
    }

    // Add private/internal dependencies as a separate section for clarity
    if (Object.keys(privateDeps).length > 0) {
        result._internalDependencies = privateDeps;
    }

    // Add version confidence metadata
    if (Object.keys(versionMeta).length > 0) {
        result._versionMeta = versionMeta;
    }

    // Add notes
    const notes: string[] = [];
    if (Object.keys(privateDeps).length > 0) {
        notes.push(
            'Internal dependencies (_internalDependencies) are likely workspace packages that need manual setup',
        );
    }
    if (Object.keys(versionMeta).length > 0) {
        notes.push(
            'Version confidence metadata available in _versionMeta (exact/high/medium/low/unverified)',
        );
    }

    if (notes.length > 0) {
        result._notes = notes;
    }

    // Add alias information if any aliases were detected
    if (aliasMap && aliasMap.aliases.size > 0) {
        result._importAliases = Object.fromEntries(aliasMap.aliases);

        // Add bundler config hint showing how to set up these aliases
        result._bundlerAliasConfig = {
            _note: 'These aliases were detected from source map analysis. Configure your bundler accordingly.',
            webpack: Object.fromEntries(
                Array.from(aliasMap.aliases.entries()).map(
                    ([alias, actual]) => [alias, actual],
                ),
            ),
            vite: Object.fromEntries(
                Array.from(aliasMap.aliases.entries()).map(
                    ([alias, actual]) => [alias, actual],
                ),
            ),
        };

        notes.push(
            `${aliasMap.aliases.size} import aliases detected - see _importAliases for bundler configuration`,
        );
    }

    return result;
}

/**
 * Writes the generated package.json to disk
 */
export async function writePackageJson(
    outputPath: string,
    packageJson: object,
): Promise<void> {
    await writeFile(
        outputPath,
        JSON.stringify(packageJson, null, 2) + '\n',
        'utf-8',
    );
}

/**
 * Detected project configuration based on source file analysis
 */
export interface DetectedProjectConfig {
    /** Whether the project uses TypeScript (.ts/.tsx files) */
    hasTypeScript: boolean;
    /** Whether the project uses JavaScript (.js/.jsx files) */
    hasJavaScript: boolean;
    /** Whether the project uses JSX syntax */
    hasJsx: boolean;
    /** Detected JSX framework */
    jsxFramework: 'react' | 'preact' | 'solid' | 'vue' | 'none';
    /** Detected module system */
    moduleSystem: 'esm' | 'commonjs' | 'mixed';
    /** Detected runtime environment */
    environment: 'browser' | 'node' | 'both';
    /** Detected ES target features */
    targetFeatures: {
        asyncAwait: boolean;
        optionalChaining: boolean;
        nullishCoalescing: boolean;
    };
}

/**
 * Analyzes source files to detect project configuration using AST parsing.
 * This properly handles code analysis without false positives from strings/comments.
 */
export function detectProjectConfig(
    sourceFiles: ExtractedSource[],
): DetectedProjectConfig {
    const config: DetectedProjectConfig = {
        hasTypeScript: false,
        hasJavaScript: false,
        hasJsx: false,
        jsxFramework: 'none',
        moduleSystem: 'esm',
        environment: 'browser',
        targetFeatures: {
            asyncAwait: false,
            optionalChaining: false,
            nullishCoalescing: false,
        },
    };

    let hasEsm = false;
    let hasCommonJs = false;
    let hasBrowserApis = false;
    let hasNodeApis = false;
    let reactImports = 0;
    let preactImports = 0;
    let solidImports = 0;
    let vueImports = 0;

    for (const file of sourceFiles) {
        const ext = file.path.split('.').pop()?.toLowerCase();

        // Detect TypeScript/JavaScript from file extension
        if (ext === 'ts' || ext === 'tsx') {
            config.hasTypeScript = true;
        }
        if (ext === 'js' || ext === 'jsx') {
            config.hasJavaScript = true;
        }

        // Detect JSX from file extension
        if (ext === 'tsx' || ext === 'jsx') {
            config.hasJsx = true;
        }

        // Skip content analysis if no content
        if (!file.content) continue;

        // Use AST-based detection for JSX in content (for .ts/.js files that might have JSX)
        if (!config.hasJsx) {
            if (hasJSXElements(file.content, file.path)) {
                config.hasJsx = true;
            }
        }

        // Use AST-based framework detection
        const frameworks = detectFrameworkImports(file.content, file.path);
        if (frameworks.react) reactImports++;
        if (frameworks.preact) preactImports++;
        if (frameworks.solid) solidImports++;
        if (frameworks.vue) vueImports++;

        // Use AST-based module system detection
        const moduleInfo = detectModuleSystem(file.content, file.path);
        if (moduleInfo.hasESM) hasEsm = true;
        if (moduleInfo.hasCommonJS) hasCommonJs = true;

        // Use AST-based environment detection
        const envInfo = detectEnvironmentAPIs(file.content, file.path);
        if (envInfo.hasBrowserAPIs) hasBrowserApis = true;
        if (envInfo.hasNodeAPIs) hasNodeApis = true;

        // Use AST-based ES features detection
        const features = detectESFeatures(file.content, file.path);
        if (features.asyncAwait) config.targetFeatures.asyncAwait = true;
        if (features.optionalChaining)
            config.targetFeatures.optionalChaining = true;
        if (features.nullishCoalescing)
            config.targetFeatures.nullishCoalescing = true;
    }

    // Determine JSX framework (pick the one with most imports)
    const frameworkCounts = [
        { framework: 'react' as const, count: reactImports },
        { framework: 'preact' as const, count: preactImports },
        { framework: 'solid' as const, count: solidImports },
        { framework: 'vue' as const, count: vueImports },
    ];
    const topFramework = frameworkCounts.sort((a, b) => b.count - a.count)[0];
    if (topFramework.count > 0) {
        config.jsxFramework = topFramework.framework;
    }

    // Determine module system
    if (hasEsm && hasCommonJs) {
        config.moduleSystem = 'mixed';
    } else if (hasCommonJs && !hasEsm) {
        config.moduleSystem = 'commonjs';
    } else {
        config.moduleSystem = 'esm';
    }

    // Determine environment
    if (hasBrowserApis && hasNodeApis) {
        config.environment = 'both';
    } else if (hasNodeApis && !hasBrowserApis) {
        config.environment = 'node';
    } else {
        config.environment = 'browser';
    }

    return config;
}

/**
 * Mapping of alias to the actual path where the package files are located
 */
export interface AliasPathMapping {
    /** Import alias (e.g., `sarsaparilla`) */
    alias: string;
    /** Actual package name (e.g., `@fp/sarsaparilla`) */
    actualPackage: string;
    /** Path to the package relative to project root (e.g., `./navigation/node_modules/@fp/sarsaparilla`) */
    relativePath: string;
}

/**
 * Builds alias path mappings from an AliasMap and source files.
 * Finds the actual location of each aliased package in the extracted files.
 *
 * File paths have the structure: `{bundleName}/{sourcePath}`
 * where sourcePath may contain `../` relative references.
 *
 * We find node_modules packages by:
 * 1. Looking for paths that contain `/node_modules/`
 * 2. Extracting the bundle prefix (the first path segment)
 * 3. Combining them to form the actual output path
 */
export function buildAliasPathMappings(
    aliasMap: AliasMap | undefined,
    sourceFiles: ExtractedSource[],
): AliasPathMapping[] {
    if (!aliasMap || aliasMap.aliases.size === 0) {
        return [];
    }

    const mappings: AliasPathMapping[] = [];

    // Build a map of package -> output path
    // The files have paths like "navigation/../../node_modules/@fp/pkg/..."
    // The actual output location is "{bundlePrefix}/node_modules/@fp/pkg/..."
    const packageLocations = new Map<string, string>();

    for (const file of sourceFiles) {
        // Check if this path contains node_modules
        const nodeModulesIdx = file.path.indexOf('node_modules/');
        if (nodeModulesIdx === -1) continue;

        // Extract the portion from node_modules onwards
        const nodeModulesPath = file.path.slice(nodeModulesIdx);

        // Match the package name
        const pkgMatch = nodeModulesPath.match(
            /^node_modules\/(@[^/]+\/[^/]+|[^/]+)/,
        );
        if (!pkgMatch) continue;

        const packageName = pkgMatch[1];

        // Already found this package
        if (packageLocations.has(packageName)) continue;

        // Extract the bundle prefix (first path segment before any /../)
        // For "navigation/../../node_modules/...", the bundle is "navigation"
        const firstSegment = file.path.split('/')[0];

        // Construct the output path: {bundle}/node_modules/{pkg}
        // This matches how reconstructSources writes files
        const outputPath = `${firstSegment}/${pkgMatch[0]}`;
        packageLocations.set(packageName, outputPath);
    }

    for (const [alias, actualPackage] of aliasMap.aliases) {
        const location = packageLocations.get(actualPackage);
        if (location) {
            mappings.push({
                alias,
                actualPackage,
                relativePath: `./${location}`,
            });
        } else {
            // Fallback to standard node_modules path if not found in extracted files
            mappings.push({
                alias,
                actualPackage,
                relativePath: `./node_modules/${actualPackage}`,
            });
        }
    }

    return mappings;
}

/**
 * Detects vendor bundle directories from source files.
 * A vendor bundle is a top-level directory that:
 * - Is named like a package (e.g., "mapbox-gl-2.15.0", "lodash-4.17.21")
 * - Contains primarily third-party library code
 *
 * These should be excluded from TypeScript checking since they may use
 * Flow or other type systems that TypeScript can't parse.
 */
export function detectVendorBundleDirectories(
    sourceFiles: ExtractedSource[],
): string[] {
    const topLevelDirs = new Map<
        string,
        { total: number; nodeModules: number }
    >();

    for (const file of sourceFiles) {
        // Skip files in node_modules (these are handled separately)
        if (file.path.startsWith('node_modules/')) continue;

        // Get the top-level directory
        const firstSlash = file.path.indexOf('/');
        if (firstSlash === -1) continue;

        const topDir = file.path.slice(0, firstSlash);

        if (!topLevelDirs.has(topDir)) {
            topLevelDirs.set(topDir, { total: 0, nodeModules: 0 });
        }

        const stats = topLevelDirs.get(topDir)!;
        stats.total++;

        // Check if path contains node_modules after the top dir
        if (file.path.includes('/node_modules/')) {
            stats.nodeModules++;
        }
    }

    const vendorDirs: string[] = [];

    // Pattern to detect package-like names: name-version or @scope/name-version
    const packageNamePattern =
        /^(@[a-z0-9-]+\/)?[a-z0-9][-a-z0-9]*(-\d+\.\d+\.\d+.*)?$/i;

    for (const [dir, stats] of topLevelDirs) {
        // Heuristics for vendor bundles:
        // 1. Named like a package with version (e.g., "mapbox-gl-2.15.0")
        // 2. OR most files are in node_modules paths

        const looksLikePackage =
            packageNamePattern.test(dir) && dir.includes('-');
        const hasVersion = /\d+\.\d+\.\d+/.test(dir);
        const mostlyNodeModules = stats.nodeModules > stats.total * 0.8;

        if ((looksLikePackage && hasVersion) || mostlyNodeModules) {
            vendorDirs.push(dir);
        }
    }

    return vendorDirs;
}

/**
 * Workspace package information for path mapping
 */
export interface WorkspacePackageMapping {
    /** Package name as imported (e.g., `site-kit`) */
    name: string;
    /** Relative path from project root (e.g., `./navigation/site-kit`) */
    relativePath: string;
}

/**
 * Subpath import mapping for package subpaths
 * e.g., `sarsaparilla/auth` to `./navigation/shared-ui/auth`
 */
export interface SubpathMapping {
    /** Full import specifier (e.g., `sarsaparilla/auth`) */
    specifier: string;
    /** Relative path from project root (e.g., `./navigation/shared-ui/auth`) */
    relativePath: string;
}

/**
 * Detects subpath imports (like 'sarsaparilla/auth') from source files
 * and attempts to map them to actual directories.
 */
export function detectSubpathImports(
    sourceFiles: ExtractedSource[],
    aliasMap?: AliasMap,
    workspacePackages?: WorkspacePackageMapping[],
): SubpathMapping[] {
    const subpathMappings: SubpathMapping[] = [];
    const seenSpecifiers = new Set<string>();

    // Collect all subpath imports from source files
    const subpathImports = new Set<string>();

    for (const file of sourceFiles) {
        // Match import statements with subpaths
        const importPatterns = [
            /import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+\/[^'"]+)['"]/g,
            /require\s*\(\s*['"]([^'"]+\/[^'"]+)['"]\s*\)/g,
            /from\s+['"]([^'"]+\/[^'"]+)['"]/g,
        ];

        for (const pattern of importPatterns) {
            pattern.lastIndex = 0;
            let match;
            while ((match = pattern.exec(file.content)) !== null) {
                const specifier = match[1];

                // Skip relative imports and node: imports
                if (
                    specifier.startsWith('.') ||
                    specifier.startsWith('node:')
                ) {
                    continue;
                }

                // Get the package name (subpath is extracted but not used currently)
                let packageName: string;

                if (specifier.startsWith('@')) {
                    // Scoped package: @scope/package/subpath
                    const parts = specifier.split('/');
                    if (parts.length <= 2) continue; // No subpath
                    packageName = parts.slice(0, 2).join('/');
                } else {
                    // Regular package: package/subpath
                    const parts = specifier.split('/');
                    if (parts.length <= 1) continue; // No subpath
                    packageName = parts[0];
                }

                // Check if this is an aliased package or workspace package
                const isAliased = aliasMap?.aliases.has(packageName);
                const isWorkspace = workspacePackages?.some(
                    (wp) => wp.name === packageName,
                );

                if (isAliased || isWorkspace) {
                    subpathImports.add(specifier);
                }
            }
        }
    }

    // Build a map of actual package -> paths for aliased packages
    // This allows us to resolve subpaths WITHIN the correct package
    const packagePaths = new Map<string, string[]>();

    for (const file of sourceFiles) {
        // Check if this path contains node_modules
        const nodeModulesIdx = file.path.indexOf('node_modules/');
        if (nodeModulesIdx === -1) continue;

        // Extract the portion from node_modules onwards
        const nodeModulesPath = file.path.slice(nodeModulesIdx);

        // Match the package name
        const pkgMatch = nodeModulesPath.match(
            /^node_modules\/(@[^/]+\/[^/]+|[^/]+)/,
        );
        if (!pkgMatch) continue;

        const packageName = pkgMatch[1];

        // Get the bundle prefix (first path segment)
        const firstSegment = file.path.split('/')[0];
        const packageBasePath = `${firstSegment}/${pkgMatch[0]}`;

        if (!packagePaths.has(packageName)) {
            packagePaths.set(packageName, []);
        }
        const paths = packagePaths.get(packageName)!;
        if (!paths.includes(packageBasePath)) {
            paths.push(packageBasePath);
        }
    }

    // Try to match subpath imports to directories WITHIN the correct package
    for (const specifier of subpathImports) {
        if (seenSpecifiers.has(specifier)) continue;

        let packageName: string;
        let subpath: string;

        if (specifier.startsWith('@')) {
            const parts = specifier.split('/');
            packageName = parts.slice(0, 2).join('/');
            subpath = parts.slice(2).join('/');
        } else {
            const parts = specifier.split('/');
            packageName = parts[0];
            subpath = parts.slice(1).join('/');
        }

        // Resolve the alias to actual package name
        const actualPackage = aliasMap?.aliases.get(packageName);

        // Find the package's base path(s)
        const packageBasePaths = actualPackage
            ? packagePaths.get(actualPackage)
            : packagePaths.get(packageName);

        if (!packageBasePaths || packageBasePaths.length === 0) {
            // Package not found in extracted files - skip
            continue;
        }

        // Look for the subpath within the package's files
        // Common patterns: package/src/subpath, package/subpath, package/lib/subpath
        const subpathLower = subpath.toLowerCase();
        const subpathNoDash = subpathLower.replace(/-/g, '');

        // Expand common abbreviations
        const expandAbbreviations = (s: string): string[] => {
            const expansions = [s];
            if (s.includes('nav')) {
                expansions.push(s.replace('nav', 'navigation'));
            }
            if (s.includes('btn')) {
                expansions.push(s.replace('btn', 'button'));
            }
            return expansions;
        };

        const subpathVariants = new Set<string>();
        for (const base of [subpathLower, subpathNoDash]) {
            for (const expanded of expandAbbreviations(base)) {
                subpathVariants.add(expanded);
                subpathVariants.add(`${expanded}external`);
            }
        }

        // Search for files within this package that match the subpath
        let bestMatch: string | null = null;

        for (const packageBasePath of packageBasePaths) {
            // Find all files under this package
            const packageFiles = sourceFiles.filter((f) =>
                f.path.startsWith(packageBasePath + '/'),
            );

            // Look for directories matching the subpath
            const matchedDirs = new Set<string>();

            for (const file of packageFiles) {
                // Get the path relative to package base
                const relativePath = file.path.slice(
                    packageBasePath.length + 1,
                );
                const pathParts = relativePath.split('/');

                // Check each directory in the path
                for (let i = 0; i < pathParts.length - 1; i++) {
                    const dirName = pathParts[i].toLowerCase();
                    if (subpathVariants.has(dirName)) {
                        // Found a matching directory - construct the full path
                        const fullDirPath = `${packageBasePath}/${pathParts.slice(0, i + 1).join('/')}`;
                        matchedDirs.add(fullDirPath);
                    }
                }
            }

            if (matchedDirs.size > 0) {
                // Prefer paths with 'src' in them, then shorter paths
                const sorted = [...matchedDirs].sort((a, b) => {
                    const aHasSrc = a.includes('/src/') ? 1 : 0;
                    const bHasSrc = b.includes('/src/') ? 1 : 0;
                    if (aHasSrc !== bHasSrc) return bHasSrc - aHasSrc;
                    return a.length - b.length;
                });
                bestMatch = sorted[0];
                break;
            }
        }

        if (bestMatch) {
            seenSpecifiers.add(specifier);
            subpathMappings.push({
                specifier,
                relativePath: `./${bestMatch}`,
            });
        }
    }

    return subpathMappings;
}

/**
 * Sanitizes a source map path to match how files are actually written by the reconstructor.
 *
 * Source map paths often contain relative sequences like "../../" which need to be resolved
 * in a way that matches the reconstructor's sanitizePath behavior.
 *
 * For paths like "bundleName/../../package/file.ts":
 * - The first segment (bundleName) is always preserved (it's the output directory)
 * - The remaining path is sanitized: ".." pops the stack, but can't escape the bundle root
 * - Result: "bundleName/package/file.ts"
 *
 * @param relativePath - Path like "./bundleName/../../package" or "./bundleName/package"
 * @returns Normalized path like "./bundleName/package"
 */
function sanitizeSourceMapPath(relativePath: string): string {
    // Remove leading ./ if present
    const path = relativePath.replace(/^\.[\\/]+/, '');

    // Split into segments
    const segments = path.split(/[/\\]/);
    if (segments.length === 0) return './' + path;

    // First segment is the bundle name - always preserved
    const bundleName = segments[0];
    const restSegments = segments.slice(1);

    // Apply sanitization logic to the rest (same as reconstructor's sanitizePath)
    // This resolves ".." by popping, but doesn't allow escaping the bundle root
    const resolved: string[] = [];
    for (const segment of restSegments) {
        if (segment === '..') {
            if (resolved.length > 0) {
                resolved.pop();
            }
            // If resolved is empty, we can't go higher - just ignore the ..
        } else if (segment && segment !== '.') {
            resolved.push(segment);
        }
    }

    // Combine bundle name with resolved path
    if (resolved.length > 0) {
        return './' + bundleName + '/' + resolved.join('/');
    }
    return './' + bundleName;
}

/**
 * Generates a tsconfig.json object based on detected project configuration
 */
export function generateTsConfig(
    aliasPathMappings?: AliasPathMapping[],
    projectConfig?: DetectedProjectConfig,
    vendorBundleDirs?: string[],
    workspacePackages?: WorkspacePackageMapping[],
    subpathMappings?: SubpathMapping[],
): object {
    const paths: Record<string, string[]> = {};

    // Add path mappings for each alias using actual extracted locations
    // Point to src/ subdirectory if it exists (common package structure)
    if (aliasPathMappings && aliasPathMappings.length > 0) {
        for (const mapping of aliasPathMappings) {
            // Sanitize the path to match actual output structure
            // e.g., "./navigation/../../shared-ui" -> "./navigation/shared-ui"
            const normalizedPath = sanitizeSourceMapPath(mapping.relativePath);

            // Try src subdirectory first (where index.ts is typically generated)
            const srcPath = `${normalizedPath}/src`;
            paths[mapping.alias] = [srcPath, normalizedPath];
            paths[`${mapping.alias}/*`] = [
                `${srcPath}/*`,
                `${normalizedPath}/*`,
            ];
        }
    }

    // Add path mappings for workspace packages (internal packages not in node_modules)
    if (workspacePackages && workspacePackages.length > 0) {
        for (const pkg of workspacePackages) {
            if (paths[pkg.name]) continue; // Don't override alias mappings

            // Sanitize the path to match actual output structure
            const normalizedPath = sanitizeSourceMapPath(pkg.relativePath);

            // Try common entry points
            const srcPath = `${normalizedPath}/src`;
            paths[pkg.name] = [srcPath, normalizedPath];
            paths[`${pkg.name}/*`] = [`${srcPath}/*`, `${normalizedPath}/*`];
        }
    }

    // Add path mappings for subpath imports (e.g., 'sarsaparilla/auth' -> './shared-ui/auth')
    if (subpathMappings && subpathMappings.length > 0) {
        for (const mapping of subpathMappings) {
            if (paths[mapping.specifier]) continue; // Don't override existing mappings

            const normalizedPath = sanitizeSourceMapPath(mapping.relativePath);
            const srcPath = `${normalizedPath}/src`;
            paths[mapping.specifier] = [srcPath, normalizedPath];
            paths[`${mapping.specifier}/*`] = [
                `${srcPath}/*`,
                `${normalizedPath}/*`,
            ];
        }
    }

    // Determine lib based on environment
    // Use ES2022 by default to support modern features like Object.hasOwn()
    const lib: string[] = ['ES2022'];

    if (
        projectConfig?.environment === 'browser' ||
        projectConfig?.environment === 'both'
    ) {
        lib.push('DOM', 'DOM.Iterable');
    }

    // Determine target - use ES2022 for modern features
    const target = 'ES2022';

    // Determine JSX setting
    let jsx: string | undefined;
    if (projectConfig?.hasJsx) {
        switch (projectConfig.jsxFramework) {
            case 'react':
                jsx = 'react-jsx';
                break;
            case 'preact':
                jsx = 'react-jsx'; // Preact uses React-compatible JSX
                break;
            case 'solid':
                jsx = 'preserve'; // Solid uses its own JSX transform
                break;
            case 'vue':
                jsx = 'preserve';
                break;
            default:
                jsx = 'react-jsx'; // Default fallback
        }
    }

    // Determine module system
    const module =
        projectConfig?.moduleSystem === 'commonjs' ? 'CommonJS' : 'ESNext';

    // Build compiler options
    const compilerOptions: Record<string, unknown> = {
        target,
        lib,
        module,
        moduleResolution: 'bundler',
    };

    // Only add allowJs if there are JavaScript files
    if (projectConfig?.hasJavaScript) {
        compilerOptions.allowJs = true;
        compilerOptions.checkJs = false;
    }

    // Only add JSX if needed
    if (jsx) {
        compilerOptions.jsx = jsx;
        // Add jsxImportSource for frameworks that need it
        if (projectConfig?.jsxFramework === 'preact') {
            compilerOptions.jsxImportSource = 'preact';
        } else if (projectConfig?.jsxFramework === 'solid') {
            compilerOptions.jsxImportSource = 'solid-js';
        }
    }

    // Path resolution
    compilerOptions.baseUrl = '.';
    if (Object.keys(paths).length > 0) {
        compilerOptions.paths = paths;
    }

    // Type checking - loose for reconstructed code
    compilerOptions.strict = false;
    compilerOptions.skipLibCheck = true;
    compilerOptions.noEmit = true;
    compilerOptions.noImplicitAny = false;
    compilerOptions.noUnusedLocals = false;
    compilerOptions.noUnusedParameters = false;

    // Include @types folder for stub declarations of missing packages
    compilerOptions.typeRoots = ['./node_modules/@types', './@types'];

    // Interop
    compilerOptions.esModuleInterop = true;
    compilerOptions.allowSyntheticDefaultImports = true;
    compilerOptions.forceConsistentCasingInFileNames = false; // Reconstructed paths may have case issues
    compilerOptions.resolveJsonModule = true;
    compilerOptions.isolatedModules = false; // Allow type re-exports

    // Build include patterns based on what files exist
    const include: string[] = [];
    if (projectConfig?.hasTypeScript) {
        include.push('**/*.ts');
        if (projectConfig.hasJsx) {
            include.push('**/*.tsx');
        }
    }
    if (projectConfig?.hasJavaScript) {
        include.push('**/*.js');
        if (projectConfig.hasJsx) {
            include.push('**/*.jsx');
        }
    }
    // Default if nothing detected
    if (include.length === 0) {
        include.push('**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx');
    }

    // Build exclude list
    const exclude: string[] = [
        'node_modules',
        '**/node_modules', // Exclude nested node_modules (e.g., bundleName/node_modules/...)
        'dist',
        'build',
    ];

    // Add vendor bundle directories to exclude
    // These are third-party libraries extracted as separate bundles that may use Flow or other type systems
    if (vendorBundleDirs && vendorBundleDirs.length > 0) {
        for (const dir of vendorBundleDirs) {
            exclude.push(dir);
        }
    }

    const tsconfig: Record<string, unknown> = {
        compilerOptions,
        include,
        exclude,
    };

    return tsconfig;
}

/**
 * Writes the generated tsconfig.json to disk
 */
export async function writeTsConfig(
    outputPath: string,
    tsconfig: object,
): Promise<void> {
    await writeFile(
        outputPath,
        JSON.stringify(tsconfig, null, 2) + '\n',
        'utf-8',
    );
}

export interface VersionStats {
    totalDependencies: number;
    withVersion: number;
    withoutVersion: number;
    privatePackages: number;
    bySource: {
        packageJson: number;
        banner: number;
        lockfilePath: number;
        versionConstant: number;
        sourcemapPath: number;
        fingerprint: number;
        fingerprintMinified: number;
        customBuild: number;
        peerDep: number;
        npmLatest: number;
    };
    byConfidence: {
        exact: number;
        high: number;
        medium: number;
        low: number;
        unverified: number;
    };
}

/**
 * Vendor bundle input for fingerprinting
 */
export interface VendorBundleForAnalysis {
    url: string;
    filename: string;
    content: string;
    inferredPackage?: string;
}

/**
 * Main function to analyze a reconstructed source directory and generate package.json.
 * Results are cached based on extraction hash and options.
 */
export async function generateDependencyManifest(
    sourceDir: string,
    manifestPath: string | null,
    outputName: string,
    options: {
        onProgress?: (file: string) => void;
        onVersionProgress?: (
            stage: string,
            packageName: string,
            result?: VersionResult,
        ) => void;
        /** Use source fingerprinting to match against npm versions */
        useFingerprinting?: boolean;
        /** Maximum versions to check during fingerprinting (0 = all) */
        maxVersionsToCheck?: number;
        /** Fallback to npm latest as last resort */
        fetchFromNpm?: boolean;
        onNpmProgress?: (
            completed: number,
            total: number,
            packageName: string,
        ) => void;
        /** Progress callback for fingerprinting */
        onFingerprintProgress?: (
            completed: number,
            total: number,
            packageName: string,
        ) => void;
        /** Raw source files from extraction (used to get versions from package.json files) */
        extractedSourceFiles?: ExtractedSource[];
        /** Include pre-release versions when fingerprinting */
        includePrereleases?: boolean;
        /** Number of packages to fingerprint concurrently (default: 5) */
        fingerprintConcurrency?: number;
        /** Number of versions to check concurrently per package (default: 10) */
        versionConcurrency?: number;
        /** Number of entry paths to try concurrently when fetching from CDN (default: 5) */
        pathConcurrency?: number;
        /** Progress callback for peer dependency inference */
        onPeerDepProgress?: (
            completed: number,
            total: number,
            packageName: string,
        ) => void;
        /** Page URL for cache keying */
        pageUrl?: string;
        /** Vendor bundles without source maps (for minified fingerprinting) */
        vendorBundles?: VendorBundleForAnalysis[];
        /** Progress callback for vendor bundle fingerprinting (called when each bundle completes) */
        onVendorBundleProgress?: (
            completed: number,
            total: number,
            bundleFilename: string,
        ) => void;
        /** Detailed progress callback for vendor bundle fingerprinting (called for each version check) */
        onVendorBundleDetailedProgress?: (
            bundleFilename: string,
            packageName: string,
            version: string,
            versionIndex: number,
            versionTotal: number,
        ) => void;
        /** Progress callback for dependency classification */
        onClassificationProgress?: (
            checked: number,
            total: number,
            packageName: string,
            classification: string,
        ) => void;
        /** Verbose log callback - use this instead of console.log when spinner is active */
        onVerbose?: (message: string) => void;
    } = {},
): Promise<{
    packageJson: object;
    tsconfig: object;
    stats: VersionStats;
    aliasMap?: AliasMap;
    projectConfig?: DetectedProjectConfig;
}> {
    const {
        onProgress,
        onVersionProgress,
        useFingerprinting = false,
        maxVersionsToCheck = 0,
        fetchFromNpm = false,
        onNpmProgress,
        onFingerprintProgress,
        extractedSourceFiles,
        includePrereleases = false,
        fingerprintConcurrency,
        versionConcurrency,
        pathConcurrency,
        onPeerDepProgress,
        pageUrl,
        vendorBundles = [],
        onVendorBundleProgress,
        onVendorBundleDetailedProgress,
        onClassificationProgress,
        onVerbose,
    } = options;

    const cache = getCache();

    // Compute cache keys
    let extractionHash = '';
    if (extractedSourceFiles && extractedSourceFiles.length > 0) {
        extractionHash = computeExtractionHash(
            extractedSourceFiles as ExtractedFile[],
        );
    }

    const optionsHash = computeOptionsHash({
        useFingerprinting,
        includePrereleases,
        fetchFromNpm,
    });

    const urlHash = pageUrl
        ? computeUrlHash(pageUrl)
        : computeUrlHash(sourceDir);

    // Detect project configuration from source files
    const projectConfig = extractedSourceFiles
        ? detectProjectConfig(extractedSourceFiles)
        : undefined;

    // Detect vendor bundle directories (third-party libraries that should be excluded from type checking)
    const vendorBundleDirs = extractedSourceFiles
        ? detectVendorBundleDirectories(extractedSourceFiles)
        : [];

    // Detect workspace packages for path mapping
    const workspacePackageRoots = extractedSourceFiles
        ? detectWorkspacePackageRoots(extractedSourceFiles)
        : new Map();
    const workspacePackages: WorkspacePackageMapping[] = Array.from(
        workspacePackageRoots.entries(),
    ).map(([name, path]) => ({
        name,
        relativePath: `./${path}`,
    }));

    // Check for cached manifest result
    if (extractionHash) {
        const cachedManifest = await cache.getDependencyManifest(
            urlHash,
            extractionHash,
            optionsHash,
        );
        if (cachedManifest) {
            // Regenerate tsconfig from the cached packageJson's alias info
            const cachedAliases = (
                cachedManifest.packageJson as Record<string, unknown>
            )._importAliases as Record<string, string> | undefined;
            const cachedAliasMap: AliasMap | undefined = cachedAliases
                ? {
                      aliases: new Map(Object.entries(cachedAliases)),
                      evidence: new Map(),
                  }
                : undefined;
            const aliasPathMappings = extractedSourceFiles
                ? buildAliasPathMappings(cachedAliasMap, extractedSourceFiles)
                : [];

            // Detect subpath imports for aliased packages
            const subpathMappings = extractedSourceFiles
                ? detectSubpathImports(
                      extractedSourceFiles,
                      cachedAliasMap,
                      workspacePackages,
                  )
                : [];

            return {
                packageJson: cachedManifest.packageJson,
                tsconfig: generateTsConfig(
                    aliasPathMappings,
                    projectConfig,
                    vendorBundleDirs,
                    workspacePackages,
                    subpathMappings,
                ),
                stats: cachedManifest.stats as VersionStats,
                aliasMap: cachedAliasMap,
                projectConfig,
            };
        }
    }

    // Analyze source files for imports
    // Use extractedSourceFiles directly if available - this includes internal packages
    // in node_modules that would otherwise be skipped by directory walking
    const analysis =
        extractedSourceFiles && extractedSourceFiles.length > 0
            ? analyzeDependenciesFromSourceFiles(
                  extractedSourceFiles,
                  onProgress,
              )
            : await analyzeDependencies(sourceDir, onProgress);

    // Initialize stats tracking
    const stats: VersionStats = {
        totalDependencies: analysis.dependencies.size,
        withVersion: 0,
        withoutVersion: 0,
        privatePackages: 0,
        bySource: {
            packageJson: 0,
            banner: 0,
            lockfilePath: 0,
            versionConstant: 0,
            sourcemapPath: 0,
            fingerprint: 0,
            fingerprintMinified: 0,
            customBuild: 0,
            peerDep: 0,
            npmLatest: 0,
        },
        byConfidence: {
            exact: 0,
            high: 0,
            medium: 0,
            low: 0,
            unverified: 0,
        },
    };

    // Classify dependencies as internal (workspace/private) or external (npm)
    let classification: DependencyClassification | undefined;
    if (extractedSourceFiles && extractedSourceFiles.length > 0) {
        const importedPackages = Array.from(analysis.dependencies.keys());
        classification = await classifyDependencies(
            importedPackages,
            extractedSourceFiles,
            onClassificationProgress,
        );

        // Mark internal packages as private
        for (const [packageName, info] of analysis.dependencies) {
            if (classification.internal.has(packageName)) {
                info.isPrivate = true;
                stats.privatePackages++;
            }
        }
    }

    // ============================================
    // VERSION DETECTION PIPELINE
    // ============================================

    if (extractedSourceFiles && extractedSourceFiles.length > 0) {
        // Get list of packages that need version detection (non-private)
        const packagesNeedingVersions = Array.from(
            analysis.dependencies.entries(),
        )
            .filter(([_, info]) => !info.isPrivate)
            .map(([name]) => name);

        // -----------------------------------------
        // Tier 1: Use the new unified version detector
        // This checks: lockfile paths, sourcemap paths, banners, VERSION constants
        // -----------------------------------------
        onVersionProgress?.('detecting', 'Starting version detection...');

        const detectedVersions = detectVersions(
            packagesNeedingVersions,
            extractedSourceFiles,
            (packageName, result) => {
                if (result) {
                    onVersionProgress?.('detected', packageName, result);
                }
            },
        );

        // Apply detected versions
        for (const [packageName, result] of detectedVersions) {
            const dep = analysis.dependencies.get(packageName);
            if (dep && !dep.version) {
                dep.version = result.version;
                dep.confidence = result.confidence;
                dep.versionSource = result.source;

                // Update stats
                switch (result.source) {
                    case 'package.json':
                        stats.bySource.packageJson++;
                        break;
                    case 'banner':
                        stats.bySource.banner++;
                        break;
                    case 'lockfile-path':
                        stats.bySource.lockfilePath++;
                        break;
                    case 'version-constant':
                        stats.bySource.versionConstant++;
                        break;
                    case 'sourcemap-path':
                        stats.bySource.sourcemapPath++;
                        break;
                    case 'custom-build':
                        stats.bySource.customBuild++;
                        break;
                }
                stats.byConfidence[result.confidence]++;
            }
        }

        // -----------------------------------------
        // Tier 2: Legacy package.json extraction (for completeness)
        // -----------------------------------------
        const sourceVersions =
            extractVersionsFromSourceFiles(extractedSourceFiles);
        for (const [packageName, version] of sourceVersions) {
            const dep = analysis.dependencies.get(packageName);
            if (dep && !dep.version) {
                dep.version = version;
                dep.confidence = 'exact';
                dep.versionSource = 'package.json';
                stats.bySource.packageJson++;
                stats.byConfidence.exact++;
            }
        }

        // -----------------------------------------
        // Tier 3: Legacy banner extraction
        // DISABLED: Banner attribution is too flaky - banners in nested node_modules
        // (e.g., hoist-non-react-statics/node_modules/react-is/) get incorrectly
        // attributed to the parent package.
        // -----------------------------------------
        // const bannerVersions = extractVersionsFromBanners(extractedSourceFiles);
        // matchBannerVersionsToDependencies(analysis.dependencies, bannerVersions);

        // -----------------------------------------
        // Tier 4: Source fingerprinting (if enabled)
        // -----------------------------------------
        if (useFingerprinting) {
            const packagesStillNeedingVersions = Array.from(
                analysis.dependencies.entries(),
            )
                .filter(([_, info]) => !info.version && !info.isPrivate)
                .map(([name]) => name);

            if (packagesStillNeedingVersions.length > 0) {
                onVersionProgress?.(
                    'fingerprinting',
                    `Fingerprinting ${packagesStillNeedingVersions.length} packages...`,
                );

                // Build map of package -> files for fingerprinting
                const packageFilesMap = new Map<string, ExtractedSource[]>();
                for (const packageName of packagesStillNeedingVersions) {
                    const files = getPackageFiles(
                        extractedSourceFiles,
                        packageName,
                    );
                    if (files.length > 0) {
                        packageFilesMap.set(packageName, files);
                    }
                }

                let fingerprintCompleted = 0;
                const fingerprintTotal = packageFilesMap.size;

                const fingerprintResults = await findMatchingVersions(
                    packageFilesMap,
                    {
                        maxVersionsToCheck, // 0 = all versions (new default)
                        minSimilarity: 0.7,
                        concurrency: fingerprintConcurrency,
                        versionConcurrency,
                        pathConcurrency,
                        includePrereleases,
                        onProgress: (packageName, result) => {
                            fingerprintCompleted++;
                            onFingerprintProgress?.(
                                fingerprintCompleted,
                                fingerprintTotal,
                                packageName,
                            );
                            if (result) {
                                onVersionProgress?.(
                                    'fingerprinted',
                                    packageName,
                                    result,
                                );
                            }
                        },
                        onDetailedProgress: (
                            packageName,
                            version,
                            versionIndex,
                            versionTotal,
                        ) => {
                            onVersionProgress?.(
                                'fingerprint-check',
                                `${packageName}@${version} (${versionIndex}/${versionTotal})`,
                            );
                        },
                    },
                );

                // Apply fingerprint results
                for (const [packageName, result] of fingerprintResults) {
                    const dep = analysis.dependencies.get(packageName);
                    if (dep && !dep.version) {
                        dep.version = result.version;
                        dep.confidence = result.confidence;
                        dep.versionSource = result.source;

                        // Track stats by source type
                        if (result.source === 'fingerprint-minified') {
                            stats.bySource.fingerprintMinified++;
                        } else {
                            stats.bySource.fingerprint++;
                        }
                        stats.byConfidence[result.confidence]++;
                    }
                }
            }

            // -----------------------------------------
            // Tier 4.5: Vendor bundle fingerprinting (minified bundles without source maps)
            // -----------------------------------------
            if (vendorBundles.length > 0) {
                // Get packages still needing versions
                const packagesStillNeedingVersions = Array.from(
                    analysis.dependencies.entries(),
                )
                    .filter(([_, info]) => !info.version && !info.isPrivate)
                    .map(([name]) => name);

                if (packagesStillNeedingVersions.length > 0) {
                    onVersionProgress?.(
                        'vendor-bundle',
                        `Fingerprinting ${vendorBundles.length} vendor bundles against ${packagesStillNeedingVersions.length} packages...`,
                    );

                    // Convert vendor bundles to input format
                    const vendorBundleInputs: VendorBundleInput[] =
                        vendorBundles.map((vb) => ({
                            content: vb.content,
                            inferredPackage: vb.inferredPackage,
                            filename: vb.filename,
                        }));

                    const vendorResults = await fingerprintVendorBundles(
                        vendorBundleInputs,
                        packagesStillNeedingVersions,
                        {
                            maxVersionsToCheck,
                            minSimilarity: 0.6, // Lower threshold for minified comparison
                            includePrereleases,
                            concurrency: 2,
                            versionConcurrency,
                            onBundleComplete: (
                                completed,
                                total,
                                bundleFilename,
                                result,
                            ) => {
                                onVendorBundleProgress?.(
                                    completed,
                                    total,
                                    bundleFilename,
                                );
                                if (result) {
                                    onVersionProgress?.(
                                        'vendor-bundle-matched',
                                        `${bundleFilename} -> ${result.packageName}@${result.version}`,
                                    );
                                }
                            },
                            onDetailedProgress: onVendorBundleDetailedProgress,
                        },
                    );

                    // Apply vendor bundle results
                    for (const [_filename, result] of vendorResults) {
                        const dep = analysis.dependencies.get(
                            result.packageName,
                        );
                        if (dep && !dep.version) {
                            dep.version = result.version;
                            dep.confidence = result.confidence;
                            dep.versionSource = 'fingerprint-minified';
                            stats.bySource.fingerprintMinified++;
                            stats.byConfidence[result.confidence]++;
                        }
                    }
                }
            }
        }

        // -----------------------------------------
        // Tier 5: Peer dependency inference
        // -----------------------------------------
        // Build map of known versions for peer dep inference
        const knownVersions = new Map<
            string,
            { name: string; version: string; confidence: VersionConfidence }
        >();
        for (const [name, info] of analysis.dependencies) {
            if (info.version && !info.isPrivate) {
                knownVersions.set(name, {
                    name,
                    version: info.version,
                    confidence: info.confidence || 'medium',
                });
            }
        }

        // Get packages still needing versions
        const packagesForPeerInference = Array.from(
            analysis.dependencies.entries(),
        )
            .filter(([_, info]) => !info.version && !info.isPrivate)
            .map(([name]) => name);

        if (packagesForPeerInference.length > 0 && knownVersions.size > 0) {
            onVersionProgress?.(
                'peer-dep',
                `Inferring versions for ${packagesForPeerInference.length} packages from peer dependencies...`,
            );

            let peerDepCompleted = 0;
            const peerDepTotal = packagesForPeerInference.length;

            const peerDepResults = await inferPeerDependencyVersions(
                packagesForPeerInference,
                knownVersions,
                {
                    onProgress: (packageName, result) => {
                        peerDepCompleted++;
                        onPeerDepProgress?.(
                            peerDepCompleted,
                            peerDepTotal,
                            packageName,
                        );
                        if (result) {
                            onVersionProgress?.(
                                'peer-dep-inferred',
                                packageName,
                                result,
                            );
                        }
                    },
                },
            );

            // Apply peer dep inference results
            for (const [packageName, result] of peerDepResults) {
                const dep = analysis.dependencies.get(packageName);
                if (dep && !dep.version) {
                    dep.version = result.version;
                    dep.confidence = result.confidence;
                    dep.versionSource = 'peer-dep';
                    stats.bySource.peerDep++;
                    stats.byConfidence[result.confidence]++;
                }
            }
        }
    }

    // -----------------------------------------
    // Tier 6: Try to extract versions from manifest paths
    // -----------------------------------------
    if (manifestPath) {
        try {
            const manifestContent = await readFile(manifestPath, 'utf-8');
            const manifest = JSON.parse(manifestContent);
            if (manifest.bundles) {
                const versions = extractVersionsFromManifest(manifest.bundles);
                for (const [packageName, version] of versions) {
                    const dep = analysis.dependencies.get(packageName);
                    if (dep && !dep.version && !dep.isPrivate) {
                        dep.version = version;
                        dep.confidence = 'high';
                        dep.versionSource = 'sourcemap-path';
                        stats.bySource.sourcemapPath++;
                        stats.byConfidence.high++;
                    }
                }
            }
        } catch {
            // Ignore manifest parsing errors
        }
    }

    // -----------------------------------------
    // Tier 7: Last resort - npm latest (if enabled)
    // -----------------------------------------
    if (fetchFromNpm) {
        const packagesStillNeedingVersions = Array.from(
            analysis.dependencies.entries(),
        )
            .filter(([_, info]) => info.version === null && !info.isPrivate)
            .map(([name]) => name);

        if (packagesStillNeedingVersions.length > 0) {
            onVersionProgress?.(
                'npm',
                `Fetching ${packagesStillNeedingVersions.length} from npm...`,
            );

            const npmVersions = await fetchNpmVersions(
                packagesStillNeedingVersions,
                10,
                onNpmProgress,
            );

            for (const [packageName, version] of npmVersions) {
                const dep = analysis.dependencies.get(packageName);
                if (dep && !dep.version) {
                    dep.version = version;
                    dep.confidence = 'unverified';
                    dep.versionSource = 'npm-latest';
                    stats.bySource.npmLatest++;
                    stats.byConfidence.unverified++;
                }
            }
        }
    }

    // -----------------------------------------
    // VERSION VALIDATION: Verify detected versions exist on npm
    // This catches cases where version detection incorrectly applies
    // a version from one package to another (e.g., @firebase/app getting
    // the firebase version 11.x when @firebase/app is actually at 0.x)
    // -----------------------------------------
    const packagesWithVersions = Array.from(analysis.dependencies.entries())
        .filter(([_, info]) => info.version && !info.isPrivate)
        .map(([name, info]) => ({ name, version: info.version! }));

    if (packagesWithVersions.length > 0) {
        onVersionProgress?.(
            'validating',
            `Validating ${packagesWithVersions.length} detected versions...`,
        );

        const { validations, replacements } = await validateNpmVersionsBatch(
            packagesWithVersions,
            10,
            (completed, total, packageName, version, valid) => {
                if (!valid) {
                    onVersionProgress?.(
                        'invalid-version',
                        `${packageName}@${version} not found on npm`,
                    );
                }
            },
        );

        // Replace invalid versions with latest
        for (const [name, info] of analysis.dependencies) {
            if (info.version && !info.isPrivate) {
                const key = `${name}@${info.version}`;
                const isValid = validations.get(key);
                if (isValid === false) {
                    const replacement = replacements.get(name);
                    if (replacement) {
                        onVersionProgress?.(
                            'version-replaced',
                            `${name}: ${info.version} -> ${replacement} (original version not found on npm)`,
                        );
                        info.version = replacement;
                        info.confidence = 'unverified';
                        info.versionSource = 'npm-latest';
                        // Update stats
                        stats.bySource.npmLatest =
                            (stats.bySource.npmLatest || 0) + 1;
                        stats.byConfidence.unverified =
                            (stats.byConfidence.unverified || 0) + 1;
                    } else {
                        // Could not get replacement, clear the version
                        onVersionProgress?.(
                            'version-cleared',
                            `${name}: ${info.version} cleared (not found on npm, no replacement available)`,
                        );
                        info.version = null;
                        info.confidence = undefined;
                        info.versionSource = undefined;
                    }
                }
            }
        }
    }

    // Calculate final stats
    stats.withVersion = Array.from(analysis.dependencies.values()).filter(
        (d) => d.version !== null,
    ).length;
    stats.withoutVersion =
        stats.totalDependencies - stats.withVersion - stats.privatePackages;

    // Detect import aliases (e.g., 'sarsaparilla' -> '@fp/sarsaparilla')
    let aliasMap: AliasMap | undefined;
    if (extractedSourceFiles && extractedSourceFiles.length > 0) {
        aliasMap = detectImportAliases(extractedSourceFiles);

        // Apply alias resolution: if we detected that 'sarsaparilla' -> '@fp/sarsaparilla',
        // and we have a dependency on 'sarsaparilla', rename it to '@fp/sarsaparilla'
        if (aliasMap.aliases.size > 0) {
            for (const [alias, actualPackage] of aliasMap.aliases) {
                if (analysis.dependencies.has(alias)) {
                    const depInfo = analysis.dependencies.get(alias)!;
                    // Check if we already have the actual package
                    if (!analysis.dependencies.has(actualPackage)) {
                        // Rename the dependency from alias to actual package
                        analysis.dependencies.delete(alias);

                        // Check if the actual package is internal (not on npm)
                        // First check if it was already classified, otherwise check npm directly
                        let isActualPackageInternal =
                            classification?.internal.has(actualPackage) ??
                            false;

                        // If not already classified (because it's a resolved alias, not a direct import),
                        // check npm registry to determine if it's internal
                        if (
                            !classification?.internal.has(actualPackage) &&
                            !classification?.external.has(actualPackage)
                        ) {
                            const isPublic =
                                await isPublicNpmPackage(actualPackage);
                            isActualPackageInternal = !isPublic;
                        }

                        analysis.dependencies.set(actualPackage, {
                            ...depInfo,
                            name: actualPackage,
                            isPrivate:
                                isActualPackageInternal || depInfo.isPrivate,
                        });

                        // Update stats if we're marking as private
                        if (isActualPackageInternal && !depInfo.isPrivate) {
                            stats.privatePackages++;
                        }
                    } else {
                        // Merge: actual package exists, just remove the alias
                        analysis.dependencies.delete(alias);
                    }
                }
            }
        }
    }

    // Build alias path mappings using actual extracted file locations
    const aliasPathMappings = extractedSourceFiles
        ? buildAliasPathMappings(aliasMap, extractedSourceFiles)
        : [];

    // Detect subpath imports for aliased packages
    const subpathMappings = extractedSourceFiles
        ? detectSubpathImports(
              extractedSourceFiles,
              aliasMap,
              workspacePackages,
          )
        : [];

    const packageJson = generatePackageJson(
        outputName,
        analysis.dependencies,
        aliasMap,
        projectConfig,
        onVerbose,
    );
    const tsconfig = generateTsConfig(
        aliasPathMappings,
        projectConfig,
        vendorBundleDirs,
        workspacePackages,
        subpathMappings,
    );

    // Cache the result for next time
    if (extractionHash) {
        await cache.setDependencyManifest(
            urlHash,
            extractionHash,
            optionsHash,
            packageJson,
            stats,
        );
    }

    return {
        packageJson,
        tsconfig,
        stats,
        aliasMap,
        projectConfig,
    };
}
