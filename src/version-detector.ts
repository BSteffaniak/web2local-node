/**
 * Version detection pipeline with confidence-based ranking
 * Tries multiple detection methods and returns the highest confidence result
 */

export type VersionConfidence = 'exact' | 'high' | 'medium' | 'low' | 'unverified';

export type VersionSource = 
  | 'package.json'
  | 'banner'
  | 'lockfile-path'
  | 'version-constant'
  | 'sourcemap-path'
  | 'peer-dep'
  | 'fingerprint'
  | 'npm-latest';

export interface VersionResult {
  version: string;
  confidence: VersionConfidence;
  source: VersionSource;
}

export interface SourceFile {
  path: string;
  content: string;
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
  packageName: string
): VersionResult | null {
  for (const pattern of LOCKFILE_PATH_PATTERNS) {
    const match = filePath.match(pattern);
    if (match) {
      const detectedName = match[1].replace(/^@/, '').toLowerCase();
      const normalizedPackageName = packageName.replace(/^@/, '').toLowerCase();
      
      // Check if the detected name matches the package we're looking for
      if (detectedName === normalizedPackageName || 
          detectedName.endsWith('/' + normalizedPackageName) ||
          normalizedPackageName.endsWith('/' + detectedName)) {
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
  packageName: string
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
  _packageName: string
): VersionResult | null {
  // Only check the first 5000 chars and last 1000 chars where version constants usually are
  const searchContent = content.slice(0, 5000) + content.slice(-1000);
  
  for (const pattern of VERSION_CONSTANT_PATTERNS) {
    const match = searchContent.match(pattern);
    if (match) {
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
  packageName: string
): VersionResult | null {
  // Only check the first 1500 chars where banners usually are
  const header = content.slice(0, 1500);
  
  for (const pattern of BANNER_PATTERNS) {
    const match = header.match(pattern);
    if (match) {
      // Pattern with package name
      if (match.length === 3) {
        const bannerName = match[1].toLowerCase();
        const pkgNameLower = packageName.toLowerCase();
        const pkgBaseName = pkgNameLower.split('/').pop() || pkgNameLower;
        
        // Check if banner name matches package name
        if (bannerName === pkgNameLower || 
            bannerName === pkgBaseName ||
            pkgBaseName.includes(bannerName) ||
            bannerName.includes(pkgBaseName)) {
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
 */
export function getPackageFiles(
  files: SourceFile[],
  packageName: string
): SourceFile[] {
  const packageFiles: SourceFile[] = [];
  const normalizedName = packageName.toLowerCase();
  
  for (const file of files) {
    const pathLower = file.path.toLowerCase();
    
    // Check if this file is from the target package's node_modules
    if (pathLower.includes('node_modules/')) {
      const extractedPkgName = extractPackageNameFromPath(file.path);
      if (extractedPkgName && extractedPkgName.toLowerCase() === normalizedName) {
        packageFiles.push(file);
      }
    }
  }
  
  return packageFiles;
}

/**
 * Main version detection function - tries all methods in order of confidence
 */
export function detectVersion(
  packageName: string,
  packageFiles: SourceFile[],
  _allFiles: SourceFile[]
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
  
  // 3. Check for license banners (high confidence)
  for (const file of packageFiles) {
    const result = detectVersionFromBanner(file.content, packageName);
    if (result) return result;
  }
  
  // 4. Check for VERSION constants (medium confidence)
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
  allFiles: SourceFile[],
  onProgress?: (packageName: string, result: VersionResult | null) => void
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
