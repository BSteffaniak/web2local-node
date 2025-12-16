/**
 * Thread-safe URL queue for parallel crawling with retry support
 */

import { normalizeUrlForCrawl } from './browser.js';

/**
 * Item in the crawl queue
 */
export interface QueueItem {
    /** URL to crawl */
    url: string;
    /** Depth from the initial URL (0 = initial URL) */
    depth: number;
    /** Number of times this URL has been retried */
    retries: number;
}

/**
 * Options for the crawl queue
 */
export interface CrawlQueueOptions {
    /** Maximum number of retries for failed pages (default: 2) */
    maxRetries: number;
    /** Maximum number of pages to visit (default: 100) */
    maxPages: number;
    /** Maximum link depth to follow (default: 5) */
    maxDepth: number;
}

/**
 * Statistics from the crawl queue
 */
export interface CrawlQueueStats {
    /** Number of pages successfully visited */
    pagesVisited: number;
    /** Number of pages skipped (duplicates, max depth, etc.) */
    pagesSkipped: number;
    /** Total number of links discovered */
    linksDiscovered: number;
    /** Whether max depth was reached */
    maxDepthReached: boolean;
    /** Whether max pages was reached */
    maxPagesReached: boolean;
}

/**
 * Thread-safe queue for managing URLs to crawl.
 *
 * Supports:
 * - Deduplication of URLs
 * - Retry of failed pages
 * - Tracking of in-progress items
 * - Statistics collection
 *
 * Note: While JavaScript is single-threaded, this class is designed to work
 * correctly with concurrent async operations (multiple workers awaiting different
 * promises). The critical operations (take, add, complete, retry) are synchronous
 * and don't yield to the event loop mid-operation.
 */
export class CrawlQueue {
    private queue: QueueItem[] = [];
    private visitedUrls = new Set<string>();
    private inProgress = new Map<string, QueueItem>();
    private completedCount = 0;
    private skippedCount = 0;
    private linksDiscovered = 0;
    private _maxDepthReached = false;
    private _maxPagesReached = false;

    constructor(private options: CrawlQueueOptions) {}

    /**
     * Atomically take the next item from the queue.
     *
     * @returns The next queue item, or null if the queue is empty or max pages reached
     */
    take(): QueueItem | null {
        // Check if we've hit the max pages limit
        // Include inProgress items to prevent overreach when multiple workers take() simultaneously
        if (
            this.completedCount + this.inProgress.size >=
            this.options.maxPages
        ) {
            this._maxPagesReached = true;
            return null;
        }

        // Get next item from queue
        const item = this.queue.shift();
        if (!item) {
            return null;
        }

        // Mark as in-progress
        const normalizedUrl = normalizeUrlForCrawl(item.url);
        this.inProgress.set(normalizedUrl, item);

        return item;
    }

    /**
     * Add a URL to the queue if not already visited or queued.
     *
     * @param url - The URL to add to the queue
     * @param depth - The link depth (distance from initial URL)
     * @returns True if the URL was added, false if skipped (already visited, queued, or exceeds depth limit)
     */
    add(url: string, depth: number): boolean {
        const normalizedUrl = normalizeUrlForCrawl(url);

        // Check if already visited or in progress
        if (this.visitedUrls.has(normalizedUrl)) {
            return false;
        }

        // Check if already in queue
        if (
            this.queue.some(
                (item) => normalizeUrlForCrawl(item.url) === normalizedUrl,
            )
        ) {
            return false;
        }

        // Check if in progress
        if (this.inProgress.has(normalizedUrl)) {
            return false;
        }

        // Check depth limit
        if (depth > this.options.maxDepth) {
            this._maxDepthReached = true;
            this.skippedCount++;
            return false;
        }

        // Track link discovery
        this.linksDiscovered++;

        // Add to queue
        this.queue.push({
            url,
            depth,
            retries: 0,
        });

        return true;
    }

    /**
     * Mark a URL as completed (successfully processed).
     *
     * @param url - The URL to mark as completed
     */
    complete(url: string): void {
        const normalizedUrl = normalizeUrlForCrawl(url);

        // Remove from in-progress
        this.inProgress.delete(normalizedUrl);

        // Mark as visited
        this.visitedUrls.add(normalizedUrl);

        // Increment completed count
        this.completedCount++;
    }

    /**
     * Re-queue a failed URL for retry.
     *
     * @param item - The queue item to retry
     * @returns True if the URL was re-queued, false if max retries exceeded
     */
    retry(item: QueueItem): boolean {
        const normalizedUrl = normalizeUrlForCrawl(item.url);

        // Remove from in-progress
        this.inProgress.delete(normalizedUrl);

        // Check if max retries exceeded
        if (item.retries >= this.options.maxRetries) {
            // Mark as visited (failed) to prevent infinite loops
            this.visitedUrls.add(normalizedUrl);
            this.skippedCount++;
            return false;
        }

        // Re-queue with incremented retry count
        this.queue.push({
            url: item.url,
            depth: item.depth,
            retries: item.retries + 1,
        });

        return true;
    }

    /**
     * Check if all work is done.
     *
     * @returns True if the queue is empty AND no items are in progress, or if max pages is reached
     */
    isDone(): boolean {
        // If max pages reached, we're done regardless of queue state
        if (this.completedCount >= this.options.maxPages) {
            this._maxPagesReached = true;
            return true;
        }

        return this.queue.length === 0 && this.inProgress.size === 0;
    }

    /**
     * Get the current queue length (not including in-progress items).
     */
    get length(): number {
        return this.queue.length;
    }

    /**
     * Get the number of items currently being processed.
     */
    get inProgressCount(): number {
        return this.inProgress.size;
    }

    /**
     * Get current statistics.
     *
     * @returns Statistics about the crawl queue state
     */
    getStats(): CrawlQueueStats {
        return {
            pagesVisited: this.completedCount,
            pagesSkipped: this.skippedCount,
            linksDiscovered: this.linksDiscovered,
            maxDepthReached: this._maxDepthReached,
            maxPagesReached: this._maxPagesReached,
        };
    }

    /**
     * Get a snapshot of current queue state for progress reporting.
     *
     * @returns Current queue state with counts of queued, in-progress, and completed items
     */
    getSnapshot(): {
        queued: number;
        inProgress: number;
        pagesCompleted: number;
    } {
        return {
            queued: this.queue.length,
            inProgress: this.inProgress.size,
            pagesCompleted: this.completedCount,
        };
    }

    /**
     * Check if a URL has been visited.
     *
     * @param url - The URL to check
     * @returns True if the URL has been visited
     */
    hasVisited(url: string): boolean {
        return this.visitedUrls.has(normalizeUrlForCrawl(url));
    }

    /**
     * Check if the max pages limit has been reached.
     *
     * Workers should use this to exit early when take() returns null.
     *
     * @returns True if the maximum page limit has been reached
     */
    isMaxPagesReached(): boolean {
        return this.completedCount >= this.options.maxPages;
    }

    /**
     * Manually mark a URL as visited without processing.
     *
     * Useful for handling redirects or marking URLs that should not be crawled.
     *
     * @param url - The URL to mark as visited
     */
    markVisited(url: string): void {
        this.visitedUrls.add(normalizeUrlForCrawl(url));
    }

    /**
     * Initialize completed count for resume scenarios.
     *
     * Call this before processing begins to account for already-completed pages.
     * This ensures the maxPages limit accounts for prior work.
     *
     * @param count - The number of pages already completed in a previous session
     */
    initializeCompletedCount(count: number): void {
        this.completedCount = count;
    }
}
