import { readFile, readdir, writeFile } from 'fs/promises';
import { join, extname, normalize } from 'path';
import {
    detectVersions,
    getPackageFiles,
    type VersionResult,
    type VersionConfidence,
    type VersionSource,
    type SourceFile,
} from './version-detector.js';
import {
    findMatchingVersions,
    fingerprintVendorBundles,
    type VendorBundleInput,
} from './source-fingerprint.js';
import { inferPeerDependencyVersions } from './peer-dependencies.js';
import {
    getCache,
    computeExtractionHash,
    computeOptionsHash,
    computeUrlHash,
    type ExtractedFile,
    type DependencyInfo as CacheDependencyInfo,
    type NpmPackageExistenceCache,
} from './fingerprint-cache.js';

export interface DependencyInfo {
    name: string;
    version: string | null;
    confidence?: VersionConfidence;
    versionSource?: VersionSource;
    importedFrom: string[];
    isPrivate?: boolean;
}

export interface AnalysisResult {
    dependencies: Map<string, DependencyInfo>;
    localImports: Set<string>;
    errors: string[];
}

/**
 * Regex patterns to match import/require statements
 */
const IMPORT_PATTERNS = [
    // ES6 imports: import x from 'package', import { x } from 'package', import 'package'
    /import\s+(?:(?:[\w*{}\s,]+)\s+from\s+)?['"]([^'"./][^'"]*)['"]/g,
    // Dynamic imports: import('package')
    /import\s*\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g,
    // Require: require('package')
    /require\s*\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g,
    // Export from: export { x } from 'package'
    /export\s+(?:[\w*{}\s,]+)\s+from\s+['"]([^'"./][^'"]*)['"]/g,
];

/**
 * Pattern to match node_modules paths with versions in source map sources
 * Examples:
 *   ../node_modules/react@18.2.0/index.js
 *   node_modules/@tanstack/react-query@5.0.0/build/index.js
 *   ../../node_modules/lodash-es/lodash.js (no version)
 */
const NODE_MODULES_VERSION_PATTERN =
    /node_modules\/(@[^/]+\/[^@/]+|[^@/]+)(?:@(\d+\.\d+\.\d+[^/]*))?/;

/**
 * Extracts the package name from an import specifier
 * Examples:
 *   'lodash' -> 'lodash'
 *   'lodash/merge' -> 'lodash'
 *   '@scope/pkg' -> '@scope/pkg'
 *   '@scope/pkg/sub' -> '@scope/pkg'
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
 * Extracts all external package imports from a source file
 */
function extractImportsFromSource(
    content: string,
    _filePath: string,
): Set<string> {
    const imports = new Set<string>();

    for (const pattern of IMPORT_PATTERNS) {
        // Reset regex lastIndex
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(content)) !== null) {
            const importSpecifier = match[1];
            const packageName = getPackageName(importSpecifier);

            // Skip built-in modules
            if (isBuiltinModule(packageName)) {
                continue;
            }

            imports.add(packageName);
        }
    }

    return imports;
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
 * like @fp/sarsaparilla that import react-stately, react-modal, etc.
 */
