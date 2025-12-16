/**
 * Source Map Validation
 *
 * Public API for validating source maps against the ECMA-426 specification.
 * Handles both regular source maps and index maps.
 */

import type { SourceMapV3, SourceMapValidationResult } from '@web2local/types';
import { SourceMapErrorCode, createValidationErrorResult } from '../errors.js';
import type { RawSourceMap } from './fields.js';
import { validateRegularSourceMap } from './source-map.js';
import { isIndexMap, validateIndexMap } from './index-map.js';

// Re-export types and validators for internal use
export type {
    RawSourceMap,
    RawIndexMapSection,
    RawIndexMapOffset,
} from './fields.js';
export { validateRegularSourceMap } from './source-map.js';
export {
    isIndexMap,
    validateIndexMap,
    type ValidatedOffset,
} from './index-map.js';

/**
 * Validates a raw parsed object against the ECMA-426 Source Map specification.
 * Automatically detects and validates both regular source maps and index maps.
 *
 * For regular source maps, checks:
 * - version === 3
 * - sources is a string array (entries can be null)
 * - mappings is a string
 * - sourcesContent (if present) contains strings or null
 * - names (if present) is a string array
 * - file (if present) is a string
 * - ignoreList (if present) is array of valid indices
 *
 * For index maps, additionally checks:
 * - sections is an array of valid section objects
 * - Each section has valid offset (line, column) and map
 * - Sections are in order and don't overlap
 * - Nested index maps are not allowed
 * - Cannot have both sections and mappings
 *
 * @param raw - The parsed JSON object
 * @returns Validation result with structured errors (including error codes)
 *
 * @example
 * ```typescript
 * const parsed = JSON.parse(sourceMapJson);
 * const result = validateSourceMap(parsed);
 * if (!result.valid) {
 *     for (const error of result.errors) {
 *         console.error(`[${error.code}] ${error.message}`);
 *     }
 * }
 * ```
 */
export function validateSourceMap(raw: unknown): SourceMapValidationResult {
    if (typeof raw !== 'object' || raw === null) {
        return {
            valid: false,
            errors: [
                createValidationErrorResult(
                    SourceMapErrorCode.INVALID_JSON,
                    'Source map must be an object',
                ),
            ],
            warnings: [],
        };
    }

    const obj = raw as RawSourceMap;

    // Dispatch to appropriate validator based on presence of sections field
    if (isIndexMap(obj)) {
        return validateIndexMap(obj);
    }

    return validateRegularSourceMap(obj);
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
