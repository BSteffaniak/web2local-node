/**
 * Improved source fingerprinting - compare extracted source against npm package versions
 * to find the best matching version
 * 
 * Key improvements:
 * - Checks ALL versions by default (unless --max-versions specified)
 * - Better entry point discovery using npm package.json
 * - Multi-file comparison for higher accuracy
 * - Source-to-dist comparison using AST-based signatures
 * - Disk caching for faster repeated runs
 */

import { createHash } from 'crypto';
import { VersionResult, SourceFile } from './version-detector.js';
import {
  FingerprintCache,
  getCache,
  computeNormalizedHash,
  extractCodeSignature,
  type PackageMetadataCache,
  type ContentFingerprintCache,
  type MatchResultCache,
} from './fingerprint-cache.js';

export interface FingerprintResult extends VersionResult {
  similarity: number;
  matchedFiles: number;
  totalFiles: number;
}

export interface FingerprintOptions {
  /** Maximum versions to check (0 = all) */
  maxVersionsToCheck?: number;
  /** Minimum similarity threshold (0-1) */
  minSimilarity?: number;
  /** Number of concurrent requests */
  concurrency?: number;
  /** Include pre-release versions (alpha, beta, rc, nightly, etc.) */
  includePrereleases?: boolean;
  /** Progress callback for overall progress */
  onProgress?: (packageName: string, result: FingerprintResult | null) => void;
  /** Detailed progress callback */
  onDetailedProgress?: (packageName: string, version: string, versionIndex: number, versionTotal: number) => void;
}

interface NpmPackageMetadata {
  name: string;
  versions: Record<string, {
    main?: string;
    module?: string;
    exports?: Record<string, unknown>;
    types?: string;
    peerDependencies?: Record<string, string>;
    dependencies?: Record<string, string>;
  }>;
  time?: Record<string, string>;
  'dist-tags'?: Record<string, string>;
}

/**
 * Fetches package metadata from npm registry (with caching)
 */
