/**
 * Smart waiting functionality for page settling
 *
 * Combines multiple wait phases into a single intelligent wait that:
 * 1. Waits for initial network idle
 * 2. Auto-scrolls to trigger lazy loading
 * 3. Waits for network to settle after scrolling
 */

import type { Page } from 'playwright';

/**
 * Options for smart page waiting
 */
export interface SmartWaitOptions {
    /** Network idle wait timeout in ms (default: 5000) */
    networkIdleTimeout?: number;
    /** Consider idle after this many ms without requests (default: 1000) */
    networkIdleTime?: number;
    /** Delay between scroll steps in ms (default: 50) */
    scrollDelay?: number;
    /** Additional settle time after scrolling in ms (default: 1000) */
    pageSettleTime?: number;
    /** Enable auto-scroll to trigger lazy loading (default: true) */
    autoScroll?: boolean;
    /** Scroll step in pixels (default: 500) */
    scrollStep?: number;
    /** Maximum scroll attempts (default: 30) */
    maxScrolls?: number;
}

/**
 * Default wait options
 */
const DEFAULT_WAIT_OPTIONS: Required<SmartWaitOptions> = {
    networkIdleTimeout: 5000,
    networkIdleTime: 1000,
    scrollDelay: 50,
    pageSettleTime: 1000,
    autoScroll: true,
    scrollStep: 500,
    maxScrolls: 30,
};

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Auto-scroll the page to trigger lazy loading.
 * This is a faster version optimized for parallel crawling.
 */
async function fastAutoScroll(
    page: Page,
    options: {
        step: number;
        delay: number;
        maxScrolls: number;
    },
): Promise<void> {
    const { step, delay, maxScrolls } = options;

    await page.evaluate(
        async ({
            step,
            delay,
            maxScrolls,
        }: {
            step: number;
            delay: number;
            maxScrolls: number;
        }) => {
            await new Promise<void>((resolve) => {
                let scrollCount = 0;
                let lastScrollHeight = 0;
                let stableCount = 0;

                const scroll = () => {
                    const scrollHeight = document.documentElement.scrollHeight;
                    const currentScroll = window.scrollY + window.innerHeight;

                    // Check if we've reached the bottom or max scrolls
                    if (
                        currentScroll >= scrollHeight - 10 ||
                        scrollCount >= maxScrolls
                    ) {
                        // Scroll back to top
                        window.scrollTo(0, 0);
                        resolve();
                        return;
                    }

                    // Check if page height hasn't changed (no more lazy content)
                    if (scrollHeight === lastScrollHeight) {
                        stableCount++;
                        // If page hasn't grown after 3 scrolls, we're done with lazy content
                        if (stableCount >= 3) {
                            window.scrollTo(0, 0);
                            resolve();
                            return;
                        }
                    } else {
                        stableCount = 0;
                    }

                    lastScrollHeight = scrollHeight;
                    window.scrollBy(0, step);
                    scrollCount++;

                    setTimeout(scroll, delay);
                };

                scroll();
            });
        },
        { step, delay, maxScrolls },
    );
}

/**
 * Wait for network to become idle with a timeout.
 * Non-blocking - will continue after timeout even if not fully idle.
 */
async function waitForNetworkIdleWithTimeout(
    page: Page,
    timeout: number,
): Promise<void> {
    try {
        await page.waitForLoadState('networkidle', { timeout });
    } catch {
        // Timeout is not critical, continue anyway
    }
}

/**
 * Combined intelligent wait for page settling.
 *
 * This function combines multiple wait phases into a single efficient wait:
 * 1. Initial network idle wait
 * 2. Auto-scroll (if enabled) to trigger lazy loading
 * 3. Final settle time
 *
 * This is more efficient than the original sequential waits because:
 * - Uses shorter timeouts
 * - Exits early when page is clearly stable
 * - Optimized scroll delays
 *
 * @param page - Playwright page instance
 * @param options - Wait configuration options
 */
export async function smartWaitForPage(
    page: Page,
    options: SmartWaitOptions = {},
): Promise<void> {
    const opts = { ...DEFAULT_WAIT_OPTIONS, ...options };

    // Phase 1: Wait for initial network idle
    await waitForNetworkIdleWithTimeout(page, opts.networkIdleTimeout);

    // Phase 2: Auto-scroll if enabled (triggers lazy loading)
    if (opts.autoScroll) {
        await fastAutoScroll(page, {
            step: opts.scrollStep,
            delay: opts.scrollDelay,
            maxScrolls: opts.maxScrolls,
        });
    }

    // Phase 3: Wait for network to settle after scrolling
    // Use a shorter timeout for this phase
    const postScrollTimeout = Math.min(opts.networkIdleTimeout / 2, 3000);
    await waitForNetworkIdleWithTimeout(page, postScrollTimeout);

    // Phase 4: Brief settle time for any trailing requests
    await sleep(opts.pageSettleTime);
}

/**
 * Wait for page to be ready for interaction.
 * This is a lighter-weight wait for non-first pages.
 */
export async function quickWaitForPage(
    page: Page,
    options: Pick<
        SmartWaitOptions,
        'networkIdleTimeout' | 'networkIdleTime'
    > = {},
): Promise<void> {
    const timeout = options.networkIdleTimeout ?? 3000;
    const idleTime = options.networkIdleTime ?? 500;

    await waitForNetworkIdleWithTimeout(page, timeout);
    await sleep(idleTime);
}
