/**
 * Static asset downloading and capturing
 *
 * Uses page.on('response') to capture static assets as they load.
 */

import type { Page, Response } from 'playwright';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, join, extname } from 'path';
import { createHash } from 'crypto';
import { minimatch } from 'minimatch';
import type {
    CapturedAsset,
    ResourceType,
    StaticAssetFilter,
    CapturedAssetInfo,
    OnAssetCaptured,
} from './types.js';
import { robustFetch, FetchError } from '@web2local/http';

/**
 * Direct HTTP fetch with proper streaming support and content verification.
 * Used as a fallback when Playwright's response.body() returns truncated data.
 * Uses robustFetch for automatic retry on transient errors.
 */
async function fetchWithContentVerification(
    url: string,
): Promise<Buffer | null> {
    try {
        const response = await robustFetch(url, {
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                Accept: '*/*',
            },
        });

        if (!response.ok) {
            return null;
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // Verify content length if header present
        const contentLength = parseInt(
            response.headers.get('content-length') || '0',
            10,
        );
        if (contentLength > 0 && buffer.length !== contentLength) {
            // Truncated data - log warning but still return what we got
            console.warn(
                `Warning: Truncated response for ${url} (got ${buffer.length} bytes, expected ${contentLength})`,
            );
        }

        return buffer;
    } catch (error) {
        // FetchError already has good error details
        if (error instanceof FetchError) {
            console.warn(`Failed to fetch ${url}: ${error.message}`);
        }
        return null;
    }
}

/**
 * Options for static asset capture
 */
export interface StaticCaptureOptions {
    /** Output directory for static assets */
    outputDir: string;
    /** Maximum file size to download (bytes) */
    maxFileSize: number;
    /** Whether to capture HTML documents */
    captureHtml: boolean;
    /** Whether to capture CSS */
    captureCss: boolean;
    /** Whether to capture JavaScript */
    captureJs: boolean;
    /** Whether to capture images */
    captureImages: boolean;
    /** Whether to capture fonts */
    captureFonts: boolean;
    /** Whether to capture other media (video, audio) */
    captureMedia: boolean;
    /**
     * Whether to capture the rendered HTML (after JS execution) instead of original.
     * Set to true for SPAs where the initial HTML is mostly empty and JS renders content.
     * Set to false (default) to capture the original HTML response, which preserves
     * proper JS initialization (event handlers will be attached when JS runs).
     */
    captureRenderedHtml: boolean;
    /**
     * Whether to capture media sources from <source> elements in <video>/<audio>.
     * These can be large files. Even when enabled, maxFileSize is still respected.
     * Default: false
     */
    captureMediaSources: boolean;
    /** Verbose logging */
    verbose: boolean;
    /** Progress callback */
    onCapture?: (asset: CapturedAsset) => void;
    /** Verbose log callback - handles spinner-safe logging */
    onVerbose?: (message: string) => void;

    /**
     * Filter for selective asset capture.
     * When provided, only assets matching the filter criteria are captured.
     * This allows fine-grained control over which assets to capture.
     */
    staticFilter?: StaticAssetFilter;

    /**
     * Callback fired when an asset is captured (fire-and-forget).
     * Useful for collecting asset content without writing to disk.
     * The callback receives the full asset content including the Buffer.
     */
    onAssetCaptured?: OnAssetCaptured;

    /**
     * Skip writing assets to disk.
     * Useful when only using onAssetCaptured callback to collect assets.
     */
    skipAssetWrite?: boolean;
}

const DEFAULT_OPTIONS: StaticCaptureOptions = {
    outputDir: './static',
    maxFileSize: 50 * 1024 * 1024, // 50MB
    captureHtml: true,
    captureCss: true,
    captureJs: true,
    captureImages: true,
    captureFonts: true,
    captureMedia: true,
    captureRenderedHtml: false,
    captureMediaSources: false,
    verbose: false,
    skipAssetWrite: false,
};

/**
 * Resource types that are considered static assets
 */
const STATIC_RESOURCE_TYPES: Set<ResourceType> = new Set([
    'document',
    'stylesheet',
    'script',
    'image',
    'font',
    'media',
]);

/**
 * Map resource type to option
 */
function shouldCaptureResourceType(
    type: ResourceType,
    options: StaticCaptureOptions,
): boolean {
    switch (type) {
        case 'document':
            return options.captureHtml;
        case 'stylesheet':
            return options.captureCss;
        case 'script':
            return options.captureJs;
        case 'image':
            return options.captureImages;
        case 'font':
            return options.captureFonts;
        case 'media':
            return options.captureMedia;
        default:
            return false;
    }
}

/**
 * Map resource type to MIME type prefix for filter matching
 */
function resourceTypeToMimePrefix(type: ResourceType): string {
    switch (type) {
        case 'document':
            return 'text/html';
        case 'stylesheet':
            return 'text/css';
        case 'script':
            return 'application/javascript';
        case 'image':
            return 'image/';
        case 'font':
            return 'font/';
        case 'media':
            return 'video/'; // also matches audio/ but we check both
        default:
            return '';
    }
}

/**
 * Check if an asset passes the static filter criteria.
 * If no filter is provided, all assets pass.
 *
 * @param url - The URL of the asset
 * @param contentType - The Content-Type header value
 * @param resourceType - The browser resource type
 * @param filter - The filter to apply (optional)
 * @returns true if the asset should be captured
 */
