/**
 * Command line argument parsing and CLI setup for web2local.
 *
 * This module defines all CLI commands, options, and their handlers using commander.js.
 * It exports type definitions for parsed options that are used throughout the CLI.
 */

import { Command } from 'commander';
import type { ServerOptions } from '@web2local/server';
import { VERSION } from '@web2local/utils';
import { runMain } from './index.js';

/**
 * Normalizes a URL by adding https:// if no protocol is specified.
 *
 * This allows users to pass URLs like "example.com" without the protocol.
 *
 * @param url - The URL to normalize
 * @returns The URL with https:// prefix if no protocol was present
 */
function normalizeUrl(url: string): string {
    // Don't modify if it already has a protocol or is a data URL
    if (
        url.startsWith('http://') ||
        url.startsWith('https://') ||
        url.startsWith('data:')
    ) {
        return url;
    }
    // Add https:// by default
    return `https://${url}`;
}

/**
 * Options for the `extract` subcommand.
 *
 * The extract command only extracts source files from source maps,
 * without dependency analysis, API capture, or rebuild.
 */
export interface ExtractOptions {
    /** Target URL to extract source maps from. */
    url: string;
    /** Output directory. If not specified, defaults to ./output/<hostname>. */
    output?: string;
    /** Clear existing output directory without prompting. */
    overwrite: boolean;
    /** Resume from checkpoint if available. */
    resume: boolean;
    /** Enable verbose logging. */
    verbose: boolean;
    /** Number of concurrent downloads. */
    concurrency: number;
    /** Bypass cache, fetch fresh. */
    noCache: boolean;
    /** Use browser crawling to discover bundles across multiple pages. */
    crawl?: boolean;
    /** Maximum link depth to follow when crawling. */
    crawlMaxDepth?: number;
    /** Maximum number of pages to visit when crawling. */
    crawlMaxPages?: number;
    /** Run browser in headless mode (default: true). */
    headless?: boolean;
}

/**
 * Full CLI options for the main web2local command.
 *
 * This interface contains all parsed options from the command line,
 * covering all phases of the extraction pipeline.
 */
export interface CliOptions {
    /** Target URL to extract from. */
    url: string;
    /** Output directory. If not specified, defaults to ./output/<hostname>. */
    output?: string;
    /** Clear existing output directory without prompting. */
    overwrite: boolean;
    /** Resume from checkpoint if available. */
    resume: boolean;
    /** Enable verbose logging. */
    verbose: boolean;
    /** Number of concurrent downloads for source map extraction. */
    concurrency: number;

    // Package.json generation options (enabled by default)

    /** Skip generating package.json with detected dependencies. */
    noPackageJson: boolean;
    /** Disable source fingerprinting for version matching. */
    noFingerprinting: boolean;
    /** Skip fetching latest npm versions for undetected packages. */
    noFetchVersions: boolean;
    /** Maximum versions to check per package during fingerprinting (0 = all). */
    maxVersions: number;
    /** Directory for caching npm metadata and fingerprints. */
    cacheDir: string;
    /** Disable fingerprint caching. */
    noCache: boolean;
    /** Include pre-release versions when fingerprinting. */
    includePrereleases: boolean;

    // Fingerprinting concurrency options

    /** Number of packages to fingerprint concurrently. */
    fingerprintConcurrency: number;
    /** Number of versions to check concurrently per package. */
    versionConcurrency: number;
    /** Number of entry paths to try concurrently when fetching from CDN. */
    pathConcurrency: number;
    /** Bypass all caches and fetch fresh data. */
    forceRefresh: boolean;

    // API capture options (enabled by default)

    /** Skip API call capture via browser automation. */
    noCapture: boolean;
    /** Filter patterns for API routes to capture (glob-style). */
    apiFilter: string[];
    /** Enable static asset capture. */
    captureStatic: boolean;
    /** Capture rendered HTML after JS execution instead of original. */
    captureRenderedHtml: boolean;
    /** Run browser in headless mode. */
    headless: boolean;
    /** Time to wait for API calls after page load (ms). */
    browseTimeout: number;
    /** Enable auto-scrolling to trigger lazy loading. */
    autoScroll: boolean;

