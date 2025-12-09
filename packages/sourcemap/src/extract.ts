/**
 * Source Map Extraction
 *
 * High-level convenience function that orchestrates the full extraction
 * pipeline: discovery → fetch → parse → extract.
 */

import type {
    SourceMapExtractionResult,
    SourceMapMetadata,
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
import { extractSources } from './sources.js';

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

/**
 * Creates empty metadata for error results.
 */
function createEmptyMetadata(): SourceMapMetadata {
    return {
        version: 3,
        sourceRoot: null,
        totalSources: 0,
        extractedCount: 0,
        skippedCount: 0,
        nullContentCount: 0,
    };
}

/**
 * Creates an error result when extraction cannot proceed.
 * Consolidates the repeated error result pattern used throughout this module.
 */
function createErrorResult(
    bundleUrl: string,
    sourceMapUrl: string,
    error: Error,
): SourceMapExtractionResult {
    return {
        bundleUrl,
        sourceMapUrl,
        sources: [],
        errors: [error],
        metadata: createEmptyMetadata(),
    };
}

/**
 * Creates an AbortSignal that combines a timeout with an optional user signal.
 * If both are provided, the signal aborts when either triggers.
 */
function createSignalWithTimeout(
    timeout?: number,
    signal?: AbortSignal,
): AbortSignal | undefined {
    if (!timeout && !signal) return undefined;
    if (!timeout) return signal;

    const timeoutSignal = AbortSignal.timeout(timeout);
    if (!signal) return timeoutSignal;

    // Combine both signals - abort when either fires
    return AbortSignal.any([signal, timeoutSignal]);
}

// ============================================================================
// MAIN EXTRACTION FUNCTION
// ============================================================================

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
        signal: userSignal,
        ...extractionOptions
    } = options ?? {};

    // Create a combined signal with timeout
    const signal = createSignalWithTimeout(timeout, userSignal);

    // Check for cancellation before starting
    if (signal?.aborted) {
        return createErrorResult(
            bundleUrl,
            '',
            new Error('Operation was aborted'),
        );
    }

    // Step 1: Discover the source map
    const discovery = await discoverSourceMap(bundleUrl, {
        timeout,
        headers,
        signal: userSignal,
    });

    if (!discovery.found || !discovery.sourceMapUrl) {
        return createErrorResult(
            bundleUrl,
            '',
            createDiscoveryError('No source map found for bundle', bundleUrl),
        );
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
                return createErrorResult(
                    bundleUrl,
                    sourceMapUrl,
                    new Error('Operation was aborted'),
                );
            }

            const response = await robustFetch(sourceMapUrl, {
                headers: { ...BROWSER_HEADERS, ...headers },
                signal,
            });

            if (!response.ok) {
                return createErrorResult(
                    bundleUrl,
                    sourceMapUrl,
                    createHttpError(
                        response.status,
                        response.statusText,
                        sourceMapUrl,
                    ),
                );
            }

            // Check content length if available
            const contentLength = response.headers.get('Content-Length');
            if (contentLength && parseInt(contentLength, 10) > maxSize) {
                return createErrorResult(
                    bundleUrl,
                    sourceMapUrl,
                    createSizeError(
                        parseInt(contentLength, 10),
                        maxSize,
                        sourceMapUrl,
                    ),
                );
            }

            sourceMapContent = await response.text();
        } catch (error) {
            const normalizedError =
                error instanceof SourceMapError
                    ? error
                    : createNetworkError(
                          error instanceof Error
                              ? error
                              : new Error(String(error)),
                          sourceMapUrl,
                      );
            return createErrorResult(bundleUrl, sourceMapUrl, normalizedError);
        }
    }

    // Step 3: Parse the source map
    let parsed;
    try {
        parsed = parseSourceMapAuto(sourceMapContent, sourceMapUrl);
    } catch (error) {
        return createErrorResult(
            bundleUrl,
            sourceMapUrl,
            error instanceof Error ? error : new Error(String(error)),
        );
    }

    // Step 4: Extract sources
    return extractSources(parsed, bundleUrl, sourceMapUrl, extractionOptions);
}
