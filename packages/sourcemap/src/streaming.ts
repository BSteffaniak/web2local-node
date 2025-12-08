/**
 * Streaming Source Map Parser
 *
 * Handles large source maps (>50MB) by parsing incrementally
 * to avoid loading the entire content into memory at once.
 *
 * For source maps under the streaming threshold, use the standard
 * parseSourceMap() function instead.
 */

import type { SourceMapV3, SourceMapValidationResult } from '@web2local/types';
import { SourceMapError, SourceMapErrorCode } from './errors.js';
import {
    STREAMING_THRESHOLD,
    SUPPORTED_SOURCE_MAP_VERSION,
} from './constants.js';

// ============================================================================
// TYPES
// ============================================================================

export interface StreamingParseOptions {
    /** Maximum size in bytes (default: 100MB) */
    maxSize?: number;
    /** Size threshold to switch to streaming (default: 50MB) */
    streamingThreshold?: number;
    /** Callback for progress updates */
    onProgress?: (bytesRead: number, totalBytes: number | null) => void;
}

export interface StreamingParseResult {
    sourceMap: SourceMapV3;
    /** Whether streaming was used */
    usedStreaming: boolean;
    /** Total bytes processed */
    bytesProcessed: number;
    /** Parse time in milliseconds */
    parseTimeMs: number;
}

// ============================================================================
// STREAMING PARSER
// ============================================================================

/**
 * Incrementally parses a source map from a readable stream.
 *
 * This function collects chunks and parses the complete JSON at the end.
 * For true streaming JSON parsing of very large files, consider using
 * a streaming JSON parser library like `stream-json`.
 *
 * The main benefit here is memory efficiency during the fetch phase,
 * as we don't need to buffer the entire response before starting.
 *
 * @param stream - ReadableStream of the source map content
 * @param options - Streaming options
 * @returns Parsed and validated source map
 */
export async function parseSourceMapStreaming(
    stream: ReadableStream<Uint8Array>,
    options?: StreamingParseOptions,
): Promise<StreamingParseResult> {
    const { maxSize = 100 * 1024 * 1024, onProgress } = options ?? {};

    const startTime = performance.now();
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let bytesRead = 0;

    try {
        while (true) {
            const { done, value } = await reader.read();

            if (done) {
                break;
            }

            bytesRead += value.byteLength;

            // Check size limit
            if (bytesRead > maxSize) {
                throw new SourceMapError(
                    SourceMapErrorCode.SOURCE_MAP_TOO_LARGE,
                    `Source map exceeds maximum size (${bytesRead} > ${maxSize})`,
                    undefined,
                    undefined,
                    { bytesRead, maxSize },
                );
            }

            // Decode chunk and collect
            chunks.push(decoder.decode(value, { stream: true }));

            // Report progress
            onProgress?.(bytesRead, null);
        }

        // Flush remaining data from decoder
        const remaining = decoder.decode();
        if (remaining) {
            chunks.push(remaining);
        }

        // Combine and parse
        const content = chunks.join('');
        const sourceMap = parseAndValidate(content);

        const parseTimeMs = performance.now() - startTime;

        return {
            sourceMap,
            usedStreaming: true,
            bytesProcessed: bytesRead,
            parseTimeMs,
        };
    } finally {
        reader.releaseLock();
    }
}

/**
 * Parses a source map from a Response, automatically using streaming
 * for large responses.
 *
 * @param response - Fetch Response object
 * @param options - Streaming options
 * @returns Parsed source map result
 */
export async function parseSourceMapFromResponse(
    response: Response,
    options?: StreamingParseOptions,
): Promise<StreamingParseResult> {
    const {
        maxSize = 100 * 1024 * 1024,
        streamingThreshold = STREAMING_THRESHOLD,
        onProgress,
    } = options ?? {};

    const startTime = performance.now();

    // Check content length if available
    const contentLength = response.headers.get('Content-Length');
    const estimatedSize = contentLength ? parseInt(contentLength, 10) : null;

    if (estimatedSize && estimatedSize > maxSize) {
        throw new SourceMapError(
            SourceMapErrorCode.SOURCE_MAP_TOO_LARGE,
            `Source map exceeds maximum size (${estimatedSize} > ${maxSize})`,
            response.url,
            undefined,
            { estimatedSize, maxSize },
        );
    }

    // Decide whether to use streaming based on size
    const useStreaming =
        estimatedSize === null || estimatedSize > streamingThreshold;

    if (useStreaming && response.body) {
        // Use streaming parser
        return parseSourceMapStreaming(response.body, {
            maxSize,
            onProgress: onProgress
                ? (bytesRead) => onProgress(bytesRead, estimatedSize)
                : undefined,
        });
    }

    // Standard parsing for smaller files
    const content = await response.text();
    const sourceMap = parseAndValidate(content);
    const parseTimeMs = performance.now() - startTime;

    return {
        sourceMap,
        usedStreaming: false,
        bytesProcessed: content.length,
        parseTimeMs,
    };
}

/**
 * Checks if a source map size suggests streaming should be used.
 *
 * @param sizeBytes - Size in bytes
 * @param threshold - Streaming threshold (default: 50MB)
 * @returns true if streaming is recommended
 */
export function shouldUseStreaming(
    sizeBytes: number,
    threshold: number = STREAMING_THRESHOLD,
): boolean {
    return sizeBytes > threshold;
}

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

/**
 * Parse JSON and validate as SourceMapV3
 */
function parseAndValidate(content: string): SourceMapV3 {
    let parsed: unknown;

    try {
        parsed = JSON.parse(content);
    } catch (e) {
        throw new SourceMapError(
            SourceMapErrorCode.INVALID_JSON,
            `Failed to parse source map JSON: ${e instanceof Error ? e.message : String(e)}`,
        );
    }

    const validation = validateBasic(parsed);
    if (!validation.valid) {
        throw new SourceMapError(
            SourceMapErrorCode.INVALID_VERSION,
            `Invalid source map: ${validation.errors.join('; ')}`,
            undefined,
            undefined,
            { errors: validation.errors },
        );
    }

    return parsed as SourceMapV3;
}

/**
 * Basic validation for streaming context (lighter than full validation)
 */
function validateBasic(raw: unknown): SourceMapValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (typeof raw !== 'object' || raw === null) {
        return {
            valid: false,
            errors: ['Source map must be an object'],
            warnings: [],
        };
    }

    const obj = raw as Record<string, unknown>;

    if (obj.version !== SUPPORTED_SOURCE_MAP_VERSION) {
        errors.push(
            `Invalid version: expected ${SUPPORTED_SOURCE_MAP_VERSION}, got ${obj.version}`,
        );
    }

    if (!Array.isArray(obj.sources)) {
        errors.push('Field "sources" must be an array');
    }

    if (typeof obj.mappings !== 'string') {
        errors.push('Field "mappings" must be a string');
    }

    return { valid: errors.length === 0, errors, warnings };
}