export function passesFilter(
    url: string,
    contentType: string,
    resourceType: ResourceType,
    filter?: StaticAssetFilter,
): boolean {
    // No filter means capture everything
    if (!filter) {
        return true;
    }

    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const ext = extname(pathname).toLowerCase();

    // Check extension filter
    if (filter.extensions && filter.extensions.length > 0) {
        const normalizedExts = filter.extensions.map((e) =>
            e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`,
        );
        if (!normalizedExts.includes(ext)) {
            return false;
        }
    }

    // Check MIME type filter
    if (filter.mimeTypes && filter.mimeTypes.length > 0) {
        const matchesMime = filter.mimeTypes.some((mimePrefix) =>
            contentType.toLowerCase().startsWith(mimePrefix.toLowerCase()),
        );
        if (!matchesMime) {
            return false;
        }
    }

    // Check include patterns (URL must match at least one)
    if (filter.includePatterns && filter.includePatterns.length > 0) {
        const matchesInclude = filter.includePatterns.some((pattern) =>
            minimatch(pathname, pattern, { matchBase: true }),
        );
        if (!matchesInclude) {
            return false;
        }
    }

    // Check exclude patterns (URL must not match any)
    if (filter.excludePatterns && filter.excludePatterns.length > 0) {
        const matchesExclude = filter.excludePatterns.some((pattern) =>
            minimatch(pathname, pattern, { matchBase: true }),
        );
        if (matchesExclude) {
            return false;
        }
    }

    return true;
}

/**
 * Early filter check using only URL information.
 * Returns false if the URL definitely fails the filter.
 * Returns true if the URL might pass (needs full check with contentType later).
 *
 * This is used for optimization - we can skip assets early without fetching
 * their response body if we know they'll fail URL-based filter criteria.
 *
 * Note: MIME type filtering cannot be done early as it requires the Content-Type
 * header. If the filter has mimeTypes, this function will return true and the
 * full passesFilter() check must be done later.
 *
 * @param url - The URL of the asset
 * @param filter - The filter to apply (optional)
 * @returns false if definitely filtered out, true if might pass
 */
export function passesFilterEarly(
    url: string,
    filter?: StaticAssetFilter,
): boolean {
    // No filter means capture everything
    if (!filter) {
        return true;
    }

    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const ext = extname(pathname).toLowerCase();

    // Check extension filter (definitive - URL only)
    if (filter.extensions && filter.extensions.length > 0) {
        const normalizedExts = filter.extensions.map((e) =>
            e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`,
        );
        if (!normalizedExts.includes(ext)) {
            return false;
        }
    }

    // Check include patterns (definitive - URL only)
    if (filter.includePatterns && filter.includePatterns.length > 0) {
        const matchesInclude = filter.includePatterns.some((pattern) =>
            minimatch(pathname, pattern, { matchBase: true }),
        );
        if (!matchesInclude) {
            return false;
        }
    }

    // Check exclude patterns (definitive - URL only)
    if (filter.excludePatterns && filter.excludePatterns.length > 0) {
        const matchesExclude = filter.excludePatterns.some((pattern) =>
            minimatch(pathname, pattern, { matchBase: true }),
        );
        if (matchesExclude) {
            return false;
        }
    }

    // MIME type check requires Content-Type header - can't check early
    // Return true to indicate "might pass, needs full check later"
    return true;
}

/**
 * Extract the base domain from a host (removes www. prefix)
 */
function getBaseDomain(host: string): string {
    return host.replace(/^www\./, '');
}

/**
 * Generate a local path for a URL
 */
