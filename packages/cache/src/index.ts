/**
 * Fingerprint caching system for web2local-node.
 *
 * This module provides a multi-layer caching system (memory + disk) for npm package
 * metadata, content fingerprints, source maps, and extraction results. Caching
 * significantly speeds up repeated operations by avoiding redundant network requests
 * and expensive computations.
 *
 * @packageDocumentation
 */

import { createHash } from 'crypto';
import { mkdir, readFile, writeFile, stat, readdir, unlink } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { stripComments, extractDeclarationNames } from '@web2local/ast';

// Cache TTL in milliseconds (7 days)
const DEFAULT_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

/**
 * Cached npm package metadata including available versions and package.json fields.
 */
export interface PackageMetadataCache {
    /** Package name (e.g., "react" or "@scope/package") */
    name: string;
    /** List of all published versions */
    versions: string[];
    /** Version-specific package.json fields for each version */
    versionDetails: Record<
        string,
        {
            main?: string;
            module?: string;
            exports?: Record<string, unknown>;
            types?: string;
            peerDependencies?: Record<string, string>;
            dependencies?: Record<string, string>;
        }
    >;
    /** Distribution tags (e.g., "latest", "next") mapped to versions */
    distTags: Record<string, string>;
    /** Version publish timestamps (version -> timestamp in ms) for smart version ordering */
    versionTimes?: Record<string, number>;
    /** Unix timestamp when this cache entry was fetched */
    fetchedAt: number;
}

/**
 * Cached content fingerprint for a specific package version.
 *
 * Contains multiple hash types to support both exact and fuzzy matching
 * of package content against extracted source code.
 */
export interface ContentFingerprintCache {
    /** Package name (e.g., "react" or "@scope/package") */
    packageName: string;
    /** Semver version string */
    version: string;
    /** Entry point path within the package */
    entryPath: string;
    /** Raw MD5 hash of the file content */
    contentHash: string;
    /** MD5 hash of normalized content (whitespace/comments stripped) */
    normalizedHash: string;
    /** Extracted code signature for fuzzy matching */
    signature: string;
    /** File size in bytes */
    contentLength: number;
    /** Whether this fingerprint is from a minified/production build */
    isMinified?: boolean;
    /** Unix timestamp when this cache entry was fetched */
    fetchedAt: number;
}

/**
 * Cached result of matching extracted content against a package.
 */
export interface MatchResultCache {
    /** Package name */
    packageName: string;
    /** Hash of the extracted source content - used as part of cache key */
    extractedContentHash: string;
    /** The matched version (null if no match found) */
    matchedVersion: string | null;
    /** Similarity score (0-1), 0 if no match */
    similarity: number;
    /** Confidence level (null if no match found) */
    confidence: 'exact' | 'high' | 'medium' | 'low' | null;
    fetchedAt: number;
}

/**
 * Cached source map data fetched from a URL.
 */
export interface SourceMapCache {
    /** Original URL of the source map */
    url: string;
    /** Hash of URL (used as filename) */
    urlHash: string;
    /** The raw source map JSON content */
    content: string;
    /** Hash of the content */
    contentHash: string;
    fetchedAt: number;
}

/**
 * A file extracted from a source map.
 */
export interface ExtractedFile {
    /** Relative file path from the source map's sourceRoot */
    path: string;
    /** File content */
    content: string;
}

/**
 * Cached result of extracting source files from a source map.
 */
export interface ExtractionResultCache {
    /** Source map URL */
    sourceMapUrl: string;
    /** Bundle URL */
    bundleUrl: string;
    /** Hash of source map URL (used as filename) */
    urlHash: string;
    /** Extracted files */
    files: ExtractedFile[];
    /** Any errors during extraction */
    errors: string[];
    fetchedAt: number;
}

/**
 * Information about a discovered JavaScript or CSS bundle.
 */
export interface BundleInfo {
    /** URL of the bundle file */
    url: string;
    /** Type of bundle */
    type: 'script' | 'stylesheet';
    /** Source map URL if referenced in the bundle (via sourceMappingURL) */
    sourceMapUrl?: string;
}

/**
 * Cached result of scraping a web page for bundle references.
 */
export interface PageScrapingCache {
    /** Original page URL */
    pageUrl: string;
    /** Hash of page URL (used as filename) */
    urlHash: string;
    /** Discovered bundle URLs */
    bundles: BundleInfo[];
    /** Final URL after any redirects */
    finalUrl?: string;
    /** Redirect detected during fetch (if any) */
    redirect?: {
        /** Original requested URL (full URL) */
        from: string;
        /** Final URL after redirect (full URL) */
        to: string;
        status: number;
    };
    fetchedAt: number;
}

/**
 * Cached result of discovering a source map URL from a bundle.
 */
export interface SourceMapDiscoveryCache {
    /** Bundle URL */
    bundleUrl: string;
    /** Hash of bundle URL (used as filename) */
    urlHash: string;
    /** Discovered source map URL (null if none found) */
    sourceMapUrl: string | null;
    fetchedAt: number;
}

// Import and re-export DependencyInfo from @web2local/types
import type { DependencyInfo } from '@web2local/types';
export type { DependencyInfo } from '@web2local/types';

/**
 * Cached result of analyzing dependencies from extracted source files.
 */
export interface DependencyAnalysisCache {
    /** Hash of extracted files (paths + content hashes) */
    extractionHash: string;
    /** Discovered dependencies */
    dependencies: Array<[string, DependencyInfo]>;
    /** Local imports */
    localImports: string[];
    fetchedAt: number;
}

/**
 * Statistics about dependency version detection results.
 */
