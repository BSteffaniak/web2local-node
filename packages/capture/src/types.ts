/**
 * Type definitions for API capture and mock server manifest generation
 */

import {
    ApiFixture,
    CapturedAsset,
    CapturedRedirect,
    FixtureIndexEntry,
    FixtureIndex,
    ServerManifest,
} from '@web2local/types';

export {
    ApiFixture,
    CapturedAsset,
    CapturedRedirect,
    FixtureIndexEntry,
    FixtureIndex,
    ServerManifest,
};

/**
 * HTTP methods supported for API capture
 */
export type HttpMethod =
    | 'GET'
    | 'POST'
    | 'PUT'
    | 'DELETE'
    | 'PATCH'
    | 'HEAD'
    | 'OPTIONS';

/**
 * Captured API request details
 */
export interface CapturedRequest {
    method: HttpMethod;
    url: string;
    path: string;
    query: Record<string, string>;
    headers: Record<string, string>;
    body?: unknown;
    bodyRaw?: string;
}

/**
 * Captured API response details
 */
export interface CapturedResponse {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: unknown;
    bodyRaw?: string;
    bodyType: 'json' | 'text' | 'binary';
}

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
    /** Progress callback */
    onProgress?: (message: string) => void;
    /** Verbose log callback - use this instead of console.log when spinner is active */
    onVerbose?: (message: string) => void;
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
