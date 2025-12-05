/**
 * Main capture orchestration module
 *
 * Coordinates browser automation, API interception, and static asset capture
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
} from '../manifest/server-manifest.js';
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
export { StaticCapturer, rewriteHtmlUrls } from './static-downloader.js';
export { extractUrlPattern, groupUrlsByPattern } from './url-pattern.js';
export {
    generateServerManifest,
    generateCaptureSummary,
} from '../manifest/server-manifest.js';
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
};

/**
 * Perform a full capture of a website
 *
 * This is the main entry point for capturing a website's API calls and static assets.
 * When crawling is enabled, it will follow links on the page to capture additional
 * routes and their associated chunks.
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

    // Crawl tracking
    const visitedUrls = new Set<string>();
    const urlQueue: Array<{ url: string; depth: number }> = [];
    let pagesVisited = 0;
    let linksDiscovered = 0;
    let maxDepthReached = false;
    let maxPagesReached = false;

    // Initialize browser
    const browser = new BrowserManager({
        headless: opts.headless,
    });

    // Initialize interceptors
    const apiInterceptor = new ApiInterceptor({
        apiFilters: opts.apiFilter,
        verbose: opts.verbose,
        onCapture: (fixture) => {
            opts.onProgress?.(
                `API: ${fixture.request.method} ${fixture.request.pattern}`,
            );
        },
    });

    const staticCapturer = new StaticCapturer({
        outputDir: staticOutputDir,
        verbose: opts.verbose,
        captureHtml: opts.captureStatic,
        captureCss: opts.captureStatic,
        captureJs: opts.captureStatic,
        captureImages: opts.captureStatic,
        captureFonts: opts.captureStatic,
        captureMedia: opts.captureStatic,
        captureRenderedHtml: opts.captureRenderedHtml ?? false,
        onCapture: (asset) => {
            opts.onProgress?.(`Static: ${asset.localPath}`);
        },
        onVerbose: opts.onVerbose,
    });

    let fixtures: ApiFixture[] = [];
    let assets: CapturedAsset[] = [];

    try {
        await browser.launch();
        const page = await browser.newPage();

        // Attach interceptors - they stay attached throughout the crawl
        apiInterceptor.attach(page);
        if (opts.captureStatic) {
            staticCapturer.attach(page, opts.url);
        }

        // Initialize the crawl queue with the entry URL
        urlQueue.push({ url: opts.url, depth: 0 });

        // Crawl loop
        while (urlQueue.length > 0) {
            // Check if we've reached the max pages limit
            if (pagesVisited >= maxPages) {
                maxPagesReached = true;
                break;
            }

            const { url: currentUrl, depth } = urlQueue.shift()!;
            const normalizedUrl = normalizeUrlForCrawl(currentUrl);

            // Skip if already visited
            if (visitedUrls.has(normalizedUrl)) {
                continue;
            }
            visitedUrls.add(normalizedUrl);

            // Progress message
            const isFirstPage = pagesVisited === 0;
            if (crawlEnabled && maxPages > 1) {
                opts.onProgress?.(
                    `Crawling [${pagesVisited + 1}/${maxPages}] depth=${depth}: ${currentUrl}`,
                );
            } else {
                opts.onProgress?.(`Navigating to ${currentUrl}...`);
            }

            // Verbose log
            if (opts.verbose) {
                opts.onVerbose?.(`Crawled: ${currentUrl} (depth ${depth})`);
            }

            try {
                // Navigate to the page
                await page.goto(currentUrl, {
                    waitUntil: 'domcontentloaded',
                    timeout: 60000,
                });

                // Update base URL on first page (handles redirects)
                if (isFirstPage && opts.captureStatic) {
                    const finalUrl = page.url();
                    if (finalUrl !== currentUrl) {
                        opts.onProgress?.(
                            `Redirected to ${finalUrl}, updating base URL...`,
                        );
                        // Also add the redirected URL to visited set
                        visitedUrls.add(normalizeUrlForCrawl(finalUrl));
                    }
                    staticCapturer.updateBaseUrl(finalUrl);
                }

                // Wait for network to settle
                await waitForNetworkIdle(page, { timeout: 10000 });

                // Auto-scroll to trigger lazy loading
                if (opts.autoScroll) {
                    await autoScrollPage(page, {
                        step: 500,
                        delay: 100,
                        maxScrolls: 30,
                    });
                }

                // Wait for additional time (shorter for subsequent pages)
                const waitTime = isFirstPage
                    ? opts.browseTimeout
                    : Math.min(opts.browseTimeout, 3000);
                await page.waitForTimeout(waitTime);

                // Wait for network to be idle again
                await waitForNetworkIdle(page, { timeout: 5000 });

                // Capture the HTML document only for the first page
                if (isFirstPage && opts.captureStatic) {
                    opts.onProgress?.('Capturing HTML document...');
                    await staticCapturer.captureDocument(page);
                }

                pagesVisited++;

                // Extract links for crawling if enabled and not at max depth
                if (crawlEnabled && depth < maxDepth) {
                    const links = await extractPageLinks(page, baseOrigin);
                    linksDiscovered += links.length;

                    for (const link of links) {
                        const normalizedLink = normalizeUrlForCrawl(link);
                        if (!visitedUrls.has(normalizedLink)) {
                            urlQueue.push({ url: link, depth: depth + 1 });
                        }
                    }

                    // Track if we hit max depth
                    if (depth + 1 >= maxDepth && links.length > 0) {
                        maxDepthReached = true;
                    }
                }
            } catch (error) {
                // Log navigation errors but continue crawling
                const errorMsg = `Error navigating to ${currentUrl}: ${error}`;
                errors.push(errorMsg);
                if (opts.verbose) {
                    opts.onVerbose?.(errorMsg);
                }
            }
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
        opts.onProgress?.('Generating server manifest...');

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
        } catch (error) {
            errors.push(`Manifest generation error: ${error}`);
        }
    }

    const captureTimeMs = Date.now() - startTime;
    const totalBytes = assets.reduce((sum, a) => sum + a.size, 0);

    // Build crawl stats
    const crawlStats: CrawlStats | undefined = crawlEnabled
        ? {
              pagesVisited,
              pagesSkipped: visitedUrls.size - pagesVisited,
              linksDiscovered,
              maxDepthReached,
              maxPagesReached,
          }
        : undefined;

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