export interface VersionStats {
    /** Total number of dependencies analyzed */
    totalDependencies: number;
    /** Count of dependencies with a detected version */
    withVersion: number;
    /** Count of dependencies without a detected version */
    withoutVersion: number;
    /** Count of private/internal packages (not on npm) */
    privatePackages: number;
    /** Breakdown by detection source (e.g., "fingerprint", "comment") */
    bySource: Record<string, number>;
    /** Breakdown by confidence level */
    byConfidence: Record<string, number>;
}

/**
 * Cached generated dependency manifest (package.json) result.
 */
export interface DependencyManifestCache {
    /** Hash of page URL */
    urlHash: string;
    /** Hash of extraction result */
    extractionHash: string;
    /** Hash of options */
    optionsHash: string;
    /** Generated package.json content */
    packageJson: object;
    /** Statistics */
    stats: VersionStats;
    fetchedAt: number;
}

/**
 * Cache for package file structure (list of files from unpkg ?meta)
 */
export interface PackageFileListCache {
    packageName: string;
    version: string;
    /** List of file paths (relative to package root) */
    files: string[];
    fetchedAt: number;
}

/**
 * Cache for npm package existence checks
 * Used to determine if a package is public (on npm) or internal/private
 */
export interface NpmPackageExistenceCache {
    packageName: string;
    /** true = package exists on npm (public), false = not found (internal/private) */
    exists: boolean;
    fetchedAt: number;
}

/**
 * Cache for npm version validation checks
 * Used to verify if a specific version of a package exists on npm
 */
export interface NpmVersionValidationCache {
    packageName: string;
    version: string;
    /** true = this version exists on npm, false = version not found */
    valid: boolean;
    fetchedAt: number;
}

/**
 * Configuration options for the fingerprint cache.
 */
export interface CacheOptions {
    /**
     * Custom directory path for cache storage.
     * @defaultValue ~/.cache/web2local-node
     */
    cacheDir?: string;
    /**
     * Time-to-live for cache entries in milliseconds.
     * @defaultValue 604800000 (7 days)
     */
    ttl?: number;
    /** Set to true to disable all caching (useful for testing) */
    disabled?: boolean;
}

/**
 * Multi-layer cache for fingerprinting operations.
 *
 * Implements a two-tier caching strategy:
 * 1. In-memory cache for fast repeated lookups within a session
 * 2. Disk cache for persistence across sessions
 *
 * Cache entries are automatically invalidated based on TTL (default 7 days).
 *
 * @example
 * ```typescript
 * const cache = new FingerprintCache({ ttl: 86400000 }); // 1 day TTL
 * await cache.init();
 *
 * // Store and retrieve metadata
 * await cache.setMetadata({ name: 'react', versions: ['18.0.0'], ... });
 * const metadata = await cache.getMetadata('react');
 * ```
 */
export class FingerprintCache {
    private cacheDir: string;
    private ttl: number;
    private disabled: boolean;
    private memoryCache: Map<
        string,
        | PackageMetadataCache
        | ContentFingerprintCache
        | MatchResultCache
        | SourceMapCache
        | ExtractionResultCache
        | PageScrapingCache
        | SourceMapDiscoveryCache
        | DependencyAnalysisCache
        | DependencyManifestCache
        | PackageFileListCache
        | NpmPackageExistenceCache
        | NpmVersionValidationCache
    > = new Map();

    /**
     * Creates a new FingerprintCache instance.
     *
     * @param options - Configuration options for the cache
     */
    constructor(options: CacheOptions = {}) {
        this.cacheDir =
            options.cacheDir || join(homedir(), '.cache', 'web2local-node');
        this.ttl = options.ttl || DEFAULT_CACHE_TTL;
        this.disabled = options.disabled || false;
    }

    /**
     * Initializes the cache directory structure.
     *
     * Creates all necessary subdirectories for different cache types.
     * Should be called once before using the cache.
     */
    async init(): Promise<void> {
        if (this.disabled) return;

        try {
            await mkdir(join(this.cacheDir, 'metadata'), { recursive: true });
            await mkdir(join(this.cacheDir, 'fingerprints'), {
                recursive: true,
            });
            await mkdir(join(this.cacheDir, 'minified-fingerprints'), {
                recursive: true,
            });
            await mkdir(join(this.cacheDir, 'matches'), { recursive: true });
            await mkdir(join(this.cacheDir, 'sourcemaps'), { recursive: true });
            await mkdir(join(this.cacheDir, 'extractions'), {
                recursive: true,
            });
            await mkdir(join(this.cacheDir, 'pages'), { recursive: true });
            await mkdir(join(this.cacheDir, 'discovery'), { recursive: true });
            await mkdir(join(this.cacheDir, 'analysis'), { recursive: true });
            await mkdir(join(this.cacheDir, 'manifests'), { recursive: true });
            await mkdir(join(this.cacheDir, 'file-lists'), { recursive: true });
            await mkdir(join(this.cacheDir, 'npm-existence'), {
                recursive: true,
            });
            await mkdir(join(this.cacheDir, 'npm-version-validation'), {
                recursive: true,
            });
        } catch {
            // Ignore errors - cache is optional
        }
    }

