/**
 * Static asset downloading and capturing
 *
 * Uses page.on('response') to capture static assets as they load.
 */

import type { Page, Response } from 'playwright';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, join, extname } from 'path';
import { createHash } from 'crypto';
import type { CapturedAsset, ResourceType } from './types.js';

/**
 * Options for static asset capture
 */
export interface StaticCaptureOptions {
    /** Output directory for static assets */
    outputDir: string;
    /** Maximum file size to download (bytes) */
    maxFileSize: number;
    /** Whether to capture HTML documents */
    captureHtml: boolean;
    /** Whether to capture CSS */
    captureCss: boolean;
    /** Whether to capture JavaScript */
    captureJs: boolean;
    /** Whether to capture images */
    captureImages: boolean;
    /** Whether to capture fonts */
    captureFonts: boolean;
    /** Whether to capture other media (video, audio) */
    captureMedia: boolean;
    /** Verbose logging */
    verbose: boolean;
    /** Progress callback */
    onCapture?: (asset: CapturedAsset) => void;
    /** Verbose log callback - handles spinner-safe logging */
    onVerbose?: (message: string) => void;
}

const DEFAULT_OPTIONS: StaticCaptureOptions = {
    outputDir: './static',
    maxFileSize: 50 * 1024 * 1024, // 50MB
    captureHtml: true,
    captureCss: true,
    captureJs: true,
    captureImages: true,
    captureFonts: true,
    captureMedia: true,
    verbose: false,
};

/**
 * Resource types that are considered static assets
 */
const STATIC_RESOURCE_TYPES: Set<ResourceType> = new Set([
    'document',
    'stylesheet',
    'script',
    'image',
    'font',
    'media',
]);

/**
 * Map resource type to option
 */
function shouldCaptureResourceType(
    type: ResourceType,
    options: StaticCaptureOptions,
): boolean {
    switch (type) {
        case 'document':
            return options.captureHtml;
        case 'stylesheet':
            return options.captureCss;
        case 'script':
            return options.captureJs;
        case 'image':
            return options.captureImages;
        case 'font':
            return options.captureFonts;
        case 'media':
            return options.captureMedia;
        default:
            return false;
    }
}

/**
 * Extract the base domain from a host (removes www. prefix)
 */
function getBaseDomain(host: string): string {
    return host.replace(/^www\./, '');
}

/**
 * Check if a URL is same-site (same domain or CDN subdomain)
 */
function isSameSite(urlObj: URL, baseUrlObj: URL): boolean {
    // Exact origin match
    if (urlObj.origin === baseUrlObj.origin) {
        return true;
    }

    const baseDomain = getBaseDomain(baseUrlObj.host);
    const urlHost = urlObj.host;

    // Check for common subdomains of the same domain
    // e.g., cdn.bob.com, api.bob.com, www.bob.com
    if (
        urlHost === baseDomain ||
        urlHost === `www.${baseDomain}` ||
        urlHost === `cdn.${baseDomain}` ||
        urlHost === `static.${baseDomain}` ||
        urlHost === `assets.${baseDomain}` ||
        urlHost === `images.${baseDomain}` ||
        urlHost === `media.${baseDomain}`
    ) {
        return true;
    }

    return false;
}

/**
 * Generate a local path for a URL
 */
