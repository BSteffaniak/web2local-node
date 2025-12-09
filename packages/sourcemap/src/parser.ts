/**
 * Source Map Parser
 *
 * Parses and validates source map JSON content.
 * Handles both external source maps and inline base64 data URIs.
 */

import type {
    SourceMapV3,
    IndexMapV3,
    SourceMap,
    SourceMapValidationResult,
    SourceMapValidationError,
} from '@web2local/types';
import {
    SourceMapErrorCode,
    createParseError,
    createValidationError,
    createDataUriError,
} from './errors.js';
import {
    SUPPORTED_SOURCE_MAP_VERSION,
    ERROR_PREVIEW_LENGTH,
} from './constants.js';
import { decodeDataUri, isDataUri } from './utils/url.js';
import { validateMappings } from './mappings.js';

// ============================================================================
// RAW SOURCE MAP TYPES (before validation)
// ============================================================================

interface RawSourceMap {
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

interface RawIndexMapSection {
    offset?: unknown;
    map?: unknown;
    [key: string]: unknown;
}

interface RawIndexMapOffset {
    line?: unknown;
    column?: unknown;
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

/**
 * Checks if a raw source map object is an index map (has sections field).
 * Per ECMA-426, an index map has `sections` instead of `sources`/`mappings`.
 */
function isIndexMap(obj: RawSourceMap): boolean {
    return 'sections' in obj;
}

// ============================================================================
// REGULAR SOURCE MAP VALIDATION
// ============================================================================

/**
 * Validates a regular source map (not index map) against the ECMA-426 spec.
 * This is an internal function - use validateSourceMap() for public API.
 *
 * @param obj - The raw source map object (already verified to be an object)
 * @returns Validation result with structured errors
 */
function validateRegularSourceMap(
    obj: RawSourceMap,
): SourceMapValidationResult {
    const errors: SourceMapValidationError[] = [];
    const warnings: string[] = [];

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
    } else if (!obj.sources.every((s) => typeof s === 'string' || s === null)) {
        errors.push(
            validationError(
                SourceMapErrorCode.SOURCES_NOT_ARRAY,
                'All entries in "sources" must be strings or null',
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
                    SourceMapErrorCode.INVALID_SOURCES_CONTENT,
                    'Field "sourcesContent" must be an array',
                    'sourcesContent',
                ),
            );
        } else {
            // Check that all entries are strings or null
            if (
                !obj.sourcesContent.every(
                    (c) => typeof c === 'string' || c === null,
                )
            ) {
                errors.push(
                    validationError(
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

    // file check (optional) - must be string if present
    if (obj.file !== undefined && typeof obj.file !== 'string') {
        errors.push(
            validationError(
                SourceMapErrorCode.INVALID_FILE,
                'Field "file" must be a string',
                'file',
            ),
        );
    }

    // ignoreList check (optional) - must be array of non-negative integers within bounds
    if (obj.ignoreList !== undefined) {
        if (!Array.isArray(obj.ignoreList)) {
            errors.push(
                validationError(
                    SourceMapErrorCode.INVALID_IGNORE_LIST,
                    'Field "ignoreList" must be an array',
                    'ignoreList',
                ),
            );
        } else {
            // Check that all entries are non-negative integers
            const hasInvalidType = obj.ignoreList.some(
                (idx) =>
                    typeof idx !== 'number' ||
                    !Number.isInteger(idx) ||
                    idx < 0,
            );
            if (hasInvalidType) {
                errors.push(
                    validationError(
                        SourceMapErrorCode.INVALID_IGNORE_LIST,
                        'All entries in "ignoreList" must be non-negative integers',
                        'ignoreList',
                    ),
                );
            } else if (Array.isArray(obj.sources)) {
                // Check bounds
                const sourcesArray = obj.sources as unknown[];
                const hasOutOfBounds = obj.ignoreList.some(
                    (idx) => (idx as number) >= sourcesArray.length,
                );
                if (hasOutOfBounds) {
                    errors.push(
                        validationError(
                            SourceMapErrorCode.INVALID_IGNORE_LIST,
                            'ignoreList contains index out of bounds of sources array',
                            'ignoreList',
                        ),
                    );
                }
            }
        }
    }

    // VLQ mappings validation - only if we have valid structural prerequisites
    // (mappings is a string, sources is an array)
    if (typeof obj.mappings === 'string' && Array.isArray(obj.sources)) {
        const sourcesLength = obj.sources.length;
        const namesLength = Array.isArray(obj.names) ? obj.names.length : 0;
        const mappingsResult = validateMappings(
            obj.mappings,
            sourcesLength,
            namesLength,
        );
        errors.push(...mappingsResult.errors);
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings,
    };
}

// ============================================================================
// INDEX MAP VALIDATION
// ============================================================================

/**
 * Validates an index map against the ECMA-426 spec.
 * Index maps have `sections` array with offset/map pairs instead of sources/mappings.
 *
 * @param obj - The raw source map object (already verified to have sections)
 * @returns Validation result with structured errors
 */
function validateIndexMapInternal(
    obj: RawSourceMap,
): SourceMapValidationResult {
    const errors: SourceMapValidationError[] = [];
    const warnings: string[] = [];

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

    // Index maps cannot have mappings field (they use sections instead)
    if (obj.mappings !== undefined) {
        errors.push(
            validationError(
                SourceMapErrorCode.INDEX_MAP_WITH_MAPPINGS,
                'Index map cannot have both "sections" and "mappings" fields',
                'mappings',
            ),
        );
    }

    // file check (optional) - must be string if present
    if (obj.file !== undefined && typeof obj.file !== 'string') {
        errors.push(
            validationError(
                SourceMapErrorCode.INVALID_FILE,
                'Field "file" must be a string',
                'file',
            ),
        );
    }

    // Sections validation
    if (!Array.isArray(obj.sections)) {
        errors.push(
            validationError(
                SourceMapErrorCode.INVALID_INDEX_MAP_SECTIONS,
                'Field "sections" must be an array',
                'sections',
            ),
        );
        return { valid: false, errors, warnings };
    }

    // Track previous offset for order/overlap validation
    let prevLine = -1;
    let prevColumn = -1;

    for (let i = 0; i < obj.sections.length; i++) {
        const section = obj.sections[i] as RawIndexMapSection | null;
        const fieldPrefix = `sections[${i}]`;

        if (typeof section !== 'object' || section === null) {
            errors.push(
                validationError(
                    SourceMapErrorCode.INVALID_INDEX_MAP_SECTIONS,
                    `${fieldPrefix} must be an object`,
                    fieldPrefix,
                ),
            );
            continue;
        }

        // Validate offset
        if (section.offset === undefined) {
            errors.push(
                validationError(
                    SourceMapErrorCode.INVALID_INDEX_MAP_OFFSET,
                    `${fieldPrefix}.offset is required`,
                    `${fieldPrefix}.offset`,
                ),
            );
        } else if (
            typeof section.offset !== 'object' ||
            section.offset === null
        ) {
            errors.push(
                validationError(
                    SourceMapErrorCode.INVALID_INDEX_MAP_OFFSET,
                    `${fieldPrefix}.offset must be an object`,
                    `${fieldPrefix}.offset`,
                ),
            );
        } else {
            const offset = section.offset as RawIndexMapOffset;

            // Validate offset.line
            if (offset.line === undefined) {
                errors.push(
                    validationError(
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
                    validationError(
                        SourceMapErrorCode.INVALID_INDEX_MAP_OFFSET,
                        `${fieldPrefix}.offset.line must be a non-negative integer`,
                        `${fieldPrefix}.offset.line`,
                    ),
                );
            }

            // Validate offset.column
            if (offset.column === undefined) {
                errors.push(
                    validationError(
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
                    validationError(
                        SourceMapErrorCode.INVALID_INDEX_MAP_OFFSET,
                        `${fieldPrefix}.offset.column must be a non-negative integer`,
                        `${fieldPrefix}.offset.column`,
                    ),
                );
            }

            // Check ordering and overlap (only if both line and column are valid numbers)
            if (
                typeof offset.line === 'number' &&
                typeof offset.column === 'number' &&
                Number.isInteger(offset.line) &&
                Number.isInteger(offset.column)
            ) {
                const currentLine = offset.line;
                const currentColumn = offset.column;

                if (i > 0) {
                    // Check for invalid order (current section starts before previous)
                    if (
                        currentLine < prevLine ||
                        (currentLine === prevLine && currentColumn < prevColumn)
                    ) {
                        errors.push(
                            validationError(
                                SourceMapErrorCode.INDEX_MAP_INVALID_ORDER,
                                `${fieldPrefix} has offset before previous section (sections must be in order)`,
                                `${fieldPrefix}.offset`,
                            ),
                        );
                    }
                    // Check for overlap (same position as previous)
                    else if (
                        currentLine === prevLine &&
                        currentColumn === prevColumn
                    ) {
                        errors.push(
                            validationError(
                                SourceMapErrorCode.INDEX_MAP_OVERLAP,
                                `${fieldPrefix} overlaps with previous section (same offset)`,
                                `${fieldPrefix}.offset`,
                            ),
                        );
                    }
                }

                prevLine = currentLine;
                prevColumn = currentColumn;
            }
        }

        // Validate map
        if (section.map === undefined) {
            errors.push(
                validationError(
                    SourceMapErrorCode.INVALID_INDEX_MAP_SECTION_MAP,
                    `${fieldPrefix}.map is required`,
                    `${fieldPrefix}.map`,
                ),
            );
        } else if (typeof section.map !== 'object' || section.map === null) {
            errors.push(
                validationError(
                    SourceMapErrorCode.INVALID_INDEX_MAP_SECTION_MAP,
                    `${fieldPrefix}.map must be an object`,
                    `${fieldPrefix}.map`,
                ),
            );
        } else {
            const sectionMap = section.map as RawSourceMap;

            // Check for nested index map (not allowed per spec)
            if (isIndexMap(sectionMap)) {
                errors.push(
                    validationError(
                        SourceMapErrorCode.INDEX_MAP_NESTED,
                        `${fieldPrefix}.map cannot be an index map (nested index maps not allowed)`,
                        `${fieldPrefix}.map`,
                    ),
                );
            } else {
                // Recursively validate the section map as a regular source map
                const sectionResult = validateRegularSourceMap(sectionMap);
                for (const error of sectionResult.errors) {
                    errors.push(
                        validationError(
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
        }
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings,
    };
}

// ============================================================================
// PUBLIC VALIDATION API
// ============================================================================

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
 */
export function validateSourceMap(raw: unknown): SourceMapValidationResult {
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

    // Dispatch to appropriate validator based on presence of sections field
    if (isIndexMap(obj)) {
        return validateIndexMapInternal(obj);
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
