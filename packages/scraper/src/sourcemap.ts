/**
 * Source Map Extraction for `@web2local/scraper`
 *
 * This module provides caching-aware source map extraction.
 * The core extraction logic lives in `@web2local/sourcemap`.
 */

import type {
    ExtractedSource,
    SourceMapExtractionResult,
} from '@web2local/types';
import { getCache } from '@web2local/cache';
import { BROWSER_HEADERS, robustFetch } from '@web2local/http';
import {
    tryParseSourceMap,
    extractSources,
    SourceMapError,
} from '@web2local/sourcemap';

// Re-export types
export type {
    ExtractedSource,
    SourceMapExtractionResult,
} from '@web2local/types';

// Re-export utilities from `@web2local/sourcemap`
export {
    normalizeSourcePath as normalizePath,
    shouldIncludeSource,
    getCleanFilename,
} from '@web2local/sourcemap';

/**
 * Extracts sources from a source map URL with caching support.
 * Results are cached to avoid re-parsing on subsequent runs.
 *
 * @param sourceMapUrl - URL of the source map
 * @param bundleUrl - URL of the bundle (for result metadata)
 * @param onFile - Optional callback for each extracted source (streaming)
 * @returns Extraction result with sources and metadata. Errors during fetch or parse
 *          are returned in the `errors` array rather than thrown.
 *
 * @example
 * ```typescript
 * const result = await extractSourcesFromMap(
 *     'https://example.com/main.js.map',
 *     'https://example.com/main.js'
 * );
 * for (const source of result.sources) {
 *     console.log(`Extracted: ${source.path}`);
 * }
 * ```
 */
export async function extractSourcesFromMap(
    sourceMapUrl: string,
    bundleUrl: string,
    onFile?: (file: ExtractedSource) => void,
): Promise<SourceMapExtractionResult> {
    const cache = getCache();

    // Check extraction result cache first - this is the fastest path
    const cachedExtraction = await cache.getExtractionResult(sourceMapUrl);
    if (cachedExtraction) {
        // Convert cached files to ExtractedSource and invoke callbacks
        const sources: ExtractedSource[] = cachedExtraction.files.map((f) => ({
            path: f.path,
            content: f.content,
        }));

        if (onFile) {
            for (const source of sources) {
                onFile(source);
            }
        }

        // Convert cached string errors to Error objects
        const errors = cachedExtraction.errors.map((e) => new Error(e));

        return {
            bundleUrl: cachedExtraction.bundleUrl,
            sourceMapUrl: cachedExtraction.sourceMapUrl,
            sources,
            errors,
            metadata: {
                version: 3,
                sourceRoot: null,
                totalSources: sources.length,
                extractedCount: sources.length,
                skippedCount: 0,
                nullContentCount: 0,
            },
        };
    }

    // Fetch source map content (with caching)
    let text: string;

    const cachedSourceMap = await cache.getSourceMap(sourceMapUrl);
    if (cachedSourceMap) {
        text = cachedSourceMap.content;
    } else {
        try {
            const response = await robustFetch(sourceMapUrl, {
                headers: BROWSER_HEADERS,
            });
            if (!response.ok) {
                const error = new SourceMapError(
                    'HTTP_ERROR',
                    `HTTP ${response.status} ${response.statusText}`,
                    sourceMapUrl,
                );
                return {
                    bundleUrl,
                    sourceMapUrl,
                    sources: [],
                    errors: [error],
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
            text = await response.text();

            // Cache the source map content
            await cache.setSourceMap(sourceMapUrl, text);
        } catch (error) {
            const fetchError =
                error instanceof Error ? error : new Error(String(error));
            return {
                bundleUrl,
                sourceMapUrl,
                sources: [],
                errors: [fetchError],
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

    // Parse the source map
    const parseResult = tryParseSourceMap(text, sourceMapUrl);
    if (!parseResult.ok) {
        const preview = text.slice(0, 1000).replace(/\n/g, ' ');
        const error = new Error(
            `Failed to parse source map JSON from ${sourceMapUrl}: ${parseResult.error.message}\n      Response preview: "${preview}${text.length > 1000 ? '...' : ''}"`,
        );
        return {
            bundleUrl,
            sourceMapUrl,
            sources: [],
            errors: [error],
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

    // Extract sources using `@web2local/sourcemap`
    const result = extractSources(parseResult.value, bundleUrl, sourceMapUrl, {
        onSource: onFile,
    });

    // Cache the extraction result
    // Convert Error[] to string[] for cache storage
    const errorStrings = result.errors.map((e) => e.message);
    const cacheFiles = result.sources.map((s) => ({
        path: s.path,
        content: s.content,
    }));

    await cache.setExtractionResult(
        sourceMapUrl,
        bundleUrl,
        cacheFiles,
        errorStrings,
    );

    return result;
}
