/**
 * Source Map Discovery
 *
 * Finds source maps from bundles using multiple strategies:
 * 1. HTTP headers (SourceMap, X-SourceMap)
 * 2. JS comments (//# source + MappingURL=...)
 * 3. CSS comments (multi-line comment with # source + MappingURL=...)
 * 4. URL probing ({bundleUrl}.map)
 */

import type {
    SourceMapDiscoveryResult,
    DiscoverSourceMapOptions,
} from '@web2local/types';
import { BROWSER_HEADERS, robustFetch } from '@web2local/http';
import {
    SOURCE_MAP_HEADERS,
    VALID_SOURCE_MAP_CONTENT_TYPES,
    INVALID_SOURCE_MAP_CONTENT_TYPES,
    ALLOW_MISSING_CONTENT_TYPE,
} from './constants.js';
import { resolveSourceMapUrl, isDataUri } from './utils/url.js';
import { createSignalWithTimeout } from './utils/signal.js';

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
// COMMENT DETECTION (ECMA-426 Spec Compliant)
//
// Per ECMA-426 section 11.1.2.1 (JavaScriptExtractSourceMapURL), the algorithm:
//
// 1. Scans the entire file line by line
// 2. Tracks `lastURL` - updated whenever a sourceMappingURL is found in a comment
// 3. RESETS `lastURL` to null whenever non-whitespace, non-comment code is found
// 4. Returns `lastURL` at the end
//
// This means:
// - Only sourceMappingURL comments in TRAILING POSITION are valid
//   (i.e., only whitespace/comments may follow)
// - If multiple valid URLs exist in trailing position, the LAST ONE wins
// - URLs followed by code are invalidated (reset to null)
//
// Example: "//# sourceMappingURL=a.map\ncode();\n//# sourceMappingURL=b.map"
//   → Returns "b.map" (first URL was reset by code, last one is in trailing position)
//
// Example: "//# sourceMappingURL=a.map\ncode();"
//   → Returns null (URL was reset by code that followed)
//
// @see https://tc39.es/ecma426/#sec-javascriptextractsourcemapurl
// ============================================================================

/**
 * Line terminators per ECMA-426 spec section 11.1.2.1
 */
const LINE_TERMINATORS = /\r\n|\n|\r|\u2028|\u2029/;

/**
 * Pattern to match sourceMappingURL directive content.
 * Matches: [@#] sourceMappingURL=<url>
 * Uses multiline flag to match within multi-line comment content.
 */
