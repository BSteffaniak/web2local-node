/**
 * Crawl worker for parallel page processing
 *
 * Each worker owns a single Page instance and processes URLs from the shared queue.
 */

import type { Page } from 'playwright';
import { CrawlQueue, type QueueItem } from './crawl-queue.js';
import { StaticCapturer } from './static-downloader.js';
import { ApiInterceptor } from './api-interceptor.js';
import { extractPageLinks } from './browser.js';
import { smartWaitForPage, sleep } from './smart-wait.js';
import type {
    OnCaptureProgress,
    OnCaptureVerbose,
    PageProgressEvent,
} from './types.js';

/**
 * Options for the crawl worker
 */
export interface CrawlWorkerOptions {
    /** Playwright page instance (reused for all URLs) */
    page: Page;
    /** Shared crawl queue */
    queue: CrawlQueue;
    /** Static asset capturer */
    staticCapturer: StaticCapturer;
    /** API call interceptor */
    apiInterceptor: ApiInterceptor;
    /** Base origin for same-origin link filtering */
    baseOrigin: string;

    // Worker context
    /** Total number of workers */
    workerCount: number;
    /** Maximum number of pages to crawl */
    maxPages: number;

    // Wait configuration
    /** Network idle wait timeout in ms */
    networkIdleTimeout: number;
    /** Consider idle after this many ms without requests */
    networkIdleTime: number;
    /** Delay between scroll steps in ms */
    scrollDelay: number;
    /** Additional settle time after scrolling in ms */
    pageSettleTime: number;
    /** Enable auto-scroll to trigger lazy loading */
    autoScroll: boolean;
    /** Per-page navigation timeout in ms */
    pageTimeout: number;
    /** Delay between requests in ms (rate limiting) */
    rateLimitDelay: number;

    // Capture options
    /** Whether to capture static assets */
    captureStatic: boolean;
    /** Whether to capture rendered HTML instead of original */
    captureRenderedHtml: boolean;
    /** Whether crawling is enabled */
    crawlEnabled: boolean;
    /** Maximum link depth to follow */
    maxDepth: number;

    // Callbacks
    /** Structured progress callback */
    onProgress?: OnCaptureProgress;
    /** Structured verbose log callback */
    onVerbose?: OnCaptureVerbose;
    /** Verbose mode enabled */
    verbose: boolean;
}

/**
 * Result from a worker's run
 */
export interface WorkerResult {
    /** Number of pages successfully processed */
    pagesProcessed: number;
    /** Errors encountered during processing */
    errors: string[];
    /** Whether this worker captured the HTML document */
    htmlCaptured: boolean;
}

/**
 * Shared state for coordinating HTML capture across workers
 */
export interface SharedCrawlState {
    /** Whether the initial HTML document has been captured */
    htmlCaptured: boolean;
    /** The final URL after any redirects (set by first successful navigation) */
    finalUrl: string | null;
    /** Lock for first page handling */
    firstPageHandled: boolean;
    /** The resolved base origin after any redirects (for same-origin link filtering) */
    resolvedBaseOrigin: string | null;
}

/**
 * Worker that processes pages from a shared queue.
 *
 * Each worker:
 * 1. Takes URLs from the queue
 * 2. Navigates to the URL
 * 3. Waits for the page to settle
 * 4. Extracts links (if crawling enabled)
 * 5. Adds new links to the queue
 *
 * The page instance is reused across all URLs for maximum efficiency.
 */
export class CrawlWorker {
    private pagesProcessed = 0;
    private errors: string[] = [];
    private htmlCaptured = false;

    constructor(
        private workerId: number,
        private options: CrawlWorkerOptions,
        private sharedState: SharedCrawlState,
    ) {}

    /**
     * Build a PageProgressEvent with current queue state
     */
    private buildProgressEvent(
        phase: PageProgressEvent['phase'],
        item: QueueItem,
        extra?: Partial<PageProgressEvent>,
    ): PageProgressEvent {
        const { queue, workerCount, maxPages, maxDepth } = this.options;
        const snapshot = queue.getSnapshot();

        return {
            type: 'page-progress',
            workerId: this.workerId,
            workerCount,
            phase,
            url: item.url,
            pagesCompleted: snapshot.pagesCompleted,
            maxPages,
            depth: item.depth,
            maxDepth,
            queued: snapshot.queued,
            inProgress: snapshot.inProgress,
            ...extra,
        };
    }

    /**
     * Emit a verbose log event
     */
    private verbose(
        message: string,
        level: 'debug' | 'info' | 'warn' | 'error' = 'debug',
        data?: Record<string, unknown>,
    ): void {
        if (!this.options.verbose) return;

        this.options.onVerbose?.({
            type: 'verbose',
            level,
            source: 'worker',
            workerId: this.workerId,
            message,
            data,
        });
    }

