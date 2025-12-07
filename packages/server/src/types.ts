/**
 * Type definitions for mock-site-server
 * These mirror the types from the capture tool
 */

/**
 * HTTP methods
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
 * Server configuration from manifest
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
 * Route configuration from manifest
 */
export interface RouteConfig {
    api: string;
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
 * Server manifest - main configuration file
 */
export interface ServerManifest {
    name: string;
    sourceUrl: string;
    capturedAt: string;
    server: ServerConfig;
    routes: RouteConfig;
    fixtures: {
        count: number;
        indexFile: string;
    };
    static: {
        enabled: boolean;
        entrypoint: string;
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
 * Fixture index entry
 */
export interface FixtureIndexEntry {
    id: string;
    file: string;
    method: HttpMethod;
    pattern: string;
    params: string[];
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
 * Captured request in fixture
 */
export interface CapturedRequest {
    method: HttpMethod;
    url: string;
    path: string;
    pattern: string;
    params: string[];
    query: Record<string, string>;
    headers: Record<string, string>;
    body?: unknown;
    bodyRaw?: string;
}

/**
 * Captured response in fixture
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
 * API fixture - a captured request/response pair
 */
export interface ApiFixture {
    id: string;
    request: CapturedRequest;
    response: CapturedResponse;
    metadata: {
        capturedAt: string;
        responseTimeMs: number;
        sourcePageUrl: string;
    };
}

/**
 * Loaded fixture with file path
 */
export interface LoadedFixture extends ApiFixture {
    filePath: string;
}

/**
 * Server options
 */
export interface ServerOptions {
    /** Directory containing the captured site */
    dir: string;
    /** Port to listen on */
    port: number;
    /** Host to bind to */
    host: string;
    /** Override delay settings */
    delay?: number;
    /** Disable CORS */
    noCors?: boolean;
    /** Only serve static files */
    staticOnly?: boolean;
    /** Only serve API fixtures */
    apiOnly?: boolean;
    /** Enable verbose logging */
    verbose?: boolean;
    /** Watch for fixture changes */
    watch?: boolean;
    /** Use rebuilt source instead of captured static files */
    useRebuilt?: boolean;
}

/**
 * Matched fixture result
 */
export interface MatchedFixture {
    fixture: LoadedFixture;
    params: Record<string, string>;
}
