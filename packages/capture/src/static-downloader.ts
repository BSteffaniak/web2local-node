/**
 * Static asset downloading and capturing
 *
 * Uses page.on('response') to capture static assets as they load.
 */

import type { Page, Response } from 'playwright';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { dirname, join, extname } from 'path';
import { createHash } from 'crypto';
import { minimatch } from 'minimatch';
import { buildUrlMap, rewriteHtml, rewriteAllCssUrls } from './url-rewriter.js';
import type {
    AssetCaptureEvent,
    RequestActivityEvent,
    DuplicateSkippedEvent,
    FlushProgressEvent,
    CapturedAsset,
    CaptureVerboseEvent,
    ResourceType,
    StaticAssetFilter,
    CapturedAssetInfo,
    OnAssetCaptured,
} from './types.js';
import { robustFetch, FetchError } from '@web2local/http';

/**
 * 1x1 transparent PNG placeholder for failed fetches (68 bytes).
 * Used when an asset referenced in CSS cannot be fetched.
 */
const PLACEHOLDER_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
);

/** Default timeout for truncation recovery fetch (60 seconds) */
const TRUNCATION_RECOVERY_TIMEOUT_MS = 60000;

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Direct HTTP fetch with proper streaming support and content verification.
 * Used as a fallback when Playwright's response.body() returns truncated data.
 * Uses robustFetch for automatic retry on transient errors.
 *
 * Includes retry logic for truncated responses: if the response is truncated
 * (received fewer bytes than Content-Length), we retry with exponential backoff.
 *
 * @param url - URL to fetch
 * @param onWarning - Optional callback for warning messages (truncation, fetch failures)
 * @param timeoutMs - Timeout in milliseconds (default: 60000)
 * @param maxRetries - Maximum number of retries for truncated responses (default: 2)
 * @param retryDelayBase - Base delay for exponential backoff in ms (default: 500)
 * @param retryDelayMax - Maximum backoff delay in ms (default: 5000)
 */
async function fetchWithContentVerification(
    url: string,
    onWarning?: (message: string) => void,
    timeoutMs: number = TRUNCATION_RECOVERY_TIMEOUT_MS,
    maxRetries: number = 2,
    retryDelayBase: number = 500,
    retryDelayMax: number = 5000,
): Promise<Buffer | null> {
    let lastBuffer: Buffer | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const response = await robustFetch(url, {
                signal: AbortSignal.timeout(timeoutMs),
                headers: {
                    'User-Agent':
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    Accept: '*/*',
                },
            });

            if (!response.ok) {
                return lastBuffer;
            }

            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            // Verify content length if header present
            const contentLength = parseInt(
                response.headers.get('content-length') || '0',
                10,
            );

            // Check for truncation (only when got < expected)
            // Note: got > expected is normal for compressed responses (gzip/br)
            // where Content-Length is compressed size but body() returns decompressed
            if (contentLength > 0 && buffer.length < contentLength) {
                lastBuffer = buffer;

                // If we have more retries, backoff and retry
                if (attempt < maxRetries) {
                    const delay = Math.min(
                        retryDelayBase * Math.pow(2, attempt),
                        retryDelayMax,
                    );
                    await sleep(delay);
                    continue;
                }

                // Final attempt still truncated - warn and return what we have
                const msg = `Truncated response for ${url} (got ${buffer.length} bytes, expected ${contentLength}) after ${attempt + 1} attempts`;
                if (onWarning) {
                    onWarning(msg);
                } else {
                    console.warn(msg);
                }
                return buffer;
            }

            // Success - got complete data (or no Content-Length to verify against)
            return buffer;
        } catch (error) {
            // FetchError already has good error details
            if (error instanceof FetchError) {
                const msg = `Failed to fetch ${url}: ${error.message}`;
                if (onWarning) {
                    onWarning(msg);
                } else {
                    console.warn(msg);
                }
            }
            return lastBuffer; // Return partial data if we have any
        }
    }

    return lastBuffer;
}

/**
 * Options for static asset capture
 */
export interface StaticCaptureOptions {
    /** Output directory for static assets */
    outputDir: string;
    /** Maximum file size to download (bytes) */
    maxFileSize: number;
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
    /** Structured progress callback for asset capture */
    onCapture?: (event: AssetCaptureEvent) => void;
    /** Structured progress callback for request activity (in-flight requests) */
    onRequestActivity?: (event: RequestActivityEvent) => void;
    /** Structured progress callback for when a duplicate request is skipped */
    onDuplicateSkipped?: (event: DuplicateSkippedEvent) => void;
    /** Structured verbose log callback */
    onVerbose?: (event: CaptureVerboseEvent) => void;

    /**
     * Filter for selective asset capture.
     * When provided, only assets matching the filter criteria are captured.
     * When not provided, all static assets are captured (default behavior).
     *
     * Use this to limit which assets are downloaded. When set, requests for
     * non-matching assets are aborted before network transfer occurs.
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

    /**
     * Callback for flush progress events.
     * Provides granular progress during pending captures, CSS asset fetching, and URL rewriting.
     */
    onFlushProgress?: (event: FlushProgressEvent) => void;

    /**
     * Number of retries for truncated asset downloads (default: 2).
     * When an asset is truncated (received fewer bytes than Content-Length header),
     * we will retry fetching it this many times with exponential backoff.
     */
    assetRetries?: number;
    /** Base delay for exponential backoff between retries in ms (default: 500) */
    retryDelayBase?: number;
    /** Maximum backoff delay between retries in ms (default: 5000) */
    retryDelayMax?: number;
}

