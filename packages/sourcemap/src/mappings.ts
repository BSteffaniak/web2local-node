/**
 * Source Map Mappings Validation
 *
 * Validates VLQ-encoded mappings strings per ECMA-426 specification.
 * Uses a custom VLQ decoder for strict spec compliance.
 *
 * @see https://tc39.es/ecma426/
 */

import type { SourceMapValidationError } from '@web2local/types';
import { SourceMapErrorCode, createValidationErrorResult } from './errors.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Valid base64 characters for VLQ encoding
 * @see https://tc39.es/ecma426/#sec-mappings
 */
const BASE64_CHARS = new Set(
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
);

/**
 * Maximum value for 32-bit signed integer (2^31 - 1)
 * Per ECMA-426, all VLQ values must fit in a 32-bit signed integer
 */
const MAX_INT32 = 2147483647;

/**
 * Minimum value for 32-bit signed integer (-2^31)
 */
const MIN_INT32 = -2147483648;

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

// Alias for convenience within this module
const validationError = createValidationErrorResult;

/**
 * Check if a character is a valid base64 character for VLQ
 */
function isValidBase64Char(char: string): boolean {
    return BASE64_CHARS.has(char);
}

/**
 * Pre-validate the mappings string for invalid characters.
 * The ECMA-426 spec requires that mappings only contain:
 * - Base64 characters (A-Z, a-z, 0-9, +, /)
 * - Comma (,) - segment separator
 * - Semicolon (;) - line separator
 */
function validateMappingsChars(
    mappings: string,
): SourceMapValidationError | null {
    for (let i = 0; i < mappings.length; i++) {
        const char = mappings[i];
        if (char !== ',' && char !== ';' && !isValidBase64Char(char)) {
            return validationError(
                SourceMapErrorCode.INVALID_VLQ,
                `Invalid VLQ: contains non-base64 character '${char}' at position ${i}`,
                'mappings',
            );
        }
    }
    return null;
}

/**
 * Manually decode a VLQ segment to get raw relative values.
 * This is needed to properly validate 32-bit overflow and other constraints.
 *
 * Note: We use multiplication instead of bit shifting to handle values > 32 bits,
 * since JavaScript's << operator only works with 32-bit integers.
 */
function decodeVLQSegment(segment: string): number[] | Error {
    const values: number[] = [];
    let shift = 0;
    let value = 0;

    for (let i = 0; i < segment.length; i++) {
        const charCode = segment.charCodeAt(i);

        // Convert base64 character to 6-bit value
        let digit: number;
        if (charCode >= 65 && charCode <= 90) {
            // A-Z
            digit = charCode - 65;
        } else if (charCode >= 97 && charCode <= 122) {
            // a-z
            digit = charCode - 97 + 26;
        } else if (charCode >= 48 && charCode <= 57) {
            // 0-9
            digit = charCode - 48 + 52;
        } else if (charCode === 43) {
            // +
            digit = 62;
        } else if (charCode === 47) {
            // /
            digit = 63;
        } else {
            return new Error(
                `Invalid character '${String.fromCharCode(charCode)}'`,
            );
        }

        // Lower 5 bits are the value, bit 5 is the continuation flag
        const hasContinuation = (digit & 32) !== 0;
        const dataBits = digit & 31;

        // Use multiplication instead of bit shift to handle values > 32 bits
        // Math.pow(2, shift) is the same as (1 << shift) but works for large shifts
        value += dataBits * Math.pow(2, shift);
        shift += 5;

        if (!hasContinuation) {
            // Convert from VLQ sign representation
            // Bit 0 is the sign bit
            let decoded: number;
            if (value % 2 === 1) {
                // Use floor division for large values
                decoded = -Math.floor(value / 2);
            } else {
                decoded = Math.floor(value / 2);
            }
            values.push(decoded);
            value = 0;
            shift = 0;
        }
    }

    // If we ended with a continuation bit set, the VLQ is invalid
    if (shift !== 0) {
        return new Error('Missing continuation digits');
    }

    return values;
}

/**
 * Check if a segment string contains an empty segment (consecutive commas or leading/trailing comma)
 */
