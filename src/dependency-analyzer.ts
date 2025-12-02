import { readFile, readdir, writeFile } from "fs/promises";
import { join, extname } from "path";
import { 
  detectVersions, 
  getPackageFiles,
  type VersionResult,
  type VersionConfidence,
  type VersionSource,
  type SourceFile,
} from "./version-detector.js";
import { findMatchingVersions } from "./source-fingerprint.js";
import { inferPeerDependencyVersions } from "./peer-dependencies.js";
import {
  getCache,
  computeExtractionHash,
  computeOptionsHash,
  computeUrlHash,
  type ExtractedFile,
  type DependencyInfo as CacheDependencyInfo,
} from "./fingerprint-cache.js";

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
  if (importSpecifier.startsWith("@")) {
    // Scoped package: @scope/package/subpath -> @scope/package
    const parts = importSpecifier.split("/");
    return parts.slice(0, 2).join("/");
  }
  // Regular package: package/subpath -> package
  return importSpecifier.split("/")[0];
}

/**
 * Checks if an import specifier is likely a Node.js built-in module
 */
function isBuiltinModule(name: string): boolean {
  const builtins = new Set([
    "assert",
    "buffer",
    "child_process",
    "cluster",
    "console",
    "constants",
    "crypto",
    "dgram",
    "dns",
    "domain",
    "events",
    "fs",
    "http",
    "https",
    "module",
    "net",
    "os",
    "path",
    "perf_hooks",
    "process",
    "punycode",
    "querystring",
    "readline",
    "repl",
    "stream",
    "string_decoder",
    "sys",
    "timers",
    "tls",
    "tty",
    "url",
    "util",
    "v8",
    "vm",
    "wasi",
    "worker_threads",
    "zlib",
    // Node.js prefixed versions
    "node:assert",
    "node:buffer",
    "node:child_process",
    "node:cluster",
    "node:console",
    "node:constants",
    "node:crypto",
    "node:dgram",
    "node:dns",
    "node:domain",
    "node:events",
    "node:fs",
    "node:http",
    "node:https",
    "node:module",
    "node:net",
    "node:os",
    "node:path",
    "node:perf_hooks",
    "node:process",
    "node:punycode",
    "node:querystring",
    "node:readline",
    "node:repl",
    "node:stream",
    "node:string_decoder",
    "node:sys",
    "node:timers",
    "node:tls",
    "node:tty",
    "node:url",
    "node:util",
    "node:v8",
    "node:vm",
    "node:wasi",
    "node:worker_threads",
    "node:zlib",
  ]);
  return builtins.has(name) || builtins.has(name.split("/")[0]);
}

/**
 * Extracts all external package imports from a source file
 */