    // Capture parallelization options

    /** Number of pages to crawl in parallel. */
    captureConcurrency: number;
    /** Number of retries for failed page navigations. */
    pageRetries: number;
    /** Number of retries for truncated asset downloads. */
    assetRetries: number;
    /** Base delay for exponential backoff between retries (ms). */
    retryDelay: number;
    /** Maximum backoff delay between retries (ms). */
    retryDelayMax: number;
    /** Delay between requests to avoid rate limiting (0 = disabled). */
    rateLimitDelay: number;
    /** Per-page navigation timeout (ms). */
    pageTimeout: number;

    // Capture wait time options

    /** Network idle wait timeout (ms). */
    networkIdleTimeout: number;
    /** Consider page idle after this many ms without network requests. */
    networkIdleTime: number;
    /** Delay between scroll steps when auto-scrolling (ms). */
    scrollDelay: number;
    /** Additional settle time after scrolling (ms). */
    pageSettleTime: number;

    // Rebuild options (enabled by default)

    /** Skip running the build (only generate config files). */
    noRebuild: boolean;
    /** Package manager to use for install/build. */
    packageManager: 'npm' | 'pnpm' | 'yarn' | 'auto';
    /** Start mock server after successful operations. */
    serve: boolean;
    /** Serve from rebuilt source instead of captured files. */
    useRebuilt: boolean;

    // Server options (when --serve is used)

    /** Mock server port. */
    port?: number;
    /** Mock server host. */
    host?: string;
    /** Mock server response delay (ms). */
    delay?: number;
    /** Disable CORS on mock server. */
    noCors?: boolean;
    /** Mock server serves only static files. */
    staticOnly?: boolean;
    /** Mock server serves only API fixtures. */
    apiOnly?: boolean;

    // Fallback options

    /** Additionally save minified bundles that have source maps. */
    saveBundles: boolean;

    // Crawl options

    /** Enable link crawling during capture. */
    crawl: boolean;
    /** Maximum link depth to follow when crawling. */
    crawlMaxDepth: number;
    /** Maximum number of pages to visit when crawling. */
    crawlMaxPages: number;

    // Dynamic import resolution options

    /** Maximum iterations for resolving dynamic imports from bundles. */
    resolveMaxIterations: number;
}

/**
 * Internal CLI options for the serve command (before parsing).
 */
interface ServeCliOptions {
    /** Mock server port (string from CLI, parsed to number). */
    port?: string;
    /** Mock server host. */
    host?: string;
    /** Response delay in ms (string from CLI, parsed to number). */
    delay?: string;
    /** CORS enabled (negatable via --no-cors). */
    cors?: boolean;
    /** Serve only static files. */
    staticOnly?: boolean;
    /** Serve only API fixtures. */
    apiOnly?: boolean;
    /** Enable verbose logging. */
    verbose?: boolean;
    /** Serve from rebuilt source. */
    useRebuilt?: boolean;
}

/**
 * Internal CLI options for the extract command (before parsing).
 */
interface ExtractCliOptions {
    /** Output directory path. */
    output?: string;
    /** Overwrite existing output. */
    overwrite?: boolean;
    /** Resume from checkpoint. */
    resume?: boolean;
    /** Enable verbose logging. */
    verbose?: boolean;
    /** Concurrency (string from CLI, parsed to number). */
    concurrency: string;
    /** Cache enabled (negatable via --no-cache). */
    cache?: boolean;
    /** Crawl enabled (negatable via --no-crawl). */
    crawl?: boolean;
    /** Max crawl depth (string from CLI). */
    crawlMaxDepth: string;
    /** Max pages to crawl (string from CLI). */
    crawlMaxPages: string;
    /** Run browser in headless mode. */
    headless?: boolean;
}

/**
 * Extracts server options from parsed CLI options for the serve command.
 *
 * @param cliOptions - The raw CLI options from commander
 * @param outputDir - The resolved output directory path
 * @returns Server options object compatible with the server package
 */
