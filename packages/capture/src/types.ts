/**
 * Type definitions for API capture and mock server manifest generation
 */

import type {
    ApiFixture,
    CapturedAsset,
    CapturedRedirect,
} from '@web2local/types';

// Re-export core capture types from @web2local/types
export type {
    HttpMethod,
    CapturedRequest,
    CapturedResponse,
    ApiFixture,
    CapturedAsset,
    CapturedRedirect,
    FixtureIndexEntry,
    FixtureIndex,
    ServerManifest,
} from '@web2local/types';

/**
 * Server configuration in manifest
 */
export interface ServerConfig {
    defaultPort: number;
    cors: boolean;
    delay: {
        enabled: boolean;
        minMs: number;
        maxMs: number;
    };
}

/**
 * Route configuration in manifest
 */
export interface RouteConfig {
    /** Base path for API fixtures */
    api: string;
    /** Base path for static assets */
    static: string;
}

/**
 * Filter for static asset capture.
 * When provided, only assets matching the filter criteria are captured.
 */
export interface StaticAssetFilter {
    /** Only capture files matching these extensions (e.g., ['.js', '.css', '.map']) */
    extensions?: string[];
    /** Only capture files matching these MIME type prefixes (e.g., ['text/css', 'application/javascript']) */
    mimeTypes?: string[];
    /** URL patterns to include (glob-style, e.g., ['**\/assets\/**']) */
    includePatterns?: string[];
    /** URL patterns to exclude (glob-style) */
    excludePatterns?: string[];
}

/**
 * Information about a captured asset, passed to onAssetCaptured callback
 */
export interface CapturedAssetInfo {
    /** Original URL of the asset */
    url: string;
    /** Content-Type header value */
    contentType: string;
    /** Raw content of the asset */
    content: Buffer;
    /** Browser resource type (script, stylesheet, document, etc.) */
    resourceType: string;
    /** URL of the page where this asset was discovered */
    pageUrl: string;
}

/**
 * Callback fired when an asset is captured.
 * This is fire-and-forget - the capture process does not wait for the callback to complete.
 */
export type OnAssetCaptured = (asset: CapturedAssetInfo) => void;

/**
 * Options for API capture
 */
export interface CaptureOptions {
    /** Target URL to capture */
    url: string;
    /** Output directory */
    outputDir: string;
    /** Filter patterns for API routes (glob-style) */
    apiFilter: string[];
    /** Whether to capture static assets */
    captureStatic: boolean;
    /**
     * Filter for static asset capture.
     * When provided, only assets matching the filter are captured.
     */
    staticFilter?: StaticAssetFilter;
    /**
     * Callback fired when an asset is captured (fire-and-forget).
     * Useful for collecting assets without writing to disk.
     */
    onAssetCaptured?: OnAssetCaptured;
    /**
     * Skip writing assets to disk.
     * Useful when only using onAssetCaptured callback to collect assets.
     */
    skipAssetWrite?: boolean;
    /**
     * Whether to capture rendered HTML (after JS execution) instead of original.
     * Set to true for SPAs where the initial HTML is mostly empty and JS renders content.
     * Set to false (default) to capture the original HTML response, which preserves
     * proper JS initialization (event handlers will be attached when JS runs).
     */
    captureRenderedHtml?: boolean;
    /** Run browser in headless mode */
    headless: boolean;
    /** Time to wait for API calls in ms (legacy, use pageSettleTime for new code) */
    browseTimeout: number;
    /** Auto-scroll to trigger lazy loading */
    autoScroll: boolean;
    /** Verbose logging */
    verbose: boolean;
    /** Redirects detected during scraping phase (to be included in manifest) */
    scrapedRedirects?: CapturedRedirect[];
    /** Structured progress callback */
    onProgress?: OnCaptureProgress;
    /** Structured verbose log callback */
    onVerbose?: OnCaptureVerbose;
    /** Whether to crawl linked pages (default: true) */
    crawl?: boolean;
    /** Maximum depth of links to follow (default: 5) */
    crawlMaxDepth?: number;
    /** Maximum number of pages to visit (default: 100) */
    crawlMaxPages?: number;

    // ===== Parallelization Options =====

