import { parse as parseHTML } from "node-html-parser";
import { getCache } from "./fingerprint-cache.js";

export interface BundleInfo {
  url: string;
  type: "script" | "stylesheet";
  sourceMapUrl?: string;
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
 * Checks if a bundle has an associated source map and returns its URL.
 * Results are cached to avoid re-fetching on subsequent runs.
 */
export async function findSourceMapUrl(bundleUrl: string): Promise<string | null> {
  const cache = getCache();
  
  // Check cache first
  const cached = await cache.getSourceMapDiscovery(bundleUrl);
  if (cached) {
    return cached.sourceMapUrl;
  }

  let sourceMapUrl: string | null = null;

  try {
    const response = await fetch(bundleUrl);
    if (!response.ok) {
      // Cache negative result
      await cache.setSourceMapDiscovery(bundleUrl, null);
      return null;
    }

    // Check SourceMap header
    const sourceMapHeader = response.headers.get('SourceMap') || response.headers.get('X-SourceMap');
    if (sourceMapHeader) {
      sourceMapUrl = resolveUrl(sourceMapHeader, new URL(bundleUrl));
      await cache.setSourceMapDiscovery(bundleUrl, sourceMapUrl);
      return sourceMapUrl;
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
      return sourceMapUrl;
    }

    // Try appending .map as a fallback
    const mapUrl = bundleUrl + '.map';
    const mapResponse = await fetch(mapUrl, { method: 'HEAD' });
    if (mapResponse.ok) {
      sourceMapUrl = mapUrl;
      await cache.setSourceMapDiscovery(bundleUrl, sourceMapUrl);
      return sourceMapUrl;
    }

    // Cache negative result
    await cache.setSourceMapDiscovery(bundleUrl, null);
    return null;
  } catch (error) {
    // Cache negative result on error
    await cache.setSourceMapDiscovery(bundleUrl, null);
    return null;
  }
}

/**
 * Processes all bundles and finds their source maps
 */
export async function findAllSourceMaps(
  bundles: BundleInfo[],
  concurrency: number = 5,
  onProgress?: (completed: number, total: number) => void
): Promise<BundleInfo[]> {
  const results: BundleInfo[] = [];
  let completed = 0;

  // Process in batches for concurrency control
  for (let i = 0; i < bundles.length; i += concurrency) {
    const batch = bundles.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (bundle) => {
        const sourceMapUrl = await findSourceMapUrl(bundle.url);
        completed++;
        onProgress?.(completed, bundles.length);
        return {
          ...bundle,
          sourceMapUrl: sourceMapUrl || undefined,
        };
      })
    );
    results.push(...batchResults);
  }

  return results.filter(b => b.sourceMapUrl);
}