function urlToLocalPath(url: string, baseUrl: string): string {
    const urlObj = new URL(url);
    const baseUrlObj = new URL(baseUrl);
    const baseDomain = getBaseDomain(baseUrlObj.host);

    // For same-origin resources, use the pathname directly
    if (urlObj.origin === baseUrlObj.origin) {
        let path = urlObj.pathname;

        // Handle root path
        if (path === '/' || path === '') {
            path = '/index.html';
        }

        // Add .html extension if no extension and looks like a page
        if (!extname(path) && !path.includes('.')) {
            path = path + '/index.html';
        }

        // Remove leading slash
        return path.replace(/^\//, '');
    }

    // For CDN/static subdomains of the same domain, save to _cdn/ directory
    const urlHost = urlObj.host;
    if (
        urlHost === `cdn.${baseDomain}` ||
        urlHost === `static.${baseDomain}` ||
        urlHost === `assets.${baseDomain}` ||
        urlHost === `images.${baseDomain}` ||
        urlHost === `media.${baseDomain}`
    ) {
        // Extract subdomain prefix (cdn, static, etc.)
        const subdomain = urlHost.split('.')[0];
        let path = urlObj.pathname;

        // Remove leading slash and prefix with _subdomain/
        return `_${subdomain}${path}`;
    }

    // For cross-origin resources, use a hash-based filename in _external/
    const hash = createHash('md5').update(url).digest('hex').slice(0, 12);
    const ext = extname(urlObj.pathname) || '.bin';
    const filename = urlObj.pathname.split('/').pop() || 'file';
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');

    return `_external/${hash}_${safeName}${ext ? '' : ext}`;
}

/**
 * Get MIME type from response or guess from extension
 */
function getContentType(response: Response, url: string): string {
    const contentType = response.headers()['content-type'];
    if (contentType) {
        return contentType.split(';')[0].trim();
    }

    // Guess from extension
    const ext = extname(new URL(url).pathname).toLowerCase();
    const mimeTypes: Record<string, string> = {
        '.html': 'text/html',
        '.htm': 'text/html',
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.mjs': 'application/javascript',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.webp': 'image/webp',
        '.ico': 'image/x-icon',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
        '.ttf': 'font/ttf',
        '.eot': 'application/vnd.ms-fontobject',
        '.otf': 'font/otf',
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.ogg': 'audio/ogg',
    };

    return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * Static Asset Capturer - captures static assets via response events
 */
export class StaticCapturer {
    private assets: CapturedAsset[] = [];
    private downloadedUrls: Set<string> = new Set();
    private pendingCaptures: Map<string, Promise<void>> = new Map();
    private options: StaticCaptureOptions;
    private entrypointUrl: string | null = null;
    private baseOrigin: string | null = null;
    /** Original HTML response from the network (before JS execution) */
    private originalDocumentHtml: string | null = null;
    /** URL of the original document */
    private originalDocumentUrl: string | null = null;
    /** Track truncated files that couldn't be recovered */
    private truncatedFiles: Array<{
        url: string;
        expectedSize: number;
        actualSize: number;
    }> = [];
    /** Track files that were recovered via direct fetch */
    private recoveredFiles: string[] = [];
    /** Track redirects detected during capture */
    private redirects: Array<{
        from: string;
        to: string;
        status: number;
    }> = [];
    /** URLs discovered in CSS image-set() that need to be fetched */
    private pendingResponsiveUrls: Set<string> = new Set();
    /** Current page URL being crawled (for onAssetCaptured callback) */
    private currentPageUrl: string | null = null;

    constructor(options: Partial<StaticCaptureOptions> = {}) {
        this.options = { ...DEFAULT_OPTIONS, ...options };
    }

    /**
     * Set the current page URL.
     * Called by the capture orchestrator when navigating to a new page during crawling.
     * This URL is passed to the onAssetCaptured callback.
     */
    setCurrentPageUrl(url: string): void {
        this.currentPageUrl = url;
        this.log(`[StaticCapturer] Current page URL set to: ${url}`);
    }

    /**
     * Get the current page URL
     */
    getCurrentPageUrl(): string | null {
        return this.currentPageUrl;
    }

    /**
     * Update the base URL after redirects.
     * This should be called after navigation completes to handle redirect scenarios.
     * For example, if user navigates to www.bob.com but gets redirected to www.robert.com,
     * call this with the final URL so assets from www.robert.com are saved with correct paths.
     */
    updateBaseUrl(finalUrl: string): void {
        const oldOrigin = this.baseOrigin;
        this.baseOrigin = new URL(finalUrl).origin;
        if (oldOrigin !== this.baseOrigin) {
            this.log(
                `[StaticCapturer] Base origin updated: ${oldOrigin} -> ${this.baseOrigin}`,
            );
        }
    }

    /**
     * Get the current base origin used for path resolution
     */
    getBaseOrigin(): string | null {
        return this.baseOrigin;
    }

    /**
     * Get redirects detected during capture
     */
    getRedirects(): Array<{ from: string; to: string; status: number }> {
        return [...this.redirects];
    }

    /**
     * Log a verbose message - uses onVerbose callback if provided, otherwise console.log
     */
    private log(message: string): void {
        if (!this.options.verbose) return;

        if (this.options.onVerbose) {
            this.options.onVerbose(message);
        } else {
            console.log(message);
        }
    }

    /**
     * Attach capturer to a page using response events
     */
    attach(page: Page, entrypointUrl: string): void {
        this.entrypointUrl = entrypointUrl;
        this.baseOrigin = new URL(entrypointUrl).origin;

        this.log(
            `[StaticCapturer] Attaching to page, entrypoint: ${entrypointUrl}`,
        );
        this.log(`[StaticCapturer] Initial base origin: ${this.baseOrigin}`);
        this.log(
            `[StaticCapturer] Options: captureHtml=${this.options.captureHtml}, captureCss=${this.options.captureCss}, captureJs=${this.options.captureJs}, captureImages=${this.options.captureImages}`,
        );

        // Listen for main frame navigation to detect redirects early
        // This updates the base origin as soon as the browser follows a redirect
        page.on('framenavigated', (frame) => {
            if (frame === page.mainFrame()) {
                const newUrl = frame.url();
                const newOrigin = new URL(newUrl).origin;
                if (newOrigin !== this.baseOrigin) {
                    this.log(
                        `[StaticCapturer] Frame navigated, updating base origin: ${this.baseOrigin} -> ${newOrigin}`,
                    );
                    this.baseOrigin = newOrigin;
                }
            }
        });

        page.on('response', async (response) => {
            const request = response.request();
            const resourceType = request.resourceType() as ResourceType;
            const requestUrl = request.url();
            const responseUrl = response.url();

            // Skip data URLs
            if (requestUrl.startsWith('data:')) {
                return;
            }

            // Check if this is a static resource type we want
            if (!STATIC_RESOURCE_TYPES.has(resourceType)) {
                return;
            }

            if (!shouldCaptureResourceType(resourceType, this.options)) {
                return;
            }

            // For navigation documents (main HTML), capture the original response
            // This preserves the original HTML before JS modifies it, ensuring
            // event handlers get properly attached when JS runs on the mock server
            if (resourceType === 'document' && request.isNavigationRequest()) {
                // Only capture the main frame document, not iframe documents
                const frame = request.frame();
                const isMainFrame = frame && frame.parentFrame() === null;

                if (!isMainFrame) {
                    this.log(
                        `[Static] Skipping iframe document: ${requestUrl}`,
                    );
                    return;
                }

                // Detect redirects by checking if this request was redirected from another
                // When Playwright follows a redirect:
                // 1. First response event: 301 from /path (we skip this, not a 200)
                // 2. Second response event: 200 from /path/ with redirectedFrom pointing to /path
                const redirectedFrom = request.redirectedFrom();
                if (redirectedFrom && response.ok()) {
                    try {
                        const originalUrl = redirectedFrom.url();
                        const finalUrl = responseUrl;
                        const origUrlObj = new URL(originalUrl);
                        const finalUrlObj = new URL(finalUrl);

                        // Only record same-origin redirects (path changes)
                        if (origUrlObj.origin === finalUrlObj.origin) {
                            const fromPath =
                                origUrlObj.pathname + origUrlObj.search;
                            const toPath =
                                finalUrlObj.pathname + finalUrlObj.search;

                            // Skip self-redirects (same path redirecting to itself)
                            // This can happen with HTTPS upgrades or www normalization
                            // where the path stays the same but origin changes
                            if (fromPath === toPath) {
                                this.log(
                                    `[Static] Skipping self-redirect: ${fromPath} -> ${toPath}`,
                                );
                            } else {
                                // Get the redirect status from the original request's response
                                const redirectResponse =
                                    await redirectedFrom.response();
                                const status =
                                    redirectResponse?.status() || 301;

                                this.redirects.push({
                                    from: fromPath,
                                    to: toPath,
                                    status,
                                });
                                this.log(
                                    `[Static] Detected redirect: ${fromPath} -> ${toPath} (${status})`,
                                );
                            }
                        }
                    } catch (error) {
                        this.log(`[Static] Error detecting redirect: ${error}`);
                    }
                }

                if (this.options.captureRenderedHtml) {
                    this.log(
                        `[Static] Skipping navigation document (will capture rendered version later): ${responseUrl}`,
                    );
                    return;
                }

                // Only capture if we haven't already captured the main document
                // (avoid overwriting with redirect responses)
                if (this.originalDocumentHtml === null) {
                    // Capture the original HTML from the network response
                    try {
                        const body = await response.body();
                        this.originalDocumentHtml = body.toString('utf-8');
                        this.originalDocumentUrl = responseUrl;
                        this.log(
                            `[Static] Captured original document HTML: ${responseUrl} (${body.length} bytes)`,
                        );
                    } catch (error) {
                        this.log(
                            `[Static] Could not capture original document HTML: ${error}`,
                        );
                    }
                } else {
                    this.log(
                        `[Static] Skipping duplicate main document: ${responseUrl}`,
                    );
                }
                return;
            }

            // Use request URL for asset tracking (consistent with previous behavior)
            const url = requestUrl;

            // Skip if already downloaded
            if (this.downloadedUrls.has(url)) {
                return;
            }

            // Early URL-based filtering (avoids fetching body for filtered assets)
            // This checks extensions, include patterns, and exclude patterns.
            // MIME type filtering is deferred to captureAsset() since it needs headers.
            if (
                this.options.staticFilter &&
                !passesFilterEarly(url, this.options.staticFilter)
            ) {
                this.log(`[Static] Skipping ${url} (does not pass URL filter)`);
                return;
            }

            // Only capture successful responses
            if (!response.ok()) {
                this.log(
                    `[Static] Skipping non-ok response: ${response.status()} ${url}`,
                );
                return;
            }

            const shortUrl =
                url.length > 80 ? url.substring(0, 80) + '...' : url;
            this.log(`[Static] Capturing ${resourceType}: ${shortUrl}`);

            // Mark as downloading to prevent duplicates
            this.downloadedUrls.add(url);

            // Capture asynchronously
            const capturePromise = this.captureAsset(
                response,
                url,
                resourceType,
            );
            this.pendingCaptures.set(url, capturePromise);
            capturePromise.finally(() => this.pendingCaptures.delete(url));
        });

        this.log(`[StaticCapturer] Response handler attached`);
    }

    /**
     * Capture and save a static asset
     */
    private async captureAsset(
        response: Response,
        url: string,
        resourceType: ResourceType,
    ): Promise<void> {
        try {
            const headers = response.headers();

            // Get content type early (from headers, doesn't require body)
            const contentType = getContentType(response, url);

            // Apply MIME type filter BEFORE fetching body (optimization)
            // Note: Extension/pattern checks were already done in response handler
            // via passesFilterEarly(). Here we only need to check if MIME type
            // filtering is configured and if so, apply the full filter.
            if (this.options.staticFilter?.mimeTypes?.length) {
                if (
                    !passesFilter(
                        url,
                        contentType,
                        resourceType,
                        this.options.staticFilter,
                    )
                ) {
                    this.log(
                        `[Static] Skipping ${url} (does not pass MIME type filter)`,
                    );
                    return;
                }
            }

            // Check content length header
            const contentLength = parseInt(
                headers['content-length'] || '0',
                10,
            );
            if (contentLength > this.options.maxFileSize) {
                this.log(
                    `[Static] Skipping large file (header): ${url} (${contentLength} bytes)`,
                );
                return;
            }

            // NOW fetch the body (only for assets that passed all filters)
            let body: Buffer;
            try {
                body = await response.body();
            } catch (error) {
                // Response body may not be available (e.g., redirects, cached responses)
                this.log(`[Static] Could not get body for ${url}: ${error}`);
                return;
            }

            // Verify content length matches (if header was present and non-zero)
            // This detects truncated responses from chunked transfers or aborted connections
            // Note: We only check for body.length < contentLength (truncation)
            // body.length > contentLength is normal for compressed responses (gzip/br)
            // where Content-Length is the compressed size but body() returns decompressed
            if (contentLength > 0 && body.length < contentLength) {
                this.log(
                    `[Static] Truncated response detected for ${url}: ` +
                        `expected ${contentLength} bytes, got ${body.length} bytes. Retrying with direct fetch...`,
                );

                // Try to recover with direct HTTP fetch
                const recoveredBody = await fetchWithContentVerification(url);
                if (recoveredBody && recoveredBody.length === contentLength) {
                    this.log(
                        `[Static] Successfully recovered ${url} via direct fetch (${recoveredBody.length} bytes)`,
                    );
                    body = recoveredBody;
                    this.recoveredFiles.push(url);
                } else if (
                    recoveredBody &&
                    recoveredBody.length > body.length
                ) {
                    // Got more data than before, use it even if not complete
                    this.log(
                        `[Static] Partial recovery for ${url}: got ${recoveredBody.length} bytes (expected ${contentLength})`,
                    );
                    body = recoveredBody;
                    this.recoveredFiles.push(url);
                } else {
                    // Could not recover, track as truncated
                    this.log(
                        `[Static] WARNING: Could not recover truncated file ${url}`,
                    );
                    this.truncatedFiles.push({
                        url,
                        expectedSize: contentLength,
                        actualSize: body.length,
                    });
                    // Still save what we have - it might be partially usable
                }
            }

            // Double-check size
            if (body.length > this.options.maxFileSize) {
                this.log(
                    `[Static] Skipping large file (body): ${url} (${body.length} bytes)`,
                );
                return;
            }

            // Fire the onAssetCaptured callback (fire-and-forget)
            if (this.options.onAssetCaptured) {
                const assetInfo: CapturedAssetInfo = {
                    url,
                    contentType,
                    content: body,
                    resourceType,
                    pageUrl:
                        this.currentPageUrl || this.entrypointUrl || 'unknown',
                };
                // Fire-and-forget: don't await the callback
                try {
                    this.options.onAssetCaptured(assetInfo);
                } catch (callbackError) {
                    this.log(
                        `[Static] onAssetCaptured callback error: ${callbackError}`,
                    );
                }
            }

            // Skip writing to disk if skipAssetWrite is enabled
            if (this.options.skipAssetWrite) {
                this.log(
                    `[Static] Skipping disk write for ${url} (skipAssetWrite=true)`,
                );
                // Still track the asset but don't write it
                const isEntrypoint = url === this.entrypointUrl;
                const baseUrl = this.baseOrigin || this.entrypointUrl || url;
                const localPath = urlToLocalPath(url, baseUrl);
                const asset: CapturedAsset = {
                    url,
                    localPath,
                    contentType,
                    size: body.length,
                    isEntrypoint,
                };
                this.assets.push(asset);
                this.options.onCapture?.(asset);
                return;
            }

            // Generate local path using the base origin (which may have been updated after redirects)
            const baseUrl = this.baseOrigin || this.entrypointUrl || url;
            const localPath = urlToLocalPath(url, baseUrl);
            const fullPath = join(this.options.outputDir, localPath);

            // Create directory and write file
            await mkdir(dirname(fullPath), { recursive: true });
            await writeFile(fullPath, body);

            const isEntrypoint = url === this.entrypointUrl;

            const asset: CapturedAsset = {
                url,
                localPath,
                contentType,
                size: body.length,
                isEntrypoint,
            };

            this.assets.push(asset);
            this.options.onCapture?.(asset);

            this.log(`[Static] Saved: ${localPath} (${body.length} bytes)`);

            // If this is a CSS file, extract image-set() URLs for later fetching
            if (contentType.includes('css') || url.endsWith('.css')) {
                try {
                    const cssContent = body.toString('utf-8');
                    const imageSetUrls = extractResponsiveUrlsFromCss(
                        cssContent,
                        url,
                    );
                    if (imageSetUrls.length > 0) {
                        this.log(
                            `[Static] Found ${imageSetUrls.length} image-set URLs in CSS: ${url}`,
                        );
                        for (const imageUrl of imageSetUrls) {
                            this.pendingResponsiveUrls.add(imageUrl);
                        }
                    }
                } catch (cssError) {
                    this.log(
                        `[Static] Error parsing CSS for image-set: ${cssError}`,
                    );
                }
            }
        } catch (error) {
            this.log(`[Static] Error capturing ${url}: ${error}`);
        }
    }

    /**
     * Manually capture the main HTML document.
     * By default, uses the original HTML response (before JS execution).
     * If captureRenderedHtml is true, captures the rendered DOM (after JS execution).
     */
    async captureDocument(page: Page): Promise<CapturedAsset | null> {
        const url = page.url();

        // Skip if already captured
        if (this.downloadedUrls.has(url)) {
            return this.assets.find((a) => a.url === url) || null;
        }

        this.log(`[Static] Capturing document: ${url}`);

        let html: string;

        if (this.options.captureRenderedHtml) {
            // Capture the rendered DOM (after JS execution)
            // Use this for SPAs where the initial HTML is empty/minimal
            this.log(`[Static] Using rendered HTML (after JS execution)`);
            html = await page.content();
        } else if (this.originalDocumentHtml) {
            // Use the original HTML response (before JS execution)
            // This ensures event handlers get properly attached when JS runs
            this.log(
                `[Static] Using original HTML (before JS execution, ${this.originalDocumentHtml.length} bytes)`,
            );
            html = this.originalDocumentHtml;
        } else {
            // Fallback to rendered HTML if original wasn't captured
            this.log(
                `[Static] Original HTML not available, falling back to rendered HTML`,
            );
            html = await page.content();
        }

        // Rewrite URLs in the HTML to point to local paths
        const baseUrl = this.baseOrigin || this.entrypointUrl || url;
        html = this.rewriteDocumentUrls(html, baseUrl);

        const body = Buffer.from(html, 'utf-8');

        // Use the base origin (which should have been updated after redirects) for path resolution
        const localPath = urlToLocalPath(url, baseUrl);
        const fullPath = join(this.options.outputDir, localPath);

        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, body);

        const asset: CapturedAsset = {
            url,
            localPath,
            contentType: 'text/html',
            size: body.length,
            isEntrypoint: true,
        };

        this.assets.push(asset);
        this.downloadedUrls.add(url);
        this.options.onCapture?.(asset);

        this.log(
            `[Static] Saved document: ${localPath} (${body.length} bytes)`,
        );

        // Extract and fetch responsive image URLs that browser may not have loaded
        // (e.g., srcset variants for different viewport sizes)
        const responsiveUrls = extractResponsiveUrlsFromHtml(html, baseUrl);
        if (responsiveUrls.length > 0) {
            this.log(
                `[Static] Found ${responsiveUrls.length} responsive URLs in HTML`,
            );
            await this.fetchAdditionalAssets(responsiveUrls);
        }

        return asset;
    }

    /**
     * Rewrite URLs in HTML content to use local paths.
     * This converts absolute URLs matching the site's origin to relative paths,
     * and rewrites CDN subdomain URLs to use the _cdn/ prefix.
     */
    private rewriteDocumentUrls(html: string, baseUrl: string): string {
        const baseUrlObj = new URL(baseUrl);
        const baseDomain = getBaseDomain(baseUrlObj.host);
        const origin = baseUrlObj.origin;

        this.log(
            `[Static] Rewriting URLs for origin: ${origin}, base domain: ${baseDomain}`,
        );

        let result = html;
        let rewriteCount = 0;

        // Rewrite full URLs matching the base origin to relative paths
        // e.g., https://www.bob.com/foo/bar -> /foo/bar
        const originPattern = new RegExp(
            `https?://(www\\.)?${escapeRegex(baseDomain)}(/[^"'\\s<>]*)`,
            'g',
        );
        result = result.replace(originPattern, (match, _www, path) => {
            rewriteCount++;
            return path || '/';
        });

        // Rewrite CDN subdomain URLs to use _cdn/ prefix
        // e.g., https://cdn.bob.com/public/images/foo.jpg -> /_cdn/public/images/foo.jpg
        const cdnSubdomains = ['cdn', 'static', 'assets', 'images', 'media'];
        for (const subdomain of cdnSubdomains) {
            const cdnPattern = new RegExp(
                `https?://${subdomain}\\.${escapeRegex(baseDomain)}(/[^"'\\s<>]*)`,
                'g',
            );
            result = result.replace(cdnPattern, (match, path) => {
                rewriteCount++;
                return `/_${subdomain}${path || '/'}`;
            });
        }

        this.log(`[Static] Rewrote ${rewriteCount} URLs in document`);

        return result;
    }

    /**
     * Wait for all pending captures to complete, then fetch any
     * responsive URLs discovered in CSS files.
     */
    async flush(): Promise<void> {
        const pending = Array.from(this.pendingCaptures.values());
        if (pending.length > 0) {
            this.log(
                `[StaticCapturer] Waiting for ${pending.length} pending captures...`,
            );
            await Promise.all(pending);
        }

        // Fetch any responsive URLs discovered in CSS files
        if (this.pendingResponsiveUrls.size > 0) {
            const urls = Array.from(this.pendingResponsiveUrls);
            this.log(
                `[StaticCapturer] Fetching ${urls.length} responsive URLs from CSS...`,
            );
            await this.fetchAdditionalAssets(urls);
            this.pendingResponsiveUrls.clear();
        }
    }

    /**
     * Get all captured assets
     */
    getAssets(): CapturedAsset[] {
        return this.assets;
    }

    /**
     * Get the entrypoint asset (main HTML)
     */
    getEntrypoint(): CapturedAsset | undefined {
        return this.assets.find((a) => a.isEntrypoint);
    }

    /**
     * Get capture statistics
     */
    getStats(): {
        totalAssets: number;
        totalBytes: number;
        byType: Record<string, { count: number; bytes: number }>;
        truncatedFiles: number;
        recoveredFiles: number;
    } {
        const byType: Record<string, { count: number; bytes: number }> = {};

        for (const asset of this.assets) {
            const type = asset.contentType.split('/')[0] || 'other';
            if (!byType[type]) {
                byType[type] = { count: 0, bytes: 0 };
            }
            byType[type].count++;
            byType[type].bytes += asset.size;
        }

        return {
            totalAssets: this.assets.length,
            totalBytes: this.assets.reduce((sum, a) => sum + a.size, 0),
            byType,
            truncatedFiles: this.truncatedFiles.length,
            recoveredFiles: this.recoveredFiles.length,
        };
    }

    /**
     * Get list of truncated files that couldn't be fully recovered
     */
    getTruncatedFiles(): Array<{
        url: string;
        expectedSize: number;
        actualSize: number;
    }> {
        return this.truncatedFiles;
    }

    /**
     * Get list of files that were recovered via direct fetch
     */
    getRecoveredFiles(): string[] {
        return this.recoveredFiles;
    }

    /**
     * Clear captured assets
     */
    clear(): void {
        this.assets = [];
        this.downloadedUrls.clear();
        this.pendingCaptures.clear();
        this.pendingResponsiveUrls.clear();
        this.entrypointUrl = null;
        this.baseOrigin = null;
        this.originalDocumentHtml = null;
        this.originalDocumentUrl = null;
        this.truncatedFiles = [];
        this.recoveredFiles = [];
        this.currentPageUrl = null;
    }

    /**
     * Fetch additional assets that were discovered but not loaded by the browser.
     * This is used to capture responsive image variants from srcset/image-set
     * that the browser didn't load based on viewport size.
     *
     * @param urls - Array of absolute URLs to fetch
     */
    async fetchAdditionalAssets(urls: string[]): Promise<void> {
        // Filter out URLs already downloaded
        const newUrls = urls.filter((url) => !this.downloadedUrls.has(url));

        if (newUrls.length === 0) {
            return;
        }

        this.log(
            `[Static] Fetching ${newUrls.length} additional responsive assets...`,
        );

        // Filter to only same-origin or recognized CDN subdomains
        const baseUrl = this.baseOrigin || this.entrypointUrl;
        if (!baseUrl) {
            this.log(
                '[Static] No base URL available, skipping additional assets',
            );
            return;
        }

        const baseUrlObj = new URL(baseUrl);
        const baseDomain = baseUrlObj.host.replace(/^www\./, '');

        const eligibleUrls = newUrls.filter((url) => {
            try {
                const urlObj = new URL(url);

                // Same origin
                if (urlObj.origin === baseUrlObj.origin) {
                    return true;
                }

                // CDN subdomains
                const urlHost = urlObj.host;
                const cdnSubdomains = [
                    'cdn',
                    'static',
                    'assets',
                    'images',
                    'media',
                ];
                for (const subdomain of cdnSubdomains) {
                    if (urlHost === `${subdomain}.${baseDomain}`) {
                        return true;
                    }
                }

                return false;
            } catch {
                return false;
            }
        });

        if (eligibleUrls.length === 0) {
            this.log('[Static] No eligible URLs to fetch (all cross-origin)');
            return;
        }

        this.log(
            `[Static] ${eligibleUrls.length} URLs are same-origin or CDN, fetching...`,
        );

        // Fetch in batches to avoid overwhelming the server
        const BATCH_SIZE = 5;
        for (let i = 0; i < eligibleUrls.length; i += BATCH_SIZE) {
            const batch = eligibleUrls.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map((url) => this.fetchSingleAsset(url)));
        }
    }

    /**
     * Fetch and save a single asset by URL.
     * Used for fetching responsive image variants that weren't loaded by the browser.
     */
    private async fetchSingleAsset(url: string): Promise<void> {
        // Skip if already downloaded (double-check)
        if (this.downloadedUrls.has(url)) {
            return;
        }

        // Check if this is a media file and if we should skip it
        if (isMediaUrl(url) && !this.options.captureMediaSources) {
            this.log(
                `[Static] Skipping media source (captureMediaSources=false): ${url}`,
            );
            return;
        }

        // Mark as downloading to prevent duplicates
        this.downloadedUrls.add(url);

        try {
            const body = await fetchWithContentVerification(url);

            if (!body) {
                this.log(`[Static] Failed to fetch: ${url}`);
                return;
            }

            // Check file size
            if (body.length > this.options.maxFileSize) {
                this.log(
                    `[Static] Skipping large file: ${url} (${body.length} bytes)`,
                );
                return;
            }

            // Generate local path
            const baseUrl = this.baseOrigin || this.entrypointUrl || url;
            const localPath = urlToLocalPath(url, baseUrl);
            const fullPath = join(this.options.outputDir, localPath);

            // Create directory and write file
            await mkdir(dirname(fullPath), { recursive: true });
            await writeFile(fullPath, body);

            // Guess content type from extension
            const ext = extname(new URL(url).pathname).toLowerCase();
            const mimeTypes: Record<string, string> = {
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.gif': 'image/gif',
                '.svg': 'image/svg+xml',
                '.webp': 'image/webp',
                '.ico': 'image/x-icon',
                '.mp4': 'video/mp4',
                '.webm': 'video/webm',
                '.mp3': 'audio/mpeg',
                '.wav': 'audio/wav',
                '.ogg': 'audio/ogg',
            };
            const contentType = mimeTypes[ext] || 'application/octet-stream';

            const asset: CapturedAsset = {
                url,
                localPath,
                contentType,
                size: body.length,
                isEntrypoint: false,
            };

            this.assets.push(asset);
            this.options.onCapture?.(asset);

            this.log(
                `[Static] Fetched responsive asset: ${localPath} (${body.length} bytes)`,
            );
        } catch (error) {
            this.log(`[Static] Error fetching ${url}: ${error}`);
        }
    }
}

