import { Command } from 'commander';
import type { ServerOptions } from '@web2local/server';
import { VERSION } from '@web2local/utils';
import { runMain } from './index.js';

export interface ExtractOptions {
    url: string;
    output: string;
    verbose: boolean;
    includeNodeModules: boolean;
    concurrency: number;
    noCache: boolean;
    /** Use browser crawling to discover bundles across multiple pages */
    crawl?: boolean;
    /** Maximum link depth to follow when crawling */
    crawlMaxDepth?: number;
    /** Maximum number of pages to visit when crawling */
    crawlMaxPages?: number;
    /** Run browser in headless mode (default: true) */
    headless?: boolean;
}

export interface CliOptions {
    url: string;
    output: string;
    verbose: boolean;
    includeNodeModules: boolean;
    concurrency: number;
    // Package.json generation (default: enabled)
    noPackageJson: boolean;
    useFingerprinting: boolean;
    noFetchVersions: boolean;
    maxVersions: number;
    cacheDir: string;
    noCache: boolean;
    includePrereleases: boolean;
    // Fingerprinting concurrency options
    fingerprintConcurrency: number;
    versionConcurrency: number;
    pathConcurrency: number;
    forceRefresh: boolean;
    // API capture options (default: enabled)
    noCapture: boolean;
    apiFilter: string[];
    captureStatic: boolean;
    captureRenderedHtml: boolean;
    headless: boolean;
    browseTimeout: number;
    autoScroll: boolean;
    // Capture parallelization options
    captureConcurrency: number;
    pageRetries: number;
    rateLimitDelay: number;
    pageTimeout: number;
    // Capture wait time options
    networkIdleTimeout: number;
    networkIdleTime: number;
    scrollDelay: number;
    pageSettleTime: number;
    // Rebuild options (default: enabled)
    noRebuild: boolean;
    packageManager: 'npm' | 'pnpm' | 'yarn' | 'auto';
    serve: boolean;
    useRebuilt: boolean;
    // Server options (when --serve is used)
    port?: number;
    host?: string;
    delay?: number;
    noCors?: boolean;
    staticOnly?: boolean;
    apiOnly?: boolean;
    // Fallback options
    saveBundles: boolean;
    // Crawl options
    crawl: boolean;
    crawlMaxDepth: number;
    crawlMaxPages: number;
    // Dynamic import resolution options
    resolveMaxIterations: number;
}

/**
 * CLI options for serve command
 */
interface ServeCliOptions {
    port?: string;
    host?: string;
    delay?: string;
    cors?: boolean;
    staticOnly?: boolean;
    apiOnly?: boolean;
    verbose?: boolean;
    useRebuilt?: boolean;
}

/**
 * CLI options for extract command
 */
interface ExtractCliOptions {
    output: string;
    verbose?: boolean;
    includeNodeModules?: boolean;
    concurrency: string;
    cache?: boolean;
    crawl?: boolean;
    crawlMaxDepth: string;
    crawlMaxPages: string;
    headless?: boolean;
}

/**
 * Extract server options from parsed CLI options
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
        .option('-o, --output <dir>', 'Output directory', './output')
        .option('-v, --verbose', 'Enable verbose logging', false)
        .option(
            '-n, --include-node-modules',
            'Include node_modules in output',
            false,
        )
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
            '--use-fingerprinting',
            'Use source fingerprinting to match versions against npm (slower but more accurate)',
            false,
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
            'Number of retries for failed page navigations (default: 2)',
            '2',
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
            const fullOptions: CliOptions = {
                url,
                output: options.output,
                verbose: options.verbose || false,
                includeNodeModules: options.includeNodeModules || false,
                concurrency: parseInt(options.concurrency, 10),
                // Package.json options (--no-X sets to false, so we check !== false for enabled)
                noPackageJson: options.packageJson === false,
                useFingerprinting: options.useFingerprinting || false,
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
        .option('-o, --output <dir>', 'Output directory', './output')
        .option('-v, --verbose', 'Enable verbose logging', false)
        .option(
            '-n, --include-node-modules',
            'Include node_modules in output',
            false,
        )
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
        .action(async (url: string, opts: ExtractCliOptions) => {
            const { runExtract } = await import('./run-extract.js');
            await runExtract({
                url,
                output: opts.output,
                verbose: opts.verbose || false,
                includeNodeModules: opts.includeNodeModules || false,
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
        verbose: options.verbose || false,
        includeNodeModules: options.includeNodeModules || false,
        concurrency: parseInt(options.concurrency, 10),
        // Package.json options
        noPackageJson: options.packageJson === false,
        useFingerprinting: options.useFingerprinting || false,
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