function urlToLocalPath(url: string, baseUrl: string): string {
    const urlObj = new URL(url);
    const baseUrlObj = new URL(baseUrl);
    const baseDomain = getBaseDomain(baseUrlObj.host);

    // For same-origin resources, use the pathname directly
    if (urlObj.origin === baseUrlObj.origin) {
        let path = urlObj.pathname;

        // Handle root path
        if (path === '/' || path === '') {
            path = '/index.html';
        }

        // Add .html extension if no extension and looks like a page
        if (!extname(path) && !path.includes('.')) {
            path = path + '/index.html';
        }

        // Remove leading slash
        return path.replace(/^\//, '');
    }

    // For CDN/static subdomains of the same domain, save to _cdn/ directory
    const urlHost = urlObj.host;
    if (
        urlHost === `cdn.${baseDomain}` ||
        urlHost === `static.${baseDomain}` ||
        urlHost === `assets.${baseDomain}` ||
        urlHost === `images.${baseDomain}` ||
        urlHost === `media.${baseDomain}`
    ) {
        // Extract subdomain prefix (cdn, static, etc.)
        const subdomain = urlHost.split('.')[0];
        let path = urlObj.pathname;

        // Remove leading slash and prefix with _subdomain/
        return `_${subdomain}${path}`;
    }

    // For cross-origin resources, use a hash-based filename in _external/
    const hash = createHash('md5').update(url).digest('hex').slice(0, 12);
    const ext = extname(urlObj.pathname) || '.bin';
    const filename = urlObj.pathname.split('/').pop() || 'file';
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');

    return `_external/${hash}_${safeName}${ext ? '' : ext}`;
}

/**
 * Get MIME type from response or guess from extension
 */
function getContentType(response: Response, url: string): string {
    const contentType = response.headers()['content-type'];
    if (contentType) {
        return contentType.split(';')[0].trim();
    }

    // Guess from extension
    const ext = extname(new URL(url).pathname).toLowerCase();
    const mimeTypes: Record<string, string> = {
        '.html': 'text/html',
        '.htm': 'text/html',
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.mjs': 'application/javascript',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.webp': 'image/webp',
        '.ico': 'image/x-icon',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
        '.ttf': 'font/ttf',
        '.eot': 'application/vnd.ms-fontobject',
        '.otf': 'font/otf',
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.ogg': 'audio/ogg',
    };

    return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * Static Asset Capturer - captures static assets via response events
 */
export class StaticCapturer {
    private assets: CapturedAsset[] = [];
    private downloadedUrls: Set<string> = new Set();
    private pendingCaptures: Map<string, Promise<void>> = new Map();
    private options: StaticCaptureOptions;
    private entrypointUrl: string | null = null;
    private baseOrigin: string | null = null;

    constructor(options: Partial<StaticCaptureOptions> = {}) {
        this.options = { ...DEFAULT_OPTIONS, ...options };
    }

    /**
     * Update the base URL after redirects.
     * This should be called after navigation completes to handle redirect scenarios.
     * For example, if user navigates to www.bob.com but gets redirected to www.robert.com,
     * call this with the final URL so assets from www.robert.com are saved with correct paths.
     */
    updateBaseUrl(finalUrl: string): void {
        const oldOrigin = this.baseOrigin;
        this.baseOrigin = new URL(finalUrl).origin;
        if (oldOrigin !== this.baseOrigin) {
            this.log(
                `[StaticCapturer] Base origin updated: ${oldOrigin} -> ${this.baseOrigin}`,
            );
        }
    }

    /**
     * Get the current base origin used for path resolution
     */
    getBaseOrigin(): string | null {
        return this.baseOrigin;
    }

    /**
     * Log a verbose message - uses onVerbose callback if provided, otherwise console.log
     */
    private log(message: string): void {
        if (!this.options.verbose) return;

        if (this.options.onVerbose) {
            this.options.onVerbose(message);
        } else {
            console.log(message);
        }
    }

    /**
     * Attach capturer to a page using response events
     */
    attach(page: Page, entrypointUrl: string): void {
        this.entrypointUrl = entrypointUrl;
        this.baseOrigin = new URL(entrypointUrl).origin;

        this.log(
            `[StaticCapturer] Attaching to page, entrypoint: ${entrypointUrl}`,
        );
        this.log(`[StaticCapturer] Initial base origin: ${this.baseOrigin}`);
        this.log(
            `[StaticCapturer] Options: captureHtml=${this.options.captureHtml}, captureCss=${this.options.captureCss}, captureJs=${this.options.captureJs}, captureImages=${this.options.captureImages}`,
        );

        // Listen for main frame navigation to detect redirects early
        // This updates the base origin as soon as the browser follows a redirect
        page.on('framenavigated', (frame) => {
            if (frame === page.mainFrame()) {
                const newUrl = frame.url();
                const newOrigin = new URL(newUrl).origin;
                if (newOrigin !== this.baseOrigin) {
                    this.log(
                        `[StaticCapturer] Frame navigated, updating base origin: ${this.baseOrigin} -> ${newOrigin}`,
                    );
                    this.baseOrigin = newOrigin;
                }
            }
        });

        page.on('response', async (response) => {
            const request = response.request();
            const resourceType = request.resourceType() as ResourceType;
            const url = request.url();

            // Skip data URLs
            if (url.startsWith('data:')) {
                return;
            }

            // Check if this is a static resource type we want
            if (!STATIC_RESOURCE_TYPES.has(resourceType)) {
                return;
            }

            if (!shouldCaptureResourceType(resourceType, this.options)) {
                return;
            }

            // Skip the main document - we'll capture it later via captureDocument()
            // to get the final rendered HTML (important for SPAs)
            if (resourceType === 'document' && request.isNavigationRequest()) {
                this.log(
                    `[Static] Skipping navigation document (will capture rendered version later): ${url}`,
                );
                return;
            }

            // Skip if already downloaded
            if (this.downloadedUrls.has(url)) {
                return;
            }

            // Only capture successful responses
            if (!response.ok()) {
                this.log(
                    `[Static] Skipping non-ok response: ${response.status()} ${url}`,
                );
                return;
            }

            const shortUrl =
                url.length > 80 ? url.substring(0, 80) + '...' : url;
            this.log(`[Static] Capturing ${resourceType}: ${shortUrl}`);

            // Mark as downloading to prevent duplicates
            this.downloadedUrls.add(url);

            // Capture asynchronously
            const capturePromise = this.captureAsset(
                response,
                url,
                resourceType,
            );
            this.pendingCaptures.set(url, capturePromise);
            capturePromise.finally(() => this.pendingCaptures.delete(url));
        });

        this.log(`[StaticCapturer] Response handler attached`);
    }

    /**
     * Capture and save a static asset
     */
    private async captureAsset(
        response: Response,
        url: string,
        _resourceType: ResourceType,
    ): Promise<void> {
        try {
            // Check content length header first
            const contentLength = parseInt(
                response.headers()['content-length'] || '0',
                10,
            );
            if (contentLength > this.options.maxFileSize) {
                this.log(
                    `[Static] Skipping large file (header): ${url} (${contentLength} bytes)`,
                );
                return;
            }

            // Get the body
            let body: Buffer;
            try {
                body = await response.body();
            } catch (error) {
                // Response body may not be available (e.g., redirects, cached responses)
                this.log(`[Static] Could not get body for ${url}: ${error}`);
                return;
            }

            // Double-check size
            if (body.length > this.options.maxFileSize) {
                this.log(
                    `[Static] Skipping large file (body): ${url} (${body.length} bytes)`,
                );
                return;
            }

            // Generate local path using the base origin (which may have been updated after redirects)
            const baseUrl = this.baseOrigin || this.entrypointUrl || url;
            const localPath = urlToLocalPath(url, baseUrl);
            const fullPath = join(this.options.outputDir, localPath);

            // Create directory and write file
            await mkdir(dirname(fullPath), { recursive: true });
            await writeFile(fullPath, body);

            const contentType = getContentType(response, url);
            const isEntrypoint = url === this.entrypointUrl;

            const asset: CapturedAsset = {
                url,
                localPath,
                contentType,
                size: body.length,
                isEntrypoint,
            };

            this.assets.push(asset);
            this.options.onCapture?.(asset);

            this.log(`[Static] Saved: ${localPath} (${body.length} bytes)`);
        } catch (error) {
            this.log(`[Static] Error capturing ${url}: ${error}`);
        }
    }

    /**
     * Manually capture the main HTML document (final rendered state)
     */
    async captureDocument(page: Page): Promise<CapturedAsset | null> {
        const url = page.url();

        // Skip if already captured
        if (this.downloadedUrls.has(url)) {
            return this.assets.find((a) => a.url === url) || null;
        }

        this.log(`[Static] Capturing document: ${url}`);

        let html = await page.content();

        // Rewrite URLs in the HTML to point to local paths
        const baseUrl = this.baseOrigin || this.entrypointUrl || url;
        html = this.rewriteDocumentUrls(html, baseUrl);

        const body = Buffer.from(html, 'utf-8');

        // Use the base origin (which should have been updated after redirects) for path resolution
        const localPath = urlToLocalPath(url, baseUrl);
        const fullPath = join(this.options.outputDir, localPath);

        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, body);

        const asset: CapturedAsset = {
            url,
            localPath,
            contentType: 'text/html',
            size: body.length,
            isEntrypoint: true,
        };

        this.assets.push(asset);
        this.downloadedUrls.add(url);
        this.options.onCapture?.(asset);

        this.log(
            `[Static] Saved document: ${localPath} (${body.length} bytes)`,
        );

        return asset;
    }

    /**
     * Rewrite URLs in HTML content to use local paths.
     * This converts absolute URLs matching the site's origin to relative paths,
     * and rewrites CDN subdomain URLs to use the _cdn/ prefix.
     */
    private rewriteDocumentUrls(html: string, baseUrl: string): string {
        const baseUrlObj = new URL(baseUrl);
        const baseDomain = getBaseDomain(baseUrlObj.host);
        const origin = baseUrlObj.origin;

        this.log(
            `[Static] Rewriting URLs for origin: ${origin}, base domain: ${baseDomain}`,
        );

        let result = html;
        let rewriteCount = 0;

        // Rewrite full URLs matching the base origin to relative paths
        // e.g., https://www.bob.com/foo/bar -> /foo/bar
        const originPattern = new RegExp(
            `https?://(www\\.)?${escapeRegex(baseDomain)}(/[^"'\\s<>]*)`,
            'g',
        );
        result = result.replace(originPattern, (match, _www, path) => {
            rewriteCount++;
            return path || '/';
        });

        // Rewrite CDN subdomain URLs to use _cdn/ prefix
        // e.g., https://cdn.bob.com/public/images/foo.jpg -> /_cdn/public/images/foo.jpg
        const cdnSubdomains = ['cdn', 'static', 'assets', 'images', 'media'];
        for (const subdomain of cdnSubdomains) {
            const cdnPattern = new RegExp(
                `https?://${subdomain}\\.${escapeRegex(baseDomain)}(/[^"'\\s<>]*)`,
                'g',
            );
            result = result.replace(cdnPattern, (match, path) => {
                rewriteCount++;
                return `/_${subdomain}${path || '/'}`;
            });
        }

        this.log(`[Static] Rewrote ${rewriteCount} URLs in document`);

        return result;
    }

    /**
     * Wait for all pending captures to complete
     */
    async flush(): Promise<void> {
        const pending = Array.from(this.pendingCaptures.values());
        if (pending.length > 0) {
            this.log(
                `[StaticCapturer] Waiting for ${pending.length} pending captures...`,
            );
            await Promise.all(pending);
        }
    }

    /**
     * Get all captured assets
     */
    getAssets(): CapturedAsset[] {
        return this.assets;
    }

    /**
     * Get the entrypoint asset (main HTML)
     */
    getEntrypoint(): CapturedAsset | undefined {
        return this.assets.find((a) => a.isEntrypoint);
    }

    /**
     * Get capture statistics
     */
    getStats(): {
        totalAssets: number;
        totalBytes: number;
        byType: Record<string, { count: number; bytes: number }>;
    } {
        const byType: Record<string, { count: number; bytes: number }> = {};

        for (const asset of this.assets) {
            const type = asset.contentType.split('/')[0] || 'other';
            if (!byType[type]) {
                byType[type] = { count: 0, bytes: 0 };
            }
            byType[type].count++;
            byType[type].bytes += asset.size;
        }

        return {
            totalAssets: this.assets.length,
            totalBytes: this.assets.reduce((sum, a) => sum + a.size, 0),
            byType,
        };
    }

    /**
     * Clear captured assets
     */
    clear(): void {
        this.assets = [];
        this.downloadedUrls.clear();
        this.pendingCaptures.clear();
        this.entrypointUrl = null;
        this.baseOrigin = null;
    }
}

/**
 * Rewrite URLs in HTML content to point to local files
 */
export function rewriteHtmlUrls(
    html: string,
    assets: CapturedAsset[],
    baseUrl: string,
): string {
    let result = html;

    // Build a map of original URLs to local paths
    const urlMap = new Map<string, string>();
    for (const asset of assets) {
        urlMap.set(asset.url, '/' + asset.localPath);
    }

    // Rewrite src and href attributes
    const baseUrlObj = new URL(baseUrl);

    for (const [originalUrl, localPath] of urlMap) {
        const urlObj = new URL(originalUrl);

        // Replace full URLs
        result = result.replace(
            new RegExp(escapeRegex(originalUrl), 'g'),
            localPath,
        );

        // Replace origin-relative URLs
        if (urlObj.origin === baseUrlObj.origin) {
            const relativePath = urlObj.pathname + urlObj.search;
            result = result.replace(
                new RegExp(
                    `(src|href)=["']${escapeRegex(relativePath)}["']`,
                    'g',
                ),
                `$1="${localPath}"`,
            );
        }
    }

    return result;
}

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
