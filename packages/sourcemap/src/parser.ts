/**
 * Source Map Parser
 *
 * Parses and validates source map JSON content.
 * Handles both external source maps and inline base64 data URIs.
 */

import type { SourceMapV3, SourceMapValidationResult } from '@web2local/types';
import {
    SourceMapErrorCode,
    createParseError,
    createValidationError,
    createDataUriError,
} from './errors.js';
import { SUPPORTED_SOURCE_MAP_VERSION } from './constants.js';
import { decodeDataUri, isDataUri } from './utils/url.js';

// ============================================================================
// RAW SOURCE MAP TYPE (before validation)
// ============================================================================

interface RawSourceMap {
    version?: unknown;
    file?: unknown;
    sourceRoot?: unknown;
    sources?: unknown;
    sourcesContent?: unknown;
    names?: unknown;
    mappings?: unknown;
    [key: string]: unknown;
}

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Determines the most appropriate error code based on validation errors.
 * Returns the first matching error code in priority order.
 *
 * @internal Exported for use by streaming.ts
 */
export function getValidationErrorCode(
    errors: readonly string[],
): SourceMapErrorCode {
    const errorText = errors.join(' ').toLowerCase();

    if (errorText.includes('missing') && errorText.includes('version')) {
        return SourceMapErrorCode.MISSING_VERSION;
    }
    if (errorText.includes('invalid version')) {
        return SourceMapErrorCode.INVALID_VERSION;
    }
    if (errorText.includes('missing') && errorText.includes('sources')) {
        return SourceMapErrorCode.MISSING_SOURCES;
    }
    if (
        errorText.includes('sources') &&
        (errorText.includes('array') || errorText.includes('must be'))
    ) {
        return SourceMapErrorCode.SOURCES_NOT_ARRAY;
    }
    if (errorText.includes('missing') && errorText.includes('mappings')) {
        return SourceMapErrorCode.MISSING_MAPPINGS;
    }

    // Default to INVALID_VERSION for general validation failures
    return SourceMapErrorCode.INVALID_VERSION;
}

/**
 * Validates a raw parsed object against the Source Map V3 specification.
 *
 * Checks:
 * - version === 3
 * - sources is a string array
 * - mappings is a string
 * - sourcesContent (if present) aligns with sources length
 *
 * @param raw - The parsed JSON object
 * @returns Validation result with errors and warnings
 */
export function validateSourceMap(raw: unknown): SourceMapValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (typeof raw !== 'object' || raw === null) {
        return {
            valid: false,
            errors: ['Source map must be an object'],
            warnings: [],
        };
    }

    const obj = raw as RawSourceMap;

    // Version check
    if (obj.version === undefined) {
        errors.push('Missing required field: version');
    } else if (obj.version !== SUPPORTED_SOURCE_MAP_VERSION) {
        errors.push(
            `Invalid version: expected ${SUPPORTED_SOURCE_MAP_VERSION}, got ${obj.version}`,
        );
    }

    // Sources check
    if (obj.sources === undefined) {
        errors.push('Missing required field: sources');
    } else if (!Array.isArray(obj.sources)) {
        errors.push('Field "sources" must be an array');
    } else if (!obj.sources.every((s) => typeof s === 'string')) {
        errors.push('All entries in "sources" must be strings');
    }

    // Mappings check
    if (obj.mappings === undefined) {
        errors.push('Missing required field: mappings');
    } else if (typeof obj.mappings !== 'string') {
        errors.push('Field "mappings" must be a string');
    }

    // sourcesContent check (optional but validated if present)
    if (obj.sourcesContent !== undefined) {
        if (!Array.isArray(obj.sourcesContent)) {
            errors.push('Field "sourcesContent" must be an array');
        } else if (
            Array.isArray(obj.sources) &&
            obj.sourcesContent.length !== obj.sources.length
        ) {
            warnings.push(
                `sourcesContent length (${obj.sourcesContent.length}) does not match sources length (${obj.sources.length})`,
            );
        }
    }

    // sourceRoot check (optional)
    if (obj.sourceRoot !== undefined && typeof obj.sourceRoot !== 'string') {
        errors.push('Field "sourceRoot" must be a string');
    }

    // names check (optional)
    if (obj.names !== undefined) {
        if (!Array.isArray(obj.names)) {
            errors.push('Field "names" must be an array');
        } else if (!obj.names.every((n) => typeof n === 'string')) {
            errors.push('All entries in "names" must be strings');
        }
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings,
    };
}

// ============================================================================
// PARSING
// ============================================================================

/**
 * Parses and validates a source map from JSON string.
 *
 * @param content - The JSON string content
 * @param url - The URL of the source map (for error messages)
 * @returns Validated SourceMapV3 object
 * @throws SourceMapError if parsing or validation fails
 */
export function parseSourceMap(content: string, url?: string): SourceMapV3 {
    // Try to parse JSON
    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    } catch (e) {
        const preview = content.slice(0, 500).replace(/\n/g, ' ');
        throw createParseError(
            `Failed to parse source map JSON: ${e instanceof Error ? e.message : String(e)}`,
            url ?? 'unknown',
            preview,
        );
    }

    // Validate structure
    const validation = validateSourceMap(parsed);
    if (!validation.valid) {
        const errorCode = getValidationErrorCode(validation.errors);
        throw createValidationError(
            errorCode,
            `Invalid source map: ${validation.errors.join('; ')}`,
            url,
            { errors: validation.errors, warnings: validation.warnings },
        );
    }

    // Cast to SourceMapV3 (validation ensures this is safe)
    return parsed as SourceMapV3;
}

/**
 * Parses a source map from an inline base64 data URI.
 *
 * @param dataUri - The data URI string (data:application/json;base64,...)
 * @param url - The URL context (for error messages)
 * @returns Validated SourceMapV3 object
 * @throws SourceMapError if decoding or parsing fails
 */
export function parseInlineSourceMap(
    dataUri: string,
    url?: string,
): SourceMapV3 {
    if (!isDataUri(dataUri)) {
        throw createDataUriError(
            SourceMapErrorCode.INVALID_DATA_URI,
            'Not a valid data URI',
            url,
        );
    }

    const decoded = decodeDataUri(dataUri);
    if (decoded === null) {
        throw createDataUriError(
            SourceMapErrorCode.INVALID_BASE64,
            'Failed to decode base64 content from data URI',
            url,
        );
    }

    return parseSourceMap(decoded, url);
}

/**
 * Parses a source map from either a JSON string or data URI.
 * Automatically detects the format.
 *
 * @param content - Either JSON string or data URI
 * @param url - The URL context (for error messages)
 * @returns Validated SourceMapV3 object
 */
export function parseSourceMapAuto(content: string, url?: string): SourceMapV3 {
    if (isDataUri(content)) {
        return parseInlineSourceMap(content, url);
    }
    return parseSourceMap(content, url);
}