/**
 * Rewrite URLs in HTML content to point to local files
 */
export function rewriteHtmlUrls(
    html: string,
    assets: CapturedAsset[],
    baseUrl: string,
): string {
    let result = html;

    // Build a map of original URLs to local paths
    const urlMap = new Map<string, string>();
    for (const asset of assets) {
        urlMap.set(asset.url, '/' + asset.localPath);
    }

    // Rewrite src and href attributes
    const baseUrlObj = new URL(baseUrl);

    for (const [originalUrl, localPath] of urlMap) {
        const urlObj = new URL(originalUrl);

        // Replace full URLs
        result = result.replace(
            new RegExp(escapeRegex(originalUrl), 'g'),
            localPath,
        );

        // Replace origin-relative URLs
        if (urlObj.origin === baseUrlObj.origin) {
            const relativePath = urlObj.pathname + urlObj.search;
            result = result.replace(
                new RegExp(
                    `(src|href)=["']${escapeRegex(relativePath)}["']`,
                    'g',
                ),
                `$1="${localPath}"`,
            );
        }
    }

    return result;
}

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse srcset attribute value and extract all URLs.
 * Handles both width descriptors (240w) and pixel density descriptors (2x).
 *
 * @param srcset - The srcset attribute value
 * @returns Array of URLs extracted from the srcset
 *
 * @example
 * parseSrcsetUrls("/img/foo-240.webp 240w, /img/foo-540.webp 540w")
 * // returns ["/img/foo-240.webp", "/img/foo-540.webp"]
 */
