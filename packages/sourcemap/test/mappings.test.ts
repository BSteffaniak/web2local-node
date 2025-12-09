/**
 * Tests for VLQ/Mappings Validation
 *
 * Tests the validateMappings() function which validates VLQ-encoded
 * mappings strings per ECMA-426 specification.
 */

import { describe, it, expect } from 'vitest';
import {
    validateMappings,
    type MappingsValidationResult,
} from '../src/mappings.js';
import { SourceMapErrorCode } from '../src/errors.js';
import {
    hasErrorCode as baseHasErrorCode,
    hasErrorMessage as baseHasErrorMessage,
} from './helpers/test-utils.js';

// Wrapper to accept MappingsValidationResult (which has errors array)
function hasErrorCode(result: MappingsValidationResult, code: string): boolean {
    return baseHasErrorCode(result.errors, code);
}

function hasErrorMessage(
    result: MappingsValidationResult,
    substring: string,
): boolean {
    return baseHasErrorMessage(result.errors, substring);
}

// ============================================================================
// VALID MAPPINGS
// ============================================================================

describe('validateMappings', () => {
    describe('valid mappings', () => {
        it('accepts empty mappings string', () => {
            const result = validateMappings('', 1, 0);
            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);
        });

        it('accepts single 1-field segment (column only)', () => {
            // 'A' = 0 in VLQ
            const result = validateMappings('A', 1, 0);
            expect(result.valid).toBe(true);
        });

        it('accepts single 4-field segment', () => {
            // 'AAAA' = [0, 0, 0, 0] - column, source index, orig line, orig col
            const result = validateMappings('AAAA', 1, 0);
            expect(result.valid).toBe(true);
        });

        it('accepts single 5-field segment with name', () => {
            // 'AAAAA' = [0, 0, 0, 0, 0] - includes name index
            const result = validateMappings('AAAAA', 1, 1);
            expect(result.valid).toBe(true);
        });

        it('accepts multiple lines separated by semicolons', () => {
            const result = validateMappings('AAAA;AAAA;AAAA', 1, 0);
            expect(result.valid).toBe(true);
        });

        it('accepts multiple segments separated by commas', () => {
            const result = validateMappings('AAAA,CAAA,EAAA', 1, 0);
            expect(result.valid).toBe(true);
        });

        it('accepts empty lines (consecutive semicolons)', () => {
            const result = validateMappings('AAAA;;AAAA', 1, 0);
            expect(result.valid).toBe(true);
        });

        it('accepts complex valid mappings', () => {
            // Real-world-like mappings
            const result = validateMappings('AAAA,SAASA,MACP,OAAO', 1, 1);
            expect(result.valid).toBe(true);
        });
    });

    // ============================================================================
    // INVALID BASE64 CHARACTERS
    // ============================================================================

    describe('invalid base64 characters', () => {
        it('rejects padding character =', () => {
            const result = validateMappings('A=', 1, 0);
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result, "non-base64 character '='")).toBe(
                true,
            );
        });

        it('rejects special characters $%?!', () => {
            const result = validateMappings('A$%?!', 1, 0);
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result, 'non-base64 character')).toBe(true);
        });

        it('rejects unicode characters', () => {
            const result = validateMappings('AAAA\u00e9', 1, 0);
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result, 'non-base64 character')).toBe(true);
        });

        it('rejects space character', () => {
            const result = validateMappings('AA AA', 1, 0);
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result, "non-base64 character ' '")).toBe(
                true,
            );
        });

        it('rejects newline character', () => {
            const result = validateMappings('AAAA\nAAAA', 1, 0);
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result, 'non-base64 character')).toBe(true);
        });
    });

    // ============================================================================
    // VLQ DECODING ERRORS
    // ============================================================================

    describe('VLQ decoding errors', () => {
        it('rejects missing continuation digits (g alone)', () => {
            // 'g' has continuation bit set but nothing follows
            const result = validateMappings('g', 1, 0);
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result, 'Missing continuation digits')).toBe(
                true,
            );
        });

        it('rejects truncated VLQ sequence', () => {
            // 'gg' - two continuation chars with no terminator
            const result = validateMappings('gg', 1, 0);
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result, 'Missing continuation digits')).toBe(
                true,
            );
        });

        it('rejects VLQ with continuation bit set at end of segment', () => {
            // Valid segment followed by incomplete one
            const result = validateMappings('AAAA,g', 1, 0);
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result, 'Missing continuation digits')).toBe(
                true,
            );
        });

        it('rejects continuation in middle of multi-segment line', () => {
            const result = validateMappings('AAAA,gg,AAAA', 1, 0);
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result, 'Missing continuation digits')).toBe(
                true,
            );
        });
    });

    // ============================================================================
    // EMPTY SEGMENTS
    // ============================================================================

    describe('empty segments', () => {
        it('rejects consecutive commas (empty segment)', () => {
            const result = validateMappings('AAAA,,AAAA', 1, 0);
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result, 'empty segment')).toBe(true);
        });

        it('rejects leading comma', () => {
            const result = validateMappings(',AAAA', 1, 0);
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result, 'empty segment')).toBe(true);
        });

        it('rejects trailing comma', () => {
            const result = validateMappings('AAAA,', 1, 0);
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result, 'empty segment')).toBe(true);
        });

        it('rejects leading comma after semicolon', () => {
            const result = validateMappings('AAAA;,AAAA', 1, 0);
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result, 'empty segment')).toBe(true);
        });

        it('rejects multiple consecutive commas', () => {
            const result = validateMappings('AAAA,,,AAAA', 1, 0);
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result, 'empty segment')).toBe(true);
        });
    });

    // ============================================================================
    // INVALID SEGMENT FIELD COUNTS
    // ============================================================================

    describe('invalid segment field counts', () => {
        it('rejects 2-field segment', () => {
            // 'AA' decodes to [0, 0] - invalid count
            const result = validateMappings('AA', 1, 0);
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result, '2 fields')).toBe(true);
        });

        it('rejects 3-field segment', () => {
            // 'AAA' decodes to [0, 0, 0] - invalid count
            const result = validateMappings('AAA', 1, 0);
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result, '3 fields')).toBe(true);
        });

        it('rejects 6-field segment', () => {
            // 'AAAAAA' decodes to [0, 0, 0, 0, 0, 0] - invalid count
            const result = validateMappings('AAAAAA', 1, 1);
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result, '6 fields')).toBe(true);
        });

        it('rejects segment with too many fields (7+)', () => {
            const result = validateMappings('AAAAAAA', 1, 1);
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result, 'fields (must be 1, 4, or 5)')).toBe(
                true,
            );
        });

        it('reports error for invalid segment among valid ones', () => {
            // Valid 4-field, invalid 2-field, valid 4-field
            const result = validateMappings('AAAA,AA,AAAA', 1, 0);
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result, '2 fields')).toBe(true);
        });
    });

    // ============================================================================
    // 32-BIT OVERFLOW
    // ============================================================================

    describe('32-bit overflow', () => {
        // 'ggggggE' encodes a value > 2^31 (specifically 2^31 = 2147483648)
        const OVERFLOW_VLQ = 'ggggggE';

        it('rejects column value exceeding 32 bits', () => {
            // First field is column
            const result = validateMappings(OVERFLOW_VLQ, 1, 0);
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result, 'exceeds 32-bit range')).toBe(true);
            expect(hasErrorMessage(result, 'column')).toBe(true);
        });

        it('rejects source index exceeding 32 bits', () => {
            // Second field is source index: A + overflow
            const result = validateMappings(
                'A' + OVERFLOW_VLQ + 'AA',
                1000000000,
                0,
            );
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result, 'exceeds 32-bit range')).toBe(true);
        });

        it('rejects original line exceeding 32 bits', () => {
            // Third field is original line: AA + overflow + A
            const result = validateMappings('AA' + OVERFLOW_VLQ + 'A', 1, 0);
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result, 'exceeds 32-bit range')).toBe(true);
        });

        it('rejects original column exceeding 32 bits', () => {
            // Fourth field is original column: AAA + overflow
            const result = validateMappings('AAA' + OVERFLOW_VLQ, 1, 0);
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result, 'exceeds 32-bit range')).toBe(true);
        });

        it('rejects name index exceeding 32 bits', () => {
            // Fifth field is name index: AAAA + overflow
            const result = validateMappings(
                'AAAA' + OVERFLOW_VLQ,
                1,
                1000000000,
            );
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result, 'exceeds 32-bit range')).toBe(true);
        });
    });

    // ============================================================================
    // NEGATIVE ABSOLUTE VALUES
    // ============================================================================

    describe('negative absolute values', () => {
        // 'D' encodes -1 in VLQ (value 3 >> 1 with sign bit = -1)
        // 'B' encodes 0 with sign bit, 'D' encodes -1, 'F' encodes -2

        it('rejects negative column in first segment', () => {
            // 'D' = -1 for column
            const result = validateMappings('D', 1, 0);
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result, 'column')).toBe(true);
            expect(hasErrorMessage(result, 'is negative')).toBe(true);
        });

        it('rejects negative column via accumulation', () => {
            // First segment: column = 2, Second segment: column delta = -3
            // 'E' = 2, 'H' = -3 (after accumulation: 2 + (-3) = -1)
            // Actually let's use: C=1, then F=-2 gives -1
            // C encodes 1, F encodes -2
            const result = validateMappings('C,F', 1, 0);
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result, 'column')).toBe(true);
            expect(hasErrorMessage(result, 'is negative')).toBe(true);
        });

        it('rejects negative source index', () => {
            // 4-field segment with negative source index: column=0, source=-1
            // 'ADAA' = [0, -1, 0, 0]
            const result = validateMappings('ADAA', 1, 0);
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result, 'source index')).toBe(true);
            expect(hasErrorMessage(result, 'is negative')).toBe(true);
        });

        it('rejects negative original line', () => {
            // 4-field segment with negative original line
            // 'AADA' = [0, 0, -1, 0]
            const result = validateMappings('AADA', 1, 0);
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result, 'original line')).toBe(true);
            expect(hasErrorMessage(result, 'is negative')).toBe(true);
        });

        it('rejects negative original column', () => {
            // 4-field segment with negative original column
            // 'AAAD' = [0, 0, 0, -1]
            const result = validateMappings('AAAD', 1, 0);
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result, 'original column')).toBe(true);
            expect(hasErrorMessage(result, 'is negative')).toBe(true);
        });

        it('rejects negative name index', () => {
            // 5-field segment with negative name index
            // 'AAAAD' = [0, 0, 0, 0, -1]
            const result = validateMappings('AAAAD', 1, 1);
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result, 'name index')).toBe(true);
            expect(hasErrorMessage(result, 'is negative')).toBe(true);
        });
    });

    // ============================================================================
    // INDEX BOUNDS CHECKING
    // ============================================================================

    describe('index bounds checking', () => {
        it('rejects source index out of bounds (single source)', () => {
            // Source index 0 is valid, but if we increment to 1 with only 1 source...
            // 'ACAA' = [0, 1, 0, 0] - source index becomes 1, but sources.length = 1
            const result = validateMappings('ACAA', 1, 0);
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result, 'source index')).toBe(true);
            expect(hasErrorMessage(result, 'out of bounds')).toBe(true);
        });

        it('rejects source index out of bounds (multiple sources)', () => {
            // With 2 sources (indices 0, 1), source index 2 is out of bounds
            // Two segments: first uses source 0, second increments by 2 to get source 2
            // 'AAAA,AEAA' - second segment adds 2 to source index
            const result = validateMappings('AAAA,AEAA', 2, 0);
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result, 'source index')).toBe(true);
            expect(hasErrorMessage(result, 'out of bounds')).toBe(true);
        });

        it('rejects name index out of bounds (single name)', () => {
            // 'AAAAC' = [0, 0, 0, 0, 1] - name index 1, but names.length = 1
            const result = validateMappings('AAAAC', 1, 1);
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result, 'name index')).toBe(true);
            expect(hasErrorMessage(result, 'out of bounds')).toBe(true);
        });

        it('rejects name index out of bounds (multiple names)', () => {
            // With 2 names (indices 0, 1), name index 2 is out of bounds
            const result = validateMappings('AAAAA,AAAAE', 1, 2);
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result, 'name index')).toBe(true);
            expect(hasErrorMessage(result, 'out of bounds')).toBe(true);
        });

        it('accepts source index at boundary', () => {
            // With 2 sources, index 1 is valid
            // 'ACAA' = [0, 1, 0, 0] - source index 1 with 2 sources
            const result = validateMappings('ACAA', 2, 0);
            expect(result.valid).toBe(true);
        });

        it('accepts name index at boundary', () => {
            // With 2 names, index 1 is valid
            // 'AAAAC' = [0, 0, 0, 0, 1] - name index 1 with 2 names
            const result = validateMappings('AAAAC', 1, 2);
            expect(result.valid).toBe(true);
        });
    });

    // ============================================================================
    // ACCUMULATION ACROSS LINES
    // ============================================================================

    describe('accumulation across lines', () => {
        it('accumulates source index across lines', () => {
            // First line: source index = 1 (via ACAA)
            // Second line: source index delta = 1, total = 2
            // With only 2 sources, this should fail
            const result = validateMappings('ACAA;ACAA', 2, 0);
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result, 'source index')).toBe(true);
            expect(hasErrorMessage(result, 'out of bounds: 2 >= 2')).toBe(true);
        });

        it('accumulates original line across lines', () => {
            // Line values accumulate, so negative relative can cause issues
            // First line: orig line = 0, Second line: orig line delta = -1
            // 'AAAA;AADA' - second segment has orig line -1, total becomes -1
            const result = validateMappings('AAAA;AADA', 1, 0);
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result, 'original line')).toBe(true);
            expect(hasErrorMessage(result, 'is negative')).toBe(true);
        });

        it('resets column per line but not other accumulators', () => {
            // Column resets each line, but source/line/col/name don't
            // This should be valid: each line starts column at 0
            const result = validateMappings('CAAA;CAAA;CAAA', 1, 0);
            expect(result.valid).toBe(true);
        });

        it('accumulates name index across lines', () => {
            // Similar to source index test
            const result = validateMappings('AAAAC;AAAAC', 1, 2);
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result, 'name index')).toBe(true);
            expect(hasErrorMessage(result, 'out of bounds: 2 >= 2')).toBe(true);
        });
    });

    // ============================================================================
    // ERROR CODES
    // ============================================================================

    describe('error codes', () => {
        it('returns INVALID_VLQ for base64 character errors', () => {
            const result = validateMappings('A$A', 1, 0);
            expect(hasErrorCode(result, SourceMapErrorCode.INVALID_VLQ)).toBe(
                true,
            );
        });

        it('returns INVALID_VLQ for continuation errors', () => {
            const result = validateMappings('g', 1, 0);
            expect(hasErrorCode(result, SourceMapErrorCode.INVALID_VLQ)).toBe(
                true,
            );
        });

        it('returns INVALID_MAPPING_SEGMENT for field count errors', () => {
            const result = validateMappings('AA', 1, 0);
            expect(
                hasErrorCode(
                    result,
                    SourceMapErrorCode.INVALID_MAPPING_SEGMENT,
                ),
            ).toBe(true);
        });

        it('returns INVALID_MAPPING_SEGMENT for empty segment', () => {
            const result = validateMappings('AAAA,,AAAA', 1, 0);
            expect(
                hasErrorCode(
                    result,
                    SourceMapErrorCode.INVALID_MAPPING_SEGMENT,
                ),
            ).toBe(true);
        });

        it('returns MAPPING_SOURCE_INDEX_OUT_OF_BOUNDS for source bounds error', () => {
            const result = validateMappings('ACAA', 1, 0);
            expect(
                hasErrorCode(
                    result,
                    SourceMapErrorCode.MAPPING_SOURCE_INDEX_OUT_OF_BOUNDS,
                ),
            ).toBe(true);
        });

        it('returns MAPPING_NAME_INDEX_OUT_OF_BOUNDS for name bounds error', () => {
            const result = validateMappings('AAAAC', 1, 1);
            expect(
                hasErrorCode(
                    result,
                    SourceMapErrorCode.MAPPING_NAME_INDEX_OUT_OF_BOUNDS,
                ),
            ).toBe(true);
        });

        it('returns MAPPING_NEGATIVE_VALUE for negative value errors', () => {
            const result = validateMappings('D', 1, 0);
            expect(
                hasErrorCode(result, SourceMapErrorCode.MAPPING_NEGATIVE_VALUE),
            ).toBe(true);
        });

        it('returns MAPPING_VALUE_EXCEEDS_32_BITS for overflow errors', () => {
            const result = validateMappings('ggggggE', 1, 0);
            expect(
                hasErrorCode(
                    result,
                    SourceMapErrorCode.MAPPING_VALUE_EXCEEDS_32_BITS,
                ),
            ).toBe(true);
        });
    });
});
