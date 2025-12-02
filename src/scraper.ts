import { parse as parseHTML } from "node-html-parser";
import { getCache } from "./fingerprint-cache.js";

export interface BundleInfo {
  url: string;
  type: "script" | "stylesheet";
  sourceMapUrl?: string;
}

/**
 * Represents a vendor bundle (minified JS) without a source map
 * These typically contain third-party libraries bundled into a single file
 */
export interface VendorBundle {
  url: string;
  filename: string;
  content: string;
  /** Inferred package name from filename (e.g., "lodash" from "lodash-Dhg5Ny8x.js") */
  inferredPackage?: string;
}

/**
 * Fetches HTML from a URL and extracts all JS/CSS bundle URLs.
 * Results are cached to avoid re-fetching on subsequent runs.
 */
export async function extractBundleUrls(pageUrl: string): Promise<BundleInfo[]> {
  const cache = getCache();
  
  // Check cache first
  const cached = await cache.getPageScraping(pageUrl);
  if (cached) {
    return cached.bundles;
  }

  const response = await fetch(pageUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${pageUrl}: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  const root = parseHTML(html);
  const baseUrl = new URL(pageUrl);
  const bundles: BundleInfo[] = [];

  // Extract script tags
  const scripts = root.querySelectorAll('script[src]');
  for (const script of scripts) {
    const src = script.getAttribute('src');
    if (src && (src.endsWith('.js') || src.includes('.js?'))) {
      const absoluteUrl = resolveUrl(src, baseUrl);
      bundles.push({
        url: absoluteUrl,
        type: 'script',
      });
    }
  }

  // Extract modulepreload links (common in Vite builds)
  const modulePreloads = root.querySelectorAll('link[rel="modulepreload"]');
  for (const link of modulePreloads) {
    const href = link.getAttribute('href');
    if (href) {
      const absoluteUrl = resolveUrl(href, baseUrl);
      // Avoid duplicates
      if (!bundles.some(b => b.url === absoluteUrl)) {
        bundles.push({
          url: absoluteUrl,
          type: 'script',
        });
      }
    }
  }

  // Extract stylesheet links
  const stylesheets = root.querySelectorAll('link[rel="stylesheet"]');
  for (const link of stylesheets) {
    const href = link.getAttribute('href');
    if (href && (href.endsWith('.css') || href.includes('.css?'))) {
      const absoluteUrl = resolveUrl(href, baseUrl);
      bundles.push({
        url: absoluteUrl,
        type: 'stylesheet',
      });
    }
  }

  // Cache the result
  await cache.setPageScraping(pageUrl, bundles);

  return bundles;
}

/**
 * Resolves a potentially relative URL against a base URL
 */
function resolveUrl(url: string, baseUrl: URL): string {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }
  if (url.startsWith('//')) {
    return `${baseUrl.protocol}${url}`;
  }
  if (url.startsWith('/')) {
    return `${baseUrl.origin}${url}`;
  }
  // Relative URL
  return new URL(url, baseUrl).href;
}

/**
 * Result of checking a bundle for source maps
 */
export interface SourceMapCheckResult {
  sourceMapUrl: string | null;
  /** The bundle content (only populated if no source map found and bundle looks like vendor) */
  bundleContent?: string;
}

/**
 * Checks if a bundle has an associated source map and returns its URL.
 * Also returns the bundle content for vendor bundles without source maps.
 * Results are cached to avoid re-fetching on subsequent runs.
 */
