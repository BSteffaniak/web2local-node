/**
 * Source Map Parser
 *
 * Parses and validates source map JSON content.
 * Handles both external source maps and inline base64 data URIs.
 */

import type {
    SourceMapV3,
    SourceMapValidationResult,
    SourceMapValidationError,
} from '@web2local/types';
import {
    SourceMapErrorCode,
    SourceMapError,
    createParseError,
    createValidationError,
    createDataUriError,
} from './errors.js';
import {
    SUPPORTED_SOURCE_MAP_VERSION,
    ERROR_PREVIEW_LENGTH,
} from './constants.js';
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
// VALIDATION HELPERS
// ============================================================================

/**
 * Creates a structured validation error.
 */
function validationError(
    code: SourceMapErrorCode,
    message: string,
    field?: string,
): SourceMapValidationError {
    return { code, message, field };
}

// ============================================================================
// VALIDATION
// ============================================================================

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
 * @returns Validation result with structured errors (including error codes)
 */
export function validateSourceMap(raw: unknown): SourceMapValidationResult {
    const errors: SourceMapValidationError[] = [];
    const warnings: string[] = [];

    if (typeof raw !== 'object' || raw === null) {
        return {
            valid: false,
            errors: [
                validationError(
                    SourceMapErrorCode.INVALID_JSON,
                    'Source map must be an object',
                ),
            ],
            warnings: [],
        };
    }

    const obj = raw as RawSourceMap;

    // Version check
    if (obj.version === undefined) {
        errors.push(
            validationError(
                SourceMapErrorCode.MISSING_VERSION,
                'Missing required field: version',
                'version',
            ),
        );
    } else if (obj.version !== SUPPORTED_SOURCE_MAP_VERSION) {
        errors.push(
            validationError(
                SourceMapErrorCode.INVALID_VERSION,
                `Invalid version: expected ${SUPPORTED_SOURCE_MAP_VERSION}, got ${obj.version}`,
                'version',
            ),
        );
    }

    // Sources check
    if (obj.sources === undefined) {
        errors.push(
            validationError(
                SourceMapErrorCode.MISSING_SOURCES,
                'Missing required field: sources',
                'sources',
            ),
        );
    } else if (!Array.isArray(obj.sources)) {
        errors.push(
            validationError(
                SourceMapErrorCode.SOURCES_NOT_ARRAY,
                'Field "sources" must be an array',
                'sources',
            ),
        );
    } else if (!obj.sources.every((s) => typeof s === 'string')) {
        errors.push(
            validationError(
                SourceMapErrorCode.SOURCES_NOT_ARRAY,
                'All entries in "sources" must be strings',
                'sources',
            ),
        );
    }

    // Mappings check
    if (obj.mappings === undefined) {
        errors.push(
            validationError(
                SourceMapErrorCode.MISSING_MAPPINGS,
                'Missing required field: mappings',
                'mappings',
            ),
        );
    } else if (typeof obj.mappings !== 'string') {
        errors.push(
            validationError(
                SourceMapErrorCode.MISSING_MAPPINGS,
                'Field "mappings" must be a string',
                'mappings',
            ),
        );
    }

    // sourcesContent check (optional but validated if present)
    if (obj.sourcesContent !== undefined) {
        if (!Array.isArray(obj.sourcesContent)) {
            errors.push(
                validationError(
                    SourceMapErrorCode.SOURCES_NOT_ARRAY,
                    'Field "sourcesContent" must be an array',
                    'sourcesContent',
                ),
            );
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
        errors.push(
            validationError(
                SourceMapErrorCode.INVALID_SOURCE_ROOT,
                'Field "sourceRoot" must be a string',
                'sourceRoot',
            ),
        );
    }

    // names check (optional)
    if (obj.names !== undefined) {
        if (!Array.isArray(obj.names)) {
            errors.push(
                validationError(
                    SourceMapErrorCode.INVALID_NAMES,
                    'Field "names" must be an array',
                    'names',
                ),
            );
        } else if (!obj.names.every((n) => typeof n === 'string')) {
            errors.push(
                validationError(
                    SourceMapErrorCode.INVALID_NAMES,
                    'All entries in "names" must be strings',
                    'names',
                ),
            );
        }
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings,
    };
}

/**
 * Type guard that checks if a value is a valid SourceMapV3.
 * Uses validateSourceMap internally for validation.
 *
 * @param value - The value to check
 * @returns true if the value is a valid SourceMapV3
 */
export function isSourceMapV3(value: unknown): value is SourceMapV3 {
    return validateSourceMap(value).valid;
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
        const preview = content
            .slice(0, ERROR_PREVIEW_LENGTH)
            .replace(/\n/g, ' ');
        throw createParseError(
            `Failed to parse source map JSON: ${e instanceof Error ? e.message : String(e)}`,
            url ?? 'unknown',
            preview,
        );
    }

    // Validate structure (single validation call)
    const validation = validateSourceMap(parsed);
    if (validation.valid) {
        return parsed as SourceMapV3;
    }

    // Build error message from validation errors
    const firstError = validation.errors[0];
    const errorCode = firstError?.code as SourceMapErrorCode;
    const errorMessages = validation.errors.map((e) => e.message).join('; ');

    throw createValidationError(
        errorCode ?? SourceMapErrorCode.INVALID_VERSION,
        `Invalid source map: ${errorMessages}`,
        url,
        {
            errors: validation.errors,
            warnings: validation.warnings,
        },
    );
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
