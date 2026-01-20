/**
 * Web Scraping Module for `@web2local/scraper`
 *
 * This module provides functionality for extracting JavaScript and CSS bundle URLs
 * from web pages, discovering associated source maps, and identifying vendor bundles.
 * It supports intelligent caching to avoid redundant network requests and includes
 * heuristics for detecting minified vendor chunks.
 */

import { parse as parseHTML } from 'node-html-parser';
import { getCache } from '@web2local/cache';
import { BROWSER_HEADERS, robustFetch } from '@web2local/http';

/**
 * Information about a JavaScript or CSS bundle extracted from a web page.
 */
export interface BundleInfo {
    /** The absolute URL of the bundle file. */
    url: string;
    /** The type of bundle (script for JS, stylesheet for CSS). */
    type: 'script' | 'stylesheet';
    /** The discovered source map URL, if found. */
    sourceMapUrl?: string;
}

/**
 * Represents a vendor bundle (minified JS) without a source map.
 * These typically contain third-party libraries bundled into a single file.
 */
export interface VendorBundle {
    /** The absolute URL of the vendor bundle file. */
    url: string;
    /** The filename portion of the URL (e.g., "lodash-Dhg5Ny8x.js"). */
    filename: string;
    /** The raw minified content of the bundle. */
    content: string;
    /** Inferred package name from filename (e.g., "lodash" from "lodash-Dhg5Ny8x.js"). */
    inferredPackage?: string;
}

/**
 * Represents a redirect detected during page scraping
 */
export interface ScrapedRedirect {
    /** Original requested URL (full URL) */
    from: string;
    /** Final URL after redirect (full URL) */
    to: string;
    /** HTTP status code (inferred as 301 for fetch redirects) */
    status: number;
}

/**
 * Result of extracting bundle URLs from a page
 */
export interface ExtractBundleUrlsResult {
    /** Extracted bundle URLs */
    bundles: BundleInfo[];
    /** The final URL after any redirects (may differ from requested URL) */
    finalUrl: string;
    /** Redirect detected during fetch (if any) */
    redirect?: ScrapedRedirect;
}

/**
 * Fetches HTML from a URL and extracts all JS/CSS bundle URLs.
 *
 * Parses the HTML document to find script tags, modulepreload links, and
 * stylesheet links. Also detects redirects and returns the final URL for
 * proper path resolution. Results are cached to avoid re-fetching on
 * subsequent runs.
 *
 * @param pageUrl - The URL of the web page to scrape
 * @returns The extracted bundles, final URL after redirects, and redirect info
 * @throws When the HTTP request fails with a non-OK status (throws Error)
 *
 * @example
 * ```typescript
 * const result = await extractBundleUrls('https://example.com');
 * console.log(result.bundles); // Array of BundleInfo objects
 * console.log(result.finalUrl); // URL after any redirects
 * ```
 */
