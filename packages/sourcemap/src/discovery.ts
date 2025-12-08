/**
 * Source Map Discovery
 *
 * Finds source maps from bundles using multiple strategies:
 * 1. HTTP headers (SourceMap, X-SourceMap)
 * 2. JS comments (//# source + MappingURL=...)
 * 3. CSS comments (/*# source + MappingURL=... *\/)
 * 4. URL probing ({bundleUrl}.map)
 */

import type {
    SourceMapDiscoveryResult,
    DiscoverSourceMapOptions,
} from '@web2local/types';
import { BROWSER_HEADERS, robustFetch } from '@web2local/http';
import {
    SOURCE_MAP_HEADERS,
    JS_SOURCE_MAP_COMMENT_PATTERN,
    CSS_SOURCE_MAP_COMMENT_PATTERN,
    VALID_SOURCE_MAP_CONTENT_TYPES,
    INVALID_SOURCE_MAP_CONTENT_TYPES,
} from './constants.js';
import { resolveSourceMapUrl, isDataUri } from './utils.js';

// ============================================================================
// HEADER DETECTION
// ============================================================================

/**
 * Checks HTTP headers for source map URL.
 *
 * @param headers - Response headers to check
 * @returns Source map URL if found, null otherwise
 */
export function findSourceMapInHeaders(headers: Headers): string | null {
    for (const headerName of SOURCE_MAP_HEADERS) {
        const value = headers.get(headerName);
        if (value) {
            return value;
        }
    }
    return null;
}

// ============================================================================
// COMMENT DETECTION
// ============================================================================

/**
 * Finds source mapping URL in JavaScript content.
 *
 * Matches patterns like:
 * - //# source + MappingURL=bundle.js.map
 * - //@ source + MappingURL=bundle.js.map (legacy)
 *
 * @param content - JavaScript file content
 * @returns Source map URL if found, null otherwise
 */
export function findSourceMapInJsComment(content: string): string | null {
    const match = content.match(JS_SOURCE_MAP_COMMENT_PATTERN);
    return match?.[1] || null;
}

/**
 * Finds source mapping URL in CSS content.
 *
 * Matches patterns like:
 * - /*# source + MappingURL=styles.css.map *\/
 *
 * @param content - CSS file content
 * @returns Source map URL if found, null otherwise
 */
export function findSourceMapInCssComment(content: string): string | null {
    const match = content.match(CSS_SOURCE_MAP_COMMENT_PATTERN);
    return match?.[1] || null;
}

/**
 * Finds source mapping URL in file content (auto-detects JS or CSS).
 *
 * @param content - File content
 * @param type - File type hint ('js' or 'css'), or 'auto' to try both
 * @returns Source map URL if found, null otherwise
 */
export function findSourceMapInComment(
    content: string,
    type: 'js' | 'css' | 'auto' = 'auto',
): string | null {
    if (type === 'js') {
        return findSourceMapInJsComment(content);
    }
    if (type === 'css') {
        return findSourceMapInCssComment(content);
    }

    // Auto-detect: try JS first, then CSS
    return (
        findSourceMapInJsComment(content) || findSourceMapInCssComment(content)
    );
}

// ============================================================================
// URL PROBING
// ============================================================================

/**
 * Validates if a content type indicates a valid source map response.
 *
 * Rejects text/html (common SPA fallback for 404s).
 *
 * @param contentType - The Content-Type header value
 * @returns true if the content type is valid for source maps
 */
export function isValidSourceMapContentType(contentType: string): boolean {
    const normalized = contentType.toLowerCase().split(';')[0].trim();

    // Check against invalid types first
    for (const invalid of INVALID_SOURCE_MAP_CONTENT_TYPES) {
        if (normalized.includes(invalid)) {
            return false;
        }
    }

    // Check against valid types
    for (const valid of VALID_SOURCE_MAP_CONTENT_TYPES) {
        if (valid === '' || normalized.includes(valid)) {
            return true;
        }
    }

    return false;
}

