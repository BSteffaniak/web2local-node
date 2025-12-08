/**
 * @web2local/sourcemap
 *
 * Professional source map parsing, discovery, and extraction.
 *
 * This package provides a clean, well-structured API for working with source maps:
 *
 * - **Discovery**: Find source maps from bundle URLs (headers, comments, probing)
 * - **Parsing**: Parse and validate source map JSON (including inline base64)
 * - **Extraction**: Extract source files with path normalization and filtering
 *
 * @example
 * ```typescript
 * import { extractSourceMap } from '@web2local/sourcemap';
 *
 * // Simple: extract sources from a bundle URL
 * const result = await extractSourceMap('https://example.com/bundle.js');
 * for (const source of result.sources) {
 *   console.log(source.path, source.content.length);
 * }
 *
 * // Advanced: use individual functions for more control
 * import { discoverSourceMap, parseSourceMap, extractSources } from '@web2local/sourcemap';
 *
 * const discovery = await discoverSourceMap(bundleUrl);
 * if (discovery.found) {
 *   const content = await fetch(discovery.sourceMapUrl).then(r => r.text());
 *   const parsed = parseSourceMap(content);
 *   const result = extractSources(parsed, bundleUrl, discovery.sourceMapUrl);
 * }
 * ```
 */

// ============================================================================
// TYPE RE-EXPORTS
// ============================================================================

export type {
    SourceMapV3,
    ExtractedSource,
    SourceMapMetadata,
    SourceMapExtractionResult,
    SourceMapLocationType,
    SourceMapDiscoveryResult,
    ExtractSourceMapOptions,
    DiscoverSourceMapOptions,
    SourceMapValidationResult,
} from '@web2local/types';

// ============================================================================
// ERROR EXPORTS
// ============================================================================

export {
    SourceMapError,
    SourceMapErrorCode,
    createHttpError,
    createParseError,
    createValidationError,
    createNetworkError,
} from './errors.js';

// ============================================================================
// CONSTANT EXPORTS
// ============================================================================

export {
    WEBPACK_PROTOCOL,
    VITE_VIRTUAL_PREFIX,
    SOURCE_MAP_HEADERS,
    VALID_SOURCE_MAP_CONTENT_TYPES,
    INVALID_SOURCE_MAP_CONTENT_TYPES,
    JS_SOURCE_MAP_COMMENT_PATTERN,
    CSS_SOURCE_MAP_COMMENT_PATTERN,
    DATA_URI_PATTERN,
    EXCLUDE_PATH_PATTERNS,
    DEFAULT_MAX_SOURCE_MAP_SIZE,
    STREAMING_THRESHOLD,
    DEFAULT_TIMEOUT,
    SUPPORTED_SOURCE_MAP_VERSION,
} from './constants.js';

// ============================================================================
// UTILITY EXPORTS
// ============================================================================

export {
    normalizeSourcePath,
    resolveSourceMapUrl,
    shouldIncludeSource,
    isDataUri,
    decodeDataUri,
    getCleanFilename,
    type FilterOptions,
} from './utils.js';

// ============================================================================
// PARSER EXPORTS
// ============================================================================

export {
    parseSourceMap,
    parseInlineSourceMap,
    parseSourceMapAuto,
    validateSourceMap,
} from './parser.js';

// ============================================================================
// DISCOVERY EXPORTS
// ============================================================================

export {
    discoverSourceMap,
    findSourceMapInHeaders,
    findSourceMapInComment,
    findSourceMapInJsComment,
    findSourceMapInCssComment,
    probeSourceMapUrl,
    isValidSourceMapContentType,
} from './discovery.js';

// ============================================================================
// EXTRACTOR EXPORTS
// ============================================================================

export {
    extractSources,
    hasExtractableContent,
    getSourceMapSummary,
} from './extractor.js';

// ============================================================================
// STREAMING EXPORTS
// ============================================================================

export {
    parseSourceMapStreaming,
    parseSourceMapFromResponse,
    shouldUseStreaming,
    type StreamingParseOptions,
    type StreamingParseResult,
} from './streaming.js';

// ============================================================================
// CONVENIENCE FUNCTION
// ============================================================================

import type {
    SourceMapExtractionResult,
    ExtractSourceMapOptions,
} from '@web2local/types';
import { robustFetch, BROWSER_HEADERS } from '@web2local/http';
import {
    SourceMapError,
    SourceMapErrorCode,
    createHttpError,
} from './errors.js';
import { DEFAULT_MAX_SOURCE_MAP_SIZE, DEFAULT_TIMEOUT } from './constants.js';
import { isDataUri } from './utils.js';
import { parseSourceMapAuto } from './parser.js';
import { discoverSourceMap } from './discovery.js';
import { extractSources } from './extractor.js';

