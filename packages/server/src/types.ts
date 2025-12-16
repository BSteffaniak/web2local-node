/**
 * Type definitions for web2local serve.
 *
 * This module exports types used throughout the mock server for
 * configuration, fixtures, and request/response handling.
 *
 * @packageDocumentation
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
 * Server configuration from manifest.
 *
 * Defines default server behavior including port, CORS, and response delays.
 */
export interface ServerConfig {
    /** Default port number for the server. */
    defaultPort: number;

    /** Whether CORS headers should be enabled. */
    cors: boolean;

    /** Artificial delay configuration for simulating network latency. */
    delay: {
        /** Whether delay is enabled. */
        enabled: boolean;
        /** Minimum delay in milliseconds. */
        minMs: number;
        /** Maximum delay in milliseconds. */
        maxMs: number;
    };
}

/**
 * Route configuration from manifest.
 *
 * Defines the base paths for API and static file routes.
 */
export interface RouteConfig {
    /** Base path for API routes. */
    api: string;

    /** Base path for static file routes. */
    static: string;
}

/**
 * A fixture that has been loaded from disk with its file path.
 *
 * Extends the base {@link ApiFixture} type with the filesystem location
 * for debugging and cache invalidation purposes.
 */
export interface LoadedFixture extends ApiFixture {
    /** Absolute path to the fixture file on disk. */
    filePath: string;
}

/**
 * Configuration options for the mock server.
 *
 * @example
 * ```typescript
 * const options: ServerOptions = {
 *     dir: './output/example.com',
 *     port: 3000,
 *     host: 'localhost',
 *     verbose: true,
 * };
 * ```
 */
export interface ServerOptions {
    /** Directory containing the captured site. */
    dir: string;

    /** Port to listen on. */
    port: number;

    /** Host to bind to. */
    host: string;

    /** Fixed delay in milliseconds to add to all responses. Overrides manifest delay settings. */
    delay?: number;

    /** Disable CORS headers even if enabled in manifest. */
    noCors?: boolean;

    /** Only serve static files, ignoring API fixtures. */
    staticOnly?: boolean;

    /** Only serve API fixtures, ignoring static files. */
    apiOnly?: boolean;

    /** Enable verbose request logging. */
    verbose?: boolean;

    /** Watch for fixture file changes and reload automatically. */
    watch?: boolean;

    /** Serve from rebuilt source (`_rebuilt/`) instead of captured static files. */
    useRebuilt?: boolean;
}

/**
 * Result of matching a request to a fixture.
 *
 * Contains the matched fixture and any URL parameters extracted from the path.
 */
export interface MatchedFixture {
    /** The fixture that matched the request. */
    fixture: LoadedFixture;

    /** URL parameters extracted from path patterns (e.g., `:userId` becomes `{ userId: "123" }`). */
    params: Record<string, string>;
}