    /**
     * Gets the cache file path for package metadata
     */
    private getMetadataPath(packageName: string): string {
        // Handle scoped packages: @scope/pkg -> @scope__pkg
        const safeName = packageName.replace(/\//g, '__');
        return join(this.cacheDir, 'metadata', `${safeName}.json`);
    }

    /**
     * Gets the cache file path for a content fingerprint
     */
    private getFingerprintPath(packageName: string, version: string): string {
        const safeName = packageName.replace(/\//g, '__');
        const dir = join(this.cacheDir, 'fingerprints', safeName);
        return join(dir, `${version}.json`);
    }

    /**
     * Gets the cache file path for a minified content fingerprint
     */
    private getMinifiedFingerprintPath(
        packageName: string,
        version: string,
    ): string {
        const safeName = packageName.replace(/\//g, '__');
        const dir = join(this.cacheDir, 'minified-fingerprints', safeName);
        return join(dir, `${version}.json`);
    }

    /**
     * Gets the cache file path for a match result
     */
    private getMatchResultPath(
        packageName: string,
        extractedContentHash: string,
    ): string {
        const safeName = packageName.replace(/\//g, '__');
        return join(
            this.cacheDir,
            'matches',
            `${safeName}-${extractedContentHash}.json`,
        );
    }

    /**
     * Gets the cache file path for a source map
     */
    private getSourceMapPath(urlHash: string): string {
        return join(this.cacheDir, 'sourcemaps', `${urlHash}.json`);
    }

    /**
     * Gets the cache file path for an extraction result
     */
    private getExtractionResultPath(urlHash: string): string {
        return join(this.cacheDir, 'extractions', `${urlHash}.json`);
    }

    /**
     * Gets the cache file path for page scraping result
     */
    private getPageScrapingPath(urlHash: string): string {
        return join(this.cacheDir, 'pages', `${urlHash}.json`);
    }

    /**
     * Gets the cache file path for source map discovery result
     */
    private getSourceMapDiscoveryPath(urlHash: string): string {
        return join(this.cacheDir, 'discovery', `${urlHash}.json`);
    }

    /**
     * Gets the cache file path for dependency analysis result
     */
    private getDependencyAnalysisPath(extractionHash: string): string {
        return join(this.cacheDir, 'analysis', `${extractionHash}.json`);
    }

    /**
     * Gets the cache file path for dependency manifest result
     */
    private getDependencyManifestPath(
        urlHash: string,
        extractionHash: string,
        optionsHash: string,
    ): string {
        return join(
            this.cacheDir,
            'manifests',
            `${urlHash}-${extractionHash}-${optionsHash}.json`,
        );
    }

    /**
     * Checks if a cache entry is still valid
     */
    private isValid(fetchedAt: number): boolean {
        return Date.now() - fetchedAt < this.ttl;
    }

    /**
     * Gets cached package metadata.
     *
     * @param packageName - Package name (e.g., "react" or "@scope/package")
     * @returns Cached metadata if found and not expired, null otherwise
     */
    async getMetadata(
        packageName: string,
    ): Promise<PackageMetadataCache | null> {
        if (this.disabled) return null;

        // Check memory cache first
        const memKey = `meta:${packageName}`;
        if (this.memoryCache.has(memKey)) {
            const cached = this.memoryCache.get(memKey) as PackageMetadataCache;
            if (this.isValid(cached.fetchedAt)) {
                return cached;
            }
            this.memoryCache.delete(memKey);
        }

        try {
            const filePath = this.getMetadataPath(packageName);
            const content = await readFile(filePath, 'utf-8');
            const cached: PackageMetadataCache = JSON.parse(content);

            if (this.isValid(cached.fetchedAt)) {
                this.memoryCache.set(memKey, cached);
                return cached;
            }

            // Cache expired, delete file
            await unlink(filePath).catch(() => {});
        } catch {
            // Cache miss
        }

        return null;
    }

    /**
     * Saves package metadata to cache.
     *
     * @param metadata - Package metadata to cache
     */
    async setMetadata(metadata: PackageMetadataCache): Promise<void> {
        if (this.disabled) return;

        const memKey = `meta:${metadata.name}`;
        this.memoryCache.set(memKey, metadata);

        try {
            const filePath = this.getMetadataPath(metadata.name);
            await writeFile(
                filePath,
                JSON.stringify(metadata, null, 2),
                'utf-8',
            );
        } catch {
            // Ignore write errors - cache is optional
        }
    }

    /**
     * Gets cached content fingerprint.
     *
     * @param packageName - Package name (e.g., "react" or "@scope/package")
     * @param version - Semver version string
     * @returns Cached fingerprint if found and not expired, null otherwise
     */
    async getFingerprint(
        packageName: string,
        version: string,
    ): Promise<ContentFingerprintCache | null> {
        if (this.disabled) return null;

        const memKey = `fp:${packageName}@${version}`;
        if (this.memoryCache.has(memKey)) {
            const cached = this.memoryCache.get(
                memKey,
            ) as ContentFingerprintCache;
            if (this.isValid(cached.fetchedAt)) {
                return cached;
            }
            this.memoryCache.delete(memKey);
        }

        try {
            const filePath = this.getFingerprintPath(packageName, version);
            const content = await readFile(filePath, 'utf-8');
            const cached: ContentFingerprintCache = JSON.parse(content);

            if (this.isValid(cached.fetchedAt)) {
                this.memoryCache.set(memKey, cached);
                return cached;
            }

            await unlink(filePath).catch(() => {});
        } catch {
            // Cache miss
        }

        return null;
    }

    /**
     * Saves content fingerprint to cache.
     *
     * @param fingerprint - Content fingerprint to cache
     */
    async setFingerprint(fingerprint: ContentFingerprintCache): Promise<void> {
        if (this.disabled) return;

        const memKey = `fp:${fingerprint.packageName}@${fingerprint.version}`;
        this.memoryCache.set(memKey, fingerprint);

        try {
            const filePath = this.getFingerprintPath(
                fingerprint.packageName,
                fingerprint.version,
            );
            const dir = join(
                this.cacheDir,
                'fingerprints',
                fingerprint.packageName.replace(/\//g, '__'),
            );
            await mkdir(dir, { recursive: true });
            await writeFile(
                filePath,
                JSON.stringify(fingerprint, null, 2),
                'utf-8',
            );
        } catch {
            // Ignore write errors
        }
    }

    /**
     * Gets cached minified content fingerprint.
     *
     * @param packageName - Package name (e.g., "react" or "@scope/package")
     * @param version - Semver version string
     * @returns Cached minified fingerprint if found and not expired, null otherwise
     */
    async getMinifiedFingerprint(
        packageName: string,
        version: string,
    ): Promise<ContentFingerprintCache | null> {
        if (this.disabled) return null;

        const memKey = `mfp:${packageName}@${version}`;
        if (this.memoryCache.has(memKey)) {
            const cached = this.memoryCache.get(
                memKey,
            ) as ContentFingerprintCache;
            if (this.isValid(cached.fetchedAt)) {
                return cached;
            }
            this.memoryCache.delete(memKey);
        }

        try {
            const filePath = this.getMinifiedFingerprintPath(
                packageName,
                version,
            );
            const content = await readFile(filePath, 'utf-8');
            const cached: ContentFingerprintCache = JSON.parse(content);

            if (this.isValid(cached.fetchedAt)) {
                this.memoryCache.set(memKey, cached);
                return cached;
            }

            await unlink(filePath).catch(() => {});
        } catch {
            // Cache miss
        }

        return null;
    }

    /**
     * Saves minified content fingerprint to cache.
     *
     * @param fingerprint - Minified content fingerprint to cache
     */
    async setMinifiedFingerprint(
        fingerprint: ContentFingerprintCache,
    ): Promise<void> {
        if (this.disabled) return;

        const memKey = `mfp:${fingerprint.packageName}@${fingerprint.version}`;
        this.memoryCache.set(memKey, fingerprint);

        try {
            const filePath = this.getMinifiedFingerprintPath(
                fingerprint.packageName,
                fingerprint.version,
            );
            const dir = join(
                this.cacheDir,
                'minified-fingerprints',
                fingerprint.packageName.replace(/\//g, '__'),
            );
            await mkdir(dir, { recursive: true });
            await writeFile(
                filePath,
                JSON.stringify(fingerprint, null, 2),
                'utf-8',
            );
        } catch {
            // Ignore write errors
        }
    }

    /**
     * Gets cached match result for a package and extracted content hash combination.
     *
     * @param packageName - Package name to look up
     * @param extractedContentHash - MD5 hash of the extracted source content
     * @returns Cached match result if found and not expired, null otherwise
     */
    async getMatchResult(
        packageName: string,
        extractedContentHash: string,
    ): Promise<MatchResultCache | null> {
        if (this.disabled) return null;

        const memKey = `match:${packageName}:${extractedContentHash}`;
        if (this.memoryCache.has(memKey)) {
            const cached = this.memoryCache.get(memKey) as MatchResultCache;
            if (this.isValid(cached.fetchedAt)) {
                return cached;
            }
            this.memoryCache.delete(memKey);
        }

        try {
            const filePath = this.getMatchResultPath(
                packageName,
                extractedContentHash,
            );
            const content = await readFile(filePath, 'utf-8');
            const cached: MatchResultCache = JSON.parse(content);

            if (this.isValid(cached.fetchedAt)) {
                this.memoryCache.set(memKey, cached);
                return cached;
            }

            await unlink(filePath).catch(() => {});
        } catch {
            // Cache miss
        }

        return null;
    }

    /**
     * Saves match result to cache.
     *
     * @param result - Match result to cache
     */
    async setMatchResult(result: MatchResultCache): Promise<void> {
        if (this.disabled) return;

        const memKey = `match:${result.packageName}:${result.extractedContentHash}`;
        this.memoryCache.set(memKey, result);

        try {
            const filePath = this.getMatchResultPath(
                result.packageName,
                result.extractedContentHash,
            );
            await writeFile(filePath, JSON.stringify(result, null, 2), 'utf-8');
        } catch {
            // Ignore write errors
        }
    }

    /**
     * Gets cached source map by URL.
     *
     * @param url - Source map URL
     * @returns Cached source map if found and not expired, null otherwise
     */
    async getSourceMap(url: string): Promise<SourceMapCache | null> {
        if (this.disabled) return null;

        const urlHash = createHash('md5').update(url).digest('hex');
        const memKey = `srcmap:${urlHash}`;

        if (this.memoryCache.has(memKey)) {
            const cached = this.memoryCache.get(memKey) as SourceMapCache;
            if (this.isValid(cached.fetchedAt)) {
                return cached;
            }
            this.memoryCache.delete(memKey);
        }

        try {
            const filePath = this.getSourceMapPath(urlHash);
            const content = await readFile(filePath, 'utf-8');
            const cached: SourceMapCache = JSON.parse(content);

            if (this.isValid(cached.fetchedAt)) {
                this.memoryCache.set(memKey, cached);
                return cached;
            }

            await unlink(filePath).catch(() => {});
        } catch {
            // Cache miss
        }

        return null;
    }

    /**
     * Saves source map to cache.
     *
     * @param url - Source map URL
     * @param content - Raw source map JSON content
     * @returns The created cache entry
     */
    async setSourceMap(url: string, content: string): Promise<SourceMapCache> {
        const urlHash = createHash('md5').update(url).digest('hex');
        const contentHash = createHash('md5').update(content).digest('hex');

        const cached: SourceMapCache = {
            url,
            urlHash,
            content,
            contentHash,
            fetchedAt: Date.now(),
        };

        if (this.disabled) return cached;

        const memKey = `srcmap:${urlHash}`;
        this.memoryCache.set(memKey, cached);

        try {
            const filePath = this.getSourceMapPath(urlHash);
            await writeFile(filePath, JSON.stringify(cached), 'utf-8');
        } catch {
            // Ignore write errors
        }

        return cached;
    }

    /**
     * Gets cached extraction result by source map URL.
     *
     * @param sourceMapUrl - Source map URL used as cache key
     * @returns Cached extraction result if found and not expired, null otherwise
     */
    async getExtractionResult(
        sourceMapUrl: string,
    ): Promise<ExtractionResultCache | null> {
        if (this.disabled) return null;

        const urlHash = createHash('md5').update(sourceMapUrl).digest('hex');
        const memKey = `extraction:${urlHash}`;

        if (this.memoryCache.has(memKey)) {
            const cached = this.memoryCache.get(
                memKey,
            ) as ExtractionResultCache;
            if (this.isValid(cached.fetchedAt)) {
                return cached;
            }
            this.memoryCache.delete(memKey);
        }

        try {
            const filePath = this.getExtractionResultPath(urlHash);
            const content = await readFile(filePath, 'utf-8');
            const cached: ExtractionResultCache = JSON.parse(content);

            if (this.isValid(cached.fetchedAt)) {
                this.memoryCache.set(memKey, cached);
                return cached;
            }

            await unlink(filePath).catch(() => {});
        } catch {
            // Cache miss
        }

        return null;
    }

    /**
     * Saves extraction result to cache.
     *
     * @param sourceMapUrl - Source map URL used as cache key
     * @param bundleUrl - URL of the associated bundle file
     * @param files - Array of extracted source files
     * @param errors - Array of error messages encountered during extraction
     * @returns The created cache entry
     */
    async setExtractionResult(
        sourceMapUrl: string,
        bundleUrl: string,
        files: ExtractedFile[],
        errors: string[],
    ): Promise<ExtractionResultCache> {
        const urlHash = createHash('md5').update(sourceMapUrl).digest('hex');

        const cached: ExtractionResultCache = {
            sourceMapUrl,
            bundleUrl,
            urlHash,
            files,
            errors,
            fetchedAt: Date.now(),
        };

        if (this.disabled) return cached;

        const memKey = `extraction:${urlHash}`;
        this.memoryCache.set(memKey, cached);

        try {
            const filePath = this.getExtractionResultPath(urlHash);
            await writeFile(filePath, JSON.stringify(cached), 'utf-8');
        } catch {
            // Ignore write errors
        }

        return cached;
    }

    // ============================================
    // PAGE SCRAPING CACHE
    // ============================================

    /**
     * Gets cached page scraping result by URL.
     *
     * @param pageUrl - Page URL used as cache key
     * @returns Cached page scraping result if found and not expired, null otherwise
     */
    async getPageScraping(pageUrl: string): Promise<PageScrapingCache | null> {
        if (this.disabled) return null;

        const urlHash = createHash('md5').update(pageUrl).digest('hex');
        const memKey = `page:${urlHash}`;

        if (this.memoryCache.has(memKey)) {
            const cached = this.memoryCache.get(memKey) as PageScrapingCache;
            if (this.isValid(cached.fetchedAt)) {
                return cached;
            }
            this.memoryCache.delete(memKey);
        }

        try {
            const filePath = this.getPageScrapingPath(urlHash);
            const content = await readFile(filePath, 'utf-8');
            const cached: PageScrapingCache = JSON.parse(content);

            if (this.isValid(cached.fetchedAt)) {
                this.memoryCache.set(memKey, cached);
                return cached;
            }

            await unlink(filePath).catch(() => {});
        } catch {
            // Cache miss
        }

        return null;
    }

    /**
     * Saves page scraping result to cache.
     *
     * @param pageUrl - Original page URL used as cache key
     * @param bundles - Array of discovered bundle references
     * @param finalUrl - Final URL after any redirects
     * @param redirect - Redirect information if a redirect occurred
     * @returns The created cache entry
     */
    async setPageScraping(
        pageUrl: string,
        bundles: BundleInfo[],
        finalUrl?: string,
        redirect?: { from: string; to: string; status: number },
    ): Promise<PageScrapingCache> {
        const urlHash = createHash('md5').update(pageUrl).digest('hex');

        const cached: PageScrapingCache = {
            pageUrl,
            urlHash,
            bundles,
            finalUrl,
            redirect,
            fetchedAt: Date.now(),
        };

        if (this.disabled) return cached;

        const memKey = `page:${urlHash}`;
        this.memoryCache.set(memKey, cached);

        try {
            const filePath = this.getPageScrapingPath(urlHash);
            await writeFile(filePath, JSON.stringify(cached), 'utf-8');
        } catch {
            // Ignore write errors
        }

        return cached;
    }

    // ============================================
    // SOURCE MAP DISCOVERY CACHE
    // ============================================

    /**
     * Gets cached source map discovery result by bundle URL.
     *
     * @param bundleUrl - Bundle URL used as cache key
     * @returns Cached discovery result if found and not expired, null otherwise
     */
    async getSourceMapDiscovery(
        bundleUrl: string,
    ): Promise<SourceMapDiscoveryCache | null> {
        if (this.disabled) return null;

        const urlHash = createHash('md5').update(bundleUrl).digest('hex');
        const memKey = `discovery:${urlHash}`;

        if (this.memoryCache.has(memKey)) {
            const cached = this.memoryCache.get(
                memKey,
            ) as SourceMapDiscoveryCache;
            if (this.isValid(cached.fetchedAt)) {
                return cached;
            }
            this.memoryCache.delete(memKey);
        }

        try {
            const filePath = this.getSourceMapDiscoveryPath(urlHash);
            const content = await readFile(filePath, 'utf-8');
            const cached: SourceMapDiscoveryCache = JSON.parse(content);

            if (this.isValid(cached.fetchedAt)) {
                this.memoryCache.set(memKey, cached);
                return cached;
            }

            await unlink(filePath).catch(() => {});
        } catch {
            // Cache miss
        }

        return null;
    }

    /**
     * Saves source map discovery result to cache.
     *
     * @param bundleUrl - Bundle URL used as cache key
     * @param sourceMapUrl - Discovered source map URL, or null if none found
     * @returns The created cache entry
     */
    async setSourceMapDiscovery(
        bundleUrl: string,
        sourceMapUrl: string | null,
    ): Promise<SourceMapDiscoveryCache> {
        const urlHash = createHash('md5').update(bundleUrl).digest('hex');

        const cached: SourceMapDiscoveryCache = {
            bundleUrl,
            urlHash,
            sourceMapUrl,
            fetchedAt: Date.now(),
        };

        if (this.disabled) return cached;

        const memKey = `discovery:${urlHash}`;
        this.memoryCache.set(memKey, cached);

        try {
            const filePath = this.getSourceMapDiscoveryPath(urlHash);
            await writeFile(filePath, JSON.stringify(cached), 'utf-8');
        } catch {
            // Ignore write errors
        }

        return cached;
    }

    // ============================================
    // DEPENDENCY ANALYSIS CACHE
    // ============================================

    /**
     * Gets cached dependency analysis result.
     *
     * @param extractionHash - Hash of the extraction result used as cache key
     * @returns Cached dependency analysis if found and not expired, null otherwise
     */
    async getDependencyAnalysis(
        extractionHash: string,
    ): Promise<DependencyAnalysisCache | null> {
        if (this.disabled) return null;

        const memKey = `analysis:${extractionHash}`;

        if (this.memoryCache.has(memKey)) {
            const cached = this.memoryCache.get(
                memKey,
            ) as DependencyAnalysisCache;
            if (this.isValid(cached.fetchedAt)) {
                return cached;
            }
            this.memoryCache.delete(memKey);
        }

        try {
            const filePath = this.getDependencyAnalysisPath(extractionHash);
            const content = await readFile(filePath, 'utf-8');
            const cached: DependencyAnalysisCache = JSON.parse(content);

            if (this.isValid(cached.fetchedAt)) {
                this.memoryCache.set(memKey, cached);
                return cached;
            }

            await unlink(filePath).catch(() => {});
        } catch {
            // Cache miss
        }

        return null;
    }

    /**
     * Saves dependency analysis result to cache.
     *
     * @param extractionHash - Hash of the extraction result used as cache key
     * @param dependencies - Map of discovered external dependencies
     * @param localImports - Set of local/relative import paths
     * @returns The created cache entry
     */
    async setDependencyAnalysis(
        extractionHash: string,
        dependencies: Map<string, DependencyInfo>,
        localImports: Set<string>,
    ): Promise<DependencyAnalysisCache> {
        const cached: DependencyAnalysisCache = {
            extractionHash,
            dependencies: Array.from(dependencies.entries()),
            localImports: Array.from(localImports),
            fetchedAt: Date.now(),
        };

        if (this.disabled) return cached;

        const memKey = `analysis:${extractionHash}`;
        this.memoryCache.set(memKey, cached);

        try {
            const filePath = this.getDependencyAnalysisPath(extractionHash);
            await writeFile(filePath, JSON.stringify(cached), 'utf-8');
        } catch {
            // Ignore write errors
        }

        return cached;
    }

    // ============================================
    // DEPENDENCY MANIFEST CACHE
    // ============================================

    /**
     * Gets cached dependency manifest result.
     *
     * @param urlHash - Hash of the page URL
     * @param extractionHash - Hash of the extraction result
     * @param optionsHash - Hash of the manifest generation options
     * @returns Cached manifest if found and not expired, null otherwise
     */
    async getDependencyManifest(
        urlHash: string,
        extractionHash: string,
        optionsHash: string,
    ): Promise<DependencyManifestCache | null> {
        if (this.disabled) return null;

        const memKey = `manifest:${urlHash}:${extractionHash}:${optionsHash}`;

        if (this.memoryCache.has(memKey)) {
            const cached = this.memoryCache.get(
                memKey,
            ) as DependencyManifestCache;
            if (this.isValid(cached.fetchedAt)) {
                return cached;
            }
            this.memoryCache.delete(memKey);
        }

        try {
            const filePath = this.getDependencyManifestPath(
                urlHash,
                extractionHash,
                optionsHash,
            );
            const content = await readFile(filePath, 'utf-8');
            const cached: DependencyManifestCache = JSON.parse(content);

            if (this.isValid(cached.fetchedAt)) {
                this.memoryCache.set(memKey, cached);
                return cached;
            }

            await unlink(filePath).catch(() => {});
        } catch {
            // Cache miss
        }

        return null;
    }

    /**
     * Saves dependency manifest result to cache.
     *
     * @param urlHash - Hash of the page URL
     * @param extractionHash - Hash of the extraction result
     * @param optionsHash - Hash of the manifest generation options
     * @param packageJson - Generated package.json content
     * @param stats - Version detection statistics
     * @returns The created cache entry
     */
    async setDependencyManifest(
        urlHash: string,
        extractionHash: string,
        optionsHash: string,
        packageJson: object,
        stats: VersionStats,
    ): Promise<DependencyManifestCache> {
        const cached: DependencyManifestCache = {
            urlHash,
            extractionHash,
            optionsHash,
            packageJson,
            stats,
            fetchedAt: Date.now(),
        };

        if (this.disabled) return cached;

        const memKey = `manifest:${urlHash}:${extractionHash}:${optionsHash}`;
        this.memoryCache.set(memKey, cached);

        try {
            const filePath = this.getDependencyManifestPath(
                urlHash,
                extractionHash,
                optionsHash,
            );
            await writeFile(filePath, JSON.stringify(cached), 'utf-8');
        } catch {
            // Ignore write errors
        }

        return cached;
    }

    /**
     * Gets cache statistics including entry counts and total disk size.
     *
     * @returns Object containing metadata count, fingerprint count, and total size in bytes
     */
    async getStats(): Promise<{
        metadataCount: number;
        fingerprintCount: number;
        totalSize: number;
    }> {
        if (this.disabled) {
            return { metadataCount: 0, fingerprintCount: 0, totalSize: 0 };
        }

        let metadataCount = 0;
        let fingerprintCount = 0;
        let totalSize = 0;

        try {
            const metaDir = join(this.cacheDir, 'metadata');
            const metaFiles = await readdir(metaDir).catch(() => []);
            metadataCount = metaFiles.length;

            for (const file of metaFiles) {
                const stats = await stat(join(metaDir, file)).catch(() => null);
                if (stats) totalSize += stats.size;
            }

            const fpDir = join(this.cacheDir, 'fingerprints');
            const pkgDirs = await readdir(fpDir).catch(() => []);

            for (const pkgDir of pkgDirs) {
                const versions = await readdir(join(fpDir, pkgDir)).catch(
                    () => [],
                );
                fingerprintCount += versions.length;

                for (const file of versions) {
                    const stats = await stat(join(fpDir, pkgDir, file)).catch(
                        () => null,
                    );
                    if (stats) totalSize += stats.size;
                }
            }
        } catch {
            // Ignore errors
        }

        return { metadataCount, fingerprintCount, totalSize };
    }

    /**
     * Clears the entire cache (both memory and disk).
     *
     * Removes all cache directories and reinitializes them.
     */
    async clear(): Promise<void> {
        this.memoryCache.clear();

        if (this.disabled) return;

        const { rm } = await import('fs/promises');
        try {
            await rm(this.cacheDir, { recursive: true, force: true });
            await this.init();
        } catch {
            // Ignore errors
        }
    }

    /**
     * Gets the file path for package file list cache
     */
    private getFileListPath(packageName: string, version: string): string {
        const safeName = packageName.replace(/\//g, '__');
        return join(this.cacheDir, 'file-lists', `${safeName}@${version}.json`);
    }

    /**
     * Gets cached package file list.
     *
     * @param packageName - Package name (e.g., "react" or "@scope/package")
     * @param version - Semver version string
     * @returns Cached file list if found and not expired, null otherwise
     */
    async getFileList(
        packageName: string,
        version: string,
    ): Promise<PackageFileListCache | null> {
        if (this.disabled) return null;

        const memKey = `fl:${packageName}@${version}`;
        if (this.memoryCache.has(memKey)) {
            const cached = this.memoryCache.get(memKey) as PackageFileListCache;
            if (this.isValid(cached.fetchedAt)) {
                return cached;
            }
            this.memoryCache.delete(memKey);
        }

        try {
            const filePath = this.getFileListPath(packageName, version);
            const content = await readFile(filePath, 'utf-8');
            const cached: PackageFileListCache = JSON.parse(content);

            if (this.isValid(cached.fetchedAt)) {
                this.memoryCache.set(memKey, cached);
                return cached;
            }

            await unlink(filePath).catch(() => {});
        } catch {
            // Cache miss
        }

        return null;
    }

    /**
     * Saves package file list to cache.
     *
     * @param fileList - Package file list to cache
     */
    async setFileList(fileList: PackageFileListCache): Promise<void> {
        if (this.disabled) return;

        const memKey = `fl:${fileList.packageName}@${fileList.version}`;
        this.memoryCache.set(memKey, fileList);

        try {
            const filePath = this.getFileListPath(
                fileList.packageName,
                fileList.version,
            );
            await writeFile(
                filePath,
                JSON.stringify(fileList, null, 2),
                'utf-8',
            );
        } catch {
            // Ignore write errors
        }
    }

    /**
     * Gets the cache file path for npm package existence check
     */
    private getNpmExistencePath(packageName: string): string {
        const safeName = packageName.replace(/\//g, '__');
        return join(this.cacheDir, 'npm-existence', `${safeName}.json`);
    }

    /**
     * Gets cached npm package existence check result.
     *
     * Uses a longer TTL (30 days) since package existence rarely changes.
     *
     * @param packageName - Package name to check
     * @returns Cached existence check if found and not expired, null otherwise
     */
    async getNpmPackageExistence(
        packageName: string,
    ): Promise<NpmPackageExistenceCache | null> {
        if (this.disabled) return null;

        const memKey = `npm:${packageName}`;
        if (this.memoryCache.has(memKey)) {
            const cached = this.memoryCache.get(
                memKey,
            ) as NpmPackageExistenceCache;
            // Use 30 day TTL for npm existence checks
            const npmExistenceTtl = 30 * 24 * 60 * 60 * 1000;
            if (Date.now() - cached.fetchedAt < npmExistenceTtl) {
                return cached;
            }
            this.memoryCache.delete(memKey);
        }

        try {
            const filePath = this.getNpmExistencePath(packageName);
            const content = await readFile(filePath, 'utf-8');
            const cached: NpmPackageExistenceCache = JSON.parse(content);

            // Use 30 day TTL for npm existence checks
            const npmExistenceTtl = 30 * 24 * 60 * 60 * 1000;
            if (Date.now() - cached.fetchedAt < npmExistenceTtl) {
                this.memoryCache.set(memKey, cached);
                return cached;
            }

            await unlink(filePath).catch(() => {});
        } catch {
            // Cache miss
        }

        return null;
    }

    /**
     * Saves npm package existence check result to cache.
     *
     * @param cache - Existence check result to cache
     */
    async setNpmPackageExistence(
        cache: NpmPackageExistenceCache,
    ): Promise<void> {
        if (this.disabled) return;

        const memKey = `npm:${cache.packageName}`;
        this.memoryCache.set(memKey, cache);

        try {
            const filePath = this.getNpmExistencePath(cache.packageName);
            await writeFile(filePath, JSON.stringify(cache, null, 2), 'utf-8');
        } catch {
            // Ignore write errors
        }
    }

    // ============================================
    // NPM VERSION VALIDATION CACHE
    // ============================================

    /**
     * Gets the cache file path for npm version validation check
     */
    private getNpmVersionValidationPath(
        packageName: string,
        version: string,
    ): string {
        const safeName = packageName.replace(/\//g, '__');
        const safeVersion = version.replace(/[/\\:*?"<>|]/g, '_');
        return join(
            this.cacheDir,
            'npm-version-validation',
            `${safeName}@${safeVersion}.json`,
        );
    }

    /**
     * Gets cached npm version validation check result.
     *
     * Uses a longer TTL (30 days) since version existence rarely changes.
     *
     * @param packageName - Package name to check
     * @param version - Version string to validate
     * @returns Cached validation result if found and not expired, null otherwise
     */
    async getNpmVersionValidation(
        packageName: string,
        version: string,
    ): Promise<NpmVersionValidationCache | null> {
        if (this.disabled) return null;

        const memKey = `npmver:${packageName}@${version}`;
        if (this.memoryCache.has(memKey)) {
            const cached = this.memoryCache.get(
                memKey,
            ) as NpmVersionValidationCache;
            // Use 30 day TTL for version validation checks
            const npmVersionTtl = 30 * 24 * 60 * 60 * 1000;
            if (Date.now() - cached.fetchedAt < npmVersionTtl) {
                return cached;
            }
            this.memoryCache.delete(memKey);
        }

        try {
            const filePath = this.getNpmVersionValidationPath(
                packageName,
                version,
            );
            const content = await readFile(filePath, 'utf-8');
            const cached: NpmVersionValidationCache = JSON.parse(content);

            // Use 30 day TTL for version validation checks
            const npmVersionTtl = 30 * 24 * 60 * 60 * 1000;
            if (Date.now() - cached.fetchedAt < npmVersionTtl) {
                this.memoryCache.set(memKey, cached);
                return cached;
            }

            await unlink(filePath).catch(() => {});
        } catch {
            // Cache miss
        }

        return null;
    }

    /**
     * Saves npm version validation check result to cache.
     *
     * @param cache - Version validation result to cache
     */
    async setNpmVersionValidation(
        cache: NpmVersionValidationCache,
    ): Promise<void> {
        if (this.disabled) return;

        const memKey = `npmver:${cache.packageName}@${cache.version}`;
        this.memoryCache.set(memKey, cache);

        try {
            const filePath = this.getNpmVersionValidationPath(
                cache.packageName,
                cache.version,
            );
            await writeFile(filePath, JSON.stringify(cache, null, 2), 'utf-8');
        } catch {
            // Ignore write errors
        }
    }
}

/**
 * Computes normalized content hash by stripping whitespace and comments.
 *
 * Uses AST-based comment stripping that properly handles comments inside strings
 * (e.g., "http://example.com" won't have "//example.com" removed).
 *
 * @param content - Source code content to hash
 * @returns MD5 hash of the normalized content
 */
export function computeNormalizedHash(content: string): string {
    // Use AST-based comment stripping that correctly handles comments inside strings
    // e.g., "http://example.com" won't have "//example.com" removed
    const withoutComments = stripComments(content);
    const normalized = withoutComments.replace(/\s+/g, ' ').trim();
    return createHash('md5').update(normalized).digest('hex');
}

/**
 * Extracts a code signature from source content using AST parsing.
 *
 * Used for fuzzy matching when exact hash doesn't match. This properly extracts
 * actual declaration names (functions, classes, variables), not matches inside
 * strings or comments.
 *
 * @param content - Source code content to analyze
 * @returns Pipe-separated sorted list of declaration names (length > 2 chars)
 */
export function extractCodeSignature(content: string): string {
    // Use AST-based extraction for accurate declaration names
    const names = extractDeclarationNames(content);

    // Filter to names longer than 2 chars (skip single-char minified names)
    const identifiers = names.filter((name) => name.length > 2);

    return [...new Set(identifiers)].sort().join('|');
}

// Global cache instance
let globalCache: FingerprintCache | null = null;

/**
 * Gets or creates the global cache instance.
 *
 * If no instance exists, creates one with default options. Options are only
 * used when creating the initial instance. To reconfigure, use
 * {@link initCache} instead.
 *
 * @returns The global FingerprintCache instance
 */
export function getCache(): FingerprintCache {
    if (!globalCache) {
        globalCache = new FingerprintCache();
    }
    return globalCache;
}

/**
 * Initializes (or reinitializes) the global cache with specific options.
 *
 * Call this once at startup before any fingerprinting operations. If called
 * multiple times, replaces the existing cache instance.
 *
 * @param options - Optional cache configuration
 * @returns The initialized FingerprintCache instance
 */
export async function initCache(
    options?: CacheOptions,
): Promise<FingerprintCache> {
    globalCache = new FingerprintCache(options);
    await globalCache.init();
    return globalCache;
}

/**
 * Computes a hash of extracted files for cache keying.
 *
 * Uses file paths and content lengths for fast comparison without hashing
 * the full content.
 *
 * @param files - Array of extracted files to hash
 * @returns MD5 hash of the file paths and lengths
 */
export function computeExtractionHash(files: ExtractedFile[]): string {
    const data = files
        .map((f) => `${f.path}:${f.content.length}`)
        .sort()
        .join('\n');
    return createHash('md5').update(data).digest('hex');
}

/**
 * Computes a hash for options that affect the manifest result.
 *
 * @param options - Manifest generation options to hash
 * @returns MD5 hash of the normalized options object
 */
export function computeOptionsHash(options: {
    useFingerprinting?: boolean;
    includePrereleases?: boolean;
    fetchFromNpm?: boolean;
}): string {
    const data = JSON.stringify({
        useFingerprinting: options.useFingerprinting || false,
        includePrereleases: options.includePrereleases || false,
        fetchFromNpm: options.fetchFromNpm || false,
    });
    return createHash('md5').update(data).digest('hex');
}

/**
 * Computes URL hash for cache keying.
 *
 * @param url - URL to hash
 * @returns MD5 hash of the URL
 */
export function computeUrlHash(url: string): string {
    return createHash('md5').update(url).digest('hex');
}
