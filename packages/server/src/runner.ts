/**
 * Programmatic interface for running the mock server.
 *
 * This module provides a simple function to start the mock server
 * programmatically, useful for integration with other tools or scripts.
 *
 * @packageDocumentation
 */

import { createApp, getServerInfo } from './server/app.js';
import { serve } from '@hono/node-server';
import pc from 'picocolors';
import type { ServerOptions } from './types.js';

/**
 * Runs the mock server programmatically.
 *
 * Starts a Hono server that serves captured API fixtures and static assets.
 * The server runs until the process is terminated (e.g., with Ctrl+C).
 *
 * @param options - Server configuration options
 * @throws {Error} When the server cannot be started (e.g., port in use, invalid directory)
 *
 * @example
 * ```typescript
 * import { runServer } from '@web2local/server';
 *
 * await runServer({
 *     dir: './output/example.com',
 *     port: 3000,
 *     host: 'localhost',
 *     verbose: true,
 * });
 * ```
 */
export async function runServer(options: ServerOptions): Promise<void> {
    console.log(pc.bold(pc.cyan('\n  Mock Site Server')));
    console.log(pc.gray('  ' + '─'.repeat(30)));
    console.log();

    const { app, manifest, fixtureCount } = await createApp(options);

    // Display server info
    const info = getServerInfo(manifest, options, fixtureCount);
    for (const line of info) {
        console.log(`  ${line}`);
    }
    console.log();

    // Start the server
    serve({
        fetch: app.fetch,
        port: options.port,
        hostname: options.host,
    });

    console.log(pc.green(`  Server started!`));
    console.log();
    console.log(pc.gray(`  Press ${pc.bold('Ctrl+C')} to stop`));
    console.log();
}
