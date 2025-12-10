#!/usr/bin/env node

/**
 * CLI for web2local serve
 */

import { Command } from 'commander';
import { serve } from '@hono/node-server';
import pc from 'picocolors';

import { createApp, getServerInfo } from './server/app.js';
import {
    resolveSiteDir,
    loadManifest,
    loadFixtureIndex,
    listCapturedSites,
} from './server/loader.js';
import type { ServerOptions } from './types.js';
import { VERSION } from '@web2local/utils';

const program = new Command();

program
    .name('web2local serve')
    .description('Serve captured API fixtures and static assets')
    .version(VERSION);

/**
 * Serve command - start the mock server
 */
program
    .command('serve')
    .description('Start the mock server')
    .argument('<dir>', 'Directory containing the captured site')
    .option('-p, --port <number>', 'Port to listen on', '3000')
    .option('-h, --host <string>', 'Host to bind to', 'localhost')
    .option('-d, --delay <ms>', 'Add fixed delay to all responses (ms)')
    .option('--no-cors', 'Disable CORS headers')
    .option('--static-only', 'Only serve static files', false)
    .option('--api-only', 'Only serve API fixtures', false)
    .option('-v, --verbose', 'Enable verbose logging', false)
    .option(
        '--use-rebuilt',
        'Serve from rebuilt source instead of captured files',
        false,
    )
    .action(async (dir: string, opts: Record<string, unknown>) => {
        try {
            const siteDir = await resolveSiteDir(dir);

            const options: ServerOptions = {
                dir: siteDir,
                port: parseInt(opts.port as string, 10),
                host: opts.host as string,
                delay: opts.delay
                    ? parseInt(opts.delay as string, 10)
                    : undefined,
                noCors: opts.cors === false,
                staticOnly: opts.staticOnly as boolean,
                apiOnly: opts.apiOnly as boolean,
                verbose: opts.verbose as boolean,
                useRebuilt: opts.useRebuilt as boolean,
            };

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
        } catch (error) {
            console.error(pc.red(`\nError: ${(error as Error).message}`));
            process.exit(1);
        }
    });

/**
 * Info command - show manifest information
 */
program
    .command('info')
    .description('Show information about a captured site')
    .argument('<dir>', 'Directory containing the captured site')
    .action(async (dir: string) => {
        try {
            const siteDir = await resolveSiteDir(dir);
            const manifest = await loadManifest(siteDir);
            const index = await loadFixtureIndex(siteDir);

            console.log(pc.bold(pc.cyan('\n  Site Information')));
            console.log(pc.gray('  ' + '─'.repeat(30)));
            console.log();
            console.log(`  Name:         ${manifest.name}`);
            console.log(`  Source URL:   ${manifest.sourceUrl}`);
            console.log(`  Captured at:  ${manifest.capturedAt}`);
            console.log();
            console.log(pc.bold('  Fixtures:'));
            console.log(`    Count:      ${index.fixtures.length}`);
            console.log(`    Generated:  ${index.generatedAt}`);
            console.log();
            console.log(pc.bold('  Static Assets:'));
            console.log(`    Enabled:    ${manifest.static.enabled}`);
            console.log(`    Count:      ${manifest.static.assetCount}`);
            console.log(`    Entrypoint: ${manifest.static.entrypoint}`);
            console.log();
            console.log(pc.bold('  Server Config:'));
            console.log(`    Port:       ${manifest.server.defaultPort}`);
            console.log(`    CORS:       ${manifest.server.cors}`);
            console.log(
                `    Delay:      ${manifest.server.delay.enabled ? `${manifest.server.delay.minMs}-${manifest.server.delay.maxMs}ms` : 'disabled'}`,
            );
            console.log();
        } catch (error) {
            console.error(pc.red(`\nError: ${(error as Error).message}`));
            process.exit(1);
        }
    });

/**
 * List command - list captured fixtures
 */
program
    .command('list')
    .description('List captured fixtures')
    .argument('<dir>', 'Directory containing the captured site')
    .option('--json', 'Output as JSON', false)
    .action(async (dir: string, opts: { json: boolean }) => {
        try {
            const siteDir = await resolveSiteDir(dir);
            const index = await loadFixtureIndex(siteDir);

            if (opts.json) {
                console.log(JSON.stringify(index.fixtures, null, 2));
                return;
            }

            console.log(pc.bold(pc.cyan('\n  Captured Fixtures')));
            console.log(pc.gray('  ' + '─'.repeat(40)));
            console.log();

            // Group by method
            const byMethod = new Map<string, typeof index.fixtures>();
            for (const fixture of index.fixtures) {
                const existing = byMethod.get(fixture.method) || [];
                existing.push(fixture);
                byMethod.set(fixture.method, existing);
            }

            for (const [method, fixtures] of byMethod) {
                const methodColor =
                    method === 'GET'
                        ? pc.green
                        : method === 'POST'
                          ? pc.yellow
                          : method === 'PUT'
                            ? pc.blue
                            : method === 'DELETE'
                              ? pc.red
                              : pc.gray;

                console.log(`  ${methodColor(pc.bold(method))}`);
                for (const fixture of fixtures) {
                    console.log(`    ${fixture.pattern}`);
                }
                console.log();
            }

            console.log(pc.gray(`  Total: ${index.fixtures.length} fixtures`));
            console.log();
        } catch (error) {
            console.error(pc.red(`\nError: ${(error as Error).message}`));
            process.exit(1);
        }
    });

/**
 * Sites command - list available captured sites in a directory
 */
program
    .command('sites')
    .description('List captured sites in an output directory')
    .argument('[dir]', 'Output directory to scan', './output')
    .action(async (dir: string) => {
        try {
            const sites = await listCapturedSites(dir);

            if (sites.length === 0) {
                console.log(pc.yellow(`\nNo captured sites found in ${dir}`));
                return;
            }

            console.log(pc.bold(pc.cyan('\n  Captured Sites')));
            console.log(pc.gray('  ' + '─'.repeat(30)));
            console.log();

            for (const site of sites) {
                console.log(`  ${pc.green('●')} ${site}`);
            }

            console.log();
            console.log(
                pc.gray(
                    `  Use ${pc.bold('web2local serve <dir>/<site>')} to start a server`,
                ),
            );
            console.log();
        } catch (error) {
            console.error(pc.red(`\nError: ${(error as Error).message}`));
            process.exit(1);
        }
    });

program.parse();
