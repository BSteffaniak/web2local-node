/**
 * Main capture orchestration module
 *
 * Coordinates browser automation, API interception, and static asset capture.
 * Supports parallel page crawling for improved performance.
 */

import { join } from 'path';
import {
    BrowserManager,
    autoScrollPage,
    waitForNetworkIdle,
    extractPageLinks,
    normalizeUrlForCrawl,
} from './browser.js';
import {
    ApiInterceptor,
    deduplicateFixtures,
    sortFixturesByPriority,
} from './api-interceptor.js';
import { StaticCapturer } from './static-downloader.js';
import {
    generateServerManifest,
    generateCaptureSummary,
} from '@web2local/manifest';
import { CrawlQueue } from './crawl-queue.js';
import { CrawlWorker, type SharedCrawlState } from './crawl-worker.js';
import { smartWaitForPage } from './smart-wait.js';
import type {
    CaptureOptions,
    CaptureResult,
    CrawlStats,
    ApiFixture,
    CapturedAsset,
} from './types.js';

export {
    BrowserManager,
    autoScrollPage,
    waitForNetworkIdle,
    extractPageLinks,
    normalizeUrlForCrawl,
} from './browser.js';
export {
    ApiInterceptor,
    deduplicateFixtures,
    sortFixturesByPriority,
} from './api-interceptor.js';
export {
    StaticCapturer,
    rewriteHtmlUrls,
    parseSrcsetUrls,
    parseImageSetUrls,
    extractResponsiveUrlsFromHtml,
    extractResponsiveUrlsFromCss,
    passesFilter,
    passesFilterEarly,
} from './static-downloader.js';
export {
    extractUrlPattern,
    groupUrlsByPattern,
    createFixtureFilename,
} from '@web2local/http';
export {
    generateServerManifest,
    generateCaptureSummary,
} from '@web2local/manifest';
export { CrawlQueue } from './crawl-queue.js';
export { CrawlWorker } from './crawl-worker.js';
export { smartWaitForPage, sleep } from './smart-wait.js';
export * from './types.js';

/**
 * Default capture options
 */
const DEFAULT_CAPTURE_OPTIONS: Partial<CaptureOptions> = {
    apiFilter: [
        '**/api/**',
        '**/graphql**',
        '**/v1/**',
        '**/v2/**',
        '**/v3/**',
    ],
    captureStatic: true,
    headless: true,
    browseTimeout: 10000,
    autoScroll: true,
    verbose: false,
    crawl: true,
    crawlMaxDepth: 5,
    crawlMaxPages: 100,
    // Parallelization defaults
    concurrency: 5,
    pageRetries: 2,
    rateLimitDelay: 0,
    pageTimeout: 30000,
    // Wait time defaults
    networkIdleTimeout: 5000,
    networkIdleTime: 1000,
    scrollDelay: 50,
    pageSettleTime: 1000,
};

/**
 * Perform a full capture of a website
 *
 * This is the main entry point for capturing a website's API calls and static assets.
 * When crawling is enabled, it will follow links on the page to capture additional
 * routes and their associated chunks.
 *
 * Supports parallel crawling with configurable concurrency for improved performance.
 */
