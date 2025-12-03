/**
 * Static asset downloading and capturing
 */

import type { Page, Response } from "playwright";
import { mkdir, writeFile } from "fs/promises";
import { dirname, join, extname } from "path";
import { createHash } from "crypto";
import type { CapturedAsset, ResourceType } from "./types.js";

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
}

const DEFAULT_OPTIONS: StaticCaptureOptions = {
  outputDir: "./static",
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
  "document",
  "stylesheet",
  "script",
  "image",
  "font",
  "media",
]);

/**
 * Map resource type to option
 */
function shouldCaptureResourceType(
  type: ResourceType,
  options: StaticCaptureOptions
): boolean {
  switch (type) {
    case "document":
      return options.captureHtml;
    case "stylesheet":
      return options.captureCss;
    case "script":
      return options.captureJs;
    case "image":
      return options.captureImages;
    case "font":
      return options.captureFonts;
    case "media":
      return options.captureMedia;
    default:
      return false;
  }
}

/**
 * Generate a local path for a URL
 */
function urlToLocalPath(url: string, baseUrl: string): string {
  const urlObj = new URL(url);
  const baseUrlObj = new URL(baseUrl);

  // For same-origin resources, use the pathname
  if (urlObj.origin === baseUrlObj.origin) {
    let path = urlObj.pathname;

    // Handle root path
    if (path === "/" || path === "") {
      path = "/index.html";
    }

    // Add .html extension if no extension and looks like a page
    if (!extname(path) && !path.includes(".")) {
      path = path + "/index.html";
    }

    // Remove leading slash
    return path.replace(/^\//, "");
  }

  // For cross-origin resources, use a hash-based filename in _external/
  const hash = createHash("md5").update(url).digest("hex").slice(0, 12);
  const ext = extname(urlObj.pathname) || ".bin";
  const filename = urlObj.pathname.split("/").pop() || "file";
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");

  return `_external/${hash}_${safeName}${ext ? "" : ext}`;
}

/**
 * Get MIME type from response or guess from extension
 */
function getContentType(response: Response, url: string): string {
  const contentType = response.headers()["content-type"];
  if (contentType) {
    return contentType.split(";")[0].trim();
  }

  // Guess from extension
  const ext = extname(new URL(url).pathname).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".html": "text/html",
    ".htm": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".eot": "application/vnd.ms-fontobject",
    ".otf": "font/otf",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
  };

  return mimeTypes[ext] || "application/octet-stream";
}

/**
 * Static Asset Capturer - downloads and saves static assets
 */
export class StaticCapturer {
  private assets: CapturedAsset[] = [];
  private downloadedUrls: Set<string> = new Set();
  private options: StaticCaptureOptions;
  private entrypointUrl: string | null = null;

  constructor(options: Partial<StaticCaptureOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Attach capturer to a page
   */
  attach(page: Page, entrypointUrl: string): void {
    this.entrypointUrl = entrypointUrl;

    page.on("response", async (response) => {
      const request = response.request();
      const resourceType = request.resourceType() as ResourceType;

      // Check if this is a static resource type we want
      if (!STATIC_RESOURCE_TYPES.has(resourceType)) {
        return;
      }

      if (!shouldCaptureResourceType(resourceType, this.options)) {
        return;
      }

      const url = request.url();

      // Skip data URLs
      if (url.startsWith("data:")) {
        return;
      }

      // Skip if already downloaded
      if (this.downloadedUrls.has(url)) {
        return;
      }

      // Only capture successful responses
      if (!response.ok()) {
        return;
      }

      try {
        await this.captureAsset(response, url, resourceType);
      } catch (error) {
        if (this.options.verbose) {
          console.error(`  Error capturing asset ${url}: ${error}`);
        }
      }
    });
  }

  /**
   * Capture and save a static asset
   */
  private async captureAsset(
    response: Response,
    url: string,
    _resourceType: ResourceType
  ): Promise<void> {
    // Mark as downloaded early to prevent duplicates
    this.downloadedUrls.add(url);

    // Check content length
    const contentLength = parseInt(response.headers()["content-length"] || "0", 10);
    if (contentLength > this.options.maxFileSize) {
      if (this.options.verbose) {
        console.log(`  Skipping large file: ${url} (${contentLength} bytes)`);
      }
      return;
    }

    // Get the body
    let body: Buffer;
    try {
      body = await response.body();
    } catch {
      // Response body may not be available (e.g., redirects)
      return;
    }

    // Double-check size
    if (body.length > this.options.maxFileSize) {
      return;
    }

    // Generate local path
    const localPath = urlToLocalPath(url, this.entrypointUrl || url);
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

    if (this.options.verbose) {
      console.log(`  Saved: ${localPath} (${body.length} bytes)`);
    }
  }

  /**
   * Manually capture the main HTML document
   */
  async captureDocument(page: Page): Promise<CapturedAsset | null> {
    const url = page.url();
    
    // Skip if already captured
    if (this.downloadedUrls.has(url)) {
      return this.assets.find(a => a.url === url) || null;
    }

    const html = await page.content();
    const body = Buffer.from(html, "utf-8");

    const localPath = urlToLocalPath(url, this.entrypointUrl || url);
    const fullPath = join(this.options.outputDir, localPath);

    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, body);

    const asset: CapturedAsset = {
      url,
      localPath,
      contentType: "text/html",
      size: body.length,
      isEntrypoint: true,
    };

    this.assets.push(asset);
    this.downloadedUrls.add(url);
    this.options.onCapture?.(asset);

    return asset;
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
      const type = asset.contentType.split("/")[0] || "other";
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
    this.entrypointUrl = null;
  }
}

/**
 * Rewrite URLs in HTML content to point to local files
 */
export function rewriteHtmlUrls(
  html: string,
  assets: CapturedAsset[],
  baseUrl: string
): string {
  let result = html;

  // Build a map of original URLs to local paths
  const urlMap = new Map<string, string>();
  for (const asset of assets) {
    urlMap.set(asset.url, "/" + asset.localPath);
  }

  // Rewrite src and href attributes
  const baseUrlObj = new URL(baseUrl);

  for (const [originalUrl, localPath] of urlMap) {
    const urlObj = new URL(originalUrl);

    // Replace full URLs
    result = result.replace(new RegExp(escapeRegex(originalUrl), "g"), localPath);

    // Replace origin-relative URLs
    if (urlObj.origin === baseUrlObj.origin) {
      const relativePath = urlObj.pathname + urlObj.search;
      result = result.replace(
        new RegExp(`(src|href)=["']${escapeRegex(relativePath)}["']`, "g"),
        `$1="${localPath}"`
      );
    }
  }

  return result;
}

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