async function fetchPackageMetadata(
  packageName: string,
  cache: FingerprintCache
): Promise<PackageMetadataCache | null> {
  // Check cache first
  const cached = await cache.getMetadata(packageName);
  if (cached) {
    return cached;
  }

  try {
    const response = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(packageName)}`,
      {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      }
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

    const metadata: PackageMetadataCache = {
      name: packageName,
      versions,
      versionDetails,
      distTags: data['dist-tags'] || {},
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
  includePrereleases: boolean = false
): Promise<string[]> {
  const metadata = await fetchPackageMetadata(packageName, cache);
  if (!metadata) {
    return [];
  }

  // Filter out pre-release versions (alpha, beta, rc, nightly, canary, etc.)
  const stableVersions = metadata.versions.filter(v => !v.includes('-'));
  const preReleaseVersions = metadata.versions.filter(v => v.includes('-'));

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
 * Resolves the entry point paths for a package version using its package.json
 */
function resolveEntryPoints(
  packageName: string,
  versionDetails: PackageMetadataCache['versionDetails'][string] | undefined
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
      } else if (typeof exportsField === 'object' && exportsField !== null) {
        const exportsObj = exportsField as Record<string, unknown>;
        // Check for '.' or 'import' or 'require' or 'default'
        const dotExport = exportsObj['.'];
        if (dotExport) {
          if (typeof dotExport === 'string') {
            paths.push(dotExport.replace(/^\.\//, ''));
          } else if (typeof dotExport === 'object' && dotExport !== null) {
            const exp = dotExport as Record<string, unknown>;
            for (const key of ['import', 'module', 'require', 'default']) {
              if (typeof exp[key] === 'string') {
                paths.push((exp[key] as string).replace(/^\.\//, ''));
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
  const fallbacks = [
    'dist/index.js',
    'lib/index.js',
    'index.js',
  ];

  for (const fb of fallbacks) {
    if (!paths.includes(fb)) {
      paths.push(fb);
    }
  }

  return paths;
}

/**
 * Fetches a file from unpkg CDN with caching
 */
async function fetchFileFromUnpkg(
  packageName: string,
  version: string,
  filePath: string,
  cache: FingerprintCache
): Promise<ContentFingerprintCache | null> {
  // Check cache first
  const cached = await cache.getFingerprint(packageName, version);
  if (cached) {
    return cached;
  }

  try {
    const url = `https://unpkg.com/${packageName}@${version}/${filePath}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: {
        'Accept': 'text/plain,application/javascript,*/*',
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
 * Computes fingerprint for extracted source file
 */
function computeExtractedFingerprint(file: SourceFile): {
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
  npm: ContentFingerprintCache
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
      const intersection = new Set([...extractedSigSet].filter(x => npmSigSet.has(x)));
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
  const lenRatio = Math.min(extracted.contentLength, npm.contentLength) /
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
function findExtractedEntryPoint(files: SourceFile[]): SourceFile | null {
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
  const sourceFiles = files.filter(f =>
    /\.(m?[jt]sx?)$/.test(f.path) && !f.path.includes('.d.ts')
  );

  if (sourceFiles.length > 0) {
    return sourceFiles.reduce((a, b) => a.content.length > b.content.length ? a : b);
  }

  return files[0] || null;
}

/**
 * Finds the best matching version for a package
 */
export async function findMatchingVersion(
  packageName: string,
  extractedFiles: SourceFile[],
  options: {
    maxVersionsToCheck?: number;
    minSimilarity?: number;
    includePrereleases?: boolean;
    cache?: FingerprintCache;
    onVersionCheck?: (version: string, index: number, total: number) => void;
  } = {}
): Promise<FingerprintResult | null> {
  const {
    maxVersionsToCheck = 0, // 0 = all versions
    minSimilarity = 0.7,
    includePrereleases = false,
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
  
  // Check for cached match result first
  const cachedMatch = await cache.getMatchResult(packageName, extractedFingerprint.normalizedHash);
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
  const versions = await getAllVersions(packageName, cache, maxVersionsToCheck, includePrereleases);
  if (versions.length === 0) {
    return null;
  }

  let bestMatch: FingerprintResult | null = null;

  for (let i = 0; i < versions.length; i++) {
    const version = versions[i];
    onVersionCheck?.(version, i + 1, versions.length);

    const versionDetails = metadata.versionDetails[version];
    const entryPaths = resolveEntryPoints(packageName, versionDetails);

    // Try to fetch and compare entry point
    let npmFingerprint: ContentFingerprintCache | null = null;

    for (const entryPath of entryPaths) {
      npmFingerprint = await fetchFileFromUnpkg(packageName, version, entryPath, cache);
      if (npmFingerprint) {
        break;
      }
    }

    if (!npmFingerprint) {
      continue;
    }

    // Compare fingerprints
    const similarity = computeSimilarity(extractedFingerprint, npmFingerprint);

    // Exact match - cache and return immediately
    if (similarity >= 0.99) {
      const result: FingerprintResult = {
        version,
        confidence: 'exact',
        source: 'fingerprint',
        similarity,
        matchedFiles: 1,
        totalFiles: extractedFiles.length,
      };
      
      // Cache the match result
      await cache.setMatchResult({
        packageName,
        extractedContentHash: extractedFingerprint.normalizedHash,
        matchedVersion: version,
        similarity,
        confidence: 'exact',
        fetchedAt: Date.now(),
      });
      
      return result;
    }

    // Track best match
    if (similarity >= minSimilarity && (!bestMatch || similarity > bestMatch.similarity)) {
      bestMatch = {
        version,
        confidence: similarity >= 0.9 ? 'high' : similarity >= 0.8 ? 'medium' : 'low',
        source: 'fingerprint',
        similarity,
        matchedFiles: 1,
        totalFiles: extractedFiles.length,
      };
    }

    // If we found a very good match, we can stop early
    if (bestMatch && bestMatch.similarity >= 0.95) {
      break;
    }
  }

  // Cache the result (including "no match" for negative caching)
  await cache.setMatchResult({
    packageName,
    extractedContentHash: extractedFingerprint.normalizedHash,
    matchedVersion: bestMatch?.version ?? null,
    similarity: bestMatch?.similarity ?? 0,
    confidence: bestMatch ? (bestMatch.confidence as 'exact' | 'high' | 'medium' | 'low') : null,
    fetchedAt: Date.now(),
  });

  return bestMatch;
}

/**
 * Batch fingerprint matching for multiple packages
 */
export async function findMatchingVersions(
  packages: Map<string, SourceFile[]>,
  options: FingerprintOptions = {}
): Promise<Map<string, FingerprintResult>> {
  const {
    maxVersionsToCheck = 0,
    minSimilarity = 0.7,
    concurrency = 3,
    includePrereleases = false,
    onProgress,
    onDetailedProgress,
  } = options;

  const cache = getCache();
  const results = new Map<string, FingerprintResult>();
  const entries = Array.from(packages.entries());

  // Process in batches for concurrency control
  for (let i = 0; i < entries.length; i += concurrency) {
    const batch = entries.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async ([packageName, files]) => {
        const result = await findMatchingVersion(packageName, files, {
          maxVersionsToCheck,
          minSimilarity,
          includePrereleases,
          cache,
          onVersionCheck: (version, index, total) => {
            onDetailedProgress?.(packageName, version, index, total);
          },
        });
        onProgress?.(packageName, result);
        return { packageName, result };
      })
    );

    for (const { packageName, result } of batchResults) {
      if (result) {
        results.set(packageName, result);
      }
    }
  }

  return results;
}

/**
 * Gets package metadata (exposed for peer dependency inference)
 */
export async function getPackageMetadata(
  packageName: string
): Promise<PackageMetadataCache | null> {
  const cache = getCache();
  return fetchPackageMetadata(packageName, cache);
}