export async function captureWebsite(
    options: CaptureOptions,
): Promise<CaptureResult> {
    const opts = { ...DEFAULT_CAPTURE_OPTIONS, ...options } as CaptureOptions;
    const startTime = Date.now();
    const errors: string[] = [];

    const urlObj = new URL(opts.url);
    const hostname = urlObj.hostname;
    const baseOrigin = urlObj.origin;
    const siteOutputDir = join(opts.outputDir, hostname);
    const staticOutputDir = join(siteOutputDir, '_server', 'static');

    // Crawl settings
    const crawlEnabled = opts.crawl ?? true;
    const maxDepth = opts.crawlMaxDepth ?? 5;
    const maxPages = opts.crawlMaxPages ?? 100;

    // Parallelization settings
    const concurrency = opts.concurrency ?? 5;
    const pageRetries = opts.pageRetries ?? 2;
    const rateLimitDelay = opts.rateLimitDelay ?? 0;
    const pageTimeout = opts.pageTimeout ?? 30000;

    // Wait time settings
    const networkIdleTimeout = opts.networkIdleTimeout ?? 5000;
    const networkIdleTime = opts.networkIdleTime ?? 1000;
    const scrollDelay = opts.scrollDelay ?? 50;
    const pageSettleTime = opts.pageSettleTime ?? 1000;

    // Initialize browser
    opts.onProgress?.({ type: 'lifecycle', phase: 'browser-launching' });
    const browser = new BrowserManager({
        headless: opts.headless,
    });

    // Initialize interceptors
    const apiInterceptor = new ApiInterceptor({
        apiFilters: opts.apiFilter,
        verbose: opts.verbose,
        onCapture: (event) => {
            opts.onProgress?.(event);
        },
        onVerbose: opts.onVerbose,
    });

    const staticCapturer = new StaticCapturer({
        outputDir: staticOutputDir,
        verbose: opts.verbose,
        captureRenderedHtml: opts.captureRenderedHtml ?? false,
        staticFilter: opts.staticFilter,
        onAssetCaptured: opts.onAssetCaptured,
        skipAssetWrite: opts.skipAssetWrite,
        onCapture: (event) => {
            opts.onProgress?.(event);
        },
        onVerbose: opts.onVerbose,
    });

    let fixtures: ApiFixture[] = [];
    let assets: CapturedAsset[] = [];

    // Create shared crawl queue
    const crawlQueue = new CrawlQueue({
        maxRetries: pageRetries,
        maxPages,
        maxDepth,
    });

    // Add initial URL to queue
    crawlQueue.add(opts.url, 0);

    // Shared state for coordinating between workers
    const sharedState: SharedCrawlState = {
        htmlCaptured: false,
        finalUrl: null,
        firstPageHandled: false,
    };

    try {
        await browser.launch();
        opts.onProgress?.({ type: 'lifecycle', phase: 'browser-launched' });

        // Determine actual concurrency (limited by maxPages)
        const actualConcurrency = Math.min(concurrency, maxPages);

        opts.onProgress?.({ type: 'lifecycle', phase: 'pages-creating' });

        // Create page pool and attach interceptors to all pages
        const pages = [];
        for (let i = 0; i < actualConcurrency; i++) {
            const page = await browser.newPage();

            // Attach interceptors - they handle concurrent events from all pages
            apiInterceptor.attach(page);
            if (opts.captureStatic) {
                await staticCapturer.attach(page, opts.url);
            }

            pages.push(page);
        }

        opts.onProgress?.({
            type: 'lifecycle',
            phase: 'pages-created',
            count: actualConcurrency,
        });

        opts.onProgress?.({ type: 'lifecycle', phase: 'crawl-starting' });

        // Create workers
        const workers = pages.map(
            (page, i) =>
                new CrawlWorker(
                    i,
                    {
                        page,
                        queue: crawlQueue,
                        staticCapturer,
                        apiInterceptor,
                        baseOrigin,
                        workerCount: actualConcurrency,
                        maxPages,
                        networkIdleTimeout,
                        networkIdleTime,
                        scrollDelay,
                        pageSettleTime,
                        autoScroll: opts.autoScroll,
                        pageTimeout,
                        rateLimitDelay,
                        captureStatic: opts.captureStatic,
                        captureRenderedHtml: opts.captureRenderedHtml ?? false,
                        crawlEnabled,
                        maxDepth,
                        onProgress: opts.onProgress,
                        onVerbose: opts.onVerbose,
                        verbose: opts.verbose,
                    },
                    sharedState,
                ),
        );

        // Run all workers concurrently
        const results = await Promise.all(workers.map((w) => w.run()));

        // Aggregate errors from all workers
        for (const result of results) {
            errors.push(...result.errors);
        }

        // Wait for all pending asset captures to complete
        if (opts.captureStatic) {
            await staticCapturer.flush();
        }

        // Get captured data
        fixtures = apiInterceptor.getFixtures();
        assets = staticCapturer.getAssets();

        // Deduplicate and sort fixtures
        fixtures = deduplicateFixtures(fixtures);
        fixtures = sortFixturesByPriority(fixtures);
    } catch (error) {
        errors.push(`Capture error: ${error}`);
    } finally {
        await browser.close();
    }

    // Get crawl stats from queue (before emitting crawl-complete)
    const queueStats = crawlQueue.getStats();

    // Build crawl stats
    const crawlStats: CrawlStats | undefined = crawlEnabled
        ? {
              pagesVisited: queueStats.pagesVisited,
              pagesSkipped: queueStats.pagesSkipped,
              linksDiscovered: queueStats.linksDiscovered,
              maxDepthReached: queueStats.maxDepthReached,
              maxPagesReached: queueStats.maxPagesReached,
          }
        : undefined;

    opts.onProgress?.({
        type: 'lifecycle',
        phase: 'crawl-complete',
        stats: crawlStats,
    });

    // Get detected redirects from browser capture
    const browserRedirects = staticCapturer.getRedirects();

    // Merge with scraped redirects (from initial HTTP fetch)
    // Scraped redirects take priority as they're from the actual HTTP layer
    const scrapedRedirects = opts.scrapedRedirects || [];

    // Combine redirects, avoiding duplicates (prefer scraped over browser-detected)
    const seenFromPaths = new Set(scrapedRedirects.map((r) => r.from));
    const allRedirects = [
        ...scrapedRedirects,
        ...browserRedirects.filter((r) => !seenFromPaths.has(r.from)),
    ];

    // Generate server manifest
    if (fixtures.length > 0 || assets.length > 0) {
        opts.onProgress?.({ type: 'lifecycle', phase: 'manifest-generating' });

        try {
            const manifestResult = await generateServerManifest(
                fixtures,
                assets,
                {
                    name: hostname,
                    sourceUrl: opts.url,
                    outputDir: siteOutputDir,
                    defaultPort: 3000,
                    cors: true,
                    delay: {
                        enabled: false,
                        minMs: 0,
                        maxMs: 0,
                    },
                    redirects:
                        allRedirects.length > 0 ? allRedirects : undefined,
                },
            );

            if (manifestResult.errors.length > 0) {
                errors.push(...manifestResult.errors);
            }

            opts.onProgress?.({
                type: 'lifecycle',
                phase: 'manifest-complete',
            });
        } catch (error) {
            errors.push(`Manifest generation error: ${error}`);
        }
    }

    const captureTimeMs = Date.now() - startTime;
    const totalBytes = assets.reduce((sum, a) => sum + a.size, 0);

    return {
        fixtures,
        assets,
        errors,
        stats: {
            apiCallsCaptured: fixtures.length,
            staticAssetsCaptured: assets.length,
            totalBytesDownloaded: totalBytes,
            captureTimeMs,
            crawlStats,
        },
    };
}

/**
 * Capture API calls only (no static assets)
 */
export async function captureApiOnly(
    url: string,
    options: Partial<CaptureOptions> = {},
): Promise<CaptureResult> {
    return captureWebsite({
        url,
        outputDir: options.outputDir || './output',
        apiFilter: options.apiFilter || ['**/api/**'],
        captureStatic: false,
        headless: options.headless ?? true,
        browseTimeout: options.browseTimeout ?? 10000,
        autoScroll: options.autoScroll ?? true,
        verbose: options.verbose ?? false,
        onProgress: options.onProgress,
    });
}

/**
 * Quick capture - fast capture with minimal waiting
 */
export async function quickCapture(
    url: string,
    outputDir: string = './output',
): Promise<CaptureResult> {
    return captureWebsite({
        url,
        outputDir,
        apiFilter: ['**/api/**', '**/graphql**'],
        captureStatic: true,
        headless: true,
        browseTimeout: 5000,
        autoScroll: false,
        verbose: false,
    });
}