function hasEmptySegment(mappings: string): boolean {
    // Check for empty segments between commas (,,)
    if (mappings.includes(',,')) return true;

    // Check each line for empty segments
    const lines = mappings.split(';');
    for (const line of lines) {
        // Empty line is OK (just a semicolon)
        if (line === '') continue;

        // Check for leading or trailing comma
        if (line.startsWith(',') || line.endsWith(',')) return true;
    }
    return false;
}

// ============================================================================
// MAPPINGS VALIDATION
// ============================================================================

/**
 * Result of mappings validation
 */
export interface MappingsValidationResult {
    valid: boolean;
    errors: SourceMapValidationError[];
}

/**
 * Validates a mappings string against the ECMA-426 specification.
 *
 * Checks:
 * - Valid VLQ encoding (base64 characters, proper continuation bits)
 * - Valid segment structure (0, 1, 4, or 5 fields per segment)
 * - Valid separators (comma between segments, semicolon between lines)
 * - Values within 32-bit signed integer range
 * - Absolute values are non-negative for column, line, source index, etc.
 * - Source/name indices within bounds of sources/names arrays
 *
 * @param mappings - The VLQ-encoded mappings string
 * @param sourcesLength - Length of the sources array (for bounds checking)
 * @param namesLength - Length of the names array (for bounds checking)
 * @returns Validation result with structured errors
 */