    /**
     * Run the worker until the queue is exhausted.
     */
    async run(): Promise<WorkerResult> {
        const { queue, rateLimitDelay, onProgress } = this.options;

        while (!queue.isDone()) {
            const item = queue.take();

            if (!item) {
                // If max pages reached, exit immediately - no point waiting
                if (queue.isMaxPagesReached()) {
                    break;
                }
                // Queue is empty but other workers may still be processing
                // and could add new URLs. Wait a bit and check again.
                await sleep(100);
                continue;
            }

            const isFirstPage = !this.sharedState.firstPageHandled;

            try {
                this.verbose(
                    `Processing: ${item.url} (depth ${item.depth}, retry ${item.retries})`,
                    'debug',
                    { url: item.url, depth: item.depth, retries: item.retries },
                );

                onProgress?.(this.buildProgressEvent('navigating', item));

                await this.processPage(item, isFirstPage);
                queue.complete(item.url);
                this.pagesProcessed++;

                // Include linksDiscovered in completed event
                const linksDiscovered = (
                    item as QueueItem & { linksDiscovered?: number }
                ).linksDiscovered;
                onProgress?.(
                    this.buildProgressEvent('completed', item, {
                        linksDiscovered,
                    }),
                );

                this.verbose(`Completed: ${item.url}`, 'info', {
                    url: item.url,
                    linksDiscovered,
                });
            } catch (error) {
                const errorStr = String(error);

                this.verbose(`Error on ${item.url}: ${errorStr}`, 'error', {
                    url: item.url,
                    error: errorStr,
                });

                // Try to retry the URL
                const willRetry = queue.retry(item);

                onProgress?.(
                    this.buildProgressEvent(
                        willRetry ? 'retrying' : 'error',
                        item,
                        {
                            error: errorStr,
                            willRetry,
                        },
                    ),
                );

                if (!willRetry) {
                    // Max retries exceeded
                    this.errors.push(
                        `Failed after ${item.retries + 1} attempts: ${item.url}: ${error}`,
                    );
                }
            }

            // Rate limit delay between requests
            if (rateLimitDelay > 0) {
                await sleep(rateLimitDelay);
            }
        }

        return {
            pagesProcessed: this.pagesProcessed,
            errors: this.errors,
            htmlCaptured: this.htmlCaptured,
        };
    }

    /**
     * Process a single page.
     */
    private async processPage(
        item: QueueItem,
        isFirstPage: boolean,
    ): Promise<void> {
        const {
            page,
            queue,
            staticCapturer,
            baseOrigin,
            networkIdleTimeout,
            networkIdleTime,
            scrollDelay,
            pageSettleTime,
            autoScroll,
            pageTimeout,
            captureStatic,
            crawlEnabled,
            maxDepth,
            onProgress,
        } = this.options;

        // Set current page URL for asset tracking and reset per-page counters
        if (captureStatic) {
            staticCapturer.setCurrentPageUrl(item.url);
            staticCapturer.resetWorkerTracking(this.workerId);
        }

        // Navigate to the page
        await page.goto(item.url, {
            waitUntil: 'domcontentloaded',
            timeout: pageTimeout,
        });

        // Handle first page special cases (redirects, HTML capture)
        if (isFirstPage && !this.sharedState.firstPageHandled) {
            this.sharedState.firstPageHandled = true;

            const finalUrl = page.url();
            this.sharedState.finalUrl = finalUrl;

            // Update resolved base origin for link filtering
            // This ensures links are filtered against the actual destination origin,
            // not the original URL's origin (important for redirects like bob.com -> www.robert.com)
            try {
                const finalOrigin = new URL(finalUrl).origin;
                this.sharedState.resolvedBaseOrigin = finalOrigin;
            } catch {
                // If URL parsing fails, fall back to original baseOrigin
                this.sharedState.resolvedBaseOrigin = baseOrigin;
            }

            // Handle redirects
            if (finalUrl !== item.url) {
                this.verbose(`Redirected to ${finalUrl}`, 'info', {
                    from: item.url,
                    to: finalUrl,
                });

                // Emit redirect-detected event so TUI can update its baseOrigin
                onProgress?.({
                    type: 'lifecycle',
                    phase: 'redirect-detected',
                    fromUrl: item.url,
                    finalUrl,
                });

                // Mark the redirected URL as visited
                queue.markVisited(finalUrl);

                // Update the current page URL
                if (captureStatic) {
                    staticCapturer.setCurrentPageUrl(finalUrl);
                    staticCapturer.updateBaseUrl(finalUrl);
                }
            }
        }

        // Wait for the page to settle with phase callbacks
        await smartWaitForPage(page, {
            networkIdleTimeout,
            networkIdleTime,
            scrollDelay,
            pageSettleTime,
            autoScroll,
            onPhase: (phase) => {
                onProgress?.(this.buildProgressEvent(phase, item));
            },
        });

        // Capture HTML document for every crawled page
        // Each page needs its own HTML file so the mock server can serve the correct content
        if (captureStatic) {
            // Track if this worker captured HTML (for stats)
            if (!this.sharedState.htmlCaptured) {
                this.sharedState.htmlCaptured = true;
                this.htmlCaptured = true;
            }

            onProgress?.(this.buildProgressEvent('capturing-html', item));
            await staticCapturer.captureDocument(page);
        }

        // Extract links for crawling
        let linksDiscovered = 0;
        if (crawlEnabled && item.depth < maxDepth) {
            onProgress?.(this.buildProgressEvent('extracting-links', item));

            // Use resolved base origin (after redirects) for same-origin filtering
            // This ensures links are properly discovered when the initial URL redirects
            // (e.g., bob.com -> www.robert.com)
            const effectiveBaseOrigin =
                this.sharedState.resolvedBaseOrigin || baseOrigin;
            const links = await extractPageLinks(page, effectiveBaseOrigin);

            for (const link of links) {
                if (queue.add(link, item.depth + 1)) {
                    linksDiscovered++;
                }
            }

            if (linksDiscovered > 0) {
                this.verbose(
                    `Discovered ${linksDiscovered} new links from ${item.url}`,
                    'info',
                    { url: item.url, linksDiscovered },
                );
            }
        }

        // Store linksDiscovered for the completed event
        (item as QueueItem & { linksDiscovered?: number }).linksDiscovered =
            linksDiscovered;
    }
}
