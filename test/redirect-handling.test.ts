/**
 * Tests for redirect detection and replay functionality
 *
 * These tests verify that:
 * 1. Redirects are properly stored in the server manifest
 * 2. The mock-site-server correctly replays captured redirects
 * 3. The manifest generator includes redirects when provided
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, writeFile, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// Import the app creation function from mock-site-server
import { createApp } from '../packages/mock-site-server/src/server/app.js';
import { generateServerManifest } from '../src/manifest/server-manifest.js';
import type {
    ServerManifest,
    CapturedRedirect,
    ApiFixture,
    CapturedAsset,
} from '../src/capture/types.js';

/**
 * Helper to create a minimal test site directory structure
 */
async function createTestSite(
    baseDir: string,
    manifest: ServerManifest,
): Promise<string> {
    const siteDir = join(baseDir, 'test-site');
    const serverDir = join(siteDir, '_server');
    const staticDir = join(serverDir, 'static');
    const fixturesDir = join(serverDir, 'fixtures');

    // Create directories
    await mkdir(staticDir, { recursive: true });
    await mkdir(fixturesDir, { recursive: true });

    // Write manifest
    await writeFile(
        join(serverDir, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
    );

    // Write fixture index
    await writeFile(
        join(fixturesDir, '_index.json'),
        JSON.stringify({ generatedAt: new Date().toISOString(), fixtures: [] }),
    );

    // Create a simple index.html
    await writeFile(
        join(staticDir, 'index.html'),
        '<!DOCTYPE html><html><body>Test</body></html>',
    );

    // Create nested directory structure for path tests
    await mkdir(join(staticDir, 'games', 'snake'), { recursive: true });
    await writeFile(
        join(staticDir, 'games', 'snake', 'index.html'),
        '<!DOCTYPE html><html><body>Snake Game</body></html>',
    );
    await mkdir(join(staticDir, 'games', 'snake', 'js'), { recursive: true });
    await writeFile(
        join(staticDir, 'games', 'snake', 'js', 'game.js'),
        'console.log("game");',
    );

    return siteDir;
}

/**
 * Create a basic manifest for testing
 */
function createTestManifest(
    redirects?: CapturedRedirect[],
    options?: { pathPrefix?: string; entrypoint?: string },
): ServerManifest {
    return {
        name: 'test-site',
        sourceUrl: 'https://example.com/',
        capturedAt: new Date().toISOString(),
        server: {
            defaultPort: 3000,
            cors: true,
            delay: { enabled: false, minMs: 0, maxMs: 0 },
        },
        routes: {
            api: '/api',
            static: '/',
        },
        fixtures: {
            count: 0,
            indexFile: 'fixtures/_index.json',
        },
        static: {
            enabled: true,
            entrypoint: options?.entrypoint || 'index.html',
            assetCount: 3,
            pathPrefix: options?.pathPrefix,
        },
        redirects,
    };
}

describe('Redirect Handling', () => {
    let testDir: string;

    beforeAll(async () => {
        testDir = join(tmpdir(), `redirect-test-${Date.now()}`);
        await mkdir(testDir, { recursive: true });
    });

    afterAll(async () => {
        await rm(testDir, { recursive: true, force: true });
    });

    describe('Mock Server Redirect Replay', () => {
        it('should return 301 redirect for captured trailing slash redirect', async () => {
            const redirects: CapturedRedirect[] = [
                { from: '/games/snake', to: '/games/snake/', status: 301 },
            ];
            const manifest = createTestManifest(redirects);
            const siteDir = await createTestSite(testDir, manifest);

            const { app } = await createApp({
                dir: siteDir,
                port: 0,
                host: 'localhost',
            });

            // Test the redirect
            const response = await app.request('/games/snake');

            expect(response.status).toBe(301);
            expect(response.headers.get('location')).toBe('/games/snake/');
        });

        it('should return 302 redirect for temporary redirects', async () => {
            const redirects: CapturedRedirect[] = [
                { from: '/old-page', to: '/new-page', status: 302 },
            ];
            const manifest = createTestManifest(redirects);
            const siteDir = await createTestSite(testDir, manifest);

            const { app } = await createApp({
                dir: siteDir,
                port: 0,
                host: 'localhost',
            });

            const response = await app.request('/old-page');

            expect(response.status).toBe(302);
            expect(response.headers.get('location')).toBe('/new-page');
        });

        it('should serve static files without redirect when path matches', async () => {
            const redirects: CapturedRedirect[] = [
                { from: '/games/snake', to: '/games/snake/', status: 301 },
            ];
            const manifest = createTestManifest(redirects);
            const siteDir = await createTestSite(testDir, manifest);

            const { app } = await createApp({
                dir: siteDir,
                port: 0,
                host: 'localhost',
            });

            // Request with trailing slash should serve content directly
            const response = await app.request('/games/snake/');

            expect(response.status).toBe(200);
            const text = await response.text();
            expect(text).toContain('Snake Game');
        });

        it('should handle multiple redirects', async () => {
            const redirects: CapturedRedirect[] = [
                { from: '/games/snake', to: '/games/snake/', status: 301 },
                { from: '/about', to: '/about/', status: 301 },
                { from: '/legacy', to: '/new-page', status: 308 },
            ];
            const manifest = createTestManifest(redirects);
            const siteDir = await createTestSite(testDir, manifest);

            const { app } = await createApp({
                dir: siteDir,
                port: 0,
                host: 'localhost',
            });

            // Test first redirect
            const res1 = await app.request('/games/snake');
            expect(res1.status).toBe(301);
            expect(res1.headers.get('location')).toBe('/games/snake/');

            // Test second redirect
            const res2 = await app.request('/about');
            expect(res2.status).toBe(301);
            expect(res2.headers.get('location')).toBe('/about/');

            // Test third redirect (308 Permanent Redirect)
            const res3 = await app.request('/legacy');
            expect(res3.status).toBe(308);
            expect(res3.headers.get('location')).toBe('/new-page');
        });

        it('should not redirect paths that are not in the redirect list', async () => {
            const redirects: CapturedRedirect[] = [
                { from: '/games/snake', to: '/games/snake/', status: 301 },
            ];
            const manifest = createTestManifest(redirects);
            const siteDir = await createTestSite(testDir, manifest);

            const { app } = await createApp({
                dir: siteDir,
                port: 0,
                host: 'localhost',
            });

            // Request a path that's not in redirects - should fall through to static
            const response = await app.request('/games/snake/js/game.js');

            expect(response.status).toBe(200);
            const text = await response.text();
            expect(text).toContain('console.log');
        });

        it('should work without any redirects in manifest', async () => {
            const manifest = createTestManifest(undefined);
            const siteDir = await createTestSite(testDir, manifest);

            const { app } = await createApp({
                dir: siteDir,
                port: 0,
                host: 'localhost',
            });

            // Should serve static content normally
            const response = await app.request('/');

            expect(response.status).toBe(200);
            const text = await response.text();
            expect(text).toContain('Test');
        });

        it('should work with empty redirects array in manifest', async () => {
            const manifest = createTestManifest([]);
            const siteDir = await createTestSite(testDir, manifest);

            const { app } = await createApp({
                dir: siteDir,
                port: 0,
                host: 'localhost',
            });

            // Should serve static content normally
            const response = await app.request('/');

            expect(response.status).toBe(200);
        });

        it('should preserve query strings in redirect target', async () => {
            const redirects: CapturedRedirect[] = [
                { from: '/search', to: '/search?default=true', status: 302 },
            ];
            const manifest = createTestManifest(redirects);
            const siteDir = await createTestSite(testDir, manifest);

            const { app } = await createApp({
                dir: siteDir,
                port: 0,
                host: 'localhost',
            });

            const response = await app.request('/search');

            expect(response.status).toBe(302);
            expect(response.headers.get('location')).toBe(
                '/search?default=true',
            );
        });
    });

    describe('CapturedRedirect Type', () => {
        it('should have correct structure', () => {
            const redirect: CapturedRedirect = {
                from: '/old',
                to: '/new',
                status: 301,
            };

            expect(redirect.from).toBe('/old');
            expect(redirect.to).toBe('/new');
            expect(redirect.status).toBe(301);
        });

        it('should support all common redirect status codes', () => {
            const codes = [301, 302, 303, 307, 308];

            for (const status of codes) {
                const redirect: CapturedRedirect = {
                    from: '/old',
                    to: '/new',
                    status,
                };
                expect(redirect.status).toBe(status);
            }
        });
    });
});

describe('Manifest Redirect Storage', () => {
    it('should include redirects in ServerManifest when present', () => {
        const redirects: CapturedRedirect[] = [
            { from: '/a', to: '/b', status: 301 },
        ];
        const manifest = createTestManifest(redirects);

        expect(manifest.redirects).toBeDefined();
        expect(manifest.redirects).toHaveLength(1);
        expect(manifest.redirects![0]).toEqual({
            from: '/a',
            to: '/b',
            status: 301,
        });
    });

    it('should allow undefined redirects in ServerManifest', () => {
        const manifest = createTestManifest(undefined);

        expect(manifest.redirects).toBeUndefined();
    });

    it('should allow empty redirects array in ServerManifest', () => {
        const manifest = createTestManifest([]);

        expect(manifest.redirects).toBeDefined();
        expect(manifest.redirects).toHaveLength(0);
    });
});

describe('Manifest Generation with Redirects', () => {
    let testDir: string;

    beforeAll(async () => {
        testDir = join(tmpdir(), `manifest-redirect-test-${Date.now()}`);
        await mkdir(testDir, { recursive: true });
    });

    afterAll(async () => {
        await rm(testDir, { recursive: true, force: true });
    });

    it('should include redirects in generated manifest', async () => {
        const fixtures: ApiFixture[] = [];
        const assets: CapturedAsset[] = [
            {
                url: 'https://example.com/index.html',
                localPath: 'index.html',
                contentType: 'text/html',
                size: 100,
                isEntrypoint: true,
            },
        ];
        const redirects: CapturedRedirect[] = [
            { from: '/games/snake', to: '/games/snake/', status: 301 },
            { from: '/about', to: '/about/', status: 301 },
        ];

        const result = await generateServerManifest(fixtures, assets, {
            name: 'test-site',
            sourceUrl: 'https://example.com/',
            outputDir: testDir,
            defaultPort: 3000,
            cors: true,
            delay: { enabled: false, minMs: 0, maxMs: 0 },
            redirects,
        });

        expect(result.errors).toHaveLength(0);

        // Read the generated manifest
        const manifestContent = await readFile(
            join(testDir, '_server', 'manifest.json'),
            'utf-8',
        );
        const manifest = JSON.parse(manifestContent) as ServerManifest;

        expect(manifest.redirects).toBeDefined();
        expect(manifest.redirects).toHaveLength(2);
        expect(manifest.redirects![0]).toEqual({
            from: '/games/snake',
            to: '/games/snake/',
            status: 301,
        });
        expect(manifest.redirects![1]).toEqual({
            from: '/about',
            to: '/about/',
            status: 301,
        });
    });

    it('should not include redirects field when none provided', async () => {
        const outputDir = join(testDir, 'no-redirects');
        await mkdir(outputDir, { recursive: true });

        const fixtures: ApiFixture[] = [];
        const assets: CapturedAsset[] = [
            {
                url: 'https://example.com/index.html',
                localPath: 'index.html',
                contentType: 'text/html',
                size: 100,
                isEntrypoint: true,
            },
        ];

        await generateServerManifest(fixtures, assets, {
            name: 'test-site',
            sourceUrl: 'https://example.com/',
            outputDir,
            defaultPort: 3000,
            cors: true,
            delay: { enabled: false, minMs: 0, maxMs: 0 },
            // No redirects provided
        });

        const manifestContent = await readFile(
            join(outputDir, '_server', 'manifest.json'),
            'utf-8',
        );
        const manifest = JSON.parse(manifestContent) as ServerManifest;

        expect(manifest.redirects).toBeUndefined();
    });

    it('should not include redirects field when empty array provided', async () => {
        const outputDir = join(testDir, 'empty-redirects');
        await mkdir(outputDir, { recursive: true });

        const fixtures: ApiFixture[] = [];
        const assets: CapturedAsset[] = [
            {
                url: 'https://example.com/index.html',
                localPath: 'index.html',
                contentType: 'text/html',
                size: 100,
                isEntrypoint: true,
            },
        ];

        await generateServerManifest(fixtures, assets, {
            name: 'test-site',
            sourceUrl: 'https://example.com/',
            outputDir,
            defaultPort: 3000,
            cors: true,
            delay: { enabled: false, minMs: 0, maxMs: 0 },
            redirects: [], // Empty array
        });

        const manifestContent = await readFile(
            join(outputDir, '_server', 'manifest.json'),
            'utf-8',
        );
        const manifest = JSON.parse(manifestContent) as ServerManifest;

        // Empty array should result in undefined (not stored)
        expect(manifest.redirects).toBeUndefined();
    });
});

describe('Path Prefix Handling', () => {
    let testDir: string;

    beforeAll(async () => {
        testDir = join(tmpdir(), `pathprefix-test-${Date.now()}`);
        await mkdir(testDir, { recursive: true });
    });

    afterAll(async () => {
        await rm(testDir, { recursive: true, force: true });
    });

    describe('Mock Server Root Redirect', () => {
        it('should redirect root to pathPrefix when set', async () => {
            const manifest = createTestManifest(undefined, {
                pathPrefix: '/games/snake/',
                entrypoint: 'games/snake/index.html',
            });
            const siteDir = await createTestSite(testDir, manifest);

            const { app } = await createApp({
                dir: siteDir,
                port: 0,
                host: 'localhost',
            });

            // Request root should redirect to pathPrefix
            const response = await app.request('/');

            expect(response.status).toBe(302);
            expect(response.headers.get('location')).toBe('/games/snake/');
        });

        it('should not redirect root when pathPrefix is not set', async () => {
            const manifest = createTestManifest(undefined);
            const siteDir = await createTestSite(testDir, manifest);

            const { app } = await createApp({
                dir: siteDir,
                port: 0,
                host: 'localhost',
            });

            // Request root should serve content directly (not redirect)
            const response = await app.request('/');

            expect(response.status).toBe(200);
        });

        it('should serve content at pathPrefix directly', async () => {
            const manifest = createTestManifest(undefined, {
                pathPrefix: '/games/snake/',
                entrypoint: 'games/snake/index.html',
            });
            const siteDir = await createTestSite(testDir, manifest);

            const { app } = await createApp({
                dir: siteDir,
                port: 0,
                host: 'localhost',
            });

            // Request the pathPrefix directly should serve content
            const response = await app.request('/games/snake/');

            expect(response.status).toBe(200);
            const text = await response.text();
            expect(text).toContain('Snake Game');
        });

        it('should serve static assets at their full paths', async () => {
            const manifest = createTestManifest(undefined, {
                pathPrefix: '/games/snake/',
                entrypoint: 'games/snake/index.html',
            });
            const siteDir = await createTestSite(testDir, manifest);

            const { app } = await createApp({
                dir: siteDir,
                port: 0,
                host: 'localhost',
            });

            // JS file should be served at its full path
            const response = await app.request('/games/snake/js/game.js');

            expect(response.status).toBe(200);
            const text = await response.text();
            expect(text).toContain('console.log');
        });

        it('should handle multi-level pathPrefix', async () => {
            const manifest = createTestManifest(undefined, {
                pathPrefix: '/a/b/c/',
                entrypoint: 'a/b/c/index.html',
            });
            // Create custom directory structure
            const siteDir = join(testDir, 'multi-level');
            const serverDir = join(siteDir, '_server');
            const staticDir = join(serverDir, 'static');
            const fixturesDir = join(serverDir, 'fixtures');

            await mkdir(join(staticDir, 'a', 'b', 'c'), { recursive: true });
            await mkdir(fixturesDir, { recursive: true });

            await writeFile(
                join(serverDir, 'manifest.json'),
                JSON.stringify(manifest, null, 2),
            );
            await writeFile(
                join(fixturesDir, '_index.json'),
                JSON.stringify({
                    generatedAt: new Date().toISOString(),
                    fixtures: [],
                }),
            );
            await writeFile(
                join(staticDir, 'a', 'b', 'c', 'index.html'),
                '<!DOCTYPE html><html><body>Deep Content</body></html>',
            );

            const { app } = await createApp({
                dir: siteDir,
                port: 0,
                host: 'localhost',
            });

            // Root should redirect to deep pathPrefix
            const response = await app.request('/');

            expect(response.status).toBe(302);
            expect(response.headers.get('location')).toBe('/a/b/c/');

            // Deep path should serve content
            const contentResponse = await app.request('/a/b/c/');
            expect(contentResponse.status).toBe(200);
            const text = await contentResponse.text();
            expect(text).toContain('Deep Content');
        });
    });

    describe('Manifest Generation with PathPrefix', () => {
        it('should extract pathPrefix from subpath sourceUrl', async () => {
            const outputDir = join(testDir, 'subpath-manifest');
            await mkdir(outputDir, { recursive: true });

            const fixtures: ApiFixture[] = [];
            const assets: CapturedAsset[] = [
                {
                    url: 'https://example.com/games/snake/index.html',
                    localPath: 'games/snake/index.html',
                    contentType: 'text/html',
                    size: 100,
                    isEntrypoint: true,
                },
            ];

            await generateServerManifest(fixtures, assets, {
                name: 'test-site',
                sourceUrl: 'https://example.com/games/snake/',
                outputDir,
                defaultPort: 3000,
                cors: true,
                delay: { enabled: false, minMs: 0, maxMs: 0 },
            });

            const manifestContent = await readFile(
                join(outputDir, '_server', 'manifest.json'),
                'utf-8',
            );
            const manifest = JSON.parse(manifestContent) as ServerManifest;

            expect(manifest.static.pathPrefix).toBe('/games/snake/');
        });

        it('should not set pathPrefix for root sourceUrl', async () => {
            const outputDir = join(testDir, 'root-manifest');
            await mkdir(outputDir, { recursive: true });

            const fixtures: ApiFixture[] = [];
            const assets: CapturedAsset[] = [
                {
                    url: 'https://example.com/index.html',
                    localPath: 'index.html',
                    contentType: 'text/html',
                    size: 100,
                    isEntrypoint: true,
                },
            ];

            await generateServerManifest(fixtures, assets, {
                name: 'test-site',
                sourceUrl: 'https://example.com/',
                outputDir,
                defaultPort: 3000,
                cors: true,
                delay: { enabled: false, minMs: 0, maxMs: 0 },
            });

            const manifestContent = await readFile(
                join(outputDir, '_server', 'manifest.json'),
                'utf-8',
            );
            const manifest = JSON.parse(manifestContent) as ServerManifest;

            expect(manifest.static.pathPrefix).toBeUndefined();
        });

        it('should normalize pathPrefix with trailing slash', async () => {
            const outputDir = join(testDir, 'no-trailing-slash');
            await mkdir(outputDir, { recursive: true });

            const fixtures: ApiFixture[] = [];
            const assets: CapturedAsset[] = [
                {
                    url: 'https://example.com/app/index.html',
                    localPath: 'app/index.html',
                    contentType: 'text/html',
                    size: 100,
                    isEntrypoint: true,
                },
            ];

            // Source URL without trailing slash
            await generateServerManifest(fixtures, assets, {
                name: 'test-site',
                sourceUrl: 'https://example.com/app',
                outputDir,
                defaultPort: 3000,
                cors: true,
                delay: { enabled: false, minMs: 0, maxMs: 0 },
            });

            const manifestContent = await readFile(
                join(outputDir, '_server', 'manifest.json'),
                'utf-8',
            );
            const manifest = JSON.parse(manifestContent) as ServerManifest;

            // Should be normalized with trailing slash
            expect(manifest.static.pathPrefix).toBe('/app/');
        });
    });
});