function getServerOptions(
    cliOptions: ServeCliOptions,
    outputDir: string,
): ServerOptions {
    return {
        dir: outputDir,
        port: cliOptions.port ? parseInt(cliOptions.port, 10) : 3000,
        host: cliOptions.host || 'localhost',
        delay: cliOptions.delay ? parseInt(cliOptions.delay, 10) : undefined,
        noCors: cliOptions.cors === false,
        staticOnly: cliOptions.staticOnly || false,
        apiOnly: cliOptions.apiOnly || false,
        verbose: cliOptions.verbose || false,
        useRebuilt: cliOptions.useRebuilt || false,
    };
}

/**
 * Adds server-related CLI options to a commander program.
 *
 * @param program - The commander program to add options to
 * @returns The modified program for chaining
 */
function serverCliOptions(program: Command): Command {
    return program
        .option('-p, --port <number>', 'Mock server port', '3000')
        .option('-H, --host <string>', 'Mock server host', 'localhost')
        .option('-d, --delay <ms>', 'Mock server response delay')
        .option('--no-cors', 'Disable CORS on mock server')
        .option('--static-only', 'Mock server serves only static files')
        .option('--api-only', 'Mock server serves only API fixtures')
        .option(
            '--use-rebuilt',
            'Serve from rebuilt source instead of captured files',
            false,
        );
}

/**
 * Parses command line arguments and returns the parsed options.
 *
 * This function sets up the main command and subcommands (serve, extract),
 * parses process.argv, and executes the appropriate action handler.
 *
 * Note: Subcommands (serve, extract) are handled internally and will execute
 * their own action handlers. The return value is only relevant for the main
 * command.
 *
 * @returns The parsed CLI options for the main command
 *
 * @example
 * ```typescript
 * // In the main entry point:
 * const options = parseArgs();
 * // Options are now available for the main command
 * // Subcommands have already executed their action handlers
 * ```
 */
