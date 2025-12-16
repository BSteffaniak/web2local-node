/**
 * `@web2local/server` - Serve captured API fixtures and static assets.
 *
 * This package provides a mock server that serves captured API responses and
 * static files from a web2local capture. It's useful for development, testing,
 * and demonstrating web applications without requiring the original backend.
 *
 * ## Features
 *
 * - Serves captured API fixtures with pattern matching support
 * - Serves static files with SPA fallback
 * - Configurable CORS, delay simulation, and logging
 * - Can serve rebuilt source from `_rebuilt/` directory
 *
 * ## Usage
 *
 * ### CLI
 *
 * ```bash
 * web2local serve ./output/example.com --port 3000
 * ```
 *
 * ### Programmatic
 *
 * ```typescript
 * import { createApp, runServer } from '@web2local/server';
 * import { serve } from '@hono/node-server';
 *
 * // Option 1: Use runServer for simple cases
 * await runServer({
 *     dir: './output/example.com',
 *     port: 3000,
 *     host: 'localhost',
 * });
 *
 * // Option 2: Use createApp for more control
 * const { app, manifest, fixtureCount } = await createApp({
 *     dir: './output/example.com',
 *     port: 3000,
 *     host: 'localhost',
 * });
 * serve({ fetch: app.fetch, port: 3000 });
 * ```
 *
 * @packageDocumentation
 */

export { createApp, getServerInfo } from './server/app.js';
export { FixtureMatcher, matchGlob, normalizePath } from './server/matcher.js';
export {
    loadManifest,
    loadFixtureIndex,
    loadFixture,
    loadAllFixtures,
    getStaticDir,
    directoryExists,
    fileExists,
    resolveSiteDir,
    listCapturedSites,
} from './server/loader.js';
export {
    delayMiddleware,
    fixedDelayMiddleware,
    loggerMiddleware,
} from './middleware/index.js';
export { runServer } from './runner.js';
export * from './types.js';
