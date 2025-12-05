/**
 * Type definitions for API capture and mock server manifest generation
 */

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
 * A captured API call (request + response pair)
 */
export interface ApiFixture {
    id: string;
    request: CapturedRequest & {
        /** URL pattern with path parameters, e.g., "/api/users/:id" */
        pattern: string;
        /** Names of path parameters, e.g., ["id"] */
        params: string[];
    };
    response: CapturedResponse;
    metadata: {
        capturedAt: string;
        responseTimeMs: number;
        /** Page URL where this API call was captured */
        sourcePageUrl: string;
    };
}

/**
 * Index entry for quick fixture lookup
 */
export interface FixtureIndexEntry {
    id: string;
    /** Relative path to fixture file */
    file: string;
    method: HttpMethod;
    /** URL pattern for matching, e.g., "/api/users/:id" */
    pattern: string;
    /** Path parameter names */
    params: string[];
    /** Priority for matching (more specific patterns = higher priority) */
    priority: number;
}

/**
 * Fixture index file structure
 */
export interface FixtureIndex {
    generatedAt: string;
    fixtures: FixtureIndexEntry[];
}

/**
 * Captured static asset
 */
export interface CapturedAsset {
    /** Original URL */
    url: string;
    /** Local path relative to static directory */
    localPath: string;
    /** MIME type */
    contentType: string;
    /** File size in bytes */
    size: number;
    /** Whether this is the entry HTML page */
    isEntrypoint: boolean;
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
 * A redirect captured from the original site
 */
export interface CapturedRedirect {
    /** Original requested path (without origin) */
    from: string;
    /** Final path after redirect (without origin) */
    to: string;
    /** HTTP status code (301, 302, 307, 308) */
    status: number;
}

/**
 * Server manifest - main configuration file for mock-site-server
 */
export interface ServerManifest {
    /** Site name (usually hostname) */
    name: string;
    /** Original source URL */
    sourceUrl: string;
    /** When the capture was performed */
    capturedAt: string;
    /** Server configuration */
    server: ServerConfig;
    /** Route configuration */
    routes: RouteConfig;
    /** Fixture information */
    fixtures: {
        count: number;
        /** Relative path to fixture index file */
        indexFile: string;
    };
    /** Static assets information */
    static: {
        enabled: boolean;
        /** Entry HTML file */
        entrypoint: string;
        /** Number of static assets captured */
        assetCount: number;
        /**
         * Path prefix from the original source URL.
         * For example, if capturing https://example.com/games/snake/,
         * pathPrefix would be "/games/snake/".
         * Used to redirect root requests to the correct subpath.
         */
        pathPrefix?: string;
    };
    /** Captured redirects to replay */
    redirects?: CapturedRedirect[];
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