function extractImportsFromSource(
  content: string,
  _filePath: string
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
      if (entry.name === "node_modules") {
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
  return [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"].includes(ext);
}

/**
 * Extracts version information from source map paths in the manifest
 */
export function extractVersionsFromManifest(
  manifestBundles: Array<{ files: string[] }>
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
 * Analyzes all source files in a directory and extracts dependencies
 */
export async function analyzeDependencies(
  sourceDir: string,
  onProgress?: (file: string) => void
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
        const content = await readFile(filePath, "utf-8");
        const imports = extractImportsFromSource(content, filePath);

        for (const packageName of imports) {
          if (result.dependencies.has(packageName)) {
            result.dependencies.get(packageName)!.importedFrom.push(filePath);
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
 * Merges version information into dependency analysis results
 */
export function mergeVersionInfo(
  dependencies: Map<string, DependencyInfo>,
  versions: Map<string, string>
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
  files: Array<{ path: string; content: string }>
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
  files: Array<{ path: string; content: string }>
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
  bannerVersions: Map<string, string>
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
          if (pkgName === bannerName || pkgName.includes(bannerName)) {
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
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      }
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
  onProgress?: (completed: number, total: number, packageName: string) => void
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
      })
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
 * Checks if a package is likely a private/internal package
 */
function isLikelyPrivatePackage(packageName: string): boolean {
  // Common patterns for internal packages
  const privatePatterns = [
    /^@internal\//,
    /^@private\//,
    /-internal$/,
    /^(shared-ui|site-kit|ui-|sarsaparilla)/,
  ];
  
  return privatePatterns.some((pattern) => pattern.test(packageName));
}

/**
 * Generates a package.json object from analysis results
 */
export function generatePackageJson(
  name: string,
  dependencies: Map<string, DependencyInfo>
): object {
  const deps: Record<string, string> = {};
  const privateDeps: Record<string, string> = {};
  const versionMeta: Record<string, { confidence: string; source: string }> = {};

  // Sort dependencies alphabetically
  const sortedDeps = Array.from(dependencies.entries()).sort((a, b) =>
    a[0].localeCompare(b[0])
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
      target[packageName] = "workspace:*";
    } else {
      // Mark as unknown for manual resolution
      target[packageName] = "*";
    }
  }

  const result: Record<string, unknown> = {
    name: name,
    version: "0.0.0-reconstructed",
    private: true,
    description: "Reconstructed from source maps",
    dependencies: deps,
  };

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
    notes.push("Internal dependencies (_internalDependencies) are likely workspace packages that need manual setup");
  }
  if (Object.keys(versionMeta).length > 0) {
    notes.push("Version confidence metadata available in _versionMeta (exact/high/medium/low/unverified)");
  }
  const unknownCount = Object.values(deps).filter(v => v === '*').length;
  if (unknownCount > 0) {
    notes.push(`${unknownCount} packages have unknown versions (*) - consider running with --use-fingerprinting`);
  }
  
  if (notes.length > 0) {
    result._notes = notes;
  }

  return result;
}

/**
 * Writes the generated package.json to disk
 */
export async function writePackageJson(
  outputPath: string,
  packageJson: object
): Promise<void> {
  await writeFile(outputPath, JSON.stringify(packageJson, null, 2) + "\n", "utf-8");
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
 * Main function to analyze a reconstructed source directory and generate package.json.
 * Results are cached based on extraction hash and options.
 */
export async function generateDependencyManifest(
  sourceDir: string,
  manifestPath: string | null,
  outputName: string,
  options: {
    onProgress?: (file: string) => void;
    onVersionProgress?: (stage: string, packageName: string, result?: VersionResult) => void;
    /** Use source fingerprinting to match against npm versions */
    useFingerprinting?: boolean;
    /** Maximum versions to check during fingerprinting (0 = all) */
    maxVersionsToCheck?: number;
    /** Fallback to npm latest as last resort */
    fetchFromNpm?: boolean;
    onNpmProgress?: (completed: number, total: number, packageName: string) => void;
    /** Progress callback for fingerprinting */
    onFingerprintProgress?: (completed: number, total: number, packageName: string) => void;
    /** Raw source files from extraction (used to get versions from package.json files) */
    extractedSourceFiles?: SourceFile[];
    /** Include pre-release versions when fingerprinting */
    includePrereleases?: boolean;
    /** Progress callback for peer dependency inference */
    onPeerDepProgress?: (completed: number, total: number, packageName: string) => void;
    /** Page URL for cache keying */
    pageUrl?: string;
  } = {}
): Promise<{
  packageJson: object;
  stats: VersionStats;
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
  } = options;

  const cache = getCache();

  // Compute cache keys
  let extractionHash = '';
  if (extractedSourceFiles && extractedSourceFiles.length > 0) {
    extractionHash = computeExtractionHash(extractedSourceFiles as ExtractedFile[]);
  }
  
  const optionsHash = computeOptionsHash({
    useFingerprinting,
    includePrereleases,
    fetchFromNpm,
  });
  
  const urlHash = pageUrl ? computeUrlHash(pageUrl) : computeUrlHash(sourceDir);

  // Check for cached manifest result
  if (extractionHash) {
    const cachedManifest = await cache.getDependencyManifest(urlHash, extractionHash, optionsHash);
    if (cachedManifest) {
      return {
        packageJson: cachedManifest.packageJson,
        stats: cachedManifest.stats as VersionStats,
      };
    }
  }

  // Analyze source files for imports
  const analysis = await analyzeDependencies(sourceDir, onProgress);

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

  // Mark likely private packages first
  for (const [packageName, info] of analysis.dependencies) {
    if (isLikelyPrivatePackage(packageName)) {
      info.isPrivate = true;
      stats.privatePackages++;
    }
  }

  // ============================================
  // VERSION DETECTION PIPELINE
  // ============================================

  if (extractedSourceFiles && extractedSourceFiles.length > 0) {
    // Get list of packages that need version detection (non-private)
    const packagesNeedingVersions = Array.from(analysis.dependencies.entries())
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
      }
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
          case 'package.json': stats.bySource.packageJson++; break;
          case 'banner': stats.bySource.banner++; break;
          case 'lockfile-path': stats.bySource.lockfilePath++; break;
          case 'version-constant': stats.bySource.versionConstant++; break;
          case 'sourcemap-path': stats.bySource.sourcemapPath++; break;
        }
        stats.byConfidence[result.confidence]++;
      }
    }

    // -----------------------------------------
    // Tier 2: Legacy package.json extraction (for completeness)
    // -----------------------------------------
    const sourceVersions = extractVersionsFromSourceFiles(extractedSourceFiles);
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
    // -----------------------------------------
    const bannerVersions = extractVersionsFromBanners(extractedSourceFiles);
    matchBannerVersionsToDependencies(analysis.dependencies, bannerVersions);

    // -----------------------------------------
    // Tier 4: Source fingerprinting (if enabled)
    // -----------------------------------------
    if (useFingerprinting) {
      const packagesStillNeedingVersions = Array.from(analysis.dependencies.entries())
        .filter(([_, info]) => !info.version && !info.isPrivate)
        .map(([name]) => name);

      if (packagesStillNeedingVersions.length > 0) {
        onVersionProgress?.('fingerprinting', `Fingerprinting ${packagesStillNeedingVersions.length} packages...`);

        // Build map of package -> files for fingerprinting
        const packageFilesMap = new Map<string, SourceFile[]>();
        for (const packageName of packagesStillNeedingVersions) {
          const files = getPackageFiles(extractedSourceFiles, packageName);
          if (files.length > 0) {
            packageFilesMap.set(packageName, files);
          }
        }

        let fingerprintCompleted = 0;
        const fingerprintTotal = packageFilesMap.size;
        
        const fingerprintResults = await findMatchingVersions(packageFilesMap, {
          maxVersionsToCheck, // 0 = all versions (new default)
          minSimilarity: 0.7,
          concurrency: 3,
          includePrereleases,
          onProgress: (packageName, result) => {
            fingerprintCompleted++;
            onFingerprintProgress?.(fingerprintCompleted, fingerprintTotal, packageName);
            if (result) {
              onVersionProgress?.('fingerprinted', packageName, result);
            }
          },
          onDetailedProgress: (packageName, version, versionIndex, versionTotal) => {
            onVersionProgress?.('fingerprint-check', `${packageName}@${version} (${versionIndex}/${versionTotal})`);
          },
        });

        // Apply fingerprint results
        for (const [packageName, result] of fingerprintResults) {
          const dep = analysis.dependencies.get(packageName);
          if (dep && !dep.version) {
            dep.version = result.version;
            dep.confidence = result.confidence;
            dep.versionSource = 'fingerprint';
            stats.bySource.fingerprint++;
            stats.byConfidence[result.confidence]++;
          }
        }
      }
    }

    // -----------------------------------------
    // Tier 5: Peer dependency inference
    // -----------------------------------------
    // Build map of known versions for peer dep inference
    const knownVersions = new Map<string, { name: string; version: string; confidence: VersionConfidence }>();
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
    const packagesForPeerInference = Array.from(analysis.dependencies.entries())
      .filter(([_, info]) => !info.version && !info.isPrivate)
      .map(([name]) => name);

    if (packagesForPeerInference.length > 0 && knownVersions.size > 0) {
      onVersionProgress?.('peer-dep', `Inferring versions for ${packagesForPeerInference.length} packages from peer dependencies...`);

      let peerDepCompleted = 0;
      const peerDepTotal = packagesForPeerInference.length;

      const peerDepResults = await inferPeerDependencyVersions(
        packagesForPeerInference,
        knownVersions,
        {
          onProgress: (packageName, result) => {
            peerDepCompleted++;
            onPeerDepProgress?.(peerDepCompleted, peerDepTotal, packageName);
            if (result) {
              onVersionProgress?.('peer-dep-inferred', packageName, result);
            }
          },
        }
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
      const manifestContent = await readFile(manifestPath, "utf-8");
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
    const packagesStillNeedingVersions = Array.from(analysis.dependencies.entries())
      .filter(([_, info]) => info.version === null && !info.isPrivate)
      .map(([name]) => name);

    if (packagesStillNeedingVersions.length > 0) {
      onVersionProgress?.('npm', `Fetching ${packagesStillNeedingVersions.length} from npm...`);
      
      const npmVersions = await fetchNpmVersions(
        packagesStillNeedingVersions,
        10,
        onNpmProgress
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
  stats.withVersion = Array.from(analysis.dependencies.values())
    .filter(d => d.version !== null).length;
  stats.withoutVersion = stats.totalDependencies - stats.withVersion - stats.privatePackages;

  const packageJson = generatePackageJson(outputName, analysis.dependencies);

  // Cache the result for next time
  if (extractionHash) {
    await cache.setDependencyManifest(urlHash, extractionHash, optionsHash, packageJson, stats);
  }

  return {
    packageJson,
    stats,
  };
}