export function parseSrcsetUrls(srcset: string): string[] {
    if (!srcset || !srcset.trim()) {
        return [];
    }

    const urls: string[] = [];

    // Parse srcset character by character to handle data: URLs with commas
    // The srcset format is: URL [descriptor], URL [descriptor], ...
    // where descriptor is optional and can be "100w" or "2x"
    let i = 0;
    const len = srcset.length;

    while (i < len) {
        // Skip leading whitespace
        while (i < len && /\s/.test(srcset[i])) i++;
        if (i >= len) break;

        // Check if this is a data: URL
        if (srcset.slice(i, i + 5) === 'data:') {
            // Skip data: URLs entirely - find the next entry after whitespace+descriptor+comma
            // Data URLs end at whitespace followed by descriptor (e.g., " 1x")
            while (i < len) {
                // Look for pattern: whitespace + descriptor (digits + w/x)
                if (/\s/.test(srcset[i])) {
                    const rest = srcset.slice(i);
                    const descriptorMatch = rest.match(
                        /^\s+\d+(?:\.\d+)?[wx]\s*(?:,|$)/i,
                    );
                    if (descriptorMatch) {
                        i += descriptorMatch[0].length;
                        break;
                    }
                }
                i++;
            }
            continue;
        }

        // Extract URL (until whitespace)
        let url = '';
        while (i < len && !/\s/.test(srcset[i]) && srcset[i] !== ',') {
            url += srcset[i];
            i++;
        }

        if (url) {
            urls.push(url);
        }

        // Skip whitespace
        while (i < len && /\s/.test(srcset[i])) i++;

        // Skip optional descriptor (e.g., "240w", "2x", "1.5x")
        if (i < len && /[\d.]/.test(srcset[i])) {
            while (i < len && /[\d.]/.test(srcset[i])) i++;
            if (i < len && /[wx]/i.test(srcset[i])) i++;
        }

        // Skip whitespace and comma
        while (i < len && (/\s/.test(srcset[i]) || srcset[i] === ',')) i++;
    }

    return urls;
}

