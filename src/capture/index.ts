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
    ApiFixture,
    CapturedAsset,
} from './types.js';

export {
    BrowserManager,
    autoScrollPage,
    waitForNetworkIdle,
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
};

/**
 * Perform a full capture of a website
 *
 * This is the main entry point for capturing a website's API calls and static assets.
 */
export async function captureWebsite(
    options: CaptureOptions,
): Promise<CaptureResult> {
    const opts = { ...DEFAULT_CAPTURE_OPTIONS, ...options } as CaptureOptions;
    const startTime = Date.now();
    const errors: string[] = [];

    const urlObj = new URL(opts.url);
    const hostname = urlObj.hostname;
    const siteOutputDir = join(opts.outputDir, hostname);
    const staticOutputDir = join(siteOutputDir, '_server', 'static');

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

        // Attach interceptors
        apiInterceptor.attach(page);
        if (opts.captureStatic) {
            // Attach static asset capturer to listen for responses
            staticCapturer.attach(page, opts.url);
        }

        opts.onProgress?.(`Navigating to ${opts.url}...`);

        // Navigate to the page
        await page.goto(opts.url, {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
        });

        // Update the static capturer's base URL after navigation completes
        // This handles redirect scenarios (e.g., www.bob.com -> www.robert.com)
        if (opts.captureStatic) {
            const finalUrl = page.url();
            if (finalUrl !== opts.url) {
                opts.onProgress?.(
                    `Redirected to ${finalUrl}, updating base URL...`,
                );
            }
            staticCapturer.updateBaseUrl(finalUrl);
        }

        // Wait for initial network activity to settle
        await waitForNetworkIdle(page, { timeout: 10000 });

        // Auto-scroll to trigger lazy loading
        if (opts.autoScroll) {
            opts.onProgress?.('Auto-scrolling page...');
            await autoScrollPage(page, {
                step: 500,
                delay: 100,
                maxScrolls: 30,
            });
        }

        // Wait for additional time to capture more API calls
        opts.onProgress?.(
            `Waiting ${opts.browseTimeout}ms for additional API calls...`,
        );
        await page.waitForTimeout(opts.browseTimeout);

        // Wait for network to be idle again
        await waitForNetworkIdle(page, { timeout: 5000 });

        // Capture the final HTML document
        if (opts.captureStatic) {
            opts.onProgress?.('Capturing final HTML document...');
            await staticCapturer.captureDocument(page);
            // Wait for all pending asset captures to complete
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

    return {
        fixtures,
        assets,
        errors,
        stats: {
            apiCallsCaptured: fixtures.length,
            staticAssetsCaptured: assets.length,
            totalBytesDownloaded: totalBytes,
            captureTimeMs,
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