const DEFAULT_OPTIONS: StaticCaptureOptions = {
    outputDir: './static',
    maxFileSize: 50 * 1024 * 1024, // 50MB
    captureRenderedHtml: false,
    captureMediaSources: false,
    verbose: false,
    skipAssetWrite: false,
    assetRetries: 2,
    retryDelayBase: 500,
    retryDelayMax: 5000,
};

/**
 * Data for an asset whose body has already been fetched.
 * Used by processAndSaveAsset() to process assets without needing the Playwright Response.
 */
interface FetchedAssetData {
    /** The URL of the asset */
    url: string;
    /** The fetched body buffer */
    body: Buffer;
    /** Content-Type from response headers */
    contentType: string;
    /** Content-Length from response headers (0 if not present) */
    contentLength: number;
    /** Browser resource type */
    resourceType: ResourceType;
    /** Worker ID for progress tracking */
    workerId?: number;
}

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
 * Generate a local path for a URL.
 *
 * Same-origin resources keep their original pathname.
 * All cross-origin resources (including CDN subdomains) go to _external/
 * with a hash-based filename to ensure uniqueness.
 */
function urlToLocalPath(url: string, baseUrl: string): string {
    const urlObj = new URL(url);
    const baseUrlObj = new URL(baseUrl);

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

    // For ALL cross-origin resources (including CDN subdomains), use a hash-based filename in _external/
    // Include the full URL (with query string) in the hash for uniqueness
    const fullUrl = url;
    const hash = createHash('md5').update(fullUrl).digest('hex').slice(0, 12);

    // Get the filename from the pathname
    const pathParts = urlObj.pathname.split('/');
    const rawFilename = pathParts[pathParts.length - 1] || 'file';

    // Sanitize the filename (remove unsafe characters)
    const safeName = rawFilename.replace(/[^a-zA-Z0-9._-]/g, '_');

    // Get extension from the pathname (ignoring query string)
    const ext = extname(urlObj.pathname);

    // If the filename already has an extension, use as-is
    // Otherwise append the extension if we found one
    let finalFilename: string;
    if (extname(safeName)) {
        finalFilename = `${hash}_${safeName}`;
    } else if (ext) {
        finalFilename = `${hash}_${safeName}${ext}`;
    } else {
        finalFilename = `${hash}_${safeName}`;
    }

    return `_external/${finalFilename}`;
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
 * Guess the content type from a URL's extension.
 * Used when we need to guess content type before fetching.
 */
function getContentTypeFromExtension(url: string): string {
    try {
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
            '.avif': 'image/avif',
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
    } catch {
        return 'application/octet-stream';
    }
}

/**
 * Guess the resource type from a URL's extension.
 * Used when applying filters to CSS-referenced assets before fetching.
 */
function guessResourceType(url: string): ResourceType {
    try {
        const ext = extname(new URL(url).pathname).toLowerCase();

        const imageExts = [
            '.png',
            '.jpg',
            '.jpeg',
            '.gif',
            '.webp',
            '.svg',
            '.ico',
            '.avif',
            '.bmp',
            '.tiff',
        ];
        const fontExts = ['.woff', '.woff2', '.ttf', '.otf', '.eot'];
        const styleExts = ['.css'];
        const scriptExts = ['.js', '.mjs'];
        const mediaExts = ['.mp4', '.webm', '.mp3', '.wav', '.ogg', '.m4a'];

        if (imageExts.includes(ext)) return 'image';
        if (fontExts.includes(ext)) return 'font';
        if (styleExts.includes(ext)) return 'stylesheet';
        if (scriptExts.includes(ext)) return 'script';
        if (mediaExts.includes(ext)) return 'media';

        return 'other';
    } catch {
        return 'other';
    }
}

/**
 * Static Asset Capturer - captures static assets via response events
 */
export class StaticCapturer {
    private assets: CapturedAsset[] = [];
    private downloadedUrls: Set<string> = new Set();
    private inFlightUrls: Set<string> = new Set();
    private duplicatesSkipped: number = 0;
    private pendingCaptures: Map<string, Promise<void>> = new Map();
    private options: StaticCaptureOptions;
    private entrypointUrl: string | null = null;
    private baseOrigin: string | null = null;
    /** Original HTML responses from the network (before JS execution), keyed by URL */
    private originalDocumentHtmlByUrl: Map<string, string> = new Map();
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
    /** Map of Page to workerId for request tracking */
    private pageToWorkerId: WeakMap<Page, number> = new WeakMap();
    /** In-flight requests per worker */
    private activeRequestsByWorker: Map<number, Set<string>> = new Map();
    /** Most recent request URL per worker */
    private currentRequestByWorker: Map<
        number,
        { url: string; size?: number }
    > = new Map();
    /** Duplicate requests count per worker (reset on each new page) */
    private duplicateRequestsByWorker: Map<number, number> = new Map();
    /** Count of assets that failed to fetch during flush (used placeholders) */
    private flushFailedCount: number = 0;
    /** Active downloads during flush phase (for progress reporting) */
    private activeDownloads: Map<
        string,
        {
            url: string;
            status: 'downloading' | 'processing' | 'saving';
            expectedSize?: number;
            startedAt: number;
        }
    > = new Map();

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
     * Reset per-worker tracking when starting a new page.
     * This clears the duplicate count and active requests so each page starts fresh.
     */
    resetWorkerTracking(workerId: number): void {
        this.duplicateRequestsByWorker.set(workerId, 0);
        this.activeRequestsByWorker.set(workerId, new Set());
        this.currentRequestByWorker.delete(workerId);
        // Emit an activity event to update the TUI
        this.emitRequestActivity(workerId);
    }

    /**
     * Track the start of a request for a worker.
     * Updates active request count and emits activity event.
     */
    private trackRequestStart(
        url: string,
        workerId: number,
        contentLength?: number,
    ): void {
        // Add to active requests for this worker
        let activeSet = this.activeRequestsByWorker.get(workerId);
        if (!activeSet) {
            activeSet = new Set();
            this.activeRequestsByWorker.set(workerId, activeSet);
        }
        activeSet.add(url);

        // Update current request for this worker
        this.currentRequestByWorker.set(workerId, {
            url,
            size: contentLength,
        });

        // Emit activity event
        this.emitRequestActivity(workerId);
    }

    /**
     * Track the completion of a request for a worker.
     * Updates active request count and emits activity event.
     */
    private trackRequestEnd(url: string, workerId: number): void {
        const activeSet = this.activeRequestsByWorker.get(workerId);
        if (activeSet) {
            activeSet.delete(url);

            // If this was the current request, clear it or set to another active one
            const current = this.currentRequestByWorker.get(workerId);
            if (current?.url === url) {
                // Find another active request to show, or clear
                const remaining = Array.from(activeSet);
                if (remaining.length > 0) {
                    this.currentRequestByWorker.set(workerId, {
                        url: remaining[remaining.length - 1],
                    });
                } else {
                    this.currentRequestByWorker.delete(workerId);
                }
            }
        }

        // Emit activity event
        this.emitRequestActivity(workerId);
    }

    /**
     * Emit a request activity event for a worker.
     */
    private emitRequestActivity(workerId: number): void {
        if (!this.options.onRequestActivity) return;

        const activeSet = this.activeRequestsByWorker.get(workerId);
        const activeRequests = activeSet?.size ?? 0;
        const duplicateRequests =
            this.duplicateRequestsByWorker.get(workerId) ?? 0;
        const current = this.currentRequestByWorker.get(workerId);

        this.options.onRequestActivity({
            type: 'request-activity',
            workerId,
            activeRequests,
            duplicateRequests,
            currentUrl: current?.url,
            currentSize: current?.size,
        });
    }

    /**
     * Add an active download to tracking (for flush progress display).
     */
    private addActiveDownload(url: string, expectedSize?: number): void {
        this.activeDownloads.set(url, {
            url,
            status: 'downloading',
            expectedSize,
            startedAt: Date.now(),
        });
    }

    /**
     * Update the status of an active download.
     */
    private updateDownloadStatus(
        url: string,
        status: 'downloading' | 'processing' | 'saving',
    ): void {
        const item = this.activeDownloads.get(url);
        if (item) {
            item.status = status;
        }
    }

    /**
     * Remove an active download from tracking.
     */
    private removeActiveDownload(url: string): void {
        this.activeDownloads.delete(url);
    }

    /**
     * Get current active downloads as an array (for progress events).
     */
    private getActiveItems(): Array<{
        url: string;
        status: 'downloading' | 'processing' | 'saving';
        expectedSize?: number;
        startedAt: number;
    }> {
        return Array.from(this.activeDownloads.values());
    }

    /**
     * Check if the response should be captured based on Content-Type header.
     * This allows filtering BEFORE fetching the body (optimization).
     * Returns true if the response should be captured, false if it should be skipped.
     */
    private shouldCaptureByContentType(
        response: Response,
        url: string,
        resourceType: ResourceType,
    ): boolean {
        // No MIME filter configured - capture everything
        if (!this.options.staticFilter?.mimeTypes?.length) {
            return true;
        }

        const contentType = getContentType(response, url);
        return passesFilter(
            url,
            contentType,
            resourceType,
            this.options.staticFilter,
        );
    }

    /**
     * Check Content-Length header before fetching body.
     * Returns true if we should proceed with body fetch.
     */
    private shouldCaptureBySize(response: Response, url: string): boolean {
        const contentLength = parseInt(
            response.headers()['content-length'] || '0',
            10,
        );
        if (contentLength > 0 && contentLength > this.options.maxFileSize) {
            this.log(
                `[Static] Skipping large file (header): ${url} (${contentLength} bytes)`,
            );
            return false;
        }
        return true;
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
     * Log a verbose message - uses onVerbose callback if provided, otherwise console.log.
     * Only emits if verbose mode is enabled.
     */
    private log(
        message: string,
        level: 'debug' | 'info' | 'warn' | 'error' = 'debug',
        data?: Record<string, unknown>,
    ): void {
        if (!this.options.verbose) return;

        if (this.options.onVerbose) {
            this.options.onVerbose({
                type: 'verbose',
                level,
                source: 'static-capturer',
                message,
                data,
            });
        } else {
            console.log(message);
        }
    }

    /**
     * Log a warning message - always emitted regardless of verbose flag.
     * These are important issues like truncated downloads that users should see.
     */
    private logWarning(message: string, data?: Record<string, unknown>): void {
        if (this.options.onVerbose) {
            this.options.onVerbose({
                type: 'verbose',
                level: 'warn',
                source: 'static-capturer',
                message,
                data,
            });
        } else {
            console.warn(message);
        }
    }

    /**
     * Attach capturer to a page using response events.
     * Must be called before navigation to enable route interception.
     *
     * @param page - Playwright page instance
     * @param entrypointUrl - The initial URL being captured
     * @param workerId - Optional worker ID for request activity tracking
     */
    async attach(
        page: Page,
        entrypointUrl: string,
        workerId?: number,
    ): Promise<void> {
        this.entrypointUrl = entrypointUrl;
        this.baseOrigin = new URL(entrypointUrl).origin;

        // Store the workerId for this page (for request activity tracking)
        if (workerId !== undefined) {
            this.pageToWorkerId.set(page, workerId);
            // Initialize tracking structures for this worker
            if (!this.activeRequestsByWorker.has(workerId)) {
                this.activeRequestsByWorker.set(workerId, new Set());
            }
            if (!this.duplicateRequestsByWorker.has(workerId)) {
                this.duplicateRequestsByWorker.set(workerId, 0);
            }
        }

        this.log(
            `[StaticCapturer] Attaching to page, entrypoint: ${entrypointUrl}, workerId: ${workerId}`,
        );
        this.log(`[StaticCapturer] Initial base origin: ${this.baseOrigin}`);
        this.log(
            `[StaticCapturer] Options: staticFilter=${this.options.staticFilter ? 'set' : 'none'}, skipAssetWrite=${this.options.skipAssetWrite}`,
        );

        // Set up route interception to:
        // 1. Deduplicate requests - abort if already downloaded or in-flight
        // 2. Filter requests - abort if they don't pass staticFilter
        this.log(
            `[StaticCapturer] Setting up route interception for deduplication and filtering`,
        );
        await page.route('**/*', (route, request) => {
            const resourceType = request.resourceType() as ResourceType;
            const url = request.url();

            // Always allow navigation requests (needed for crawling)
            if (request.isNavigationRequest()) {
                route.continue();
                return;
            }

            // Skip data URLs
            if (url.startsWith('data:')) {
                route.continue();
                return;
            }

            // Only handle static resource types for deduplication/filtering
            if (!STATIC_RESOURCE_TYPES.has(resourceType)) {
                route.continue();
                return;
            }

            // DEDUPLICATION: If already downloaded or in-flight from another worker, abort
            if (this.downloadedUrls.has(url) || this.inFlightUrls.has(url)) {
                this.duplicatesSkipped++;
                this.log(
                    `[Static] Skipping duplicate request: ${url.length > 60 ? url.substring(0, 60) + '...' : url}`,
                );

                // Track duplicate count for this worker and emit activity event
                if (workerId !== undefined) {
                    const current =
                        this.duplicateRequestsByWorker.get(workerId) ?? 0;
                    this.duplicateRequestsByWorker.set(workerId, current + 1);
                    this.emitRequestActivity(workerId);
                }

                // Emit duplicate skipped event
                this.options.onDuplicateSkipped?.({
                    type: 'duplicate-skipped',
                    workerId,
                    url,
                });
                route.abort();
                return;
            }

            // Mark as in-flight before continuing
            this.inFlightUrls.add(url);

            // Apply early URL-based filter (if staticFilter is set)
            if (
                this.options.staticFilter &&
                !passesFilterEarly(url, this.options.staticFilter)
            ) {
                this.log(`[Static] Aborting ${url} (does not pass filter)`);
                this.inFlightUrls.delete(url);
                route.abort();
                return;
            }

            // Track request start immediately when allowing it through
            // This ensures the TUI shows activity as soon as requests begin
            if (workerId !== undefined) {
                this.trackRequestStart(url, workerId, undefined);
            }

            // Let the request proceed
            route.continue();
        });

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

        // Note: Request tracking is now done in the route handler above
        // (trackRequestStart is called when we allow a request through)
        // This ensures activity is shown immediately when requests begin,
        // rather than waiting for the 'request' event which may fire later.

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

                // Capture the original HTML for this URL if we haven't already
                // (avoid overwriting with redirect responses for the same URL)
                if (!this.originalDocumentHtmlByUrl.has(responseUrl)) {
                    // Capture the original HTML from the network response
                    try {
                        const body = await response.body();
                        this.originalDocumentHtmlByUrl.set(
                            responseUrl,
                            body.toString('utf-8'),
                        );
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
                        `[Static] Skipping duplicate document: ${responseUrl}`,
                    );
                }
                return;
            }

            // Use request URL for asset tracking (consistent with previous behavior)
            const url = requestUrl;

            // Skip if already downloaded
            if (this.downloadedUrls.has(url)) {
                this.inFlightUrls.delete(url);
                return;
            }

            // Early URL-based filtering (avoids fetching body for filtered assets)
            // This checks extensions, include patterns, and exclude patterns.
            if (
                this.options.staticFilter &&
                !passesFilterEarly(url, this.options.staticFilter)
            ) {
                this.log(`[Static] Skipping ${url} (does not pass URL filter)`);
                this.inFlightUrls.delete(url);
                return;
            }

            // Only capture successful responses
            if (!response.ok()) {
                this.log(
                    `[Static] Skipping non-ok response: ${response.status()} ${url}`,
                );
                this.inFlightUrls.delete(url);
                return;
            }

            // Check MIME type from headers BEFORE fetching body (optimization)
            if (!this.shouldCaptureByContentType(response, url, resourceType)) {
                this.log(
                    `[Static] Skipping ${url} (does not pass MIME type filter)`,
                );
                this.inFlightUrls.delete(url);
                return;
            }

            // Check Content-Length BEFORE fetching body (optimization)
            if (!this.shouldCaptureBySize(response, url)) {
                this.inFlightUrls.delete(url);
                return;
            }

            const shortUrl =
                url.length > 80 ? url.substring(0, 80) + '...' : url;
            this.log(`[Static] Capturing ${resourceType}: ${shortUrl}`);

            // Mark as downloading to prevent duplicates
            this.downloadedUrls.add(url);

            // Get workerId for this page for tracking
            const wid = this.pageToWorkerId.get(page);

            // Fetch body IMMEDIATELY while response is still valid
            // This prevents hanging if the page navigates away before we process the asset
            let body: Buffer;
            try {
                body = await response.body();
            } catch (error) {
                // Response body may not be available (e.g., redirects, cached responses, page navigated)
                this.log(`[Static] Could not get body for ${url}: ${error}`);
                this.inFlightUrls.delete(url);
                this.downloadedUrls.delete(url); // Allow retry
                return;
            }

            // Get content info from headers for processAndSaveAsset
            const contentType = getContentType(response, url);
            const contentLength = parseInt(
                response.headers()['content-length'] || '0',
                10,
            );

            // Process and save asynchronously (file I/O only - won't hang on page navigation)
            const processPromise = this.processAndSaveAsset({
                url,
                body,
                contentType,
                contentLength,
                resourceType,
                workerId: wid,
            });
            this.pendingCaptures.set(url, processPromise);
            processPromise.finally(() => {
                this.pendingCaptures.delete(url);
                // Clean up in-flight tracking
                this.inFlightUrls.delete(url);
                // Track request completion
                if (wid !== undefined) {
                    this.trackRequestEnd(url, wid);
                }
            });
        });

        this.log(`[StaticCapturer] Response handler attached`);
    }

    /**
     * Process and save a static asset whose body has already been fetched.
     * This method does NOT call response.body() - the body must be provided.
     *
     * This is the core asset processing logic extracted from captureAsset().
     * It handles: truncation recovery, size validation, callbacks, file writing,
     * and CSS URL extraction.
     */
    private async processAndSaveAsset(data: FetchedAssetData): Promise<void> {
        const { url, contentType, contentLength, resourceType, workerId } =
            data;
        let body = data.body;

        try {
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

                // Try to recover with direct HTTP fetch (with timeout and retries)
                const recoveredBody = await fetchWithContentVerification(
                    url,
                    (msg) => this.logWarning(msg),
                    TRUNCATION_RECOVERY_TIMEOUT_MS,
                    this.options.assetRetries ?? 2,
                    this.options.retryDelayBase ?? 500,
                    this.options.retryDelayMax ?? 5000,
                );
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

            // Double-check size (body might be larger than header indicated due to decompression)
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
                this.options.onCapture?.({
                    type: 'asset-capture',
                    workerId,
                    url,
                    localPath,
                    contentType,
                    size: body.length,
                });
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
            this.options.onCapture?.({
                type: 'asset-capture',
                workerId,
                url,
                localPath,
                contentType,
                size: body.length,
            });

            this.log(`[Static] Saved: ${localPath} (${body.length} bytes)`);

            // If this is a CSS file, extract ALL URL references for later fetching
            // This includes url(), @import, and image-set() references
            if (contentType.includes('css') || url.endsWith('.css')) {
                try {
                    const cssContent = body.toString('utf-8');
                    const allCssUrls = extractAllUrlsFromCss(cssContent, url);
                    if (allCssUrls.length > 0) {
                        this.log(
                            `[Static] Found ${allCssUrls.length} URLs in CSS: ${url}`,
                        );
                        for (const cssUrl of allCssUrls) {
                            this.pendingResponsiveUrls.add(cssUrl);
                        }
                    }
                } catch (cssError) {
                    this.log(
                        `[Static] Error parsing CSS for image-set: ${cssError}`,
                    );
                }
            }
        } catch (error) {
            this.log(`[Static] Error processing ${url}: ${error}`);
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

        // Look up the original HTML for this specific URL
        const originalHtml = this.originalDocumentHtmlByUrl.get(url);

        if (this.options.captureRenderedHtml) {
            // Capture the rendered DOM (after JS execution)
            // Use this for SPAs where the initial HTML is empty/minimal
            this.log(`[Static] Using rendered HTML (after JS execution)`);
            html = await page.content();
        } else if (originalHtml) {
            // Use the original HTML response (before JS execution)
            // This ensures event handlers get properly attached when JS runs
            this.log(
                `[Static] Using original HTML (before JS execution, ${originalHtml.length} bytes)`,
            );
            html = originalHtml;
        } else {
            // Fallback to rendered HTML if original wasn't captured
            this.log(
                `[Static] Original HTML not available for ${url}, falling back to rendered HTML`,
            );
            html = await page.content();
        }

        // Note: URL rewriting is done in flush() after all assets are captured
        // to ensure we have the complete URL mapping
        const baseUrl = this.baseOrigin || this.entrypointUrl || url;

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
        this.options.onCapture?.({
            type: 'asset-capture',
            url,
            localPath,
            contentType: 'text/html',
            size: body.length,
        });

        this.log(
            `[Static] Saved document: ${localPath} (${body.length} bytes)`,
        );

        // Extract responsive image URLs that browser may not have loaded
        // (e.g., srcset variants for different viewport sizes)
        // These will be fetched during flush() for better progress tracking
        const responsiveUrls = extractResponsiveUrlsFromHtml(html, baseUrl);
        if (responsiveUrls.length > 0) {
            this.log(
                `[Static] Found ${responsiveUrls.length} responsive URLs in HTML, queuing for fetch`,
            );
            for (const url of responsiveUrls) {
                this.pendingResponsiveUrls.add(url);
            }
        }

        return asset;
    }

    /**
     * Get the number of pending asset captures.
     */
    getPendingCount(): number {
        return this.pendingCaptures.size + this.pendingResponsiveUrls.size;
    }

    /**
     * Wait for all pending captures to complete, then fetch any
     * responsive URLs discovered in CSS files, and finally rewrite
     * all URLs in HTML and CSS files to point to local copies.
     *
     * Emits granular progress events via onFlushProgress callback.
     * Uses unified progress tracking across all phases.
     */
    async flush(): Promise<void> {
        const flushStartTime = Date.now();
        this.flushFailedCount = 0;
        this.activeDownloads.clear();

        // Calculate totals upfront for unified progress
        const pendingCapturesCount = this.pendingCaptures.size;
        const responsiveUrlsCount = this.pendingResponsiveUrls.size;

        // Calculate rewrite count upfront (we'll do actual filtering later)
        const htmlAssets = this.assets.filter(
            (a) =>
                a.contentType.includes('html') ||
                a.localPath.endsWith('.html') ||
                a.localPath.endsWith('.htm'),
        );
        const cssAssets = this.assets.filter(
            (a) =>
                a.contentType.includes('css') || a.localPath.endsWith('.css'),
        );
        const rewriteCount = this.options.skipAssetWrite
            ? 0
            : htmlAssets.length + cssAssets.length;

        // Total items across all phases
        const overallTotal =
            pendingCapturesCount + responsiveUrlsCount + rewriteCount;
        let completedItems = 0;

        // Phase 1: Wait for pending captures with progress
        const pending = Array.from(this.pendingCaptures.entries());

        if (pending.length > 0) {
            this.log(
                `[StaticCapturer] Waiting for ${pending.length} pending captures...`,
            );

            // Add all pending URLs to active downloads tracking
            for (const [url] of pending) {
                this.addActiveDownload(url);
            }

            // Emit initial progress event to show progress bar immediately
            this.options.onFlushProgress?.({
                type: 'flush-progress',
                phase: 'pending-captures',
                completed: completedItems,
                total: overallTotal,
                activeItems: this.getActiveItems(),
            });

            await Promise.all(
                pending.map(async ([url, promise]) => {
                    await promise;
                    this.removeActiveDownload(url);
                    completedItems++;
                    this.options.onFlushProgress?.({
                        type: 'flush-progress',
                        phase: 'pending-captures',
                        completed: completedItems,
                        total: overallTotal,
                        completedItem: url,
                        activeItems: this.getActiveItems(),
                    });
                }),
            );
        }

        // Phase 2: Fetch responsive URLs discovered in CSS/HTML files
        if (this.pendingResponsiveUrls.size > 0) {
            const urls = Array.from(this.pendingResponsiveUrls);
            this.log(
                `[StaticCapturer] Fetching ${urls.length} URLs from CSS/HTML...`,
            );
            completedItems = await this.fetchAdditionalAssetsWithProgress(
                urls,
                completedItems,
                overallTotal,
            );
            this.pendingResponsiveUrls.clear();
        }

        // Phase 3: Rewrite URLs in HTML and CSS files
        // Skip if we're not writing assets to disk
        if (!this.options.skipAssetWrite) {
            completedItems = await this.rewriteAssetUrlsWithProgress(
                completedItems,
                overallTotal,
                htmlAssets,
                cssAssets,
            );
        }

        // Emit completion event with total time
        const totalTimeMs = Date.now() - flushStartTime;
        this.options.onFlushProgress?.({
            type: 'flush-progress',
            phase: 'complete',
            completed: overallTotal,
            total: overallTotal,
            totalTimeMs,
        });
    }

    /**
     * Rewrite URLs in all captured HTML and CSS files to point to local copies.
     * This is called after all assets have been captured to ensure we have
     * the complete URL mapping.
     *
     * Emits progress events via onFlushProgress callback.
     * Uses unified progress tracking across all flush phases.
     *
     * @param baseCompleted - Number of items already completed in previous phases
     * @param overallTotal - Total number of items across all phases
     * @param htmlAssets - Pre-filtered HTML assets to rewrite
     * @param cssAssets - Pre-filtered CSS assets to rewrite
     * @returns Updated completed count after this phase
     */
    private async rewriteAssetUrlsWithProgress(
        baseCompleted: number,
        overallTotal: number,
        htmlAssets: CapturedAsset[],
        cssAssets: CapturedAsset[],
    ): Promise<number> {
        let completedItems = baseCompleted;

        if (this.assets.length === 0) {
            return completedItems;
        }

        const baseUrl = this.baseOrigin || this.entrypointUrl || '';
        if (!baseUrl) {
            this.log(
                '[StaticCapturer] No base URL available, skipping URL rewriting',
            );
            return completedItems;
        }

        // Build URL map from all captured assets
        const urlMap = buildUrlMap(this.assets, baseUrl);
        this.log(
            `[StaticCapturer] Built URL map with ${urlMap.size} entries for rewriting`,
        );

        const phaseTotal = htmlAssets.length + cssAssets.length;

        this.log(
            `[StaticCapturer] Rewriting URLs in ${htmlAssets.length} HTML and ${cssAssets.length} CSS files`,
        );

        // Emit initial progress event to show progress bar immediately
        if (phaseTotal > 0) {
            this.options.onFlushProgress?.({
                type: 'flush-progress',
                phase: 'rewriting-urls',
                completed: completedItems,
                total: overallTotal,
            });
        }

        // Rewrite HTML files
        for (const asset of htmlAssets) {
            try {
                const fullPath = join(this.options.outputDir, asset.localPath);
                const content = await readFile(fullPath, 'utf-8');

                const rewritten = rewriteHtml(content, urlMap, asset.url);

                if (rewritten !== content) {
                    await writeFile(fullPath, rewritten, 'utf-8');
                    this.log(
                        `[StaticCapturer] Rewrote URLs in HTML: ${asset.localPath}`,
                    );
                }
            } catch (error) {
                this.log(
                    `[StaticCapturer] Error rewriting HTML ${asset.localPath}: ${error}`,
                    'error',
                );
            }

            completedItems++;
            this.options.onFlushProgress?.({
                type: 'flush-progress',
                phase: 'rewriting-urls',
                completed: completedItems,
                total: overallTotal,
                completedItem: asset.localPath,
            });
        }

        // Rewrite CSS files
        for (const asset of cssAssets) {
            try {
                const fullPath = join(this.options.outputDir, asset.localPath);
                const content = await readFile(fullPath, 'utf-8');

                const rewritten = rewriteAllCssUrls(content, urlMap, asset.url);

                if (rewritten !== content) {
                    await writeFile(fullPath, rewritten, 'utf-8');
                    this.log(
                        `[StaticCapturer] Rewrote URLs in CSS: ${asset.localPath}`,
                    );
                }
            } catch (error) {
                this.log(
                    `[StaticCapturer] Error rewriting CSS ${asset.localPath}: ${error}`,
                    'error',
                );
            }

            completedItems++;
            this.options.onFlushProgress?.({
                type: 'flush-progress',
                phase: 'rewriting-urls',
                completed: completedItems,
                total: overallTotal,
                completedItem: asset.localPath,
            });
        }

        return completedItems;
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
        duplicatesSkipped: number;
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
            duplicatesSkipped: this.duplicatesSkipped,
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
        this.inFlightUrls.clear();
        this.duplicatesSkipped = 0;
        this.pendingCaptures.clear();
        this.pendingResponsiveUrls.clear();
        this.entrypointUrl = null;
        this.baseOrigin = null;
        this.originalDocumentHtmlByUrl.clear();
        this.truncatedFiles = [];
        this.recoveredFiles = [];
        this.currentPageUrl = null;
    }

    /**
     * Fetch additional assets that were discovered but not loaded by the browser.
     * This is used to capture assets referenced in CSS (`url()`, `\@import`) and HTML
     * (srcset, inline styles) that the browser didn't load.
     *
     * All URLs are eligible for fetching (including cross-origin), but the same
     * staticFilter is applied to respect user filtering preferences.
     *
     * Emits progress events via onFlushProgress callback.
     * Uses unified progress tracking across all flush phases.
     *
     * @param urls - Array of absolute URLs to fetch
     * @param baseCompleted - Number of items already completed in previous phases
     * @param overallTotal - Total number of items across all phases
     * @returns Updated completed count after this phase
     */
    private async fetchAdditionalAssetsWithProgress(
        urls: string[],
        baseCompleted: number,
        overallTotal: number,
    ): Promise<number> {
        let completedItems = baseCompleted;

        // Filter out URLs already downloaded
        const newUrls = urls.filter((url) => !this.downloadedUrls.has(url));

        if (newUrls.length === 0) {
            return completedItems;
        }

        this.log(
            `[Static] Fetching ${newUrls.length} additional assets from CSS/HTML...`,
        );

        const baseUrl = this.baseOrigin || this.entrypointUrl;
        if (!baseUrl) {
            this.log(
                '[Static] No base URL available, skipping additional assets',
            );
            return completedItems;
        }

        // Apply the same staticFilter that's used for other assets
        const eligibleUrls = newUrls.filter((url) => {
            try {
                // Apply staticFilter if set
                if (this.options.staticFilter) {
                    const resourceType = guessResourceType(url);
                    const contentType = getContentTypeFromExtension(url);
                    if (
                        !passesFilter(
                            url,
                            contentType,
                            resourceType,
                            this.options.staticFilter,
                        )
                    ) {
                        this.log(
                            `[Static] Skipping ${url} (does not pass filter)`,
                        );
                        return false;
                    }
                }
                return true;
            } catch {
                return false;
            }
        });

        if (eligibleUrls.length === 0) {
            this.log('[Static] No eligible URLs to fetch after filtering');
            return completedItems;
        }

        this.log(
            `[Static] ${eligibleUrls.length} URLs pass filter, fetching...`,
        );

        // Emit initial progress event to show progress bar immediately
        this.options.onFlushProgress?.({
            type: 'flush-progress',
            phase: 'fetching-css-assets',
            completed: completedItems,
            total: overallTotal,
            failed: 0,
            activeItems: [],
        });

        // Fetch in batches to avoid overwhelming the server
        const BATCH_SIZE = 5;
        for (let i = 0; i < eligibleUrls.length; i += BATCH_SIZE) {
            const batch = eligibleUrls.slice(i, i + BATCH_SIZE);

            // Add batch to active downloads tracking
            for (const url of batch) {
                this.addActiveDownload(url);
            }

            // Emit progress with active items before starting batch
            this.options.onFlushProgress?.({
                type: 'flush-progress',
                phase: 'fetching-css-assets',
                completed: completedItems,
                total: overallTotal,
                failed: this.flushFailedCount,
                activeItems: this.getActiveItems(),
            });

            await Promise.all(
                batch.map(async (url) => {
                    const success =
                        await this.fetchSingleAssetWithTracking(url);
                    if (!success) {
                        this.flushFailedCount++;
                    }
                    this.removeActiveDownload(url);
                    completedItems++;
                    this.options.onFlushProgress?.({
                        type: 'flush-progress',
                        phase: 'fetching-css-assets',
                        completed: completedItems,
                        total: overallTotal,
                        failed: this.flushFailedCount,
                        completedItem: url,
                        activeItems: this.getActiveItems(),
                    });
                }),
            );
        }

        return completedItems;
    }

    /**
     * Fetch and save a single asset by URL.
     * Used for fetching assets referenced in CSS/HTML that weren't loaded by the browser.
     * If fetching fails, a placeholder is saved so the URL can still be rewritten.
     *
     * @returns true if the asset was fetched successfully, false if a placeholder was used
     */
    private async fetchSingleAssetWithTracking(url: string): Promise<boolean> {
        // Skip if already downloaded (double-check)
        if (this.downloadedUrls.has(url)) {
            return true;
        }

        // Check if this is a media file and if we should skip it
        if (isMediaUrl(url) && !this.options.captureMediaSources) {
            this.log(
                `[Static] Skipping media source (captureMediaSources=false): ${url}`,
            );
            return true; // Not a failure, just skipped
        }

        // Mark as downloading to prevent duplicates
        this.downloadedUrls.add(url);

        let body: Buffer | null = null;
        let usedPlaceholder = false;

        try {
            body = await fetchWithContentVerification(
                url,
                (msg) => this.logWarning(msg),
                TRUNCATION_RECOVERY_TIMEOUT_MS,
                this.options.assetRetries ?? 2,
                this.options.retryDelayBase ?? 500,
                this.options.retryDelayMax ?? 5000,
            );
        } catch (error) {
            this.log(
                `[Static] Error fetching ${url}: ${error}, using placeholder`,
                'warn',
            );
        }

        // If fetch failed, use placeholder
        if (!body) {
            this.log(
                `[Static] Failed to fetch ${url}, using placeholder`,
                'warn',
            );
            body = PLACEHOLDER_PNG;
            usedPlaceholder = true;
        }

        // Check file size (skip if too large, but not for placeholders)
        if (!usedPlaceholder && body.length > this.options.maxFileSize) {
            this.log(
                `[Static] Skipping large file: ${url} (${body.length} bytes)`,
            );
            return true; // Not a failure, just skipped
        }

        // Generate local path
        const baseUrl = this.baseOrigin || this.entrypointUrl || url;
        const localPath = urlToLocalPath(url, baseUrl);
        const fullPath = join(this.options.outputDir, localPath);

        // Create directory and write file
        try {
            await mkdir(dirname(fullPath), { recursive: true });
            await writeFile(fullPath, body);
        } catch (writeError) {
            this.log(
                `[Static] Error writing ${localPath}: ${writeError}`,
                'error',
            );
            return false;
        }

        // Guess content type from extension
        const contentType = getContentTypeFromExtension(url);

        const asset: CapturedAsset = {
            url,
            localPath,
            contentType,
            size: body.length,
            isEntrypoint: false,
        };

        this.assets.push(asset);
        this.options.onCapture?.({
            type: 'asset-capture',
            url,
            localPath,
            contentType,
            size: body.length,
        });

        if (usedPlaceholder) {
            this.log(`[Static] Saved placeholder for: ${localPath}`, 'warn');
            return false; // Used placeholder = failure
        }

        this.log(
            `[Static] Fetched CSS/HTML asset: ${localPath} (${body.length} bytes)`,
        );
        return true;
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
 * ```typescript
 * parseImageSetUrls("image-set(url('foo.webp') 1x, url('foo\@2x.webp') 2x)")
 * // returns ["foo.webp", "foo\@2x.webp"]
 * ```
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
 * - `<img srcset="...">` elements
 * - `<source srcset="...">` elements (in `<picture>` elements)
 * - `<source src="...">` elements (in `<video>` and `<audio>` elements)
 * - `<style>` tags containing `url()`, `\@import`, `image-set()`
 * - Inline style attributes containing `url()`
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

    // Extract ALL URLs from inline <style> tags (not just image-set)
    const stylePattern = /<style[^>]*>([\s\S]*?)<\/style>/gi;

    while ((match = stylePattern.exec(html)) !== null) {
        const styleContent = match[1];
        const cssUrls = extractAllUrlsFromCss(styleContent, baseUrl);
        for (const url of cssUrls) {
            urls.add(url);
        }
    }

    // Extract url() from inline style attributes
    const inlineStylePattern =
        /style\s*=\s*["']([^"']*url\([^)]+\)[^"']*)["']/gi;

    while ((match = inlineStylePattern.exec(html)) !== null) {
        const styleValue = match[1];
        const cssUrls = extractAllUrlsFromCss(styleValue, baseUrl);
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
 * Extract ALL URLs from CSS content.
 * This includes:
 * - All `url()` references (backgrounds, fonts, cursors, etc.)
 * - All `\@import url()` and `\@import "..."` references
 * - All `image-set()` references
 *
 * @param css - The CSS content to parse
 * @param cssUrl - URL of the CSS file (for resolving relative URLs)
 * @returns Array of absolute URLs
 */
export function extractAllUrlsFromCss(css: string, cssUrl: string): string[] {
    const urls: Set<string> = new Set();

    // 1. Extract all url() references
    const urlPattern = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
    let match;

    while ((match = urlPattern.exec(css)) !== null) {
        const url = match[2];
        // Skip data:, blob:, and fragment-only URLs
        if (
            url &&
            !url.startsWith('data:') &&
            !url.startsWith('blob:') &&
            !url.startsWith('#')
        ) {
            const absoluteUrl = resolveUrl(url, cssUrl);
            if (absoluteUrl) {
                urls.add(absoluteUrl);
            }
        }
    }

    // 2. Extract @import references
    // Matches: @import url("path"), @import url('path'), @import "path", @import 'path'
    const importPattern =
        /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)/gi;

    while ((match = importPattern.exec(css)) !== null) {
        const url = match[2] || match[4];
        if (url && !url.startsWith('data:')) {
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
