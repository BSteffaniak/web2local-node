/**
 * Type definitions for web2local serve
 */

import type { ApiFixture } from '@web2local/types';

// Re-export from @web2local/types
export type {
    HttpMethod,
    CapturedRequest,
    CapturedResponse,
    CapturedRedirect,
    FixtureIndexEntry,
    FixtureIndex,
    ServerManifest,
    ApiFixture,
} from '@web2local/types';

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
