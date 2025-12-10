/**
 * Hono app factory - creates the mock server application
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFile } from 'fs/promises';
import { join } from 'path';

import type { ServerManifest, ServerOptions, HttpMethod } from '../types.js';
import { FixtureMatcher, normalizePath } from './matcher.js';
import {
    loadManifest,
    loadAllFixtures,
    getStaticDir,
    directoryExists,
} from './loader.js';
import { delayMiddleware, fixedDelayMiddleware } from '../middleware/delay.js';
import { loggerMiddleware } from '../middleware/logger.js';

/**
 * Create a Hono app configured for serving captured fixtures
 */
export async function createApp(options: ServerOptions): Promise<{
    app: Hono;
    manifest: ServerManifest;
    fixtureCount: number;
}> {
    const app = new Hono();
    const matcher = new FixtureMatcher();

    // Load manifest
    const manifest = await loadManifest(options.dir);

    // Add logger middleware
    if (options.verbose) {
        app.use('*', loggerMiddleware({ enabled: true }));
    }

    // Add CORS middleware
    if (!options.noCors && manifest.server.cors) {
        app.use('*', cors());
    }

    // Add delay middleware
    if (options.delay !== undefined) {
        app.use('*', fixedDelayMiddleware(options.delay));
    } else if (manifest.server.delay.enabled) {
        app.use('*', delayMiddleware(manifest.server.delay));
    }

    // Add redirect handling from captured redirects
    if (manifest.redirects && manifest.redirects.length > 0) {
        app.use('*', async (c, next) => {
            const path = new URL(c.req.url).pathname;

            // Check if this path matches a captured redirect
            for (const redirect of manifest.redirects!) {
                // Skip self-redirects to prevent infinite loops
                // (defensive check - these shouldn't be captured, but handle gracefully)
                if (redirect.from === redirect.to) {
                    continue;
                }

                if (path === redirect.from) {
                    // Perform the redirect with the original status code
                    return c.redirect(
                        redirect.to,
                        redirect.status as 301 | 302 | 303 | 307 | 308,
                    );
                }
            }

            return next();
        });
    }

    // Add root redirect for subpath captures
    // When a site is captured from a subpath (e.g., https://example.com/games/snake/),
    // we need to redirect root requests to that subpath so relative URLs work correctly
    if (manifest.static.pathPrefix && manifest.static.pathPrefix !== '/') {
        app.get('/', (c) => {
            return c.redirect(manifest.static.pathPrefix!, 302);
        });
    }

    // Load fixtures (unless static-only mode)
    let fixtureCount = 0;
    if (!options.staticOnly) {
        const fixtures = await loadAllFixtures(options.dir);
        matcher.setFixtures(fixtures);
        fixtureCount = fixtures.length;

        // Create API route handler
        app.all('*', async (c, next) => {
            const method = c.req.method as HttpMethod;
            const path = normalizePath(new URL(c.req.url).pathname);

            // Try to match a fixture
            const matched = matcher.match(method, path);

            if (matched) {
                const { fixture } = matched;
                const response = fixture.response;

                // Set response headers
                for (const [key, value] of Object.entries(response.headers)) {
                    // Skip some headers that shouldn't be forwarded
                    if (
                        ![
                            'content-encoding',
                            'transfer-encoding',
                            'content-length',
                        ].includes(key.toLowerCase())
                    ) {
                        c.header(key, value);
                    }
                }

                // Add mock server header
                c.header('X-Mock-Server', 'true');
                c.header('X-Fixture-Id', fixture.id);

                // Return the response
                // Note: We cast to ContentfulStatusCode since Hono expects a specific union type
                // but our captured responses have arbitrary status numbers
                if (response.bodyType === 'json') {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    return c.json(response.body, response.status as any);
                } else {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    c.status(response.status as any);
                    return c.body(
                        typeof response.body === 'string'
                            ? response.body
                            : JSON.stringify(response.body),
                    );
                }
            }

            // No fixture matched, try static files or continue
            return next();
        });
    }

    // Serve static files (unless api-only mode)
    if (!options.apiOnly && manifest.static.enabled) {
        const staticDir = getStaticDir(options.dir, options.useRebuilt);
        const capturedStaticDir = getStaticDir(options.dir, false); // Always get the captured static dir

        if (await directoryExists(staticDir)) {
            // Serve static files using Hono's serveStatic
            app.use(
                '/*',
                serveStatic({
                    root: staticDir,
                    rewriteRequestPath: (path) => path,
                }),
            );

            // When using rebuilt bundles, also serve from captured static dir
            // This ensures fonts, images, and other assets are available
            if (
                options.useRebuilt &&
                (await directoryExists(capturedStaticDir))
            ) {
                app.use(
                    '/*',
                    serveStatic({
                        root: capturedStaticDir,
                        rewriteRequestPath: (path) => path,
                    }),
                );
            }

            // Fallback to index.html for SPA routing
            app.get('*', async (c) => {
                const entrypoint = manifest.static.entrypoint ?? 'index.html';
                const indexPath = join(staticDir, entrypoint);

                try {
                    const content = await readFile(indexPath, 'utf-8');
                    c.header('Content-Type', 'text/html');
                    return c.body(content);
                } catch {
                    return c.notFound();
                }
            });
        }
    }

    // 404 handler
    app.notFound((c) => {
        return c.json(
            {
                error: 'Not Found',
                message: `No fixture or static file found for ${c.req.method} ${c.req.url}`,
                hint: 'Check that the request matches a captured API pattern or static file',
            },
            404,
        );
    });

    // Error handler
    app.onError((err, c) => {
        console.error('Server error:', err);
        return c.json(
            {
                error: 'Internal Server Error',
                message: err.message,
            },
            500,
        );
    });

    return { app, manifest, fixtureCount };
}

/**
 * Get server info for display
 */
export function getServerInfo(
    manifest: ServerManifest,
    options: ServerOptions,
    fixtureCount: number,
): string[] {
    const lines: string[] = [];

    lines.push(`Site: ${manifest.name}`);
    lines.push(`Source: ${manifest.sourceUrl}`);
    lines.push(`Captured: ${manifest.capturedAt}`);
    lines.push('');
    lines.push(`Fixtures: ${fixtureCount}`);
    lines.push(`Static assets: ${manifest.static.assetCount}`);
    lines.push('');
    lines.push(`Listening on: http://${options.host}:${options.port}`);

    if (options.delay !== undefined) {
        lines.push(`Delay: ${options.delay}ms (fixed)`);
    } else if (manifest.server.delay.enabled) {
        lines.push(
            `Delay: ${manifest.server.delay.minMs}-${manifest.server.delay.maxMs}ms`,
        );
    }

    if (options.staticOnly) {
        lines.push('Mode: Static files only');
    } else if (options.apiOnly) {
        lines.push('Mode: API fixtures only');
    }

    if (options.useRebuilt) {
        lines.push('Static source: Rebuilt bundles');
    }

    return lines;
}
