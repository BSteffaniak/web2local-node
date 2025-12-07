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
     * Whether to capture rendered HTML (after JS execution) instead of original.
     * Set to true for SPAs where the initial HTML is mostly empty and JS renders content.
     * Set to false (default) to capture the original HTML response, which preserves
     * proper JS initialization (event handlers will be attached when JS runs).
     */
    captureRenderedHtml?: boolean;
    /** Run browser in headless mode */
    headless: boolean;
    /** Time to wait for API calls in ms */
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
