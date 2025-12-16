/**
 * Core server functionality for the mock server.
 *
 * This module exports the main server components including the Hono app factory,
 * fixture matching, and file loading utilities.
 *
 * @packageDocumentation
 */

export { createApp, getServerInfo } from './app.js';
export { FixtureMatcher, matchGlob, normalizePath } from './matcher.js';
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
} from './loader.js';