/**
 * Parse CSS image-set() function and extract all URLs.
 * Handles both standard image-set() and -webkit-image-set().
 *
 * @param imageSet - The image-set() function content (including the function name)
 * @returns Array of URLs extracted from the image-set
 *
 * @example
 * parseImageSetUrls("image-set(url('foo.webp') 1x, url('foo@2x.webp') 2x)")
 * // returns ["foo.webp", "foo@2x.webp"]
 */
export function parseImageSetUrls(imageSet: string): string[] {
    if (!imageSet || !imageSet.trim()) {
        return [];
    }

    const urls: string[] = [];

    // Match url() functions within the image-set
    // Handles: url("path"), url('path'), url(path)
    const urlPattern = /url\(\s*['"]?([^'")\s]+)['"]?\s*\)/gi;
    let match;

    while ((match = urlPattern.exec(imageSet)) !== null) {
        const url = match[1];
        if (url && !url.startsWith('data:')) {
            urls.push(url);
        }
    }

    // Also handle bare strings (without url()) which some browsers support
    // Format: "image.webp" 1x, "image@2x.webp" 2x
    // This is less common but valid
    const bareStringPattern = /['"]([^'"]+\.[a-z0-9]+)['"]\s+\d+x/gi;
    while ((match = bareStringPattern.exec(imageSet)) !== null) {
        const url = match[1];
        if (url && !url.startsWith('data:') && !urls.includes(url)) {
            urls.push(url);
        }
    }

    return urls;
}

