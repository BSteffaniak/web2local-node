/**
 * Source Map Parser
 *
 * Parses source map JSON content and validates it using the validation module.
 * Handles both external source maps and inline base64 data URIs.
 *
 * Two API styles are available:
 * - Result-based: `tryParseSourceMap()` returns `Result<SourceMapV3, SourceMapError>`
 * - Throwing: `parseSourceMap()` throws `SourceMapError` on failure
 */

import type { SourceMapV3, Result } from '@web2local/types';
import { Ok, Err } from '@web2local/types';
import {
    SourceMapError,
    SourceMapErrorCode,
    createParseError,
    createValidationError,
    createDataUriError,
} from './errors.js';
import { ERROR_PREVIEW_LENGTH } from './constants.js';
import { decodeDataUri, isDataUri } from './utils/url.js';
import { validateSourceMap, isSourceMapV3 } from './validation/index.js';

// Re-export validation functions for backwards compatibility
export { validateSourceMap, isSourceMapV3 };

// ============================================================================
// RESULT-BASED API (Recommended)
// ============================================================================

/**
 * Parses and validates a source map from JSON string.
 * Returns a Result instead of throwing.
 *
 * @param content - The JSON string content
 * @param url - The URL of the source map (for error messages)
 * @returns Result with validated SourceMapV3 or SourceMapError
 *
 * @example
 * ```typescript
 * const result = tryParseSourceMap(jsonString);
 * if (result.ok) {
 *     console.log(result.value.sources);
 * } else {
 *     console.error(result.error.message);
 * }
 * ```
 */
export function tryParseSourceMap(
    content: string,
    url?: string,
): Result<SourceMapV3, SourceMapError> {
    // Try to parse JSON
    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    } catch (e) {
        const preview = content
            .slice(0, ERROR_PREVIEW_LENGTH)
            .replace(/\n/g, ' ');
        return Err(
            createParseError(
                `Failed to parse source map JSON: ${e instanceof Error ? e.message : String(e)}`,
                url ?? 'unknown',
                preview,
            ),
        );
    }

    // Validate structure (single validation call)
    const validation = validateSourceMap(parsed);
    if (validation.valid) {
        return Ok(parsed as SourceMapV3);
    }

    // Build error message from validation errors
    const firstError = validation.errors[0];
    const errorCode = firstError?.code as SourceMapErrorCode;
    const errorMessages = validation.errors.map((e) => e.message).join('; ');

    return Err(
        createValidationError(
            errorCode ?? SourceMapErrorCode.INVALID_VERSION,
            `Invalid source map: ${errorMessages}`,
            url,
            {
                errors: validation.errors,
                warnings: validation.warnings,
            },
        ),
    );
}

/**
 * Parses a source map from an inline base64 data URI.
 * Returns a Result instead of throwing.
 *
 * @param dataUri - The data URI string (data:application/json;base64,...)
 * @param url - The URL context (for error messages)
 * @returns Result with validated SourceMapV3 or SourceMapError
 */
export function tryParseInlineSourceMap(
    dataUri: string,
    url?: string,
): Result<SourceMapV3, SourceMapError> {
    if (!isDataUri(dataUri)) {
        return Err(
            createDataUriError(
                SourceMapErrorCode.INVALID_DATA_URI,
                'Not a valid data URI',
                url,
            ),
        );
    }

    const decoded = decodeDataUri(dataUri);
    if (decoded === null) {
        return Err(
            createDataUriError(
                SourceMapErrorCode.INVALID_BASE64,
                'Failed to decode base64 content from data URI',
                url,
            ),
        );
    }

    return tryParseSourceMap(decoded, url);
}

/**
 * Parses a source map from either a JSON string or data URI.
 * Automatically detects the format. Returns a Result instead of throwing.
 *
 * @param content - Either JSON string or data URI
 * @param url - The URL context (for error messages)
 * @returns Result with validated SourceMapV3 or SourceMapError
 */
export function tryParseSourceMapAuto(
    content: string,
    url?: string,
): Result<SourceMapV3, SourceMapError> {
    if (isDataUri(content)) {
        return tryParseInlineSourceMap(content, url);
    }
    return tryParseSourceMap(content, url);
}

// ============================================================================
// THROWING API (Legacy compatibility)
// ============================================================================

/**
 * Parses and validates a source map from JSON string.
 *
 * @param content - The JSON string content
 * @param url - The URL of the source map (for error messages)
 * @returns Validated SourceMapV3 object
 * @throws \{SourceMapError\} When JSON parsing fails (INVALID_JSON code)
 * @throws \{SourceMapError\} When validation fails (various validation error codes)
 */
export function parseSourceMap(content: string, url?: string): SourceMapV3 {
    const result = tryParseSourceMap(content, url);
    if (result.ok) {
        return result.value;
    }
    throw result.error;
}

/**
 * Parses a source map from an inline base64 data URI.
 *
 * @param dataUri - The data URI string (data:application/json;base64,...)
 * @param url - The URL context (for error messages)
 * @returns Validated SourceMapV3 object
 * @throws \{SourceMapError\} When the data URI format is invalid (INVALID_DATA_URI code)
 * @throws \{SourceMapError\} When base64 decoding fails (INVALID_BASE64 code)
 * @throws \{SourceMapError\} When JSON parsing or validation fails
 */
export function parseInlineSourceMap(
    dataUri: string,
    url?: string,
): SourceMapV3 {
    const result = tryParseInlineSourceMap(dataUri, url);
    if (result.ok) {
        return result.value;
    }
    throw result.error;
}

/**
 * Parses a source map from either a JSON string or data URI.
 * Automatically detects the format.
 *
 * @param content - Either JSON string or data URI
 * @param url - The URL context (for error messages)
 * @returns Validated SourceMapV3 object
 * @throws \{SourceMapError\} When parsing or validation fails
 *
 * @example
 * ```typescript
 * // Works with both JSON and data URIs
 * const map1 = parseSourceMapAuto('{"version":3,"sources":[],"mappings":""}');
 * const map2 = parseSourceMapAuto('data:application/json;base64,eyJ2ZXJzaW9uIjozfQ==');
 * ```
 */
export function parseSourceMapAuto(content: string, url?: string): SourceMapV3 {
    const result = tryParseSourceMapAuto(content, url);
    if (result.ok) {
        return result.value;
    }
    throw result.error;
}
