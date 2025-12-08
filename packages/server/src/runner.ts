/**
 * Programmatic interface for running the mock server
 */

import { createApp, getServerInfo } from './server/app.js';
import { serve } from '@hono/node-server';
import pc from 'picocolors';
import type { ServerOptions } from './types.js';

/**
 * Run the mock server programmatically
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
