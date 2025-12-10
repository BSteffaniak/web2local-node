/**
 * Regular Source Map Validator
 *
 * Validates non-index source maps against the ECMA-426 specification.
 */

import type {
    SourceMapValidationResult,
    SourceMapValidationError,
} from '@web2local/types';
import { SourceMapErrorCode } from '../errors.js';
import {
    type RawSourceMap,
    validateVersion,
    validateSources,
    validateMappingsField,
    validateSourcesContent,
    validateNames,
    validateOptionalStringField,
    validateIgnoreList,
    validateVlqMappings,
} from './fields.js';

/**
 * Validates a regular source map (not index map) against the ECMA-426 spec.
 *
 * @param obj - The raw source map object (already verified to be an object)
 * @returns Validation result with structured errors
 */
export function validateRegularSourceMap(
    obj: RawSourceMap,
): SourceMapValidationResult {
    const errors: SourceMapValidationError[] = [];
    const warnings: string[] = [];

    // Required fields
    validateVersion(obj, errors);
    validateSources(obj, errors);
    validateMappingsField(obj, errors);

    // Optional fields
    validateSourcesContent(obj, errors, warnings);
    validateOptionalStringField(
        obj,
        'sourceRoot',
        SourceMapErrorCode.INVALID_SOURCE_ROOT,
        errors,
    );
    validateNames(obj, errors);
    validateOptionalStringField(
        obj,
        'file',
        SourceMapErrorCode.INVALID_FILE,
        errors,
    );
    validateIgnoreList(obj, errors);

    // VLQ content validation
    validateVlqMappings(obj, errors);

    return {
        valid: errors.length === 0,
        errors,
        warnings,
    };
}