/**
 * Probes for a source map at {bundleUrl}.map.
 *
 * Uses HEAD request to avoid downloading the full file.
 * Validates Content-Type to avoid false positives from SPAs.
 *
 * @param bundleUrl - The bundle URL to probe
 * @param options - Discovery options
 * @returns Source map URL if found and valid, null otherwise
 */
export async function probeSourceMapUrl(
    bundleUrl: string,
    options?: DiscoverSourceMapOptions,
): Promise<string | null> {
    const mapUrl = bundleUrl + '.map';

    try {
        const response = await robustFetch(mapUrl, {
            method: 'HEAD',
            headers: {
                ...BROWSER_HEADERS,
                ...options?.headers,
            },
        });

        if (!response.ok) {
            return null;
        }

        // Validate content type
        const contentType = response.headers.get('Content-Type') || '';
        if (!isValidSourceMapContentType(contentType)) {
            return null;
        }

        return mapUrl;
    } catch {
        return null;
    }
}

// ============================================================================
// MAIN DISCOVERY FUNCTION
// ============================================================================

/**
 * Discovers the source map for a bundle using all available strategies.
 *
 * Strategy order:
 * 1. Check HTTP headers (fastest, most reliable)
 * 2. Check inline/external comments in content
 * 3. Probe {url}.map as fallback
 *
 * @param bundleUrl - The URL of the bundle
 * @param options - Discovery options
 * @returns Discovery result with source map URL (if found) and bundle content
 */
export async function discoverSourceMap(
    bundleUrl: string,
    options?: DiscoverSourceMapOptions,
): Promise<SourceMapDiscoveryResult> {
    const {
        skipHeaderCheck = false,
        skipCommentCheck = false,
        skipProbe = false,
        headers = {},
    } = options ?? {};

    try {
        // Fetch the bundle
        const response = await robustFetch(bundleUrl, {
            headers: { ...BROWSER_HEADERS, ...headers },
        });

        if (!response.ok) {
            return {
                found: false,
                sourceMapUrl: null,
                locationType: null,
            };
        }

        // Strategy 1: Check HTTP headers
        if (!skipHeaderCheck) {
            const headerUrl = findSourceMapInHeaders(response.headers);
            if (headerUrl) {
                const resolved = resolveSourceMapUrl(bundleUrl, headerUrl);
                return {
                    found: true,
                    sourceMapUrl: resolved,
                    locationType: 'http-header',
                };
            }
        }

        // Get content for comment check and fallback
        const content = await response.text();

        // Strategy 2: Check comments in content
        if (!skipCommentCheck) {
            // Determine file type from URL
            const isCSS = bundleUrl.toLowerCase().includes('.css');
            const commentUrl = findSourceMapInComment(
                content,
                isCSS ? 'css' : 'js',
            );

            if (commentUrl) {
                // Check if it's an inline data URI
                if (isDataUri(commentUrl)) {
                    return {
                        found: true,
                        sourceMapUrl: commentUrl,
                        locationType: 'inline-data-uri',
                        bundleContent: content,
                    };
                }

                const resolved = resolveSourceMapUrl(bundleUrl, commentUrl);
                return {
                    found: true,
                    sourceMapUrl: resolved,
                    locationType: isCSS ? 'css-comment' : 'js-comment',
                    bundleContent: content,
                };
            }
        }

        // Strategy 3: Probe {url}.map
        if (!skipProbe) {
            const probeUrl = await probeSourceMapUrl(bundleUrl, options);
            if (probeUrl) {
                return {
                    found: true,
                    sourceMapUrl: probeUrl,
                    locationType: 'url-probe',
                    bundleContent: content,
                };
            }
        }

        // No source map found
        return {
            found: false,
            sourceMapUrl: null,
            locationType: null,
            bundleContent: content,
        };
    } catch {
        return {
            found: false,
            sourceMapUrl: null,
            locationType: null,
        };
    }
}
