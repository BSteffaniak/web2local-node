/**
 * Source Map Extraction
 *
 * High-level convenience function that orchestrates the full extraction
 * pipeline: discovery → fetch → parse → extract.
 */

import type {
    SourceMapExtractionResult,
    ExtractSourceMapOptions,
} from '@web2local/types';
import { robustFetch, BROWSER_HEADERS } from '@web2local/http';
import {
    SourceMapError,
    createHttpError,
    createDiscoveryError,
    createSizeError,
    createNetworkError,
} from './errors.js';
import { DEFAULT_MAX_SOURCE_MAP_SIZE, DEFAULT_TIMEOUT } from './constants.js';
import { isDataUri } from './utils/url.js';
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
        signal,
        ...extractionOptions
    } = options ?? {};

    // Check for cancellation before starting
    if (signal?.aborted) {
        return {
            bundleUrl,
            sourceMapUrl: '',
            sources: [],
            errors: [new Error('Operation was aborted')],
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

    // Step 1: Discover the source map
    const discovery = await discoverSourceMap(bundleUrl, {
        timeout,
        headers,
        signal,
    });

    if (!discovery.found || !discovery.sourceMapUrl) {
        return {
            bundleUrl,
            sourceMapUrl: '',
            sources: [],
            errors: [
                createDiscoveryError(
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
            // Check for cancellation before fetching
            if (signal?.aborted) {
                return {
                    bundleUrl,
                    sourceMapUrl,
                    sources: [],
                    errors: [new Error('Operation was aborted')],
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

            const response = await robustFetch(sourceMapUrl, {
                headers: { ...BROWSER_HEADERS, ...headers },
                signal,
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
                        createSizeError(
                            parseInt(contentLength, 10),
                            maxSize,
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

            sourceMapContent = await response.text();
        } catch (error) {
            return {
                bundleUrl,
                sourceMapUrl,
                sources: [],
                errors: [
                    error instanceof SourceMapError
                        ? error
                        : createNetworkError(
                              error instanceof Error
                                  ? error
                                  : new Error(String(error)),
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