export function analyzeDependenciesFromSourceFiles(
    sourceFiles: SourceFile[],
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
 * Examples:
 *   node_modules/react/package.json
 *   node_modules/@reduxjs/toolkit/package.json
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
 *   /** @license React v18.2.0 *\/
 *   /*! lodash v4.17.21 *\/
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
 * Handles cases like: fingerprintjs -> @fingerprintjs/fingerprintjs
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
        const response = await fetch(
            `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
            {
                headers: { Accept: 'application/json' },
                signal: AbortSignal.timeout(5000),
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
    let completed = 0;

    // Process in batches
    for (let i = 0; i < packageNames.length; i += concurrency) {
        const batch = packageNames.slice(i, i + concurrency);
        const results = await Promise.all(
            batch.map(async (name) => {
                const version = await fetchNpmVersion(name);
                completed++;
                onProgress?.(completed, packageNames.length, name);
                return { name, version };
            }),
        );

        for (const { name, version } of results) {
            if (version) {
                versions.set(name, version);
            }
        }
    }

    return versions;
}

/**
 * Checks if a package exists on npm registry (cached)
 * Returns true if public (exists on npm), false if internal/private (not on npm)
 */
export async function isPublicNpmPackage(
    packageName: string,
): Promise<boolean> {
    const cache = getCache();

    // Check cache first
    const cached = await cache.getNpmPackageExistence(packageName);
    if (cached) {
        return cached.exists;
    }

    // Fetch from npm registry using HEAD request for efficiency
    try {
        const response = await fetch(
            `https://registry.npmjs.org/${encodeURIComponent(packageName)}`,
            {
                method: 'HEAD',
                signal: AbortSignal.timeout(5000),
            },
        );
        const exists = response.ok;

        // Cache the result
        await cache.setNpmPackageExistence({
            packageName,
            exists,
            fetchedAt: Date.now(),
        });

        return exists;
    } catch {
        // Network error - don't cache, assume public to be safe
        // (we don't want to accidentally extract all of node_modules due to network issues)
        return true;
    }
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
    let checked = 0;

    // Process in batches
    for (let i = 0; i < packageNames.length; i += concurrency) {
        const batch = packageNames.slice(i, i + concurrency);
        const results = await Promise.all(
            batch.map(async (pkg) => {
                const isPublic = await isPublicNpmPackage(pkg);
                return { pkg, isPublic };
            }),
        );

        for (const { pkg, isPublic } of results) {
            checked++;
            if (!isPublic) {
                internalPackages.add(pkg);
            }
            onProgress?.(checked, packageNames.length, pkg, !isPublic);
        }
    }

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
 * - {package}/package.json
 * - {package}/src/index.{ts,tsx,js,jsx}
 * - {package}/index.{ts,tsx,js,jsx}
 * - {package}/src/... (directory containing source files)
 *
 * Returns a map of package name -> package root path
 */
function detectWorkspacePackageRoots(
    sourceFiles: SourceFile[],
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
    sourceFiles: SourceFile[],
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
    let checked = 0;
    const totalToCheck = packagesNeedingNpmCheck.length;

    for (let i = 0; i < packagesNeedingNpmCheck.length; i += concurrency) {
        const batch = packagesNeedingNpmCheck.slice(i, i + concurrency);
        const results = await Promise.all(
            batch.map(async (pkg) => {
                const isPublic = await isPublicNpmPackage(pkg);
                return { pkg, isPublic };
            }),
        );

        for (const { pkg, isPublic } of results) {
            checked++;
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
                onProgress?.(checked, totalToCheck, pkg, 'external');
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
                onProgress?.(checked, totalToCheck, pkg, 'internal');
            }
        }
    }

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
 * e.g., 'sarsaparilla' -> '@fp/sarsaparilla'
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
 * When a source file imports from 'sarsaparilla' but the source map shows the file
 * resolved to 'node_modules/@fp/sarsaparilla/...', we've discovered an alias.
 *
 * @param sourceFiles - All extracted source files with their paths and content
 * @returns Map of aliases to their actual package names
 */
export function detectImportAliases(sourceFiles: SourceFile[]): AliasMap {
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
            // Use caret range for flexibility
            target[packageName] = `^${info.version}`;

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
        devDeps['typescript'] = '^5.0.0';
        scripts['typecheck'] = 'tsc --noEmit';
        scripts['build'] = 'tsc';
    }

    // Add type definitions for detected frameworks
    if (projectConfig?.jsxFramework === 'react' && !deps['@types/react']) {
        devDeps['@types/react'] = '^18.0.0';
        devDeps['@types/react-dom'] = '^18.0.0';
    }

    // Add Node types if Node environment detected
    if (
        (projectConfig?.environment === 'node' ||
            projectConfig?.environment === 'both') &&
        projectConfig?.hasTypeScript
    ) {
        devDeps['@types/node'] = '^20.0.0';
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
    const unknownCount = Object.values(deps).filter((v) => v === '*').length;
    if (unknownCount > 0) {
        notes.push(
            `${unknownCount} packages have unknown versions (*) - consider running with --use-fingerprinting`,
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
 * Analyzes source files to detect project configuration
 */
export function detectProjectConfig(
    sourceFiles: SourceFile[],
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

        // Detect TypeScript/JavaScript
        if (ext === 'ts' || ext === 'tsx') {
            config.hasTypeScript = true;
        }
        if (ext === 'js' || ext === 'jsx') {
            config.hasJavaScript = true;
        }

        // Detect JSX
        if (ext === 'tsx' || ext === 'jsx') {
            config.hasJsx = true;
        }

        // Skip content analysis if no content
        if (!file.content) continue;

        const content = file.content;

        // Detect JSX in content (for .ts/.js files that might have JSX)
        if (
            !config.hasJsx &&
            (/<[A-Z][a-zA-Z]*[\s/>]/.test(content) || /<\/[A-Z]/.test(content))
        ) {
            config.hasJsx = true;
        }

        // Detect JSX framework imports
        if (/from\s+['"]react['"]|require\s*\(\s*['"]react['"]/.test(content)) {
            reactImports++;
        }
        if (
            /from\s+['"]preact['"]|require\s*\(\s*['"]preact['"]/.test(content)
        ) {
            preactImports++;
        }
        if (
            /from\s+['"]solid-js['"]|require\s*\(\s*['"]solid-js['"]/.test(
                content,
            )
        ) {
            solidImports++;
        }
        if (/from\s+['"]vue['"]|require\s*\(\s*['"]vue['"]/.test(content)) {
            vueImports++;
        }

        // Detect module system
        if (
            /\bimport\s+.*\s+from\s+['"]|export\s+(default\s+|{|\*|const|function|class|interface|type)/.test(
                content,
            )
        ) {
            hasEsm = true;
        }
        if (/\brequire\s*\(|module\.exports|exports\.[a-zA-Z]/.test(content)) {
            hasCommonJs = true;
        }

        // Detect environment
        if (
            /\b(document|window|localStorage|sessionStorage|navigator|location|history|fetch|XMLHttpRequest|DOM|HTMLElement)\b/.test(
                content,
            )
        ) {
            hasBrowserApis = true;
        }
        if (
            /\b(process\.env|__dirname|__filename|require\.resolve|Buffer|fs\.|path\.)\b/.test(
                content,
            )
        ) {
            hasNodeApis = true;
        }

        // Detect ES features
        if (/\basync\s+function|\basync\s*\(|await\s+/.test(content)) {
            config.targetFeatures.asyncAwait = true;
        }
        if (/\?\.\s*[a-zA-Z([]/.test(content)) {
            config.targetFeatures.optionalChaining = true;
        }
        if (/\?\?\s*[^?]/.test(content)) {
            config.targetFeatures.nullishCoalescing = true;
        }
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
    /** Import alias (e.g., 'sarsaparilla') */
    alias: string;
    /** Actual package name (e.g., '@fp/sarsaparilla') */
    actualPackage: string;
    /** Path to the package relative to project root (e.g., './navigation/node_modules/@fp/sarsaparilla') */
    relativePath: string;
}

/**
 * Builds alias path mappings from an AliasMap and source files.
 * Finds the actual location of each aliased package in the extracted files.
 *
 * File paths have the structure: {bundleName}/{sourcePath}
 * where sourcePath may contain ../ relative references.
 *
 * We find node_modules packages by:
 * 1. Looking for paths that contain /node_modules/
 * 2. Extracting the bundle prefix (the first path segment)
 * 3. Combining them to form the actual output path
 */
export function buildAliasPathMappings(
    aliasMap: AliasMap | undefined,
    sourceFiles: SourceFile[],
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
    sourceFiles: SourceFile[],
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
    /** Package name as imported (e.g., 'site-kit') */
    name: string;
    /** Relative path from project root (e.g., './navigation/site-kit') */
    relativePath: string;
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
    let path = relativePath.replace(/^\.[\\/]+/, '');

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

    // Determine lib based on environment
    const lib: string[] = [];
    if (
        projectConfig?.targetFeatures.optionalChaining ||
        projectConfig?.targetFeatures.nullishCoalescing
    ) {
        lib.push('ES2020');
    } else if (projectConfig?.targetFeatures.asyncAwait) {
        lib.push('ES2017');
    } else {
        lib.push('ES2015');
    }

    if (
        projectConfig?.environment === 'browser' ||
        projectConfig?.environment === 'both'
    ) {
        lib.push('DOM', 'DOM.Iterable');
    }

    // Determine target
    let target = 'ES2015';
    if (
        projectConfig?.targetFeatures.optionalChaining ||
        projectConfig?.targetFeatures.nullishCoalescing
    ) {
        target = 'ES2020';
    } else if (projectConfig?.targetFeatures.asyncAwait) {
        target = 'ES2017';
    }

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
        extractedSourceFiles?: SourceFile[];
        /** Include pre-release versions when fingerprinting */
        includePrereleases?: boolean;
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
        /** Progress callback for vendor bundle fingerprinting */
        onVendorBundleProgress?: (
            completed: number,
            total: number,
            bundleFilename: string,
        ) => void;
        /** Progress callback for dependency classification */
        onClassificationProgress?: (
            checked: number,
            total: number,
            packageName: string,
            classification: string,
        ) => void;
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
        onPeerDepProgress,
        pageUrl,
        vendorBundles = [],
        onVendorBundleProgress,
        onClassificationProgress,
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
            return {
                packageJson: cachedManifest.packageJson,
                tsconfig: generateTsConfig(
                    aliasPathMappings,
                    projectConfig,
                    vendorBundleDirs,
                    workspacePackages,
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
                const packageFilesMap = new Map<string, SourceFile[]>();
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
                        concurrency: 3,
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

                    let vendorCompleted = 0;
                    const vendorTotal = vendorBundles.length;

                    const vendorResults = await fingerprintVendorBundles(
                        vendorBundleInputs,
                        packagesStillNeedingVersions,
                        {
                            maxVersionsToCheck,
                            minSimilarity: 0.6, // Lower threshold for minified comparison
                            includePrereleases,
                            concurrency: 2,
                            onProgress: (
                                bundleFilename,
                                packageName,
                                result,
                            ) => {
                                vendorCompleted++;
                                onVendorBundleProgress?.(
                                    vendorCompleted,
                                    vendorTotal,
                                    bundleFilename,
                                );
                                if (result && packageName) {
                                    onVersionProgress?.(
                                        'vendor-bundle-matched',
                                        `${bundleFilename} -> ${packageName}@${result.version}`,
                                    );
                                }
                            },
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

    const packageJson = generatePackageJson(
        outputName,
        analysis.dependencies,
        aliasMap,
        projectConfig,
    );
    const tsconfig = generateTsConfig(
        aliasPathMappings,
        projectConfig,
        vendorBundleDirs,
        workspacePackages,
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
