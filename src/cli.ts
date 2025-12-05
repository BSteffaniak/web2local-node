import { Command } from 'commander';

export interface CliOptions {
    url: string;
    output: string;
    verbose: boolean;
    includeNodeModules: boolean;
    concurrency: number;
    generatePackageJson: boolean;
    useFingerprinting: boolean;
    fetchNpmVersions: boolean;
    maxVersions: number;
    cacheDir: string;
    noCache: boolean;
    includePrereleases: boolean;
    forceRefresh: boolean;
    // API capture options
    captureApi: boolean;
    apiFilter: string[];
    captureStatic: boolean;
    captureRenderedHtml: boolean;
    headless: boolean;
    browseTimeout: number;
    autoScroll: boolean;
    // Rebuild options
    prepareRebuild: boolean;
    rebuild: boolean;
    packageManager: 'npm' | 'pnpm' | 'yarn' | 'auto';
    // Fallback options
    saveBundles: boolean;
    // Crawl options
    crawl: boolean;
    crawlMaxDepth: number;
    crawlMaxPages: number;
    // Dynamic import resolution options
    resolveMaxIterations: number;
}

export function parseArgs(): CliOptions {
    const program = new Command();

    program
        .name('top-secret-source-reverse-engineerer-9001')
        .description(
            'Extract and reconstruct original source code from publicly available source maps',
        )
        .version('1.0.0')
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
        .option(
            '-p, --generate-package-json',
            'Generate package.json with detected dependencies',
            false,
        )
        .option(
            '--use-fingerprinting',
            'Use source fingerprinting to match versions against npm (slower but more accurate)',
            false,
        )
        .option(
            '--fetch-npm-versions',
            'Fallback to latest npm versions for undetected packages (requires -p)',
            false,
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
        .option('--no-cache', 'Disable fingerprint caching', false)
        .option(
            '--include-prereleases',
            'Include pre-release versions (alpha, beta, rc, nightly) when fingerprinting',
            false,
        )
        .option(
            '--force-refresh',
            'Bypass all caches and fetch fresh data',
            false,
        )
        // API capture options
        .option(
            '--capture-api',
            'Enable API call capture via browser automation (uses Playwright)',
            false,
        )
        .option(
            '--api-filter <patterns...>',
            'Filter patterns for API routes to capture (glob-style)',
            ['**/api/**', '**/graphql**', '**/v1/**', '**/v2/**', '**/v3/**'],
        )
        .option(
            '--no-static',
            'Disable static asset capture (only capture API calls)',
        )
        .option(
            '--no-headless',
            'Run browser in visible mode (not headless)',
            false,
        )
        .option(
            '--browse-timeout <ms>',
            'Time to wait for API calls after page load (ms)',
            '10000',
        )
        .option(
            '--no-scroll',
            'Disable auto-scrolling to trigger lazy loading',
            false,
        )
        .option(
            '--capture-rendered-html',
            'Capture rendered HTML after JS execution instead of original (use for SPAs)',
            false,
        )
        // Rebuild options
        .option(
            '--prepare-rebuild',
            'Generate build configuration (vite.config.ts, index.html) for rebuilding from source',
            false,
        )
        .option(
            '--rebuild',
            'Generate build configuration and run the build (requires -p for package.json)',
            false,
        )
        .option(
            '--package-manager <manager>',
            'Package manager to use for install/build (npm, pnpm, yarn, or auto for detection)',
            'auto',
        )
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
        .parse();

    const options = program.opts();
    const [url] = program.args;

    return {
        url,
        output: options.output,
        verbose: options.verbose,
        includeNodeModules: options.includeNodeModules,
        concurrency: parseInt(options.concurrency, 10),
        generatePackageJson: options.generatePackageJson,
        useFingerprinting: options.useFingerprinting,
        fetchNpmVersions: options.fetchNpmVersions,
        maxVersions: parseInt(options.maxVersions, 10),
        cacheDir: options.cacheDir || '',
        noCache: options.noCache || false,
        includePrereleases: options.includePrereleases || false,
        forceRefresh: options.forceRefresh || false,
        // API capture options
        captureApi: options.captureApi || false,
        apiFilter: options.apiFilter || [
            '**/api/**',
            '**/graphql**',
            '**/v1/**',
            '**/v2/**',
            '**/v3/**',
        ],
        // Note: commander's --no-X flags set the option to true when NOT specified
        // and false when specified, so we need to handle this correctly
        captureStatic: options.static !== false,
        captureRenderedHtml: options.captureRenderedHtml || false,
        headless: options.headless !== false,
        browseTimeout: parseInt(options.browseTimeout, 10),
        autoScroll: options.scroll !== false,
        // Rebuild options
        prepareRebuild: options.prepareRebuild || false,
        rebuild: options.rebuild || false,
        packageManager: options.packageManager || 'auto',
        // Fallback options
        saveBundles: options.saveBundles || false,
        // Crawl options (--no-crawl sets crawl to false)
        crawl: options.crawl !== false,
        crawlMaxDepth: parseInt(options.crawlMaxDepth, 10),
        crawlMaxPages: parseInt(options.crawlMaxPages, 10),
        // Dynamic import resolution options
        resolveMaxIterations: parseInt(options.resolveMaxIterations, 10),
    };
}
