/**
 * Source Map Mappings Validation
 *
 * Validates VLQ-encoded mappings strings per ECMA-426 specification.
 * Uses a single-pass streaming parser for optimal performance.
 *
 * @see https://tc39.es/ecma426/
 */

import {
    type SourceMapValidationError,
    Err,
    Ok,
    type Result,
} from '@web2local/types';
import { SourceMapErrorCode, createValidationErrorResult } from './errors.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Maximum value for 32-bit signed integer (2^31 - 1)
 * Per ECMA-426, all VLQ values must fit in a 32-bit signed integer
 */
const MAX_INT32 = 0x7fffffff;

/**
 * Minimum value for 32-bit signed integer (-2^31)
 */
const MIN_INT32 = -0x80000000;

/** ASCII code for semicolon (line separator) */
const CHAR_SEMICOLON = 59;

/** ASCII code for comma (segment separator) */
const CHAR_COMMA = 44;

// ============================================================================
// VLQ DECODING
// ============================================================================

/**
 * Convert a base64 character code to its 6-bit value.
 * Returns -1 for invalid characters.
 */
function base64CharToDigit(charCode: number): number {
    // A-Z: 0-25
    if (charCode >= 65 && charCode <= 90) return charCode - 65;
    // a-z: 26-51
    if (charCode >= 97 && charCode <= 122) return charCode - 71;
    // 0-9: 52-61
    if (charCode >= 48 && charCode <= 57) return charCode + 4;
    // +: 62
    if (charCode === 43) return 62;
    // /: 63
    if (charCode === 47) return 63;
    // Invalid character
    return -1;
}

/**
 * Discriminated error types for VLQ decoding.
 * Using error codes instead of string matching for robustness.
 */
type VlqDecodeError =
    | { type: 'invalid_char'; char: string; position: number }
    | { type: 'incomplete' };

/**
 * Decode VLQ values from a segment of the mappings string.
 * Uses the Result pattern with discriminated error types.
 *
 * @param mappings - The full mappings string
 * @param start - Start index of the segment
 * @param end - End index of the segment (exclusive)
 * @returns Result with decoded values or typed error
 */
function decodeVlqSegment(
    mappings: string,
    start: number,
    end: number,
): Result<number[], VlqDecodeError> {
    const values: number[] = [];
    let value = 0;
    let shift = 0;

    for (let pos = start; pos < end; pos++) {
        const charCode = mappings.charCodeAt(pos);
        const digit = base64CharToDigit(charCode);

        if (digit === -1) {
            return Err({
                type: 'invalid_char',
                char: mappings[pos],
                position: pos,
            });
        }

        // Lower 5 bits are the value, bit 5 is the continuation flag
        const hasContinuation = (digit & 32) !== 0;
        const dataBits = digit & 31;

        // Use multiplication to avoid 32-bit overflow in JS bitwise operations
        // Even with shift < 32, dataBits << shift can overflow if result > 2^31
        value += dataBits * Math.pow(2, shift);
        shift += 5;

        if (!hasContinuation) {
            // Convert from VLQ sign representation (bit 0 is sign)
            // value=0 -> 0, value=1 -> -0 (treated as 0)
            // value=2 -> 1, value=3 -> -1
            // value=4 -> 2, value=5 -> -2
            // Formula: positive = floor(value/2), negative = -floor(value/2)
            const decoded =
                (value & 1) === 1
                    ? -Math.floor(value / 2)
                    : Math.floor(value / 2);
            values.push(decoded);
            value = 0;
            shift = 0;
        }
    }

    // If we ended with a continuation bit set, the VLQ is invalid
    if (shift !== 0) {
        return Err({ type: 'incomplete' });
    }

    return Ok(values);
}

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

/**
 * Human-readable field names for VLQ mapping segments
 */
const FIELD_NAMES = [
    'column',
    'source index',
    'original line',
    'original column',
    'name index',
];

function getFieldName(index: number): string {
    return FIELD_NAMES[index] ?? `field ${index}`;
}

// ============================================================================
// MAPPINGS VALIDATION
// ============================================================================

/**
 * Result of mappings validation.
 */
export interface MappingsValidationResult {
    /** Whether the mappings string passed all validation checks. */
    valid: boolean;
    /** Array of validation errors found (empty if valid). */
    errors: SourceMapValidationError[];
}

