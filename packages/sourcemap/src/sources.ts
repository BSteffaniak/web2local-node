/**
 * Source Extraction
 *
 * Extracts source files from a parsed source map.
 * Handles path normalization and filtering.
 */

import type {
    SourceMapV3,
    ExtractedSource,
    SourceMapExtractionResult,
    SourceMapMetadata,
    ExtractSourceMapOptions,
} from '@web2local/types';
import { SourceMapErrorCode, createContentError } from './errors.js';
import { normalizeSourcePath } from './utils/path.js';
import { shouldIncludeSource } from './utils/filter.js';

// ============================================================================
// EXTRACTION
// ============================================================================

/**
 * Extracts source files from a parsed source map.
 *
 * For each entry in sources/sourcesContent:
 * - Normalizes the path (handles webpack://, vite, etc.)
 * - Filters based on options (excludes webpack/vite internals, etc.)
 * - Skips entries with null/undefined content
 *
 * Note: node_modules paths are always included to ensure internal/workspace
 * packages bundled from node_modules paths are properly extracted.
 *
 * @param sourceMap - The parsed and validated source map
 * @param bundleUrl - The URL of the bundle (for result metadata)
 * @param sourceMapUrl - The URL of the source map (for result metadata)
 * @param options - Extraction options
 * @returns Extraction result with sources and metadata
 *
 * @example
 * ```typescript
 * const result = extractSources(
 *     parsedMap,
 *     'https://example.com/bundle.js',
 *     'https://example.com/bundle.js.map'
 * );
 *
 * for (const source of result.sources) {
 *     console.log(`${source.path}: ${source.content.length} bytes`);
 * }
 * ```
 */
export function extractSources(
    sourceMap: SourceMapV3,
    bundleUrl: string,
    sourceMapUrl: string,
    options?: ExtractSourceMapOptions,
): SourceMapExtractionResult {
    const { excludePatterns, onSource } = options ?? {};

    const sources: ExtractedSource[] = [];
    const errors: Error[] = [];

    const sourceRoot = sourceMap.sourceRoot ?? '';
    const totalSources = sourceMap.sources.length;
    let extractedCount = 0;
    let skippedCount = 0;
    let nullContentCount = 0;

    // Validate sourcesContent exists
    if (!sourceMap.sourcesContent || sourceMap.sourcesContent.length === 0) {
        errors.push(
            createContentError(
                SourceMapErrorCode.NO_EXTRACTABLE_SOURCES,
                'Source map has no sourcesContent array',
                sourceMapUrl,
            ),
        );

        return {
            bundleUrl,
            sourceMapUrl,
            sources: [],
            errors,
            metadata: {
                version: sourceMap.version,
                sourceRoot: sourceRoot || null,
                totalSources,
                extractedCount: 0,
                skippedCount: 0,
                nullContentCount: 0,
            },
        };
    }

    // Process each source
    for (let i = 0; i < sourceMap.sources.length; i++) {
        const originalPath = sourceMap.sources[i];
        const content = sourceMap.sourcesContent[i];

        // Skip null/undefined source paths (allowed per ECMA-426)
        if (originalPath === null || originalPath === undefined) {
            nullContentCount++;
            continue;
        }

        // Skip null/undefined content
        if (content === null || content === undefined) {
            nullContentCount++;
            continue;
        }

        // Normalize the path
        const normalizedPath = normalizeSourcePath(originalPath, sourceRoot);

        // Apply filters
        if (
            !shouldIncludeSource(normalizedPath, {
                excludePatterns,
            })
        ) {
            skippedCount++;
            continue;
        }

        // Create the extracted source
        const extractedSource: ExtractedSource = {
            path: normalizedPath,
            content,
            originalPath,
        };

        sources.push(extractedSource);
        extractedCount++;

        // Call streaming callback if provided
        onSource?.(extractedSource);
    }

    // Build metadata
    const metadata: SourceMapMetadata = {
        version: sourceMap.version,
        sourceRoot: sourceRoot || null,
        totalSources,
        extractedCount,
        skippedCount,
        nullContentCount,
    };

    return {
        bundleUrl,
        sourceMapUrl,
        sources,
        errors,
        metadata,
    };
}

/**
 * Checks if a source map has any extractable content.
 *
 * @param sourceMap - The parsed source map
 * @returns true if there are sources with content
 */
export function hasExtractableContent(sourceMap: SourceMapV3): boolean {
    if (!sourceMap.sourcesContent || sourceMap.sourcesContent.length === 0) {
        return false;
    }

    return sourceMap.sourcesContent.some((content) => content !== null);
}

/**
 * Gets a summary of what's in a source map without fully extracting.
 *
 * Useful for quickly inspecting a source map before committing to
 * full extraction. Does not apply filtering or path normalization.
 *
 * @param sourceMap - The parsed source map
 * @returns Summary object containing:
 *   - `totalSources`: Total number of source entries
 *   - `withContent`: Number of sources with non-null content
 *   - `nullContent`: Number of sources with null/undefined content
 *   - `sourceRoot`: The sourceRoot value if present, null otherwise
 *
 * @example
 * ```typescript
 * const summary = getSourceMapSummary(parsedMap);
 * console.log(`${summary.withContent}/${summary.totalSources} sources have content`);
 * ```
 */
export function getSourceMapSummary(sourceMap: SourceMapV3): {
    totalSources: number;
    withContent: number;
    nullContent: number;
    sourceRoot: string | null;
} {
    const totalSources = sourceMap.sources.length;
    let withContent = 0;
    let nullContent = 0;

    if (sourceMap.sourcesContent) {
        for (const content of sourceMap.sourcesContent) {
            if (content === null || content === undefined) {
                nullContent++;
            } else {
                withContent++;
            }
        }
    }

    return {
        totalSources,
        withContent,
        nullContent,
        sourceRoot: sourceMap.sourceRoot ?? null,
    };
}
