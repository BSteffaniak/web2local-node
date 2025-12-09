/**
 * Source Map Extraction for @web2local/scraper
 *
 * This module provides caching-aware source map extraction.
 * The core extraction logic lives in @web2local/sourcemap.
 */

import type { SourceFile, SourceMapResult } from '@web2local/types';
import { getCache } from '@web2local/cache';
import { BROWSER_HEADERS, robustFetch } from '@web2local/http';
import { parseSourceMap, normalizeSourcePath } from '@web2local/sourcemap';

// Re-export types from @web2local/types for backwards compatibility
export type { SourceFile, SourceMapResult } from '@web2local/types';

// Re-export utilities from @web2local/sourcemap
export {
    normalizeSourcePath as normalizePath,
    shouldIncludeSource,
    getCleanFilename,
} from '@web2local/sourcemap';

/**
 * Streaming source map parser that extracts sources without loading entire file into memory.
 * Results are cached to avoid re-parsing on subsequent runs.
 */
export async function extractSourcesFromMap(
    sourceMapUrl: string,
    bundleUrl: string,
    onFile?: (file: SourceFile) => void,
): Promise<SourceMapResult> {
    const cache = getCache();

    // Check extraction result cache first - this is the fastest path
    const cachedExtraction = await cache.getExtractionResult(sourceMapUrl);
    if (cachedExtraction) {
        // Return cached result, invoking onFile callbacks if provided
        if (onFile) {
            for (const file of cachedExtraction.files) {
                onFile(file);
            }
        }
        return {
            bundleUrl: cachedExtraction.bundleUrl,
            sourceMapUrl: cachedExtraction.sourceMapUrl,
            files: cachedExtraction.files,
            errors: cachedExtraction.errors,
        };
    }

    const result: SourceMapResult = {
        bundleUrl,
        sourceMapUrl,
        files: [],
        errors: [],
    };

    try {
        let text: string;

        // Check source map content cache
        const cachedSourceMap = await cache.getSourceMap(sourceMapUrl);
        if (cachedSourceMap) {
            text = cachedSourceMap.content;
        } else {
            // Fetch from network
            const response = await robustFetch(sourceMapUrl, {
                headers: BROWSER_HEADERS,
            });
            if (!response.ok) {
                result.errors.push(
                    `HTTP ${response.status} ${response.statusText} fetching source map from ${sourceMapUrl}`,
                );
                return result;
            }
            text = await response.text();

            // Cache the source map content
            await cache.setSourceMap(sourceMapUrl, text);
        }

        // Parse and validate the source map using @web2local/sourcemap
        let sourceMap;
        try {
            sourceMap = parseSourceMap(text, sourceMapUrl);
        } catch (e) {
            // Provide helpful context about what we received instead of JSON
            const preview = text.slice(0, 1000).replace(/\n/g, ' ');
            result.errors.push(
                `Failed to parse source map JSON from ${sourceMapUrl}: ${e}\n      Response preview: "${preview}${text.length > 1000 ? '...' : ''}"`,
            );
            return result;
        }

        if (
            !sourceMap.sourcesContent ||
            sourceMap.sourcesContent.length === 0
        ) {
            result.errors.push(
                `Source map from ${sourceMapUrl} is missing sourcesContent array`,
            );
            return result;
        }

        const sourceRoot = sourceMap.sourceRoot || '';

        for (let i = 0; i < sourceMap.sources.length; i++) {
            const sourcePath = sourceMap.sources[i];
            const content = sourceMap.sourcesContent[i];

            // Skip null source paths (allowed per ECMA-426)
            if (sourcePath === null || sourcePath === undefined) {
                continue;
            }

            if (content === null || content === undefined) {
                continue;
            }

            // Normalize the path using @web2local/sourcemap
            const normalizedPath = normalizeSourcePath(sourcePath, sourceRoot);

            const file: SourceFile = {
                path: normalizedPath,
                content,
            };

            result.files.push(file);
            onFile?.(file);
        }

        // Cache the extraction result for next time
        await cache.setExtractionResult(
            sourceMapUrl,
            bundleUrl,
            result.files,
            result.errors,
        );

        return result;
    } catch (error) {
        result.errors.push(
            `Error processing source map from ${sourceMapUrl}: ${error}`,
        );
        return result;
    }
}