/**
 * Validates a mappings string against the ECMA-426 specification.
 * Uses a single-pass streaming parser for optimal performance.
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
 *
 * @example
 * ```typescript
 * const result = validateMappings('AAAA;BACA', 2, 0);
 * if (!result.valid) {
 *     console.error('Mapping errors:', result.errors);
 * }
 * ```
 */
export function validateMappings(
    mappings: string,
    sourcesLength: number,
    namesLength: number,
): MappingsValidationResult {
    const errors: SourceMapValidationError[] = [];

    // Empty mappings is valid
    if (mappings.length === 0) {
        return { valid: true, errors: [] };
    }

    // Accumulated state (persists across entire mappings string)
    let accSourceIndex = 0;
    let accOriginalLine = 0;
    let accOriginalColumn = 0;
    let accNameIndex = 0;

    // Per-line state
    let accColumn = 0;
    let lineIndex = 0;
    let segmentIndex = 0;
    let segmentStart = 0;
    let hasSegmentContent = false;

    // Single pass through the mappings string
    for (let pos = 0; pos <= mappings.length; pos++) {
        const charCode = pos < mappings.length ? mappings.charCodeAt(pos) : -1;
        const isEnd = charCode === -1;
        const isSeparator =
            charCode === CHAR_SEMICOLON || charCode === CHAR_COMMA;

        if (isEnd || isSeparator) {
            const segmentEnd = pos;
            const segmentLength = segmentEnd - segmentStart;

            // Check for empty segment (consecutive separators or leading/trailing comma)
            if (segmentLength === 0 && hasSegmentContent) {
                // Empty segment after content on this line (e.g., "AAAA," or "AAAA,,")
                errors.push(
                    createValidationErrorResult(
                        SourceMapErrorCode.INVALID_MAPPING_SEGMENT,
                        'Invalid mapping: contains empty segment (0 fields)',
                        'mappings',
                    ),
                );
                // Skip to next separator
                segmentStart = pos + 1;
                if (charCode === CHAR_SEMICOLON) {
                    lineIndex++;
                    segmentIndex = 0;
                    accColumn = 0;
                    hasSegmentContent = false;
                } else if (charCode === CHAR_COMMA) {
                    segmentIndex++;
                }
                continue;
            }

            if (segmentLength === 0 && charCode === CHAR_COMMA) {
                // Leading comma on a line (e.g., ";,AAAA" or ",AAAA")
                errors.push(
                    createValidationErrorResult(
                        SourceMapErrorCode.INVALID_MAPPING_SEGMENT,
                        'Invalid mapping: contains empty segment (0 fields)',
                        'mappings',
                    ),
                );
                segmentStart = pos + 1;
                segmentIndex++;
                continue;
            }

            // Process non-empty segment
            if (segmentLength > 0) {
                hasSegmentContent = true;
                const segmentLocation = `line ${lineIndex}, segment ${segmentIndex}`;

                // First validate characters and decode VLQ
                const decodeResult = decodeVlqSegment(
                    mappings,
                    segmentStart,
                    segmentEnd,
                );

                if (!decodeResult.ok) {
                    const error = decodeResult.error;
                    if (error.type === 'invalid_char') {
                        errors.push(
                            createValidationErrorResult(
                                SourceMapErrorCode.INVALID_VLQ,
                                `Invalid VLQ: contains non-base64 character '${error.char}' at position ${error.position}`,
                                'mappings',
                            ),
                        );
                        // Return early on invalid character
                        return { valid: false, errors };
                    } else {
                        // error.type === 'incomplete'
                        errors.push(
                            createValidationErrorResult(
                                SourceMapErrorCode.INVALID_VLQ,
                                `Invalid VLQ at ${segmentLocation}: Missing continuation digits`,
                                'mappings',
                            ),
                        );
                    }
                } else {
                    const values = decodeResult.value;

                    // Validate segment field count (must be 1, 4, or 5)
                    // Note: values.length === 0 is unreachable here because:
                    // - Empty segments (segmentLength === 0) are caught earlier
                    // - decodeVlqSegment only succeeds with valid base64 chars, always producing >= 1 value
                    if (values.length === 2 || values.length === 3) {
                        errors.push(
                            createValidationErrorResult(
                                SourceMapErrorCode.INVALID_MAPPING_SEGMENT,
                                `Invalid mapping segment at ${segmentLocation}: ${values.length} fields (must be 1, 4, or 5)`,
                                'mappings',
                            ),
                        );
                    } else if (values.length > 5) {
                        errors.push(
                            createValidationErrorResult(
                                SourceMapErrorCode.INVALID_MAPPING_SEGMENT,
                                `Invalid mapping segment at ${segmentLocation}: ${values.length} fields (must be 1, 4, or 5)`,
                                'mappings',
                            ),
                        );
                    } else {
                        // Valid field count (1, 4, or 5) - validate values

                        // Check all raw values are within 32-bit range
                        for (let i = 0; i < values.length; i++) {
                            const v = values[i];
                            if (v > MAX_INT32 || v < MIN_INT32) {
                                errors.push(
                                    createValidationErrorResult(
                                        SourceMapErrorCode.MAPPING_VALUE_EXCEEDS_32_BITS,
                                        `Mapping ${getFieldName(i)} at ${segmentLocation} exceeds 32-bit range: ${v}`,
                                        'mappings',
                                    ),
                                );
                            }
                        }

                        // Field 0: Generated column (relative within line)
                        accColumn += values[0];
                        if (accColumn < 0) {
                            errors.push(
                                createValidationErrorResult(
                                    SourceMapErrorCode.MAPPING_NEGATIVE_VALUE,
                                    `Mapping column at ${segmentLocation} is negative: ${accColumn}`,
                                    'mappings',
                                ),
                            );
                        }

                        // If segment has 4 or 5 fields, validate source mapping
                        if (values.length >= 4) {
                            // Field 1: Source index
                            accSourceIndex += values[1];
                            if (accSourceIndex < 0) {
                                errors.push(
                                    createValidationErrorResult(
                                        SourceMapErrorCode.MAPPING_NEGATIVE_VALUE,
                                        `Mapping source index at ${segmentLocation} is negative: ${accSourceIndex}`,
                                        'mappings',
                                    ),
                                );
                            } else if (accSourceIndex >= sourcesLength) {
                                errors.push(
                                    createValidationErrorResult(
                                        SourceMapErrorCode.MAPPING_SOURCE_INDEX_OUT_OF_BOUNDS,
                                        `Mapping source index at ${segmentLocation} is out of bounds: ${accSourceIndex} >= ${sourcesLength}`,
                                        'mappings',
                                    ),
                                );
                            }

                            // Field 2: Original line
                            accOriginalLine += values[2];
                            if (accOriginalLine < 0) {
                                errors.push(
                                    createValidationErrorResult(
                                        SourceMapErrorCode.MAPPING_NEGATIVE_VALUE,
                                        `Mapping original line at ${segmentLocation} is negative: ${accOriginalLine}`,
                                        'mappings',
                                    ),
                                );
                            }

                            // Field 3: Original column
                            accOriginalColumn += values[3];
                            if (accOriginalColumn < 0) {
                                errors.push(
                                    createValidationErrorResult(
                                        SourceMapErrorCode.MAPPING_NEGATIVE_VALUE,
                                        `Mapping original column at ${segmentLocation} is negative: ${accOriginalColumn}`,
                                        'mappings',
                                    ),
                                );
                            }
                        }

                        // If segment has 5 fields, validate name mapping
                        if (values.length === 5) {
                            // Field 4: Name index
                            accNameIndex += values[4];
                            if (accNameIndex < 0) {
                                errors.push(
                                    createValidationErrorResult(
                                        SourceMapErrorCode.MAPPING_NEGATIVE_VALUE,
                                        `Mapping name index at ${segmentLocation} is negative: ${accNameIndex}`,
                                        'mappings',
                                    ),
                                );
                            } else if (accNameIndex >= namesLength) {
                                errors.push(
                                    createValidationErrorResult(
                                        SourceMapErrorCode.MAPPING_NAME_INDEX_OUT_OF_BOUNDS,
                                        `Mapping name index at ${segmentLocation} is out of bounds: ${accNameIndex} >= ${namesLength}`,
                                        'mappings',
                                    ),
                                );
                            }
                        }
                    }
                }
            }

            // Update position tracking
            segmentStart = pos + 1;

            if (charCode === CHAR_SEMICOLON) {
                // New line - reset column accumulator
                lineIndex++;
                segmentIndex = 0;
                accColumn = 0;
                hasSegmentContent = false;
            } else if (charCode === CHAR_COMMA) {
                segmentIndex++;
            }
        }
        // Non-separator characters are validated by decodeVlqSegment when processing
        // each segment, so no need for duplicate validation here.
    }

    return { valid: errors.length === 0, errors };
}
