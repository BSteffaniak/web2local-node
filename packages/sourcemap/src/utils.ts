/**
 * Source Map Utilities
 *
 * Shared helper functions for path normalization, URL resolution, and filtering.
 * This is THE single source of truth for these operations.
 */

import {
    WEBPACK_PROTOCOL,
    VITE_VIRTUAL_PREFIX,
    EXCLUDE_PATH_PATTERNS,
    DATA_URI_PATTERN,
} from './constants.js';

// ============================================================================
// PATH NORMALIZATION
// ============================================================================

/**
 * Normalizes source paths from various bundler formats.
 *
 * Handles:
 * - webpack:// protocol (webpack://myapp/./src/... → src/...)
 * - Vite virtual modules (\0 prefix)
 * - sourceRoot prepending
 * - Leading ./ removal
 * - Safe .. segment resolution
 *
 * @param sourcePath - The raw source path from the source map
 * @param sourceRoot - Optional sourceRoot from the source map
 * @returns Normalized path
 */
export function normalizeSourcePath(
    sourcePath: string,
    sourceRoot: string = '',
): string {
    let path = sourcePath;

    // Handle webpack:// protocol
    // webpack://myapp/./src/components/Button.tsx → src/components/Button.tsx
    if (path.startsWith(WEBPACK_PROTOCOL)) {
        path = path.replace(/^webpack:\/\/[^/]*\//, '');
    }

    // Handle vite/rollup virtual modules (prefixed with \0)
    if (path.startsWith(VITE_VIRTUAL_PREFIX)) {
        path = path.slice(1);
    }

    // Apply source root if present and path is relative
    if (sourceRoot && !path.startsWith('/') && !path.startsWith('.')) {
        path = sourceRoot + path;
    }

    // Remove leading ./
    path = path.replace(/^\.\//, '');

    // Resolve .. segments safely (prevent path traversal)
    const segments = path.split('/');
    const resolved: string[] = [];

    for (const segment of segments) {
        if (segment === '..') {
            // Only pop if we have segments and the last one isn't already ..
            if (resolved.length > 0 && resolved[resolved.length - 1] !== '..') {
                resolved.pop();
            } else {
                // Keep the .. if we can't resolve it (edge case)
                resolved.push(segment);
            }
        } else if (segment !== '.' && segment !== '') {
            resolved.push(segment);
        }
    }

    return resolved.join('/');
}

// ============================================================================
// URL RESOLUTION
// ============================================================================

/**
 * Check if a URL is a data URI (inline source map)
 */
export function isDataUri(url: string): boolean {
    return url.startsWith('data:');
}

/**
 * Resolves a source map URL against a base bundle URL.
 *
 * Handles:
 * - Absolute URLs (returned as-is)
 * - Data URIs (returned as-is)
 * - Protocol-relative URLs (//example.com/...)
 * - Absolute paths (/path/to/map)
 * - Relative paths (./map, ../map, map)
 *
 * @param baseUrl - The URL of the bundle file
 * @param sourceMapUrl - The source map URL (from header or comment)
 * @returns Resolved absolute URL
 */
export function resolveSourceMapUrl(
    baseUrl: string,
    sourceMapUrl: string,
): string {
    // Absolute URLs - return as-is
    if (
        sourceMapUrl.startsWith('http://') ||
        sourceMapUrl.startsWith('https://')
    ) {
        return sourceMapUrl;
    }

    // Data URIs - return as-is
    if (isDataUri(sourceMapUrl)) {
        return sourceMapUrl;
    }

    // Use URL API for proper resolution
    const base = new URL(baseUrl);

    // Protocol-relative URLs
    if (sourceMapUrl.startsWith('//')) {
        return `${base.protocol}${sourceMapUrl}`;
    }

    // Absolute paths
    if (sourceMapUrl.startsWith('/')) {
        return `${base.origin}${sourceMapUrl}`;
    }

    // Relative URLs - let URL API handle resolution
    return new URL(sourceMapUrl, base).href;
}

// ============================================================================
// PATH FILTERING
// ============================================================================

export interface FilterOptions {
    /** Include node_modules sources (default: false) */
    includeNodeModules?: boolean;
    /** Package names that are "internal" and should always be included */
    internalPackages?: ReadonlySet<string>;
    /** Additional patterns to exclude */
    excludePatterns?: readonly RegExp[];
}

/**
 * Determines if a source path should be included in extraction results.
 *
 * Excludes:
 * - Paths containing virtual module markers (\0)
 * - node_modules (unless includeNodeModules is true or package is internal)
 * - Webpack/Vite internal paths
 * - Query strings and data URIs
 *
 * @param path - The normalized source path
 * @param options - Filtering options
 * @returns true if the path should be included
 */
export function shouldIncludeSource(
    path: string,
    options: FilterOptions = {},
): boolean {
    const {
        includeNodeModules = false,
        internalPackages,
        excludePatterns,
    } = options;

    // Always exclude paths with virtual module marker
    if (path.includes(VITE_VIRTUAL_PREFIX)) {
        return false;
    }

    // Handle node_modules filtering
    if (path.includes('node_modules')) {
        if (includeNodeModules) {
            return true;
        }

        // Check if this is an internal package that should always be included
        if (internalPackages && internalPackages.size > 0) {
            // Extract package name: node_modules/@scope/pkg/... or node_modules/pkg/...
            const match = path.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)/);
            if (match && internalPackages.has(match[1])) {
                return true;
            }
        }

        return false;
    }

    // Check built-in exclusion patterns
    for (const pattern of EXCLUDE_PATH_PATTERNS) {
        if (pattern.test(path)) {
            return false;
        }
    }

    // Check custom exclusion patterns
    if (excludePatterns) {
        for (const pattern of excludePatterns) {
            if (pattern.test(path)) {
                return false;
            }
        }
    }

    return true;
}

// ============================================================================
// DATA URI HANDLING
// ============================================================================

/**
 * Extracts and decodes the JSON content from a base64 data URI.
 *
 * @param dataUri - The full data URI string
 * @returns The decoded JSON string, or null if invalid
 */
export function decodeDataUri(dataUri: string): string | null {
    const match = dataUri.match(DATA_URI_PATTERN);
    if (!match) {
        return null;
    }

    const base64Content = match[1];

    // Validate base64 format - must only contain valid base64 characters
    // Valid base64: A-Z, a-z, 0-9, +, /, and = for padding
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64Content)) {
        return null;
    }

    try {
        return Buffer.from(base64Content, 'base64').toString('utf-8');
    } catch {
        return null;
    }
}

// ============================================================================
// FILENAME UTILITIES
// ============================================================================

/**
 * Gets a clean filename for a source path, handling edge cases.
 *
 * @param path - The source file path
 * @returns Clean filename with extension
 */
export function getCleanFilename(path: string): string {
    // Remove query strings
    const withoutQuery = path.split('?')[0];

    // Get the filename
    const parts = withoutQuery.split('/');
    const filename = parts[parts.length - 1];

    // If no extension, try to infer one
    if (!filename.includes('.')) {
        return filename + '.js';
    }

    return filename;
}