/**
 * Extract all responsive image URLs from HTML content.
 * Finds URLs in:
 * - <img srcset="...">
 * - <source srcset="..."> (in <picture> elements)
 * - <source src="..."> (in <video> and <audio> elements)
 * - <style> tags containing image-set()
 *
 * @param html - The HTML content to parse
 * @param baseUrl - Base URL for resolving relative URLs
 * @returns Array of absolute URLs
 */
export function extractResponsiveUrlsFromHtml(
    html: string,
    baseUrl: string,
): string[] {
    const urls: Set<string> = new Set();

    // Extract srcset attributes from <img> and <source> elements
    const srcsetPattern = /srcset\s*=\s*["']([^"']+)["']/gi;
    let match;

    while ((match = srcsetPattern.exec(html)) !== null) {
        const srcsetValue = match[1];
        const srcsetUrls = parseSrcsetUrls(srcsetValue);
        for (const url of srcsetUrls) {
            const absoluteUrl = resolveUrl(url, baseUrl);
            if (absoluteUrl) {
                urls.add(absoluteUrl);
            }
        }
    }

    // Extract src attributes from <source> elements (for video/audio)
    // Be careful not to match <source> inside <picture> which uses srcset
    // We'll match all <source src="..."> and filter later if needed
    const sourceSrcPattern = /<source[^>]+src\s*=\s*["']([^"']+)["']/gi;

    while ((match = sourceSrcPattern.exec(html)) !== null) {
        const url = match[1];
        if (url && !url.startsWith('data:')) {
            const absoluteUrl = resolveUrl(url, baseUrl);
            if (absoluteUrl) {
                urls.add(absoluteUrl);
            }
        }
    }

    // Extract image-set() from inline <style> tags
    const stylePattern = /<style[^>]*>([\s\S]*?)<\/style>/gi;

    while ((match = stylePattern.exec(html)) !== null) {
        const styleContent = match[1];
        const cssUrls = extractResponsiveUrlsFromCss(styleContent, baseUrl);
        for (const url of cssUrls) {
            urls.add(url);
        }
    }

    return Array.from(urls);
}

