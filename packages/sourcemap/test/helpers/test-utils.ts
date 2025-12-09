/**
 * Shared Test Utilities
 *
 * Common helpers for sourcemap package tests.
 */

import type { SourceMapValidationError, SourceMapV3 } from '@web2local/types';

// ============================================================================
// ERROR MATCHING HELPERS
// ============================================================================

/**
 * Checks if any error in the array has the specified error code.
 *
 * @param errors - Array of validation errors
 * @param code - The error code to search for
 * @returns true if an error with the code exists
 */
export function hasErrorCode(
    errors: readonly SourceMapValidationError[],
    code: string,
): boolean {
    return errors.some((e) => e.code === code);
}

/**
 * Checks if any error in the array contains the specified substring in its message.
 *
 * @param errors - Array of validation errors
 * @param substring - The substring to search for in error messages
 * @returns true if an error message containing the substring exists
 */
export function hasErrorMessage(
    errors: readonly SourceMapValidationError[],
    substring: string,
): boolean {
    return errors.some((e) => e.message.includes(substring));
}

/**
 * Checks if any error in the array has the specified field.
 *
 * @param errors - Array of validation errors
 * @param field - The field name to search for
 * @returns true if an error with the field exists
 */
export function hasErrorField(
    errors: readonly SourceMapValidationError[],
    field: string,
): boolean {
    return errors.some((e) => e.field === field);
}

// ============================================================================
// TEST DATA FACTORIES
// ============================================================================

/**
 * Creates a minimal valid source map for testing.
 *
 * @param overrides - Optional fields to override
 * @returns A valid SourceMapV3 object
 */
export function createMinimalSourceMap(
    overrides?: Partial<SourceMapV3>,
): SourceMapV3 {
    return {
        version: 3,
        sources: ['test.js'],
        mappings: '',
        ...overrides,
    } as SourceMapV3;
}

/**
 * Creates a source map with sources content for testing extraction.
 *
 * @param sources - Array of source file paths
 * @param contents - Array of source file contents
 * @returns A valid SourceMapV3 object with sourcesContent
 */
export function createSourceMapWithContent(
    sources: string[],
    contents: (string | null)[],
): SourceMapV3 {
    return {
        version: 3,
        sources,
        sourcesContent: contents,
        mappings: '',
    } as SourceMapV3;
}
