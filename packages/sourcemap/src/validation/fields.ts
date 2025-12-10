/**
 * Source Map Field Validators
 *
 * Individual field validation functions for source map properties.
 * Used by both regular source map and index map validators.
 */

import type { SourceMapValidationError } from '@web2local/types';
import { SourceMapErrorCode, createValidationErrorResult } from '../errors.js';
import { SUPPORTED_SOURCE_MAP_VERSION } from '../constants.js';
import { validateMappings } from '../mappings.js';

// ============================================================================
// RAW SOURCE MAP TYPES (before validation)
// ============================================================================

export interface RawSourceMap {
    version?: unknown;
    file?: unknown;
    sourceRoot?: unknown;
    sources?: unknown;
    sourcesContent?: unknown;
    names?: unknown;
    mappings?: unknown;
    ignoreList?: unknown;
    sections?: unknown;
    [key: string]: unknown;
}

export interface RawIndexMapSection {
    offset?: unknown;
    map?: unknown;
    [key: string]: unknown;
}

export interface RawIndexMapOffset {
    line?: unknown;
    column?: unknown;
    [key: string]: unknown;
}

// ============================================================================
// FIELD VALIDATORS
// ============================================================================

/**
 * Validates the version field (required, must be 3).
 */
export function validateVersion(
    obj: RawSourceMap,
    errors: SourceMapValidationError[],
): void {
    if (obj.version === undefined) {
        errors.push(
            createValidationErrorResult(
                SourceMapErrorCode.MISSING_VERSION,
                'Missing required field: version',
                'version',
            ),
        );
    } else if (obj.version !== SUPPORTED_SOURCE_MAP_VERSION) {
        errors.push(
            createValidationErrorResult(
                SourceMapErrorCode.INVALID_VERSION,
                `Invalid version: expected ${SUPPORTED_SOURCE_MAP_VERSION}, got ${obj.version}`,
                'version',
            ),
        );
    }
}

/**
 * Validates the sources field (required, must be array of strings or null).
 */
export function validateSources(
    obj: RawSourceMap,
    errors: SourceMapValidationError[],
): void {
    if (obj.sources === undefined) {
        errors.push(
            createValidationErrorResult(
                SourceMapErrorCode.MISSING_SOURCES,
                'Missing required field: sources',
                'sources',
            ),
        );
    } else if (!Array.isArray(obj.sources)) {
        errors.push(
            createValidationErrorResult(
                SourceMapErrorCode.SOURCES_NOT_ARRAY,
                'Field "sources" must be an array',
                'sources',
            ),
        );
    } else if (!obj.sources.every((s) => typeof s === 'string' || s === null)) {
        errors.push(
            createValidationErrorResult(
                SourceMapErrorCode.SOURCES_NOT_ARRAY,
                'All entries in "sources" must be strings or null',
                'sources',
            ),
        );
    }
}

/**
 * Validates the mappings field (required, must be string).
 */
export function validateMappingsField(
    obj: RawSourceMap,
    errors: SourceMapValidationError[],
): void {
    if (obj.mappings === undefined) {
        errors.push(
            createValidationErrorResult(
                SourceMapErrorCode.MISSING_MAPPINGS,
                'Missing required field: mappings',
                'mappings',
            ),
        );
    } else if (typeof obj.mappings !== 'string') {
        errors.push(
            createValidationErrorResult(
                SourceMapErrorCode.MISSING_MAPPINGS,
                'Field "mappings" must be a string',
                'mappings',
            ),
        );
    }
}

/**
 * Validates the sourcesContent field (optional, must be array of strings or null).
 */
