/**
 * Index Map Validator
 *
 * Validates index maps (source maps with sections) against the ECMA-426 specification.
 */

import type {
    SourceMapValidationResult,
    SourceMapValidationError,
} from '@web2local/types';
import { SourceMapErrorCode, createValidationErrorResult } from '../errors.js';
import {
    type RawSourceMap,
    type RawIndexMapSection,
    type RawIndexMapOffset,
    validateVersion,
    validateOptionalStringField,
} from './fields.js';
import { validateRegularSourceMap } from './source-map.js';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Represents a validated index map offset with line and column.
 */
export interface ValidatedOffset {
    /** Zero-based line number in the generated code. */
    line: number;
    /** Zero-based column number in the generated code. */
    column: number;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Checks if a raw source map object is an index map (has sections field).
 * Per ECMA-426, an index map has `sections` instead of `sources`/`mappings`.
 *
 * @param obj - The raw source map object to check
 * @returns true if the object has a sections field
 */
export function isIndexMap(obj: RawSourceMap): boolean {
    return 'sections' in obj;
}

/**
 * Validates section.offset field structure and values.
 * Returns the validated offset if valid, null otherwise.
 *
 * @param section - The raw section object to validate
 * @param fieldPrefix - Prefix for error field paths (e.g., "sections[0]")
 * @param errors - Array to push validation errors into
 * @returns The validated offset if valid, null otherwise
 */
export function validateSectionOffset(
    section: RawIndexMapSection,
    fieldPrefix: string,
    errors: SourceMapValidationError[],
): ValidatedOffset | null {
    if (section.offset === undefined) {
        errors.push(
            createValidationErrorResult(
                SourceMapErrorCode.INVALID_INDEX_MAP_OFFSET,
                `${fieldPrefix}.offset is required`,
                `${fieldPrefix}.offset`,
            ),
        );
        return null;
    }

    if (typeof section.offset !== 'object' || section.offset === null) {
        errors.push(
            createValidationErrorResult(
                SourceMapErrorCode.INVALID_INDEX_MAP_OFFSET,
                `${fieldPrefix}.offset must be an object`,
                `${fieldPrefix}.offset`,
            ),
        );
        return null;
    }

    const offset = section.offset as RawIndexMapOffset;
    let lineValid = false;
    let columnValid = false;

    // Validate offset.line
    if (offset.line === undefined) {
        errors.push(
            createValidationErrorResult(
                SourceMapErrorCode.INVALID_INDEX_MAP_OFFSET,
                `${fieldPrefix}.offset.line is required`,
                `${fieldPrefix}.offset.line`,
            ),
        );
    } else if (
        typeof offset.line !== 'number' ||
        !Number.isInteger(offset.line) ||
        offset.line < 0
    ) {
        errors.push(
            createValidationErrorResult(
                SourceMapErrorCode.INVALID_INDEX_MAP_OFFSET,
                `${fieldPrefix}.offset.line must be a non-negative integer`,
                `${fieldPrefix}.offset.line`,
            ),
        );
    } else {
        lineValid = true;
    }

    // Validate offset.column
    if (offset.column === undefined) {
        errors.push(
            createValidationErrorResult(
                SourceMapErrorCode.INVALID_INDEX_MAP_OFFSET,
                `${fieldPrefix}.offset.column is required`,
                `${fieldPrefix}.offset.column`,
            ),
        );
    } else if (
        typeof offset.column !== 'number' ||
        !Number.isInteger(offset.column) ||
        offset.column < 0
    ) {
        errors.push(
            createValidationErrorResult(
                SourceMapErrorCode.INVALID_INDEX_MAP_OFFSET,
                `${fieldPrefix}.offset.column must be a non-negative integer`,
                `${fieldPrefix}.offset.column`,
            ),
        );
    } else {
        columnValid = true;
    }

    // Return validated offset only if both line and column are valid
    if (lineValid && columnValid) {
        return {
            line: offset.line as number,
            column: offset.column as number,
        };
    }
    return null;
}

/**
 * Validates section ordering and overlap against previous section.
 *
 * @param current - The current section's validated offset
 * @param prev - The previous section's validated offset, or null if first section
 * @param fieldPrefix - Prefix for error field paths (e.g., "sections[1]")
 * @param errors - Array to push validation errors into
 */
export function validateSectionOrdering(
    current: ValidatedOffset,
    prev: ValidatedOffset | null,
    fieldPrefix: string,
    errors: SourceMapValidationError[],
): void {
    if (prev === null) return;

    // Check for invalid order (current section starts before previous)
    if (
        current.line < prev.line ||
        (current.line === prev.line && current.column < prev.column)
    ) {
        errors.push(
            createValidationErrorResult(
                SourceMapErrorCode.INDEX_MAP_INVALID_ORDER,
                `${fieldPrefix} has offset before previous section (sections must be in order)`,
                `${fieldPrefix}.offset`,
            ),
        );
    }
    // Check for overlap (same position as previous)
    else if (current.line === prev.line && current.column === prev.column) {
        errors.push(
            createValidationErrorResult(
                SourceMapErrorCode.INDEX_MAP_OVERLAP,
                `${fieldPrefix} overlaps with previous section (same offset)`,
                `${fieldPrefix}.offset`,
            ),
        );
    }
}

/**
 * Validates section.map field.
 *
 * @param section - The raw section object to validate
 * @param fieldPrefix - Prefix for error field paths (e.g., "sections[0]")
 * @param errors - Array to push validation errors into
 * @param warnings - Array to push validation warnings into
 */
export function validateSectionMap(
    section: RawIndexMapSection,
    fieldPrefix: string,
    errors: SourceMapValidationError[],
    warnings: string[],
): void {
    if (section.map === undefined) {
        errors.push(
            createValidationErrorResult(
                SourceMapErrorCode.INVALID_INDEX_MAP_SECTION_MAP,
                `${fieldPrefix}.map is required`,
                `${fieldPrefix}.map`,
            ),
        );
        return;
    }

    if (typeof section.map !== 'object' || section.map === null) {
        errors.push(
            createValidationErrorResult(
                SourceMapErrorCode.INVALID_INDEX_MAP_SECTION_MAP,
                `${fieldPrefix}.map must be an object`,
                `${fieldPrefix}.map`,
            ),
        );
        return;
    }

    const sectionMap = section.map as RawSourceMap;

    // Check for nested index map (not allowed per spec)
    if (isIndexMap(sectionMap)) {
        errors.push(
            createValidationErrorResult(
                SourceMapErrorCode.INDEX_MAP_NESTED,
                `${fieldPrefix}.map cannot be an index map (nested index maps not allowed)`,
                `${fieldPrefix}.map`,
            ),
        );
        return;
    }

    // Recursively validate the section map as a regular source map
    const sectionResult = validateRegularSourceMap(sectionMap);
    for (const error of sectionResult.errors) {
        errors.push(
            createValidationErrorResult(
                error.code as SourceMapErrorCode,
                `${fieldPrefix}.map: ${error.message}`,
                error.field
                    ? `${fieldPrefix}.map.${error.field}`
                    : `${fieldPrefix}.map`,
            ),
        );
    }
    for (const warning of sectionResult.warnings) {
        warnings.push(`${fieldPrefix}.map: ${warning}`);
    }
}

// ============================================================================
// MAIN VALIDATION FUNCTION
// ============================================================================

/**
 * Validates an index map against the ECMA-426 spec.
 * Index maps have `sections` array with offset/map pairs instead of sources/mappings.
 *
 * @param obj - The raw source map object (already verified to have sections)
 * @returns Validation result with structured errors
 */
export function validateIndexMap(obj: RawSourceMap): SourceMapValidationResult {
    const errors: SourceMapValidationError[] = [];
    const warnings: string[] = [];

    // Reuse existing validators for common fields
    validateVersion(obj, errors);
    validateOptionalStringField(
        obj,
        'file',
        SourceMapErrorCode.INVALID_FILE,
        errors,
    );

    // Index maps cannot have mappings field (they use sections instead)
    if (obj.mappings !== undefined) {
        errors.push(
            createValidationErrorResult(
                SourceMapErrorCode.INDEX_MAP_WITH_MAPPINGS,
                'Index map cannot have both "sections" and "mappings" fields',
                'mappings',
            ),
        );
    }

    // Sections must be an array
    if (!Array.isArray(obj.sections)) {
        errors.push(
            createValidationErrorResult(
                SourceMapErrorCode.INVALID_INDEX_MAP_SECTIONS,
                'Field "sections" must be an array',
                'sections',
            ),
        );
        return { valid: false, errors, warnings };
    }

    // Validate each section
    let prevOffset: ValidatedOffset | null = null;

    for (let i = 0; i < obj.sections.length; i++) {
        const section = obj.sections[i] as RawIndexMapSection | null;
        const fieldPrefix = `sections[${i}]`;

        // Section must be an object
        if (typeof section !== 'object' || section === null) {
            errors.push(
                createValidationErrorResult(
                    SourceMapErrorCode.INVALID_INDEX_MAP_SECTIONS,
                    `${fieldPrefix} must be an object`,
                    fieldPrefix,
                ),
            );
            continue;
        }

        // Validate offset
        const offset = validateSectionOffset(section, fieldPrefix, errors);
        if (offset !== null) {
            validateSectionOrdering(offset, prevOffset, fieldPrefix, errors);
            prevOffset = offset;
        }

        // Validate map
        validateSectionMap(section, fieldPrefix, errors, warnings);
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings,
    };
}
