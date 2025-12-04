/**
 * Hono app factory - creates the mock server application
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFile } from 'fs/promises';
import { join, extname } from 'path';

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
 * MIME types for static files
 */
const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.eot': 'application/vnd.ms-fontobject',
    '.otf': 'font/otf',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.txt': 'text/plain',
    '.xml': 'application/xml',
};

/**
 * Get MIME type from file extension
 */
function getMimeType(filepath: string): string {
    const ext = extname(filepath).toLowerCase();
    return MIME_TYPES[ext] || 'application/octet-stream';
}

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
                if (response.bodyType === 'json') {
                    return c.json(response.body, response.status as any);
                } else {
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

        if (await directoryExists(staticDir)) {
            // Serve static files using Hono's serveStatic
            app.use(
                '/*',
                serveStatic({
                    root: staticDir,
                    rewriteRequestPath: (path) => path,
                }),
            );

            // Fallback to index.html for SPA routing
            app.get('*', async (c) => {
                const entrypoint = manifest.static.entrypoint;
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