export async function extractBundleUrls(
    pageUrl: string,
): Promise<ExtractBundleUrlsResult> {
    const cache = getCache();

    // Check cache first
    const cached = await cache.getPageScraping(pageUrl);
    if (cached) {
        return {
            bundles: cached.bundles,
            finalUrl: cached.finalUrl || pageUrl,
            redirect: cached.redirect,
        };
    }

    const response = await robustFetch(pageUrl, { headers: BROWSER_HEADERS });
    if (!response.ok) {
        throw new Error(
            `HTTP ${response.status} ${response.statusText} fetching ${pageUrl}`,
        );
    }

    // Detect redirects by comparing requested URL to response URL
    // fetch() follows redirects automatically, so response.url is the final URL
    const finalUrl = response.url;
    let redirect: ScrapedRedirect | undefined;

    if (finalUrl !== pageUrl) {
        const requestedUrlObj = new URL(pageUrl);
        const finalUrlObj = new URL(finalUrl);

        // Only record same-origin redirects (path changes)
        if (requestedUrlObj.origin === finalUrlObj.origin) {
            redirect = {
                from: pageUrl,
                to: finalUrl,
                // fetch() doesn't expose the redirect status, assume 301 (most common)
                status: 301,
            };
        }
    }

    const html = await response.text();
    const root = parseHTML(html);
    // Use the FINAL URL as base for resolving relative paths (important after redirects!)
    const baseUrl = new URL(finalUrl);
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
            if (!bundles.some((b) => b.url === absoluteUrl)) {
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

    // Cache the result (including redirect info)
    await cache.setPageScraping(pageUrl, bundles, finalUrl, redirect);

    return { bundles, finalUrl, redirect };
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
 * Result of checking a bundle for source maps.
 */
export interface SourceMapCheckResult {
    /** The discovered source map URL, or null if not found. */
    sourceMapUrl: string | null;
    /** The bundle content, populated when no source map is found for fallback handling. */
    bundleContent?: string;
}

/**
 * Checks if a bundle has an associated source map and returns its URL.
 *
 * Searches for source maps by checking HTTP headers (SourceMap, X-SourceMap),
 * inline sourceMappingURL comments in the bundle content, and by attempting
 * to fetch a `.map` file at the bundle URL. Also returns the bundle content
 * for vendor bundles without source maps. Results are cached to avoid
 * re-fetching on subsequent runs.
 *
 * @param bundleUrl - The URL of the JavaScript or CSS bundle
 * @returns The source map URL if found, plus bundle content for fallback handling
 */
export async function findSourceMapUrl(
    bundleUrl: string,
): Promise<SourceMapCheckResult> {
    const cache = getCache();

    // Check cache first
    const cached = await cache.getSourceMapDiscovery(bundleUrl);
    if (cached && cached.sourceMapUrl) {
        // Cached positive result - we have a source map URL
        return { sourceMapUrl: cached.sourceMapUrl };
    }

    // Either not cached, or cached as "no source map" - need to fetch the bundle
    // (We always need the bundle content for fallback saving even if we know there's no source map)
    let sourceMapUrl: string | null = null;

    try {
        const response = await robustFetch(bundleUrl, {
            headers: BROWSER_HEADERS,
        });
        if (!response.ok) {
            // Cache negative result
            await cache.setSourceMapDiscovery(bundleUrl, null);
            return { sourceMapUrl: null };
        }

        const text = await response.text();

        // If we already know there's no source map (from cache), skip the checks
        if (cached) {
            return { sourceMapUrl: null, bundleContent: text };
        }

        // Check SourceMap header
        const sourceMapHeader =
            response.headers.get('SourceMap') ||
            response.headers.get('X-SourceMap');
        if (sourceMapHeader) {
            sourceMapUrl = resolveUrl(sourceMapHeader, new URL(bundleUrl));
            await cache.setSourceMapDiscovery(bundleUrl, sourceMapUrl);
            return { sourceMapUrl };
        }

        // Check for sourceMappingURL comment at the end
        const jsMatch = text.match(/\/\/[#@]\s*sourceMappingURL=(\S+)\s*$/);
        const cssMatch = text.match(
            /\/\*[#@]\s*sourceMappingURL=(\S+)\s*\*\/\s*$/,
        );

        const match = jsMatch || cssMatch;
        if (match) {
            const mapUrl = match[1];
            sourceMapUrl = resolveUrl(mapUrl, new URL(bundleUrl));
            await cache.setSourceMapDiscovery(bundleUrl, sourceMapUrl);
            return { sourceMapUrl };
        }

        // Try appending .map as a fallback
        const mapUrl = bundleUrl + '.map';
        const mapResponse = await robustFetch(mapUrl, {
            method: 'HEAD',
            headers: BROWSER_HEADERS,
        });
        if (mapResponse.ok) {
            // Validate Content-Type to avoid false positives from SPAs that return HTML for all routes
            const contentType = mapResponse.headers.get('Content-Type') || '';
            const isValidSourceMap =
                contentType.includes('application/json') ||
                contentType.includes('application/octet-stream') ||
                contentType.includes('text/plain') ||
                // Some servers don't set Content-Type for .map files
                contentType === '';

            if (isValidSourceMap && !contentType.includes('text/html')) {
                sourceMapUrl = mapUrl;
                await cache.setSourceMapDiscovery(bundleUrl, sourceMapUrl);
                return { sourceMapUrl };
            }
        }

        // Cache negative result
        await cache.setSourceMapDiscovery(bundleUrl, null);

        // No source map found - return bundle content for fallback saving and vendor analysis
        return { sourceMapUrl: null, bundleContent: text };
    } catch (_error) {
        // Cache negative result on error
        await cache.setSourceMapDiscovery(bundleUrl, null);
        return { sourceMapUrl: null };
    }
}

/**
 * Represents a bundle without a source map (for --save-bundles fallback)
 */
export interface BundleWithContent {
    bundle: BundleInfo;
    content: string;
}

/**
 * Pre-fetched bundle content for use with findAllSourceMaps.
 * When provided, the bundle content won't be re-fetched.
 */
export interface PreFetchedBundle {
    /** The URL of the bundle */
    url: string;
    /** The raw content of the bundle */
    content: Buffer | string;
    /** The Content-Type header value */
    contentType: string;
}

/**
 * Result from processing all bundles for source maps
 */
export interface SourceMapSearchResult {
    /** Bundles that have associated source maps */
    bundlesWithMaps: BundleInfo[];
    /** Vendor bundles without source maps (for fingerprinting) */
    vendorBundles: VendorBundle[];
    /** All bundles without source maps (for --save-bundles fallback) */
    bundlesWithoutMaps: BundleWithContent[];
}

/**
 * Extracts package name from a vendor bundle filename.
 * Common patterns:
 *   - lodash-Dhg5Ny8x.js -\> lodash
 *   - chunk-react-dom-ABCD1234.js -\> react-dom
 *   - vendor~react~react-dom.js -\> react, react-dom (returns first)
 *   - date-fns-CxYz1234.js -\> date-fns
 *   - \@turf-boolean-contains-abcd.js -\> \@turf/boolean-contains
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
        const parts = base
            .split('~')
            .filter((p) => p && !p.startsWith('chunk'));
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
        /^@/, // Scoped packages
        /[-_][a-z0-9]{6,12}\.js$/i, // Hash suffix pattern
    ];

    if (vendorFilenamePatterns.some((p) => p.test(lowerFilename))) {
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
 * Checks if a bundle has an associated source map using pre-fetched content.
 *
 * This avoids re-fetching bundles that have already been captured during crawling.
 * Searches for sourceMappingURL comments in the provided content and falls back
 * to checking for a `.map` file at the bundle URL.
 *
 * @param bundleUrl - The URL of the bundle
 * @param content - The pre-fetched content of the bundle
 * @returns The source map URL if found, plus the bundle content for fallback handling
 */
export async function findSourceMapUrlWithContent(
    bundleUrl: string,
    content: string,
): Promise<SourceMapCheckResult> {
    const cache = getCache();

    // Check cache first for positive source map results
    const cached = await cache.getSourceMapDiscovery(bundleUrl);
    if (cached && cached.sourceMapUrl) {
        return { sourceMapUrl: cached.sourceMapUrl };
    }

    // If we already know there's no source map (from cache), return with the content
    if (cached) {
        return { sourceMapUrl: null, bundleContent: content };
    }

    // Look for source map reference in the content
    // Check for sourceMappingURL comment at the end
    const jsMatch = content.match(/\/\/[#@]\s*sourceMappingURL=(\S+)\s*$/);
    const cssMatch = content.match(
        /\/\*[#@]\s*sourceMappingURL=(\S+)\s*\*\/\s*$/,
    );

    const match = jsMatch || cssMatch;
    if (match) {
        const mapUrl = match[1];
        const sourceMapUrl = resolveUrl(mapUrl, new URL(bundleUrl));
        await cache.setSourceMapDiscovery(bundleUrl, sourceMapUrl);
        return { sourceMapUrl };
    }

    // Try appending .map as a fallback (still need to make a HEAD request)
    try {
        const mapUrl = bundleUrl + '.map';
        const mapResponse = await robustFetch(mapUrl, {
            method: 'HEAD',
            headers: BROWSER_HEADERS,
        });
        if (mapResponse.ok) {
            // Validate Content-Type to avoid false positives from SPAs that return HTML for all routes
            const contentType = mapResponse.headers.get('Content-Type') || '';
            const isValidSourceMap =
                contentType.includes('application/json') ||
                contentType.includes('application/octet-stream') ||
                contentType.includes('text/plain') ||
                // Some servers don't set Content-Type for .map files
                contentType === '';

            if (isValidSourceMap && !contentType.includes('text/html')) {
                const sourceMapUrl = mapUrl;
                await cache.setSourceMapDiscovery(bundleUrl, sourceMapUrl);
                return { sourceMapUrl };
            }
        }
    } catch {
        // Ignore errors from .map fallback check
    }

    // Cache negative result
    await cache.setSourceMapDiscovery(bundleUrl, null);

    // No source map found - return bundle content for fallback saving
    return { sourceMapUrl: null, bundleContent: content };
}

/**
 * Options for findAllSourceMaps
 */
export interface FindAllSourceMapsOptions {
    /** Concurrency limit for fetching bundles (default: 5) */
    concurrency?: number;
    /** Progress callback */
    onProgress?: (completed: number, total: number) => void;
    /** Pre-fetched bundle content to avoid re-fetching */
    preFetchedBundles?: PreFetchedBundle[];
}

/**
 * Processes all bundles and finds their source maps.
 *
 * Iterates through all provided bundles, checking each for an associated source map.
 * Bundles with source maps are collected for extraction, while bundles without maps
 * are categorized as either vendor bundles (for fingerprinting) or general bundles
 * (for fallback saving).
 *
 * @param bundles - The bundles to process
 * @param options - Processing options including concurrency, progress callback, and pre-fetched content
 * @returns Categorized results with bundles that have maps, vendor bundles, and bundles without maps
 *
 * @example
 * ```typescript
 * const { bundles } = await extractBundleUrls('https://example.com');
 * const result = await findAllSourceMaps(bundles, {
 *     concurrency: 3,
 *     onProgress: (done, total) => console.log(`${done}/${total}`)
 * });
 * console.log(`Found ${result.bundlesWithMaps.length} bundles with source maps`);
 * ```
 */
export async function findAllSourceMaps(
    bundles: BundleInfo[],
    options?: FindAllSourceMapsOptions,
): Promise<SourceMapSearchResult> {
    const concurrency = options?.concurrency ?? 5;
    const onProgress = options?.onProgress;
    const preFetchedBundles = options?.preFetchedBundles;

    // Build a map of pre-fetched content for quick lookup
    const preFetchedMap = new Map<string, string>();
    if (preFetchedBundles) {
        for (const pf of preFetchedBundles) {
            const contentStr =
                typeof pf.content === 'string'
                    ? pf.content
                    : pf.content.toString('utf-8');
            preFetchedMap.set(pf.url, contentStr);
        }
    }

    const bundlesWithMaps: BundleInfo[] = [];
    const vendorBundles: VendorBundle[] = [];
    const bundlesWithoutMaps: BundleWithContent[] = [];
    let completed = 0;

    // Process in batches for concurrency control
    for (let i = 0; i < bundles.length; i += concurrency) {
        const batch = bundles.slice(i, i + concurrency);
        const batchResults = await Promise.all(
            batch.map(async (bundle) => {
                // Use pre-fetched content if available, otherwise fetch
                const preFetchedContent = preFetchedMap.get(bundle.url);
                const result = preFetchedContent
                    ? await findSourceMapUrlWithContent(
                          bundle.url,
                          preFetchedContent,
                      )
                    : await findSourceMapUrl(bundle.url);
                completed++;
                onProgress?.(completed, bundles.length);
                return {
                    bundle,
                    result,
                };
            }),
        );

        for (const { bundle, result } of batchResults) {
            if (result.sourceMapUrl) {
                // Bundle has a source map
                bundlesWithMaps.push({
                    ...bundle,
                    sourceMapUrl: result.sourceMapUrl,
                });
            } else if (result.bundleContent) {
                // No source map - collect for --save-bundles fallback
                bundlesWithoutMaps.push({
                    bundle,
                    content: result.bundleContent,
                });

                // Also check if it's a vendor bundle worth fingerprinting (JS only)
                if (bundle.type === 'script') {
                    const filename = bundle.url.split('/').pop() || bundle.url;

                    if (looksLikeVendorBundle(filename, result.bundleContent)) {
                        const inferredPackage =
                            extractPackageNameFromFilename(filename);
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
    }

    return { bundlesWithMaps, vendorBundles, bundlesWithoutMaps };
}
