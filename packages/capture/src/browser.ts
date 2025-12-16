/**
 * Browser management for Playwright-based capture
 */

import { chromium, Browser, BrowserContext, Page } from 'playwright';

/**
 * Options for configuring browser behavior.
 */
export interface BrowserOptions {
    /** Whether to run the browser in headless mode */
    headless: boolean;
    /** User agent string to use for requests */
    userAgent?: string;
    /** Viewport size for the browser window */
    viewport?: { width: number; height: number };
    /** Extra HTTP headers to send with every request */
    extraHeaders?: Record<string, string>;
}

const DEFAULT_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };

/**
 * Manages browser lifecycle for capture operations.
 *
 * Wraps Playwright's browser management to provide a consistent interface
 * for launching browsers, creating pages, and cleaning up resources.
 */
export class BrowserManager {
    private browser: Browser | null = null;
    private context: BrowserContext | null = null;
    private options: BrowserOptions;

    /**
     * Create a new browser manager.
     *
     * @param options - Browser configuration options
     */
    constructor(options: Partial<BrowserOptions> = {}) {
        this.options = {
            headless: options.headless ?? true,
            userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
            viewport: options.viewport ?? DEFAULT_VIEWPORT,
            extraHeaders: options.extraHeaders,
        };
    }

    /**
     * Launch the browser and create a context.
     *
     * If the browser is already launched, this method returns immediately.
     *
     * @throws Error if the browser fails to launch
     */
    async launch(): Promise<void> {
        if (this.browser) {
            return;
        }

        this.browser = await chromium.launch({
            headless: this.options.headless,
        });

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
     * Create a new page in the browser context.
     *
     * Automatically launches the browser if not already running.
     *
     * @returns A new Playwright page instance
     * @throws Error if page creation fails
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
     * Get the browser context.
     *
     * @returns The current browser context, or null if the browser hasn't been launched
     */
    getContext(): BrowserContext | null {
        return this.context;
    }
}

/**
 * Auto-scroll the page to trigger lazy loading.
 *
 * Scrolls down the page in increments, waiting for lazy-loaded content to load.
 * Automatically scrolls back to the top when finished.
 *
 * @param page - The Playwright page to scroll
 * @param options - Scroll configuration options including step (scroll step in pixels, default: 500), delay (delay between scrolls in ms, default: 100), and maxScrolls (maximum scroll attempts, default: 50)
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
 * Wait for network to be idle (no pending requests).
 *
 * Waits for the Playwright 'networkidle' state, then adds an additional
 * idle time buffer for any trailing requests.
 *
 * @param page - The Playwright page to wait on
 * @param options - Wait configuration options including timeout (maximum wait time in ms, default: 30000) and idleTime (additional idle buffer in ms, default: 500)
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

/**
 * File extensions to skip when crawling (non-page resources)
 */
const SKIP_EXTENSIONS = new Set([
    '.pdf',
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.svg',
    '.webp',
    '.ico',
    '.bmp',
    '.tiff',
    '.mp4',
    '.webm',
    '.ogg',
    '.mp3',
    '.wav',
    '.flac',
    '.aac',
    '.zip',
    '.tar',
    '.gz',
    '.rar',
    '.7z',
    '.exe',
    '.dmg',
    '.pkg',
    '.deb',
    '.rpm',
    '.msi',
    '.doc',
    '.docx',
    '.xls',
    '.xlsx',
    '.ppt',
    '.pptx',
    '.csv',
    '.xml',
    '.json',
    '.txt',
    '.md',
    '.rss',
    '.atom',
]);

/**
 * Normalize a URL for crawl deduplication.
 * Removes hash fragments but preserves query parameters.
 * Removes trailing slashes (except for root path).
 *
 * @param url - URL to normalize
 * @returns Normalized URL string
 */
export function normalizeUrlForCrawl(url: string): string {
    try {
        const parsed = new URL(url);
        // Remove hash fragment
        parsed.hash = '';
        // Remove trailing slash from pathname (except for root)
        if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
            parsed.pathname = parsed.pathname.slice(0, -1);
        }
        return parsed.href;
    } catch {
        return url;
    }
}

/**
 * Check if a URL should be skipped based on its extension
 */
function shouldSkipUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        const pathname = parsed.pathname.toLowerCase();

        // Check for file extensions to skip
        for (const ext of SKIP_EXTENSIONS) {
            if (pathname.endsWith(ext)) {
                return true;
            }
        }

        // Check for non-http(s) protocols
        if (!parsed.protocol.startsWith('http')) {
            return true;
        }

        return false;
    } catch {
        return true; // Skip invalid URLs
    }
}

/**
 * Extract all same-origin links from the current page.
 *
 * Filters out non-page URLs (images, files, mailto, etc.) and normalizes
 * URLs for consistent crawl deduplication.
 *
 * @param page - Playwright page to extract links from
 * @param baseOrigin - Origin to filter links (e.g., "https://example.com")
 * @returns Array of absolute URLs to same-origin pages, sorted alphabetically
 *
 * @example
 * ```typescript
 * const links = await extractPageLinks(page, 'https://example.com');
 * // Returns: ['https://example.com/about', 'https://example.com/contact']
 * ```
 */
export async function extractPageLinks(
    page: Page,
    baseOrigin: string,
): Promise<string[]> {
    const currentUrl = page.url();

    // Extract all href attributes from anchor tags
    const hrefs = await page.evaluate(() => {
        const anchors = document.querySelectorAll('a[href]');
        const hrefs: string[] = [];
        for (const anchor of anchors) {
            const href = anchor.getAttribute('href');
            if (href) {
                hrefs.push(href);
            }
        }
        return hrefs;
    });

    const links: Set<string> = new Set();
    const baseOriginObj = new URL(baseOrigin);

    for (const href of hrefs) {
        // Skip empty hrefs
        if (!href || href.trim() === '') continue;

        // Skip javascript:, mailto:, tel:, data: protocols
        if (
            href.startsWith('javascript:') ||
            href.startsWith('mailto:') ||
            href.startsWith('tel:') ||
            href.startsWith('data:')
        ) {
            continue;
        }

        // Skip hash-only links (same page anchors)
        if (href.startsWith('#')) continue;

        try {
            // Resolve relative URLs using current page URL as base
            const absoluteUrl = new URL(href, currentUrl);

            // Only include same-origin links
            if (absoluteUrl.origin !== baseOriginObj.origin) {
                continue;
            }

            // Skip non-page URLs (files, images, etc.)
            if (shouldSkipUrl(absoluteUrl.href)) {
                continue;
            }

            // Normalize and add to set
            const normalized = normalizeUrlForCrawl(absoluteUrl.href);
            links.add(normalized);
        } catch {
            // Skip invalid URLs
            continue;
        }
    }

    // Return sorted array for deterministic ordering
    return Array.from(links).sort();
}