export function validateSourcesContent(
    obj: RawSourceMap,
    errors: SourceMapValidationError[],
    warnings: string[],
): void {
    if (obj.sourcesContent === undefined) return;

    if (!Array.isArray(obj.sourcesContent)) {
        errors.push(
            createValidationErrorResult(
                SourceMapErrorCode.INVALID_SOURCES_CONTENT,
                'Field "sourcesContent" must be an array',
                'sourcesContent',
            ),
        );
        return;
    }

    // Check that all entries are strings or null
    if (!obj.sourcesContent.every((c) => typeof c === 'string' || c === null)) {
        errors.push(
            createValidationErrorResult(
                SourceMapErrorCode.INVALID_SOURCES_CONTENT,
                'All entries in "sourcesContent" must be strings or null',
                'sourcesContent',
            ),
        );
    }

    // Length mismatch is a warning, not an error
    if (
        Array.isArray(obj.sources) &&
        obj.sourcesContent.length !== obj.sources.length
    ) {
        warnings.push(
            `sourcesContent length (${obj.sourcesContent.length}) does not match sources length (${obj.sources.length})`,
        );
    }
}

/**
 * Validates the names field (optional, must be array of strings).
 */
export function validateNames(
    obj: RawSourceMap,
    errors: SourceMapValidationError[],
): void {
    if (obj.names === undefined) return;

    if (!Array.isArray(obj.names)) {
        errors.push(
            createValidationErrorResult(
                SourceMapErrorCode.INVALID_NAMES,
                'Field "names" must be an array',
                'names',
            ),
        );
    } else if (!obj.names.every((n) => typeof n === 'string')) {
        errors.push(
            createValidationErrorResult(
                SourceMapErrorCode.INVALID_NAMES,
                'All entries in "names" must be strings',
                'names',
            ),
        );
    }
}

/**
 * Validates an optional string field (sourceRoot, file).
 */
export function validateOptionalStringField(
    obj: RawSourceMap,
    field: 'sourceRoot' | 'file',
    errorCode: SourceMapErrorCode,
    errors: SourceMapValidationError[],
): void {
    if (obj[field] !== undefined && typeof obj[field] !== 'string') {
        errors.push(
            createValidationErrorResult(
                errorCode,
                `Field "${field}" must be a string`,
                field,
            ),
        );
    }
}

/**
 * Validates the ignoreList field (optional, must be array of valid indices).
 */
export function validateIgnoreList(
    obj: RawSourceMap,
    errors: SourceMapValidationError[],
): void {
    if (obj.ignoreList === undefined) return;

    if (!Array.isArray(obj.ignoreList)) {
        errors.push(
            createValidationErrorResult(
                SourceMapErrorCode.INVALID_IGNORE_LIST,
                'Field "ignoreList" must be an array',
                'ignoreList',
            ),
        );
        return;
    }

    // Check that all entries are non-negative integers
    const hasInvalidType = obj.ignoreList.some(
        (idx) => typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0,
    );

    if (hasInvalidType) {
        errors.push(
            createValidationErrorResult(
                SourceMapErrorCode.INVALID_IGNORE_LIST,
                'All entries in "ignoreList" must be non-negative integers',
                'ignoreList',
            ),
        );
        return;
    }

    // Check bounds (only if sources is valid)
    if (Array.isArray(obj.sources)) {
        const sourcesLength = obj.sources.length;
        const hasOutOfBounds = obj.ignoreList.some(
            (idx) => (idx as number) >= sourcesLength,
        );
        if (hasOutOfBounds) {
            errors.push(
                createValidationErrorResult(
                    SourceMapErrorCode.INVALID_IGNORE_LIST,
                    'ignoreList contains index out of bounds of sources array',
                    'ignoreList',
                ),
            );
        }
    }
}

/**
 * Validates VLQ mappings content (only if structural prerequisites are met).
 */
export function validateVlqMappings(
    obj: RawSourceMap,
    errors: SourceMapValidationError[],
): void {
    // Only validate if we have valid structural prerequisites
    if (typeof obj.mappings !== 'string' || !Array.isArray(obj.sources)) {
        return;
    }

    const sourcesLength = obj.sources.length;
    const namesLength = Array.isArray(obj.names) ? obj.names.length : 0;
    const mappingsResult = validateMappings(
        obj.mappings,
        sourcesLength,
        namesLength,
    );
    errors.push(...mappingsResult.errors);
}