export async function findSourceMapUrl(bundleUrl: string): Promise<SourceMapCheckResult> {
  const cache = getCache();
  
  // Check cache first
  const cached = await cache.getSourceMapDiscovery(bundleUrl);
  if (cached) {
    return { sourceMapUrl: cached.sourceMapUrl };
  }

  let sourceMapUrl: string | null = null;

  try {
    const response = await fetch(bundleUrl);
    if (!response.ok) {
      // Cache negative result
      await cache.setSourceMapDiscovery(bundleUrl, null);
      return { sourceMapUrl: null };
    }

    // Check SourceMap header
    const sourceMapHeader = response.headers.get('SourceMap') || response.headers.get('X-SourceMap');
    if (sourceMapHeader) {
      sourceMapUrl = resolveUrl(sourceMapHeader, new URL(bundleUrl));
      await cache.setSourceMapDiscovery(bundleUrl, sourceMapUrl);
      return { sourceMapUrl };
    }

    const text = await response.text();
    
    // Check for sourceMappingURL comment at the end
    const jsMatch = text.match(/\/\/[#@]\s*sourceMappingURL=(\S+)\s*$/);
    const cssMatch = text.match(/\/\*[#@]\s*sourceMappingURL=(\S+)\s*\*\/\s*$/);
    
    const match = jsMatch || cssMatch;
    if (match) {
      const mapUrl = match[1];
      sourceMapUrl = resolveUrl(mapUrl, new URL(bundleUrl));
      await cache.setSourceMapDiscovery(bundleUrl, sourceMapUrl);
      return { sourceMapUrl };
    }

    // Try appending .map as a fallback
    const mapUrl = bundleUrl + '.map';
    const mapResponse = await fetch(mapUrl, { method: 'HEAD' });
    if (mapResponse.ok) {
      sourceMapUrl = mapUrl;
      await cache.setSourceMapDiscovery(bundleUrl, sourceMapUrl);
      return { sourceMapUrl };
    }

    // Cache negative result
    await cache.setSourceMapDiscovery(bundleUrl, null);
    
    // No source map found - return bundle content for potential vendor bundle analysis
    // Only return content for JS files (not CSS)
    if (bundleUrl.endsWith('.js') || bundleUrl.includes('.js?')) {
      return { sourceMapUrl: null, bundleContent: text };
    }
    
    return { sourceMapUrl: null };
  } catch (error) {
    // Cache negative result on error
    await cache.setSourceMapDiscovery(bundleUrl, null);
    return { sourceMapUrl: null };
  }
}

/**
 * Result from processing all bundles for source maps
 */
export interface SourceMapSearchResult {
  /** Bundles that have associated source maps */
  bundlesWithMaps: BundleInfo[];
  /** Vendor bundles without source maps (for fingerprinting) */
  vendorBundles: VendorBundle[];
}

/**
 * Extracts package name from a vendor bundle filename.
 * Common patterns:
 *   - lodash-Dhg5Ny8x.js -> lodash
 *   - chunk-react-dom-ABCD1234.js -> react-dom
 *   - vendor~react~react-dom.js -> react, react-dom (returns first)
 *   - date-fns-CxYz1234.js -> date-fns
 *   - @turf-boolean-contains-abcd.js -> @turf/boolean-contains
 */
function extractPackageNameFromFilename(filename: string): string | undefined {
  // Remove file extension and query params
  let base = filename.replace(/\.js(\?.*)?$/, '');
  
  // Remove common chunk prefixes
  base = base.replace(/^(chunk[-_]?|vendor[-_~]?|lib[-_]?)/, '');
  
  // Remove common hash suffixes (various patterns)
  // Pattern: name-HASH where HASH is alphanumeric 6-12 chars
  base = base.replace(/[-_.][a-zA-Z0-9]{6,12}$/, '');
  
  // Handle scoped packages encoded as @scope-package -> @scope/package
  if (base.startsWith('@')) {
    const parts = base.split('-');
    if (parts.length >= 2) {
      // @turf-boolean-contains -> @turf/boolean-contains
      const scope = parts[0];
      const rest = parts.slice(1).join('-');
      return `${scope}/${rest}`;
    }
  }
  
  // Handle vendor~package1~package2 format (webpack)
  if (base.includes('~')) {
    const parts = base.split('~').filter(p => p && !p.startsWith('chunk'));
    if (parts.length > 0) {
      return parts[0];
    }
  }
  
  // Return if it looks like a valid package name
  if (base && /^[@a-z][\w\-./]*$/i.test(base)) {
    return base.toLowerCase();
  }
  
  return undefined;
}

/**
 * Determines if a bundle looks like a vendor chunk based on filename and content heuristics.
 */
function looksLikeVendorBundle(filename: string, content: string): boolean {
  const lowerFilename = filename.toLowerCase();
  
  // Check filename patterns
  const vendorFilenamePatterns = [
    /vendor/i,
    /chunk[-_]/i,
    /^(lodash|react|vue|angular|jquery|moment|date-fns|axios|uuid)/i,
    /^@/,  // Scoped packages
    /[-_][a-z0-9]{6,12}\.js$/i,  // Hash suffix pattern
  ];
  
  if (vendorFilenamePatterns.some(p => p.test(lowerFilename))) {
    return true;
  }
  
  // Check content heuristics for minified vendor code
  // Minified code typically has very long lines
  const lines = content.split('\n');
  const avgLineLength = content.length / lines.length;
  
  // Minified bundles usually have avg line length > 500
  if (avgLineLength > 500 && lines.length < 50) {
    return true;
  }
  
  return false;
}

/**
 * Processes all bundles and finds their source maps.
 * Also collects vendor bundles without source maps for fingerprinting.
 */
export async function findAllSourceMaps(
  bundles: BundleInfo[],
  concurrency: number = 5,
  onProgress?: (completed: number, total: number) => void
): Promise<SourceMapSearchResult> {
  const bundlesWithMaps: BundleInfo[] = [];
  const vendorBundles: VendorBundle[] = [];
  let completed = 0;

  // Process in batches for concurrency control
  for (let i = 0; i < bundles.length; i += concurrency) {
    const batch = bundles.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (bundle) => {
        const result = await findSourceMapUrl(bundle.url);
        completed++;
        onProgress?.(completed, bundles.length);
        return {
          bundle,
          result,
        };
      })
    );
    
    for (const { bundle, result } of batchResults) {
      if (result.sourceMapUrl) {
        // Bundle has a source map
        bundlesWithMaps.push({
          ...bundle,
          sourceMapUrl: result.sourceMapUrl,
        });
      } else if (result.bundleContent && bundle.type === 'script') {
        // No source map - check if it's a vendor bundle worth fingerprinting
        const filename = bundle.url.split('/').pop() || bundle.url;
        
        if (looksLikeVendorBundle(filename, result.bundleContent)) {
          const inferredPackage = extractPackageNameFromFilename(filename);
          vendorBundles.push({
            url: bundle.url,
            filename,
            content: result.bundleContent,
            inferredPackage,
          });
        }
      }
    }
  }

  return { bundlesWithMaps, vendorBundles };
}
