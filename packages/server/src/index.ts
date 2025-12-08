/**
 * web2local serve - Serve captured API fixtures and static assets
 *
 * Programmatic API for using the mock server
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