    /** Number of pages to crawl in parallel (default: 5) */
    concurrency?: number;
    /** Number of retries for failed page navigations (default: 2) */
    pageRetries?: number;
    /** Delay between requests in ms to avoid rate limiting (default: 0, disabled) */
    rateLimitDelay?: number;
    /** Per-page navigation timeout in ms (default: 30000) */
    pageTimeout?: number;

    // ===== Wait Time Configuration =====

    /** Network idle wait timeout in ms (default: 5000) */
    networkIdleTimeout?: number;
    /** Consider page idle after this many ms without network requests (default: 1000) */
    networkIdleTime?: number;
    /** Delay between scroll steps when auto-scrolling in ms (default: 50) */
    scrollDelay?: number;
    /** Additional settle time after scrolling in ms (default: 1000) */
    pageSettleTime?: number;
}

/**
 * Crawl statistics
 */
export interface CrawlStats {
    /** Number of pages successfully visited */
    pagesVisited: number;
    /** Number of pages skipped (already visited, errors, etc.) */
    pagesSkipped: number;
    /** Total number of links discovered across all pages */
    linksDiscovered: number;
    /** Whether crawling stopped due to max depth limit */
    maxDepthReached: boolean;
    /** Whether crawling stopped due to max pages limit */
    maxPagesReached: boolean;
}

// ===== Structured Progress Event Types =====

/**
 * Progress event for page crawling operations
 */
export interface PageProgressEvent {
    type: 'page-progress';
    /** Current worker ID (0-indexed) */
    workerId: number;
    /** Total number of workers */
    workerCount: number;
    /** Current phase of page processing */
    phase:
        | 'navigating'
        | 'network-idle'
        | 'scrolling'
        | 'settling'
        | 'extracting-links'
        | 'capturing-html'
        | 'completed'
        | 'error'
        | 'retrying';
    /** URL being processed */
    url: string;
    /** Number of pages completed so far */
    pagesCompleted: number;
    /** Maximum pages to crawl */
    maxPages: number;
    /** Current link depth */
    depth: number;
    /** Maximum link depth */
    maxDepth: number;
    /** Number of URLs still in queue */
    queued: number;
    /** Number of URLs currently being processed by workers */
    inProgress: number;
    /** Error message if phase is 'error' */
    error?: string;
    /** Whether the page will be retried if phase is 'error' */
    willRetry?: boolean;
    /** Number of links discovered from this page */
    linksDiscovered?: number;
}

/**
 * Progress event for API capture
 */
export interface ApiCaptureEvent {
    type: 'api-capture';
    /** HTTP method */
    method: string;
    /** Full URL */
    url: string;
    /** URL pattern (with path params normalized) */
    pattern: string;
    /** HTTP status code */
    status: number;
}

/**
 * Progress event for static asset capture
 */
export interface AssetCaptureEvent {
    type: 'asset-capture';
    /** Worker ID that captured this asset (0-indexed) */
    workerId?: number;
    /** Original URL of the asset */
    url: string;
    /** Local path where asset was saved */
    localPath: string;
    /** Content-Type header value */
    contentType: string;
    /** Size in bytes */
    size: number;
    /** Compressed size in bytes (if available) */
    compressedSize?: number;
}

/**
 * Progress event for request activity tracking (in-flight requests per worker)
 */
export interface RequestActivityEvent {
    type: 'request-activity';
    /** Worker ID (0-indexed) */
    workerId: number;
    /** Number of currently in-flight requests */
    activeRequests: number;
    /** Number of duplicate requests skipped for this worker (since page load started) */
    duplicateRequests?: number;
    /** URL of the current/most recent request (if any) */
    currentUrl?: string;
    /** Size of current request in bytes (from Content-Length, if known) */
    currentSize?: number;
}

/**
 * Progress event for when a duplicate asset request is skipped
 */
export interface DuplicateSkippedEvent {
    type: 'duplicate-skipped';
    /** Worker ID that attempted the duplicate request (0-indexed) */
    workerId?: number;
    /** URL that was skipped */
    url: string;
}

/**
 * Information about an actively downloading item during flush.
 */
export interface ActiveDownloadItem {
    /** URL being downloaded */
    url: string;
    /** Download status */
    status: 'downloading' | 'processing' | 'saving';
    /** Expected size in bytes (from Content-Length header, if known) */
    expectedSize?: number;
    /** Bytes downloaded so far (if streaming progress available) */
    downloadedBytes?: number;
    /** When the download started (timestamp) */
    startedAt: number;
}