export function parseArgs(): CliOptions {
    const program = new Command();

    // Check if --serve is present to conditionally add server options
    const hasServe = process.argv.includes('--serve');

    program
        .name('web2local')
        .enablePositionalOptions()
        .description(
            'Extract and reconstruct original source code from publicly available source maps. ' +
                'By default, this will extract sources, generate package.json, capture API calls, and run a full rebuild.',
        )
        .version(VERSION)
        .argument('<url>', 'URL of the website to extract source maps from')
        .option(
            '-o, --output <dir>',
            'Output directory (default: ./output/<hostname>)',
        )
        .option(
            '--overwrite',
            'Clear existing output directory without prompting',
            false,
        )
        .option('--resume', 'Resume from checkpoint if available', false)
        .option('-v, --verbose', 'Enable verbose logging', false)
        .option(
            '-c, --concurrency <number>',
            'Number of concurrent downloads',
            '5',
        )
        // Package.json generation options (enabled by default)
        .option(
            '--no-package-json',
            'Skip generating package.json with detected dependencies',
        )
        .option(
            '--no-fingerprinting',
            'Disable source fingerprinting for version matching',
        )
        .option(
            '--no-fetch-versions',
            'Skip fetching latest npm versions for undetected packages',
        )
        .option(
            '--max-versions <number>',
            'Maximum versions to check per package during fingerprinting (0 = all)',
            '0',
        )
        .option(
            '--cache-dir <dir>',
            'Directory for caching npm metadata and fingerprints',
            '',
        )
        .option('--no-cache', 'Disable fingerprint caching')
        .option(
            '--include-prereleases',
            'Include pre-release versions (alpha, beta, rc, nightly) when fingerprinting',
            false,
        )
        .option(
            '--fingerprint-concurrency <number>',
            'Number of packages to fingerprint concurrently (default: 5)',
            '5',
        )
        .option(
            '--version-concurrency <number>',
            'Number of versions to check concurrently per package (default: 10)',
            '10',
        )
        .option(
            '--path-concurrency <number>',
            'Number of entry paths to try concurrently when fetching from CDN (default: 5)',
            '5',
        )
        .option(
            '--force-refresh',
            'Bypass all caches and fetch fresh data',
            false,
        )
        // API capture options (enabled by default)
        .option('--no-capture', 'Skip API call capture via browser automation')
        .option(
            '--api-filter <patterns...>',
            'Filter patterns for API routes to capture (glob-style)',
            ['**/api/**', '**/graphql**', '**/v1/**', '**/v2/**', '**/v3/**'],
        )
        .option(
            '--no-static',
            'Disable static asset capture (only capture API calls)',
        )
        .option('--no-headless', 'Run browser in visible mode (not headless)')
        .option(
            '--browse-timeout <ms>',
            'Time to wait for API calls after page load (ms)',
            '10000',
        )
        .option('--no-scroll', 'Disable auto-scrolling to trigger lazy loading')
        .option(
            '--capture-rendered-html',
            'Capture rendered HTML after JS execution instead of original (use for SPAs)',
            false,
        )
        // Capture parallelization options
        .option(
            '--capture-concurrency <number>',
            'Number of pages to crawl in parallel (default: 5)',
            '5',
        )
        .option(
            '--page-retries <number>',
            'Number of retries for failed page navigations (default: 3)',
            '3',
        )
        .option(
            '--asset-retries <number>',
            'Number of retries for truncated asset downloads (default: 2)',
            '2',
        )
        .option(
            '--retry-delay <ms>',
            'Base delay for exponential backoff between retries in ms (default: 500)',
            '500',
        )
        .option(
            '--retry-delay-max <ms>',
            'Maximum backoff delay between retries in ms (default: 5000)',
            '5000',
        )
        .option(
            '--rate-limit-delay <ms>',
            'Delay between requests in ms to avoid rate limiting (0 = disabled)',
            '0',
        )
        .option(
            '--page-timeout <ms>',
            'Per-page navigation timeout in ms (default: 30000)',
            '30000',
        )
        // Capture wait time options
        .option(
            '--network-idle-timeout <ms>',
            'Network idle wait timeout in ms (default: 5000)',
            '5000',
        )
        .option(
            '--network-idle-time <ms>',
            'Consider page idle after this many ms without network requests (default: 1000)',
            '1000',
        )
        .option(
            '--scroll-delay <ms>',
            'Delay between scroll steps when auto-scrolling in ms (default: 50)',
            '50',
        )
        .option(
            '--page-settle-time <ms>',
            'Additional settle time after scrolling in ms (default: 1000)',
            '1000',
        )
        // Rebuild options (enabled by default)
        .option(
            '--no-rebuild',
            'Skip running the build (only generate config files)',
        )
        .option(
            '--package-manager <manager>',
            'Package manager to use for install/build (npm, pnpm, yarn, or auto for detection)',
            'auto',
        )
        .option(
            '--serve',
            'Start mock server after successful operations',
            false,
        );

    // Add server options conditionally when --serve is present
    if (hasServe) {
        serverCliOptions(program);
    }

    program
        .option(
            '--save-bundles',
            'Additionally save minified bundles that have source maps (bundles without source maps are always saved)',
            false,
        )
        // Crawl options
        .option(
            '--no-crawl',
            'Disable link crawling (only capture the entry page)',
        )
        .option(
            '--crawl-max-depth <number>',
            'Maximum link depth to follow when crawling',
            '5',
        )
        .option(
            '--crawl-max-pages <number>',
            'Maximum number of pages to visit when crawling',
            '100',
        )
        .option(
            '--resolve-max-iterations <number>',
            'Maximum iterations for resolving dynamic imports from bundles (default: 10)',
            '10',
        )
        .action(async (url, options) => {
            const normalizedUrl = normalizeUrl(url);
            const fullOptions: CliOptions = {
                url: normalizedUrl,
                output: options.output,
                overwrite: options.overwrite || false,
                resume: options.resume || false,
                verbose: options.verbose || false,
                concurrency: parseInt(options.concurrency, 10),
                // Package.json options (--no-X sets to false, so we check !== false for enabled)
                noPackageJson: options.packageJson === false,
                noFingerprinting: options.fingerprinting === false,
                noFetchVersions: options.fetchVersions === false,
                maxVersions: parseInt(options.maxVersions, 10),
                cacheDir: options.cacheDir || '',
                noCache: options.cache === false,
                includePrereleases: options.includePrereleases || false,
                // Fingerprinting concurrency options
                fingerprintConcurrency: parseInt(
                    options.fingerprintConcurrency,
                    10,
                ),
                versionConcurrency: parseInt(options.versionConcurrency, 10),
                pathConcurrency: parseInt(options.pathConcurrency, 10),
                forceRefresh: options.forceRefresh || false,
                // API capture options
                noCapture: options.capture === false,
                apiFilter: options.apiFilter || [
                    '**/api/**',
                    '**/graphql**',
                    '**/v1/**',
                    '**/v2/**',
                    '**/v3/**',
                ],
                captureStatic: options.static !== false,
                captureRenderedHtml: options.captureRenderedHtml || false,
                headless: options.headless !== false,
                browseTimeout: parseInt(options.browseTimeout, 10),
                autoScroll: options.scroll !== false,
                // Capture parallelization options
                captureConcurrency: parseInt(options.captureConcurrency, 10),
                pageRetries: parseInt(options.pageRetries, 10),
                assetRetries: parseInt(options.assetRetries, 10),
                retryDelay: parseInt(options.retryDelay, 10),
                retryDelayMax: parseInt(options.retryDelayMax, 10),
                rateLimitDelay: parseInt(options.rateLimitDelay, 10),
                pageTimeout: parseInt(options.pageTimeout, 10),
                // Capture wait time options
                networkIdleTimeout: parseInt(options.networkIdleTimeout, 10),
                networkIdleTime: parseInt(options.networkIdleTime, 10),
                scrollDelay: parseInt(options.scrollDelay, 10),
                pageSettleTime: parseInt(options.pageSettleTime, 10),
                // Rebuild options
                noRebuild: options.rebuild === false,
                packageManager: options.packageManager || 'auto',
                serve: options.serve || false,
                useRebuilt: options.useRebuilt || false,
                // Server options (when --serve is used)
                port: options.port ? parseInt(options.port, 10) : undefined,
                host: options.host,
                delay: options.delay ? parseInt(options.delay, 10) : undefined,
                noCors: options.cors === false,
                staticOnly: options.staticOnly || false,
                apiOnly: options.apiOnly || false,
                // Fallback options
                saveBundles: options.saveBundles || false,
                // Crawl options
                crawl: options.crawl !== false,
                crawlMaxDepth: parseInt(options.crawlMaxDepth, 10),
                crawlMaxPages: parseInt(options.crawlMaxPages, 10),
                // Dynamic import resolution options
                resolveMaxIterations: parseInt(
                    options.resolveMaxIterations,
                    10,
                ),
            };
            await runMain(fullOptions);
        });

    /**
     * Serve command - start the mock server
     */
    serverCliOptions(
        program
            .command('serve')
            .description('Serve captured API fixtures and static assets')
            .argument('<dir>', 'Directory containing the captured site'),
    )
        .option('-v, --verbose', 'Enable verbose logging', false)
        .action(async (dir: string, opts: ServeCliOptions) => {
            const { runServer } = await import('@web2local/server');
            const { resolve } = await import('path');

            const serverOptions = getServerOptions(opts, resolve(dir));

            await runServer(serverOptions);
        });

    /**
     * Extract command - extract source files from source maps only
     */
    program
        .command('extract')
        .description(
            'Extract source files from source maps (no rebuild, no capture)',
        )
        .argument(
            '<url>',
            'URL of a page to find bundles, or a direct source map URL',
        )
        .option(
            '-o, --output <dir>',
            'Output directory (default: ./output/<hostname>)',
        )
        .option(
            '--overwrite',
            'Clear existing output directory without prompting',
            false,
        )
        .option('-v, --verbose', 'Enable verbose logging', false)
        .option(
            '-c, --concurrency <number>',
            'Number of concurrent downloads',
            '5',
        )
        .option('--no-cache', 'Bypass cache, fetch fresh')
        // Crawl options for extract command
        .option(
            '--no-crawl',
            'Disable link crawling (only extract from entry page)',
        )
        .option(
            '--crawl-max-depth <number>',
            'Maximum link depth to follow when crawling',
            '5',
        )
        .option(
            '--crawl-max-pages <number>',
            'Maximum number of pages to visit when crawling',
            '100',
        )
        .option('--no-headless', 'Run browser in visible mode (not headless)')
        .option('--resume', 'Resume from checkpoint if available')
        .action(async (url: string, opts: ExtractCliOptions) => {
            const { runExtract } = await import('./run-extract.js');
            await runExtract({
                url: normalizeUrl(url),
                output: opts.output,
                overwrite: opts.overwrite || false,
                resume: opts.resume || false,
                verbose: opts.verbose || false,
                concurrency: parseInt(opts.concurrency, 10),
                noCache: opts.cache === false,
                // Crawl options
                crawl: opts.crawl !== false,
                crawlMaxDepth: parseInt(opts.crawlMaxDepth, 10),
                crawlMaxPages: parseInt(opts.crawlMaxPages, 10),
                headless: opts.headless !== false,
            });
        });

    program.parse();

    const options = program.opts();
    const [url] = program.args;

    return {
        url,
        output: options.output,
        overwrite: options.overwrite || false,
        resume: options.resume || false,
        verbose: options.verbose || false,
        concurrency: parseInt(options.concurrency, 10),
        // Package.json options
        noPackageJson: options.packageJson === false,
        noFingerprinting: options.fingerprinting === false,
        noFetchVersions: options.fetchVersions === false,
        maxVersions: parseInt(options.maxVersions, 10),
        cacheDir: options.cacheDir || '',
        noCache: options.cache === false,
        includePrereleases: options.includePrereleases || false,
        // Fingerprinting concurrency options
        fingerprintConcurrency: parseInt(options.fingerprintConcurrency, 10),
        versionConcurrency: parseInt(options.versionConcurrency, 10),
        pathConcurrency: parseInt(options.pathConcurrency, 10),
        forceRefresh: options.forceRefresh || false,
        // API capture options
        noCapture: options.capture === false,
        apiFilter: options.apiFilter || [
            '**/api/**',
            '**/graphql**',
            '**/v1/**',
            '**/v2/**',
            '**/v3/**',
        ],
        captureStatic: options.static !== false,
        captureRenderedHtml: options.captureRenderedHtml || false,
        headless: options.headless !== false,
        browseTimeout: parseInt(options.browseTimeout, 10),
        autoScroll: options.scroll !== false,
        // Capture parallelization options
        captureConcurrency: parseInt(options.captureConcurrency, 10),
        pageRetries: parseInt(options.pageRetries, 10),
        assetRetries: parseInt(options.assetRetries, 10),
        retryDelay: parseInt(options.retryDelay, 10),
        retryDelayMax: parseInt(options.retryDelayMax, 10),
        rateLimitDelay: parseInt(options.rateLimitDelay, 10),
        pageTimeout: parseInt(options.pageTimeout, 10),
        // Capture wait time options
        networkIdleTimeout: parseInt(options.networkIdleTimeout, 10),
        networkIdleTime: parseInt(options.networkIdleTime, 10),
        scrollDelay: parseInt(options.scrollDelay, 10),
        pageSettleTime: parseInt(options.pageSettleTime, 10),
        // Rebuild options
        noRebuild: options.rebuild === false,
        packageManager: options.packageManager || 'auto',
        serve: options.serve || false,
        useRebuilt: options.useRebuilt || false,
        // Fallback options
        saveBundles: options.saveBundles || false,
        // Crawl options
        crawl: options.crawl !== false,
        crawlMaxDepth: parseInt(options.crawlMaxDepth, 10),
        crawlMaxPages: parseInt(options.crawlMaxPages, 10),
        // Dynamic import resolution options
        resolveMaxIterations: parseInt(options.resolveMaxIterations, 10),
    };
}