/**
 * Extract all image-set() URLs from CSS content.
 * Handles both standard image-set() and -webkit-image-set().
 *
 * @param css - The CSS content to parse
 * @param cssUrl - URL of the CSS file (for resolving relative URLs)
 * @returns Array of absolute URLs
 */
export function extractResponsiveUrlsFromCss(
    css: string,
    cssUrl: string,
): string[] {
    const urls: Set<string> = new Set();

    // Match image-set() and -webkit-image-set() functions
    // The content can span multiple lines and contain nested parentheses in url()
    const imageSetPattern = /(?:-webkit-)?image-set\s*\(([^;{}]+)\)/gi;
    let match;

    while ((match = imageSetPattern.exec(css)) !== null) {
        const imageSetContent = match[0]; // Include the function name for parseImageSetUrls
        const imageSetUrls = parseImageSetUrls(imageSetContent);
        for (const url of imageSetUrls) {
            const absoluteUrl = resolveUrl(url, cssUrl);
            if (absoluteUrl) {
                urls.add(absoluteUrl);
            }
        }
    }

    return Array.from(urls);
}

/**
 * Resolve a potentially relative URL against a base URL.
 * Returns null if the URL is invalid.
 *
 * @param url - The URL to resolve (may be relative or absolute)
 * @param baseUrl - The base URL to resolve against
 * @returns Absolute URL string, or null if invalid
 */
function resolveUrl(url: string, baseUrl: string): string | null {
    try {
        // Handle protocol-relative URLs (//example.com/path)
        if (url.startsWith('//')) {
            const baseProtocol = new URL(baseUrl).protocol;
            return new URL(baseProtocol + url).href;
        }

        // Use URL constructor to resolve relative URLs
        return new URL(url, baseUrl).href;
    } catch {
        return null;
    }
}

/**
 * Check if a URL points to a media file (video/audio) based on extension.
 */
function isMediaUrl(url: string): boolean {
    try {
        const pathname = new URL(url).pathname.toLowerCase();
        const mediaExtensions = [
            '.mp4',
            '.webm',
            '.ogg',
            '.ogv',
            '.mp3',
            '.wav',
            '.flac',
            '.aac',
            '.m4a',
            '.m4v',
            '.mov',
            '.avi',
            '.mkv',
        ];
        return mediaExtensions.some((ext) => pathname.endsWith(ext));
    } catch {
        return false;
    }
}
