/**
 * Source Map Extractor
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
import { SourceMapError, SourceMapErrorCode } from './errors.js';
import { normalizeSourcePath, shouldIncludeSource } from './utils.js';

// ============================================================================
// EXTRACTION
// ============================================================================

/**
 * Extracts source files from a parsed source map.
 *
 * For each entry in sources/sourcesContent:
 * - Normalizes the path (handles webpack://, vite, etc.)
 * - Filters based on options (node_modules, internal packages, etc.)
 * - Skips entries with null/undefined content
 *
 * @param sourceMap - The parsed and validated source map
 * @param bundleUrl - The URL of the bundle (for result metadata)
 * @param sourceMapUrl - The URL of the source map (for result metadata)
 * @param options - Extraction options
 * @returns Extraction result with sources and metadata
 */
export function extractSources(
    sourceMap: SourceMapV3,
    bundleUrl: string,
    sourceMapUrl: string,
    options?: ExtractSourceMapOptions,
): SourceMapExtractionResult {
    const {
        includeNodeModules = false,
        internalPackages,
        excludePatterns,
        onSource,
    } = options ?? {};

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
            new SourceMapError(
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
                includeNodeModules,
                internalPackages,
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

    return sourceMap.sourcesContent.some(
        (content: string | null) => content !== null && content !== undefined,
    );
}

/**
 * Gets a summary of what's in a source map without fully extracting.
 *
 * @param sourceMap - The parsed source map
 * @returns Summary information
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