const SOURCE_MAPPING_URL_PATTERN = /[@#]\s*sourceMappingURL=(\S*?)\s*$/m;

/**
 * Matches a sourceMappingURL directive in a comment.
 * For multi-line comments, searches the entire content for the pattern.
 *
 * @param comment - The comment content (without delimiters)
 * @returns The URL if matched, null otherwise
 */
function matchSourceMapUrl(comment: string): string | null {
    const match = comment.match(SOURCE_MAPPING_URL_PATTERN);
    return match ? match[1] : null;
}

// ============================================================================
// SHARED COMMENT PARSER IMPLEMENTATION
// ============================================================================

/**
 * Configuration for the comment parser.
 */
interface CommentParserConfig {
    /**
     * Whether to support single-line comments (//).
     * true for JavaScript, false for CSS.
     */
    supportsSingleLineComments: boolean;
}

/**
 * Internal implementation of ECMA-426 sourceMappingURL extraction.
 *
 * This shared implementation handles both JavaScript (section 11.1.2.1) and
 * CSS (section 11.1.2.2) extraction. The only difference is that JavaScript
 * supports both // and /* comments, while CSS only supports /* comments.
 *
 * Algorithm per spec:
 * 1. Scans the entire file line by line
 * 2. Tracks `lastURL` - updated whenever a sourceMappingURL is found in a comment
 * 3. RESETS `lastURL` to null whenever non-whitespace, non-comment code is found
 * 4. Returns `lastURL` at the end
 *
 * This means only URLs in trailing comments are valid - if code follows a
 * sourceMappingURL comment, it is invalidated.
 *
 * @param content - File content to parse
 * @param config - Parser configuration
 * @returns Source map URL if found in valid trailing position, null otherwise
 */
function extractSourceMapUrlFromComments(
    content: string,
    config: CommentParserConfig,
): string | null {
    const lines = content.split(LINE_TERMINATORS);

    let lastURL: string | null = null;
    let inMultiLineComment = false;
    let multiLineCommentContent = '';

    for (const line of lines) {
        let position = 0;
        const lineLength = line.length;

        // If we're in a multi-line comment from previous line, continue it
        if (inMultiLineComment) {
            const closeIndex = line.indexOf('*/');
            if (closeIndex !== -1) {
                // End of multi-line comment
                multiLineCommentContent += line.slice(0, closeIndex);
                const url = matchSourceMapUrl(multiLineCommentContent);
                if (url) {
                    lastURL = url;
                }
                inMultiLineComment = false;
                multiLineCommentContent = '';
                position = closeIndex + 2;
            } else {
                // Comment continues to next line
                multiLineCommentContent += line + '\n';
                continue;
            }
        }

        while (position < lineLength) {
            const char = line[position];

            // Check for comments starting with /
            if (char === '/' && position + 1 < lineLength) {
                const nextChar = line[position + 1];

                // Single-line comment (JS only)
                if (config.supportsSingleLineComments && nextChar === '/') {
                    const comment = line.slice(position + 2);
                    const url = matchSourceMapUrl(comment);
                    if (url) {
                        lastURL = url;
                    }
                    // Move to end of line
                    position = lineLength;
                } else if (nextChar === '*') {
                    // Multi-line comment (both JS and CSS)
                    const closeIndex = line.indexOf('*/', position + 2);
                    if (closeIndex !== -1) {
                        // Comment ends on same line
                        const comment = line.slice(position + 2, closeIndex);
                        const url = matchSourceMapUrl(comment);
                        if (url) {
                            lastURL = url;
                        }
                        position = closeIndex + 2;
                    } else {
                        // Comment continues to next line
                        inMultiLineComment = true;
                        multiLineCommentContent =
                            line.slice(position + 2) + '\n';
                        position = lineLength;
                    }
                } else {
                    // Just a / character (e.g., division) - this is code
                    lastURL = null;
                    position++;
                }
            } else if (/\s/.test(char)) {
                // Whitespace - skip
                position++;
            } else {
                // Non-whitespace, non-comment code - reset lastURL per spec
                lastURL = null;
                position++;
            }
        }
    }

    // Handle unclosed multi-line comment at end of file
    if (inMultiLineComment) {
        const url = matchSourceMapUrl(multiLineCommentContent);
        if (url) {
            lastURL = url;
        }
    }

    return lastURL;
}

// ============================================================================
// PUBLIC COMMENT EXTRACTION FUNCTIONS
// ============================================================================

/**
 * Extracts source map URL from JavaScript content following ECMA-426 spec.
 *
 * Per ECMA-426 section 11.1.2.1, this implements the "without parsing" algorithm:
 * - Scans for sourceMappingURL in single-line (//) and multi-line comments
 * - Returns the LAST valid URL found in trailing comments
 * - Resets when non-comment code is encountered (URL must be in trailing position)
 *
 * NOTE: "Last URL wins" is SPEC-COMPLIANT behavior, not a bug. The spec uses
 * a `lastURL` variable that gets updated on each match and reset on code.
 *
 * @see https://tc39.es/ecma426/#sec-javascriptextractsourcemapurl
 * @param content - JavaScript file content
 * @returns Source map URL if found in valid trailing position, null otherwise
 */
export function findSourceMapInJsComment(content: string): string | null {
    return extractSourceMapUrlFromComments(content, {
        supportsSingleLineComments: true,
    });
}

/**
 * Extracts source map URL from CSS content following ECMA-426 spec.
 *
 * Per ECMA-426 section 11.1.2.2, CSS extraction is similar to JavaScript
 * but only supports multi-line comments.
 *
 * NOTE: "Last URL wins" is SPEC-COMPLIANT behavior, not a bug. The spec uses
 * a `lastURL` variable that gets updated on each match and reset on code.
 *
 * @see https://tc39.es/ecma426/#sec-cssextractsourcemapurl
 * @param content - CSS file content
 * @returns Source map URL if found in valid trailing position, null otherwise
 */
export function findSourceMapInCssComment(content: string): string | null {
    return extractSourceMapUrlFromComments(content, {
        supportsSingleLineComments: false,
    });
}

/**
 * Finds source mapping URL in file content.
 *
 * Uses the appropriate extraction method based on file type.
 * Per ECMA-426 spec, returns the LAST valid URL in trailing comments.
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
 * Accepts missing/empty content types if ALLOW_MISSING_CONTENT_TYPE is true.
 *
 * @param contentType - The Content-Type header value
 * @returns true if the content type is valid for source maps
 */
export function isValidSourceMapContentType(contentType: string): boolean {
    const normalized = contentType.toLowerCase().split(';')[0].trim();

    // Handle missing or empty content type
    if (!normalized) {
        return ALLOW_MISSING_CONTENT_TYPE;
    }

    // Check against invalid types first (these are always rejected)
    for (const invalid of INVALID_SOURCE_MAP_CONTENT_TYPES) {
        if (normalized.includes(invalid)) {
            return false;
        }
    }

    // Check against known valid types
    for (const valid of VALID_SOURCE_MAP_CONTENT_TYPES) {
        if (normalized.includes(valid)) {
            return true;
        }
    }

    // Unknown content type - accept if we allow missing types (lenient mode)
    return ALLOW_MISSING_CONTENT_TYPE;
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
    const signal = createSignalWithTimeout(options?.timeout, options?.signal);

    try {
        const response = await robustFetch(mapUrl, {
            method: 'HEAD',
            headers: {
                ...BROWSER_HEADERS,
                ...options?.headers,
            },
            signal,
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
    } catch (_error) {
        // Network errors are expected when probing - fail gracefully
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
    const { timeout, headers = {} } = options ?? {};
    const signal = createSignalWithTimeout(timeout, options?.signal);

    try {
        // Fetch the bundle
        const response = await robustFetch(bundleUrl, {
            headers: { ...BROWSER_HEADERS, ...headers },
            signal,
        });

        if (!response.ok) {
            return {
                found: false,
                sourceMapUrl: null,
                locationType: null,
            };
        }

        // Strategy 1: Check HTTP headers
        const headerUrl = findSourceMapInHeaders(response.headers);
        if (headerUrl) {
            const resolved = resolveSourceMapUrl(bundleUrl, headerUrl);
            return {
                found: true,
                sourceMapUrl: resolved,
                locationType: 'http-header',
            };
        }

        // Get content for comment check and fallback
        const content = await response.text();

        // Strategy 2: Check comments in content
        // Determine file type from URL extension
        const lowerUrl = bundleUrl.toLowerCase();
        const isCSS = lowerUrl.endsWith('.css') || lowerUrl.includes('.css?');
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

        // Strategy 3: Probe {url}.map
        const probeUrl = await probeSourceMapUrl(bundleUrl, options);
        if (probeUrl) {
            return {
                found: true,
                sourceMapUrl: probeUrl,
                locationType: 'url-probe',
                bundleContent: content,
            };
        }

        // No source map found
        return {
            found: false,
            sourceMapUrl: null,
            locationType: null,
            bundleContent: content,
        };
    } catch (_error) {
        // Network errors, aborts, and timeouts are expected - fail gracefully
        return {
            found: false,
            sourceMapUrl: null,
            locationType: null,
        };
    }
}
