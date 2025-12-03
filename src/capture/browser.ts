/**
 * Browser management for Playwright-based capture
 */

import { chromium, Browser, BrowserContext, Page } from 'playwright';

export interface BrowserOptions {
    headless: boolean;
    /** User agent to use */
    userAgent?: string;
    /** Viewport size */
    viewport?: { width: number; height: number };
    /** Extra HTTP headers to send */
    extraHeaders?: Record<string, string>;
}

const DEFAULT_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };

/**
 * Manages browser lifecycle for capture operations
 */
export class BrowserManager {
    private browser: Browser | null = null;
    private context: BrowserContext | null = null;
    private options: BrowserOptions;

    constructor(options: Partial<BrowserOptions> = {}) {
        this.options = {
            headless: options.headless ?? true,
            userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
            viewport: options.viewport ?? DEFAULT_VIEWPORT,
            extraHeaders: options.extraHeaders,
        };
    }

    /**
     * Launch the browser and create a context
     */
    async launch(): Promise<void> {
        if (this.browser) {
            return;
        }

        this.browser = await chromium.launch({
            // Use 'new' headless mode (Chrome's built-in) which doesn't require X11/display
            headless: this.options.headless ? ('new' as const) : false,
        } as Parameters<typeof chromium.launch>[0]);

        this.context = await this.browser.newContext({
            userAgent: this.options.userAgent,
            viewport: this.options.viewport,
            extraHTTPHeaders: this.options.extraHeaders,
            // Accept all content types
            acceptDownloads: false,
            // Ignore HTTPS errors for development sites
            ignoreHTTPSErrors: true,
            // Block service workers to ensure all network events are visible
            // See: https://playwright.dev/docs/network#missing-network-events-and-service-workers
            serviceWorkers: 'block',
        });
    }

    /**
     * Create a new page in the browser context
     */
    async newPage(): Promise<Page> {
        if (!this.context) {
            await this.launch();
        }

        return this.context!.newPage();
    }

    /**
     * Close the browser and clean up resources
     */
    async close(): Promise<void> {
        if (this.context) {
            await this.context.close();
            this.context = null;
        }

        if (this.browser) {
            await this.browser.close();
            this.browser = null;
        }
    }

    /**
     * Get the browser context
     */
    getContext(): BrowserContext | null {
        return this.context;
    }
}

/**
 * Auto-scroll the page to trigger lazy loading
 */
export async function autoScrollPage(
    page: Page,
    options: {
        /** Scroll step in pixels */
        step?: number;
        /** Delay between scrolls in ms */
        delay?: number;
        /** Maximum scroll attempts */
        maxScrolls?: number;
    } = {},
): Promise<void> {
    const { step = 500, delay = 100, maxScrolls = 50 } = options;

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
                        scrollCount++;
                    } else {
                        scrollCount = 0;
                    }

                    lastScrollHeight = scrollHeight;
                    window.scrollBy(0, step);

                    setTimeout(scroll, delay);
                };

                scroll();
            });
        },
        { step, delay, maxScrolls },
    );
}

/**
 * Wait for network to be idle (no pending requests)
 */
export async function waitForNetworkIdle(
    page: Page,
    options: {
        /** Timeout in ms */
        timeout?: number;
        /** Consider idle after this many ms without requests */
        idleTime?: number;
    } = {},
): Promise<void> {
    const { timeout = 30000, idleTime = 500 } = options;

    try {
        await page.waitForLoadState('networkidle', { timeout });
    } catch {
        // Network idle timeout is not critical, continue anyway
    }

    // Additional wait for any trailing requests
    await page.waitForTimeout(idleTime);
}