/**
 * Progress event emitted during the flush phase.
 * Provides granular progress for pending captures, CSS asset fetching, and URL rewriting.
 */
export interface FlushProgressEvent {
    type: 'flush-progress';
    /** Current phase of the flush operation */
    phase:
        | 'pending-captures'
        | 'fetching-css-assets'
        | 'rewriting-urls'
        | 'complete';
    /** Number of items completed across ALL flush phases (unified counter) */
    completed: number;
    /** Total number of items across ALL flush phases (unified counter) */
    total: number;
    /** Number of failed items */
    failed?: number;
    /** Item that just completed (for logging) */
    completedItem?: string;
    /** Currently active downloads with their status */
    activeItems?: ActiveDownloadItem[];
    /** Total elapsed time in ms (for 'complete' phase) */
    totalTimeMs?: number;
}

/**
 * Progress event for capture lifecycle
 */
export interface CaptureLifecycleEvent {
    type: 'lifecycle';
    /** Current lifecycle phase */
    phase:
        | 'browser-launching'
        | 'browser-launched'
        | 'pages-creating'
        | 'pages-created'
        | 'crawl-starting'
        | 'crawl-complete'
        | 'flushing-assets'
        | 'flushing-complete'
        | 'manifest-generating'
        | 'manifest-complete'
        | 'redirect-detected';
    /** Number of pages/workers (for pages-created) */
    count?: number;
    /** Final crawl stats (for crawl-complete) */
    stats?: CrawlStats;
    /** Original URL before redirect (for redirect-detected) */
    fromUrl?: string;
    /** Final URL after redirect (for redirect-detected) */
    finalUrl?: string;
}

/**
 * All possible capture progress events
 */
export type CaptureProgressEvent =
    | PageProgressEvent
    | ApiCaptureEvent
    | AssetCaptureEvent
    | RequestActivityEvent
    | DuplicateSkippedEvent
    | CaptureLifecycleEvent
    | FlushProgressEvent;

/**
 * Structured progress callback for capture operations
 */
export type OnCaptureProgress = (event: CaptureProgressEvent) => void;

// ===== Structured Verbose Event Types =====

/**
 * Structured verbose log entry
 */
export interface CaptureVerboseEvent {
    type: 'verbose';
    /** Log level */
    level: 'debug' | 'info' | 'warn' | 'error';
    /** Source component */
    source: 'worker' | 'queue' | 'interceptor' | 'static-capturer' | 'browser';
    /** Worker ID if applicable */
    workerId?: number;
    /** Human-readable message */
    message: string;
    /** Additional context data */
    data?: Record<string, unknown>;
}

/**
 * Structured verbose callback
 */
export type OnCaptureVerbose = (event: CaptureVerboseEvent) => void;

/**
 * Result of capture operation
 */
export interface CaptureResult {
    /** Captured API fixtures */
    fixtures: ApiFixture[];
    /** Captured static assets */
    assets: CapturedAsset[];
    /** Any errors during capture */
    errors: string[];
    /** Capture statistics */
    stats: {
        apiCallsCaptured: number;
        staticAssetsCaptured: number;
        totalBytesDownloaded: number;
        captureTimeMs: number;
        /** Number of files that were truncated during download */
        truncatedFiles?: number;
        /** Crawl statistics (only present if crawling was enabled) */
        crawlStats?: CrawlStats;
    };
}

/**
 * Resource type from browser
 */
export type ResourceType =
    | 'document'
    | 'stylesheet'
    | 'image'
    | 'media'
    | 'font'
    | 'script'
    | 'texttrack'
    | 'xhr'
    | 'fetch'
    | 'eventsource'
    | 'websocket'
    | 'manifest'
    | 'other';

/**
 * Determines if a resource type is an API call
 */
export function isApiResourceType(type: ResourceType): boolean {
    return type === 'xhr' || type === 'fetch';
}

/**
 * Determines if a resource type is a static asset
 */
export function isStaticResourceType(type: ResourceType): boolean {
    return [
        'document',
        'stylesheet',
        'image',
        'media',
        'font',
        'script',
        'manifest',
    ].includes(type);
}