export function validateMappings(
    mappings: string,
    sourcesLength: number,
    namesLength: number,
): MappingsValidationResult {
    const errors: SourceMapValidationError[] = [];

    // Empty mappings is valid
    if (mappings === '') {
        return { valid: true, errors: [] };
    }

    // First, validate that all characters are valid
    const charError = validateMappingsChars(mappings);
    if (charError) {
        errors.push(charError);
        return { valid: false, errors };
    }

    // Check for empty segments (consecutive commas)
    if (hasEmptySegment(mappings)) {
        errors.push(
            validationError(
                SourceMapErrorCode.INVALID_MAPPING_SEGMENT,
                'Invalid mapping: contains empty segment (0 fields)',
                'mappings',
            ),
        );
        return { valid: false, errors };
    }

    // Parse and validate each segment manually to check raw VLQ values
    const lines = mappings.split(';');

    // Track accumulated state for absolute value validation
    // (per ECMA-426, these accumulate across the entire mappings string)
    let accSourceIndex = 0;
    let accOriginalLine = 0;
    let accOriginalColumn = 0;
    let accNameIndex = 0;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        if (line === '') continue; // Empty line is OK

        const segments = line.split(',');

        // Column resets to 0 for each new line
        let accColumn = 0;

        for (let segIndex = 0; segIndex < segments.length; segIndex++) {
            const segmentStr = segments[segIndex];
            const segmentLocation = `line ${lineIndex}, segment ${segIndex}`;

            // Decode the raw VLQ values
            const rawValues = decodeVLQSegment(segmentStr);
            if (rawValues instanceof Error) {
                errors.push(
                    validationError(
                        SourceMapErrorCode.INVALID_VLQ,
                        `Invalid VLQ at ${segmentLocation}: ${rawValues.message}`,
                        'mappings',
                    ),
                );
                continue;
            }

            // Validate segment field count (must be 1, 4, or 5 fields)
            if (rawValues.length === 0) {
                // This shouldn't happen if we already checked for empty segments
                errors.push(
                    validationError(
                        SourceMapErrorCode.INVALID_MAPPING_SEGMENT,
                        `Invalid mapping segment at ${segmentLocation}: empty segment (0 fields)`,
                        'mappings',
                    ),
                );
                continue;
            }

            if (rawValues.length === 2 || rawValues.length === 3) {
                errors.push(
                    validationError(
                        SourceMapErrorCode.INVALID_MAPPING_SEGMENT,
                        `Invalid mapping segment at ${segmentLocation}: ${rawValues.length} fields (must be 1, 4, or 5)`,
                        'mappings',
                    ),
                );
                continue;
            }

            if (rawValues.length > 5) {
                errors.push(
                    validationError(
                        SourceMapErrorCode.INVALID_MAPPING_SEGMENT,
                        `Invalid mapping segment at ${segmentLocation}: ${rawValues.length} fields (must be 1, 4, or 5)`,
                        'mappings',
                    ),
                );
                continue;
            }

            // Check all raw values are within 32-bit range
            for (let i = 0; i < rawValues.length; i++) {
                const value = rawValues[i];
                if (value > MAX_INT32 || value < MIN_INT32) {
                    const fieldName = getFieldName(i);
                    errors.push(
                        validationError(
                            SourceMapErrorCode.MAPPING_VALUE_EXCEEDS_32_BITS,
                            `Mapping ${fieldName} at ${segmentLocation} exceeds 32-bit range: ${value}`,
                            'mappings',
                        ),
                    );
                }
            }

            // Accumulate and validate absolute values
            // Field 0: Generated column (relative within line)
            accColumn += rawValues[0];
            if (accColumn < 0) {
                errors.push(
                    validationError(
                        SourceMapErrorCode.MAPPING_NEGATIVE_VALUE,
                        `Mapping column at ${segmentLocation} is negative: ${accColumn}`,
                        'mappings',
                    ),
                );
            }

            // If segment has 4 or 5 fields, validate source mapping
            if (rawValues.length >= 4) {
                // Field 1: Source index (relative across all segments)
                accSourceIndex += rawValues[1];
                if (accSourceIndex < 0) {
                    errors.push(
                        validationError(
                            SourceMapErrorCode.MAPPING_NEGATIVE_VALUE,
                            `Mapping source index at ${segmentLocation} is negative: ${accSourceIndex}`,
                            'mappings',
                        ),
                    );
                } else if (accSourceIndex >= sourcesLength) {
                    errors.push(
                        validationError(
                            SourceMapErrorCode.MAPPING_SOURCE_INDEX_OUT_OF_BOUNDS,
                            `Mapping source index at ${segmentLocation} is out of bounds: ${accSourceIndex} >= ${sourcesLength}`,
                            'mappings',
                        ),
                    );
                }

                // Field 2: Original line (relative across all segments)
                accOriginalLine += rawValues[2];
                if (accOriginalLine < 0) {
                    errors.push(
                        validationError(
                            SourceMapErrorCode.MAPPING_NEGATIVE_VALUE,
                            `Mapping original line at ${segmentLocation} is negative: ${accOriginalLine}`,
                            'mappings',
                        ),
                    );
                }

                // Field 3: Original column (relative across all segments)
                accOriginalColumn += rawValues[3];
                if (accOriginalColumn < 0) {
                    errors.push(
                        validationError(
                            SourceMapErrorCode.MAPPING_NEGATIVE_VALUE,
                            `Mapping original column at ${segmentLocation} is negative: ${accOriginalColumn}`,
                            'mappings',
                        ),
                    );
                }
            }

            // If segment has 5 fields, validate name mapping
            if (rawValues.length === 5) {
                // Field 4: Name index (relative across all segments)
                accNameIndex += rawValues[4];
                if (accNameIndex < 0) {
                    errors.push(
                        validationError(
                            SourceMapErrorCode.MAPPING_NEGATIVE_VALUE,
                            `Mapping name index at ${segmentLocation} is negative: ${accNameIndex}`,
                            'mappings',
                        ),
                    );
                } else if (accNameIndex >= namesLength) {
                    errors.push(
                        validationError(
                            SourceMapErrorCode.MAPPING_NAME_INDEX_OUT_OF_BOUNDS,
                            `Mapping name index at ${segmentLocation} is out of bounds: ${accNameIndex} >= ${namesLength}`,
                            'mappings',
                        ),
                    );
                }
            }
        }
    }

    return {
        valid: errors.length === 0,
        errors,
    };
}

/**
 * Human-readable field names for VLQ mapping segments
 * Index 0-4 correspond to the 5 possible fields in a mapping segment
 */
const MAPPING_FIELD_NAMES = [
    'column',
    'source index',
    'original line',
    'original column',
    'name index',
] as const;

/**
 * Get human-readable field name for error messages
 */
function getFieldName(index: number): string {
    return MAPPING_FIELD_NAMES[index] ?? `field ${index}`;
}