/**
 * Extract source files from a bundle URL.
 *
 * This is the main convenience function that combines discovery, fetching,
 * parsing, and extraction into a single call.
 *
 * Steps:
 * 1. Discover the source map URL (headers, comments, or probing)
 * 2. Fetch the source map content
 * 3. Parse and validate the source map
 * 4. Extract sources with path normalization and filtering
 *
 * @param bundleUrl - The URL of the JavaScript/CSS bundle
 * @param options - Extraction options
 * @returns Extraction result with sources and metadata
 *
 * @example
 * ```typescript
 * const result = await extractSourceMap('https://example.com/app.js');
 *
 * console.log(`Extracted ${result.metadata.extractedCount} sources`);
 * for (const source of result.sources) {
 *   await writeFile(source.path, source.content);
 * }
 * ```
 */
export async function extractSourceMap(
    bundleUrl: string,
    options?: ExtractSourceMapOptions,
): Promise<SourceMapExtractionResult> {
    const {
        maxSize = DEFAULT_MAX_SOURCE_MAP_SIZE,
        timeout = DEFAULT_TIMEOUT,
        headers = {},
        ...extractionOptions
    } = options ?? {};

    // Step 1: Discover the source map
    const discovery = await discoverSourceMap(bundleUrl, {
        timeout,
        headers,
    });

    if (!discovery.found || !discovery.sourceMapUrl) {
        return {
            bundleUrl,
            sourceMapUrl: '',
            sources: [],
            errors: [
                new SourceMapError(
                    SourceMapErrorCode.NO_SOURCE_MAP_FOUND,
                    'No source map found for bundle',
                    bundleUrl,
                ),
            ],
            metadata: {
                version: 3,
                sourceRoot: null,
                totalSources: 0,
                extractedCount: 0,
                skippedCount: 0,
                nullContentCount: 0,
            },
        };
    }

    const sourceMapUrl = discovery.sourceMapUrl;

    // Step 2: Fetch the source map content
    let sourceMapContent: string;

    if (isDataUri(sourceMapUrl)) {
        // Inline source map - no fetch needed
        sourceMapContent = sourceMapUrl;
    } else {
        try {
            const response = await robustFetch(sourceMapUrl, {
                headers: { ...BROWSER_HEADERS, ...headers },
            });

            if (!response.ok) {
                return {
                    bundleUrl,
                    sourceMapUrl,
                    sources: [],
                    errors: [
                        createHttpError(
                            response.status,
                            response.statusText,
                            sourceMapUrl,
                        ),
                    ],
                    metadata: {
                        version: 3,
                        sourceRoot: null,
                        totalSources: 0,
                        extractedCount: 0,
                        skippedCount: 0,
                        nullContentCount: 0,
                    },
                };
            }

            // Check content length if available
            const contentLength = response.headers.get('Content-Length');
            if (contentLength && parseInt(contentLength, 10) > maxSize) {
                return {
                    bundleUrl,
                    sourceMapUrl,
                    sources: [],
                    errors: [
                        new SourceMapError(
                            SourceMapErrorCode.SOURCE_MAP_TOO_LARGE,
                            `Source map exceeds maximum size (${contentLength} > ${maxSize})`,
                            sourceMapUrl,
                            undefined,
                            {
                                contentLength: parseInt(contentLength, 10),
                                maxSize,
                            },
                        ),
                    ],
                    metadata: {
                        version: 3,
                        sourceRoot: null,
                        totalSources: 0,
                        extractedCount: 0,
                        skippedCount: 0,
                        nullContentCount: 0,
                    },
                };
            }

            sourceMapContent = await response.text();
        } catch (error) {
            return {
                bundleUrl,
                sourceMapUrl,
                sources: [],
                errors: [
                    error instanceof SourceMapError
                        ? error
                        : new SourceMapError(
                              SourceMapErrorCode.FETCH_FAILED,
                              error instanceof Error
                                  ? error.message
                                  : 'Failed to fetch source map',
                              sourceMapUrl,
                              error instanceof Error ? error : undefined,
                          ),
                ],
                metadata: {
                    version: 3,
                    sourceRoot: null,
                    totalSources: 0,
                    extractedCount: 0,
                    skippedCount: 0,
                    nullContentCount: 0,
                },
            };
        }
    }

    // Step 3: Parse the source map
    let parsed;
    try {
        parsed = parseSourceMapAuto(sourceMapContent, sourceMapUrl);
    } catch (error) {
        return {
            bundleUrl,
            sourceMapUrl,
            sources: [],
            errors: [error instanceof Error ? error : new Error(String(error))],
            metadata: {
                version: 3,
                sourceRoot: null,
                totalSources: 0,
                extractedCount: 0,
                skippedCount: 0,
                nullContentCount: 0,
            },
        };
    }

    // Step 4: Extract sources
    return extractSources(parsed, bundleUrl, sourceMapUrl, extractionOptions);
}
