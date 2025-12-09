import { describe, it, expect } from 'vitest';
import type { SourceMapValidationError } from '@web2local/types';
import {
    parseSourceMap,
    parseInlineSourceMap,
    parseSourceMapAuto,
    validateSourceMap,
    isSourceMapV3,
} from '../src/parser.js';
import { SourceMapError, SourceMapErrorCode } from '../src/errors.js';

/**
 * Helper to check if an error with a specific message exists in the errors array.
 */
function hasErrorMessage(
    errors: readonly SourceMapValidationError[],
    substring: string,
): boolean {
    return errors.some((e) => e.message.includes(substring));
}

/**
 * Helper to check if an error with a specific code exists in the errors array.
 */
function hasErrorCode(
    errors: readonly SourceMapValidationError[],
    code: string,
): boolean {
    return errors.some((e) => e.code === code);
}

describe('validateSourceMap', () => {
    it('validates a correct source map', () => {
        const result = validateSourceMap({
            version: 3,
            sources: ['index.ts'],
            sourcesContent: ['export default 1;'],
            mappings: 'AAAA',
        });
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
    });

    it('fails on non-object', () => {
        const result = validateSourceMap('not an object');
        expect(result.valid).toBe(false);
        expect(
            hasErrorMessage(result.errors, 'Source map must be an object'),
        ).toBe(true);
        expect(
            hasErrorCode(result.errors, SourceMapErrorCode.INVALID_JSON),
        ).toBe(true);
    });

    it('fails on null', () => {
        const result = validateSourceMap(null);
        expect(result.valid).toBe(false);
        expect(
            hasErrorMessage(result.errors, 'Source map must be an object'),
        ).toBe(true);
    });

    it('fails on missing version', () => {
        const result = validateSourceMap({
            sources: ['index.ts'],
            mappings: 'AAAA',
        });
        expect(result.valid).toBe(false);
        expect(
            hasErrorMessage(result.errors, 'Missing required field: version'),
        ).toBe(true);
        expect(
            hasErrorCode(result.errors, SourceMapErrorCode.MISSING_VERSION),
        ).toBe(true);
    });

    it('fails on wrong version', () => {
        const result = validateSourceMap({
            version: 2,
            sources: ['index.ts'],
            mappings: 'AAAA',
        });
        expect(result.valid).toBe(false);
        expect(hasErrorMessage(result.errors, 'Invalid version')).toBe(true);
        expect(
            hasErrorCode(result.errors, SourceMapErrorCode.INVALID_VERSION),
        ).toBe(true);
    });

    it('fails on missing sources', () => {
        const result = validateSourceMap({
            version: 3,
            mappings: 'AAAA',
        });
        expect(result.valid).toBe(false);
        expect(
            hasErrorMessage(result.errors, 'Missing required field: sources'),
        ).toBe(true);
        expect(
            hasErrorCode(result.errors, SourceMapErrorCode.MISSING_SOURCES),
        ).toBe(true);
    });

    it('fails on non-array sources', () => {
        const result = validateSourceMap({
            version: 3,
            sources: 'not an array',
            mappings: 'AAAA',
        });
        expect(result.valid).toBe(false);
        expect(
            hasErrorMessage(result.errors, 'Field "sources" must be an array'),
        ).toBe(true);
        expect(
            hasErrorCode(result.errors, SourceMapErrorCode.SOURCES_NOT_ARRAY),
        ).toBe(true);
    });

    it('fails on missing mappings', () => {
        const result = validateSourceMap({
            version: 3,
            sources: ['index.ts'],
        });
        expect(result.valid).toBe(false);
        expect(
            hasErrorMessage(result.errors, 'Missing required field: mappings'),
        ).toBe(true);
        expect(
            hasErrorCode(result.errors, SourceMapErrorCode.MISSING_MAPPINGS),
        ).toBe(true);
    });

    it('fails on non-string mappings', () => {
        const result = validateSourceMap({
            version: 3,
            sources: ['index.ts'],
            mappings: 123,
        });
        expect(result.valid).toBe(false);
        expect(
            hasErrorMessage(result.errors, 'Field "mappings" must be a string'),
        ).toBe(true);
    });

    it('warns on sourcesContent length mismatch', () => {
        const result = validateSourceMap({
            version: 3,
            sources: ['a.ts', 'b.ts'],
            sourcesContent: ['content'],
            mappings: 'AAAA',
        });
        expect(result.valid).toBe(true); // Mismatch is a warning, not error
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain('does not match');
    });

    it('validates optional names array', () => {
        const result = validateSourceMap({
            version: 3,
            sources: ['index.ts'],
            mappings: 'AAAA',
            names: 'not an array',
        });
        expect(result.valid).toBe(false);
        expect(
            hasErrorMessage(result.errors, 'Field "names" must be an array'),
        ).toBe(true);
        expect(
            hasErrorCode(result.errors, SourceMapErrorCode.INVALID_NAMES),
        ).toBe(true);
    });

    it('validates sourceRoot is a string', () => {
        const result = validateSourceMap({
            version: 3,
            sources: ['index.ts'],
            mappings: 'AAAA',
            sourceRoot: 123,
        });
        expect(result.valid).toBe(false);
        expect(
            hasErrorMessage(
                result.errors,
                'Field "sourceRoot" must be a string',
            ),
        ).toBe(true);
        expect(
            hasErrorCode(result.errors, SourceMapErrorCode.INVALID_SOURCE_ROOT),
        ).toBe(true);
    });

    it('includes field information in validation errors', () => {
        const result = validateSourceMap({
            version: 3,
            mappings: 'AAAA',
        });
        expect(result.valid).toBe(false);
        const sourcesError = result.errors.find((e) => e.field === 'sources');
        expect(sourcesError).toBeDefined();
        expect(sourcesError?.code).toBe(SourceMapErrorCode.MISSING_SOURCES);
    });

    it('validates file is a string', () => {
        const result = validateSourceMap({
            version: 3,
            sources: ['index.ts'],
            mappings: 'AAAA',
            file: 123,
        });
        expect(result.valid).toBe(false);
        expect(
            hasErrorMessage(result.errors, 'Field "file" must be a string'),
        ).toBe(true);
        expect(
            hasErrorCode(result.errors, SourceMapErrorCode.INVALID_FILE),
        ).toBe(true);
    });

    it('allows null entries in sources array', () => {
        const result = validateSourceMap({
            version: 3,
            sources: ['index.ts', null, 'other.ts'],
            mappings: 'AAAA',
        });
        expect(result.valid).toBe(true);
    });

    it('allows null entries in sourcesContent array', () => {
        const result = validateSourceMap({
            version: 3,
            sources: ['index.ts', 'other.ts'],
            sourcesContent: ['content', null],
            mappings: 'AAAA',
        });
        expect(result.valid).toBe(true);
    });

    it('fails on non-string/non-null sourcesContent entries', () => {
        const result = validateSourceMap({
            version: 3,
            sources: ['index.ts'],
            sourcesContent: [123],
            mappings: 'AAAA',
        });
        expect(result.valid).toBe(false);
        expect(
            hasErrorCode(
                result.errors,
                SourceMapErrorCode.INVALID_SOURCES_CONTENT,
            ),
        ).toBe(true);
    });

    it('validates ignoreList is an array', () => {
        const result = validateSourceMap({
            version: 3,
            sources: ['index.ts'],
            mappings: 'AAAA',
            ignoreList: 'not an array',
        });
        expect(result.valid).toBe(false);
        expect(
            hasErrorCode(result.errors, SourceMapErrorCode.INVALID_IGNORE_LIST),
        ).toBe(true);
    });

    it('validates ignoreList entries are non-negative integers', () => {
        const result = validateSourceMap({
            version: 3,
            sources: ['index.ts', 'other.ts'],
            mappings: 'AAAA',
            ignoreList: [-1],
        });
        expect(result.valid).toBe(false);
        expect(hasErrorMessage(result.errors, 'non-negative integers')).toBe(
            true,
        );
    });

    it('validates ignoreList indices are within bounds', () => {
        const result = validateSourceMap({
            version: 3,
            sources: ['index.ts'],
            mappings: 'AAAA',
            ignoreList: [5],
        });
        expect(result.valid).toBe(false);
        expect(hasErrorMessage(result.errors, 'out of bounds')).toBe(true);
    });

    it('allows valid ignoreList', () => {
        const result = validateSourceMap({
            version: 3,
            sources: ['index.ts', 'vendor.ts'],
            mappings: 'AAAA',
            ignoreList: [1],
        });
        expect(result.valid).toBe(true);
    });

    it('allows empty ignoreList', () => {
        const result = validateSourceMap({
            version: 3,
            sources: ['index.ts'],
            mappings: 'AAAA',
            ignoreList: [],
        });
        expect(result.valid).toBe(true);
    });
});

describe('isSourceMapV3', () => {
    it('returns true for valid source maps', () => {
        expect(
            isSourceMapV3({
                version: 3,
                sources: ['index.ts'],
                mappings: 'AAAA',
            }),
        ).toBe(true);
    });

    it('returns false for invalid source maps', () => {
        expect(isSourceMapV3({ version: 2 })).toBe(false);
        expect(isSourceMapV3(null)).toBe(false);
        expect(isSourceMapV3('string')).toBe(false);
    });
});

describe('parseSourceMap', () => {
    it('parses valid JSON source map', () => {
        const json = JSON.stringify({
            version: 3,
            sources: ['index.ts'],
            sourcesContent: ['export default 1;'],
            mappings: 'AAAA',
        });

        const result = parseSourceMap(json);
        expect(result.version).toBe(3);
        expect(result.sources).toEqual(['index.ts']);
        expect(result.sourcesContent).toEqual(['export default 1;']);
    });

    it('throws on invalid JSON', () => {
        expect(() => parseSourceMap('{ invalid json }')).toThrow(
            SourceMapError,
        );
        expect(() => parseSourceMap('{ invalid json }')).toThrow(
            /Failed to parse/,
        );
    });

    it('throws on invalid source map structure', () => {
        const json = JSON.stringify({ version: 2 });
        expect(() => parseSourceMap(json)).toThrow(SourceMapError);
    });

    it('includes URL in error when provided', () => {
        try {
            parseSourceMap('invalid', 'https://example.com/bundle.js.map');
            expect.fail('Should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(SourceMapError);
            expect((e as SourceMapError).url).toBe(
                'https://example.com/bundle.js.map',
            );
        }
    });

    it('handles source maps with all optional fields', () => {
        const json = JSON.stringify({
            version: 3,
            file: 'bundle.js',
            sourceRoot: 'src/',
            sources: ['index.ts'],
            sourcesContent: ['export default 1;'],
            names: ['foo', 'bar'],
            mappings: 'AAAA',
        });

        const result = parseSourceMap(json);
        expect(result.file).toBe('bundle.js');
        expect(result.sourceRoot).toBe('src/');
        expect(result.names).toEqual(['foo', 'bar']);
    });
});

describe('parseInlineSourceMap', () => {
    it('parses base64 encoded inline source map', () => {
        // {"version":3,"sources":["index.ts"],"mappings":"AAAA"}
        const base64 =
            'eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImluZGV4LnRzIl0sIm1hcHBpbmdzIjoiQUFBQSJ9';
        const dataUri = `data:application/json;base64,${base64}`;

        const result = parseInlineSourceMap(dataUri);
        expect(result.version).toBe(3);
        expect(result.sources).toEqual(['index.ts']);
    });

    it('throws on non-data-uri', () => {
        expect(() =>
            parseInlineSourceMap('https://example.com/file.map'),
        ).toThrow(SourceMapError);
        expect(() =>
            parseInlineSourceMap('https://example.com/file.map'),
        ).toThrow(/Not a valid data URI/);
    });

    it('throws on invalid base64', () => {
        const dataUri = 'data:application/json;base64,!!invalid!!';
        expect(() => parseInlineSourceMap(dataUri)).toThrow(SourceMapError);
        expect(() => parseInlineSourceMap(dataUri)).toThrow(
            /Failed to decode base64/,
        );
    });

    it('throws on invalid JSON after decoding', () => {
        // Base64 of "not json"
        const base64 = Buffer.from('not json').toString('base64');
        const dataUri = `data:application/json;base64,${base64}`;

        expect(() => parseInlineSourceMap(dataUri)).toThrow(SourceMapError);
    });
});

describe('parseSourceMapAuto', () => {
    it('parses regular JSON', () => {
        const json = JSON.stringify({
            version: 3,
            sources: ['index.ts'],
            mappings: 'AAAA',
        });

        const result = parseSourceMapAuto(json);
        expect(result.version).toBe(3);
    });

    it('parses data URIs', () => {
        const base64 =
            'eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImluZGV4LnRzIl0sIm1hcHBpbmdzIjoiQUFBQSJ9';
        const dataUri = `data:application/json;base64,${base64}`;

        const result = parseSourceMapAuto(dataUri);
        expect(result.version).toBe(3);
    });

    it('uses JSON parsing for non-data-uri strings', () => {
        const json = JSON.stringify({
            version: 3,
            sources: ['index.ts'],
            mappings: 'AAAA',
        });

        const result = parseSourceMapAuto(json);
        expect(result.version).toBe(3);
    });
});

// ============================================================================
// INDEX MAP VALIDATION TESTS
// ============================================================================

describe('validateSourceMap - Index Maps', () => {
    // Helper to create a minimal valid regular source map
    function validRegularMap() {
        return {
            version: 3,
            sources: ['index.ts'],
            mappings: 'AAAA',
        };
    }

    // Helper to create a minimal valid index map
    function validIndexMap(sections: unknown[] = []) {
        return {
            version: 3,
            sections,
        };
    }

    // Helper to create a valid section
    function validSection(line = 0, column = 0) {
        return {
            offset: { line, column },
            map: validRegularMap(),
        };
    }

    describe('index map detection', () => {
        it('detects object with sections as index map', () => {
            const result = validateSourceMap({
                version: 3,
                sections: [],
            });
            // Empty sections is valid for an index map
            expect(result.valid).toBe(true);
        });

        it('detects object without sections as regular source map', () => {
            const result = validateSourceMap({
                version: 3,
                sources: ['index.ts'],
                mappings: 'AAAA',
            });
            expect(result.valid).toBe(true);
        });

        it('treats object with sections as index map even if it has sources', () => {
            // If sections is present, it's an index map - sources would be ignored
            // but mappings being present would cause an error
            const result = validateSourceMap({
                version: 3,
                sections: [validSection()],
                sources: ['index.ts'], // This is ignored for index maps
            });
            expect(result.valid).toBe(true);
        });
    });

    describe('valid index maps', () => {
        it('accepts empty sections array', () => {
            const result = validateSourceMap(validIndexMap([]));
            expect(result.valid).toBe(true);
        });

        it('accepts single section with valid offset and map', () => {
            const result = validateSourceMap(validIndexMap([validSection()]));
            expect(result.valid).toBe(true);
        });

        it('accepts multiple sections in ascending order by line', () => {
            const result = validateSourceMap(
                validIndexMap([
                    validSection(0, 0),
                    validSection(1, 0),
                    validSection(2, 0),
                ]),
            );
            expect(result.valid).toBe(true);
        });

        it('accepts multiple sections in ascending order by column', () => {
            const result = validateSourceMap(
                validIndexMap([
                    validSection(0, 0),
                    validSection(0, 10),
                    validSection(0, 20),
                ]),
            );
            expect(result.valid).toBe(true);
        });

        it('accepts index map with optional file field', () => {
            const result = validateSourceMap({
                version: 3,
                file: 'bundle.js',
                sections: [validSection()],
            });
            expect(result.valid).toBe(true);
        });

        it('accepts section map with all optional fields', () => {
            const result = validateSourceMap({
                version: 3,
                sections: [
                    {
                        offset: { line: 0, column: 0 },
                        map: {
                            version: 3,
                            file: 'chunk.js',
                            sourceRoot: 'src/',
                            sources: ['index.ts'],
                            sourcesContent: ['export default 1;'],
                            names: ['foo'],
                            mappings: 'AAAA',
                            ignoreList: [],
                        },
                    },
                ],
            });
            expect(result.valid).toBe(true);
        });
    });

    describe('invalid sections field', () => {
        it('rejects sections as string', () => {
            const result = validateSourceMap({
                version: 3,
                sections: 'not an array',
            });
            expect(result.valid).toBe(false);
            expect(
                hasErrorCode(
                    result.errors,
                    SourceMapErrorCode.INVALID_INDEX_MAP_SECTIONS,
                ),
            ).toBe(true);
        });

        it('rejects sections as number', () => {
            const result = validateSourceMap({
                version: 3,
                sections: 123,
            });
            expect(result.valid).toBe(false);
            expect(
                hasErrorCode(
                    result.errors,
                    SourceMapErrorCode.INVALID_INDEX_MAP_SECTIONS,
                ),
            ).toBe(true);
        });

        it('rejects sections as null', () => {
            const result = validateSourceMap({
                version: 3,
                sections: null,
            });
            expect(result.valid).toBe(false);
            expect(
                hasErrorCode(
                    result.errors,
                    SourceMapErrorCode.INVALID_INDEX_MAP_SECTIONS,
                ),
            ).toBe(true);
        });

        it('rejects section entry that is not an object', () => {
            const result = validateSourceMap({
                version: 3,
                sections: ['not an object'],
            });
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result.errors, 'must be an object')).toBe(
                true,
            );
        });

        it('rejects section entry that is null', () => {
            const result = validateSourceMap({
                version: 3,
                sections: [null],
            });
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result.errors, 'must be an object')).toBe(
                true,
            );
        });

        it('rejects section entry that is a number', () => {
            const result = validateSourceMap({
                version: 3,
                sections: [123],
            });
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result.errors, 'must be an object')).toBe(
                true,
            );
        });
    });

    describe('invalid offset', () => {
        it('rejects missing offset', () => {
            const result = validateSourceMap({
                version: 3,
                sections: [{ map: validRegularMap() }],
            });
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result.errors, 'offset is required')).toBe(
                true,
            );
            expect(
                hasErrorCode(
                    result.errors,
                    SourceMapErrorCode.INVALID_INDEX_MAP_OFFSET,
                ),
            ).toBe(true);
        });

        it('rejects offset as string', () => {
            const result = validateSourceMap({
                version: 3,
                sections: [{ offset: 'invalid', map: validRegularMap() }],
            });
            expect(result.valid).toBe(false);
            expect(
                hasErrorMessage(result.errors, 'offset must be an object'),
            ).toBe(true);
        });

        it('rejects offset as null', () => {
            const result = validateSourceMap({
                version: 3,
                sections: [{ offset: null, map: validRegularMap() }],
            });
            expect(result.valid).toBe(false);
            expect(
                hasErrorMessage(result.errors, 'offset must be an object'),
            ).toBe(true);
        });

        it('rejects missing offset.line', () => {
            const result = validateSourceMap({
                version: 3,
                sections: [{ offset: { column: 0 }, map: validRegularMap() }],
            });
            expect(result.valid).toBe(false);
            expect(
                hasErrorMessage(result.errors, 'offset.line is required'),
            ).toBe(true);
        });

        it('rejects missing offset.column', () => {
            const result = validateSourceMap({
                version: 3,
                sections: [{ offset: { line: 0 }, map: validRegularMap() }],
            });
            expect(result.valid).toBe(false);
            expect(
                hasErrorMessage(result.errors, 'offset.column is required'),
            ).toBe(true);
        });

        it('rejects offset.line as string', () => {
            const result = validateSourceMap({
                version: 3,
                sections: [
                    {
                        offset: { line: 'zero', column: 0 },
                        map: validRegularMap(),
                    },
                ],
            });
            expect(result.valid).toBe(false);
            expect(
                hasErrorMessage(
                    result.errors,
                    'offset.line must be a non-negative integer',
                ),
            ).toBe(true);
        });

        it('rejects offset.column as string', () => {
            const result = validateSourceMap({
                version: 3,
                sections: [
                    {
                        offset: { line: 0, column: 'zero' },
                        map: validRegularMap(),
                    },
                ],
            });
            expect(result.valid).toBe(false);
            expect(
                hasErrorMessage(
                    result.errors,
                    'offset.column must be a non-negative integer',
                ),
            ).toBe(true);
        });

        it('rejects negative offset.line', () => {
            const result = validateSourceMap({
                version: 3,
                sections: [
                    { offset: { line: -1, column: 0 }, map: validRegularMap() },
                ],
            });
            expect(result.valid).toBe(false);
            expect(
                hasErrorMessage(
                    result.errors,
                    'offset.line must be a non-negative integer',
                ),
            ).toBe(true);
        });

        it('rejects negative offset.column', () => {
            const result = validateSourceMap({
                version: 3,
                sections: [
                    { offset: { line: 0, column: -1 }, map: validRegularMap() },
                ],
            });
            expect(result.valid).toBe(false);
            expect(
                hasErrorMessage(
                    result.errors,
                    'offset.column must be a non-negative integer',
                ),
            ).toBe(true);
        });

        it('rejects float offset.line', () => {
            const result = validateSourceMap({
                version: 3,
                sections: [
                    {
                        offset: { line: 1.5, column: 0 },
                        map: validRegularMap(),
                    },
                ],
            });
            expect(result.valid).toBe(false);
            expect(
                hasErrorMessage(
                    result.errors,
                    'offset.line must be a non-negative integer',
                ),
            ).toBe(true);
        });

        it('rejects float offset.column', () => {
            const result = validateSourceMap({
                version: 3,
                sections: [
                    {
                        offset: { line: 0, column: 1.5 },
                        map: validRegularMap(),
                    },
                ],
            });
            expect(result.valid).toBe(false);
            expect(
                hasErrorMessage(
                    result.errors,
                    'offset.column must be a non-negative integer',
                ),
            ).toBe(true);
        });
    });

    describe('section ordering', () => {
        it('rejects sections out of order by line', () => {
            const result = validateSourceMap(
                validIndexMap([validSection(5, 0), validSection(3, 0)]),
            );
            expect(result.valid).toBe(false);
            expect(
                hasErrorMessage(result.errors, 'sections must be in order'),
            ).toBe(true);
            expect(
                hasErrorCode(
                    result.errors,
                    SourceMapErrorCode.INDEX_MAP_INVALID_ORDER,
                ),
            ).toBe(true);
        });

        it('rejects sections out of order by column on same line', () => {
            const result = validateSourceMap(
                validIndexMap([validSection(0, 20), validSection(0, 10)]),
            );
            expect(result.valid).toBe(false);
            expect(
                hasErrorMessage(result.errors, 'sections must be in order'),
            ).toBe(true);
        });

        it('accepts valid order with gaps between offsets', () => {
            const result = validateSourceMap(
                validIndexMap([
                    validSection(0, 0),
                    validSection(10, 0),
                    validSection(100, 50),
                ]),
            );
            expect(result.valid).toBe(true);
        });
    });

    describe('section overlap', () => {
        it('rejects two sections with same offset', () => {
            const result = validateSourceMap(
                validIndexMap([validSection(5, 10), validSection(5, 10)]),
            );
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result.errors, 'overlaps')).toBe(true);
            expect(
                hasErrorCode(
                    result.errors,
                    SourceMapErrorCode.INDEX_MAP_OVERLAP,
                ),
            ).toBe(true);
        });

        it('rejects three sections with same offset', () => {
            const result = validateSourceMap(
                validIndexMap([
                    validSection(0, 0),
                    validSection(0, 0),
                    validSection(0, 0),
                ]),
            );
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result.errors, 'overlaps')).toBe(true);
            // Should have multiple overlap errors
            expect(
                result.errors.filter(
                    (e) => e.code === SourceMapErrorCode.INDEX_MAP_OVERLAP,
                ).length,
            ).toBeGreaterThanOrEqual(2);
        });
    });

    describe('invalid section map', () => {
        it('rejects missing map field', () => {
            const result = validateSourceMap({
                version: 3,
                sections: [{ offset: { line: 0, column: 0 } }],
            });
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result.errors, 'map is required')).toBe(
                true,
            );
            expect(
                hasErrorCode(
                    result.errors,
                    SourceMapErrorCode.INVALID_INDEX_MAP_SECTION_MAP,
                ),
            ).toBe(true);
        });

        it('rejects map as string', () => {
            const result = validateSourceMap({
                version: 3,
                sections: [
                    { offset: { line: 0, column: 0 }, map: 'not an object' },
                ],
            });
            expect(result.valid).toBe(false);
            expect(
                hasErrorMessage(result.errors, 'map must be an object'),
            ).toBe(true);
        });

        it('rejects map as null', () => {
            const result = validateSourceMap({
                version: 3,
                sections: [{ offset: { line: 0, column: 0 }, map: null }],
            });
            expect(result.valid).toBe(false);
            expect(
                hasErrorMessage(result.errors, 'map must be an object'),
            ).toBe(true);
        });

        it('rejects map missing required fields', () => {
            const result = validateSourceMap({
                version: 3,
                sections: [
                    {
                        offset: { line: 0, column: 0 },
                        map: { version: 3 }, // Missing sources and mappings
                    },
                ],
            });
            expect(result.valid).toBe(false);
            expect(
                hasErrorMessage(result.errors, 'Missing required field'),
            ).toBe(true);
        });

        it('propagates errors from invalid mappings in section map', () => {
            const result = validateSourceMap({
                version: 3,
                sections: [
                    {
                        offset: { line: 0, column: 0 },
                        map: {
                            version: 3,
                            sources: ['index.ts'],
                            mappings: 'INVALID$MAPPINGS',
                        },
                    },
                ],
            });
            expect(result.valid).toBe(false);
            expect(hasErrorMessage(result.errors, 'non-base64 character')).toBe(
                true,
            );
        });
    });

    describe('nested index maps', () => {
        it('rejects section map that is itself an index map', () => {
            const result = validateSourceMap({
                version: 3,
                sections: [
                    {
                        offset: { line: 0, column: 0 },
                        map: {
                            version: 3,
                            sections: [], // This makes it an index map
                        },
                    },
                ],
            });
            expect(result.valid).toBe(false);
            expect(
                hasErrorMessage(result.errors, 'nested index maps not allowed'),
            ).toBe(true);
            expect(
                hasErrorCode(
                    result.errors,
                    SourceMapErrorCode.INDEX_MAP_NESTED,
                ),
            ).toBe(true);
        });

        it('rejects deeply nested index map', () => {
            const result = validateSourceMap({
                version: 3,
                sections: [
                    {
                        offset: { line: 0, column: 0 },
                        map: {
                            version: 3,
                            sections: [
                                {
                                    offset: { line: 0, column: 0 },
                                    map: validRegularMap(),
                                },
                            ],
                        },
                    },
                ],
            });
            expect(result.valid).toBe(false);
            expect(
                hasErrorCode(
                    result.errors,
                    SourceMapErrorCode.INDEX_MAP_NESTED,
                ),
            ).toBe(true);
        });
    });

    describe('index map with mappings field', () => {
        it('rejects index map with both sections and mappings', () => {
            const result = validateSourceMap({
                version: 3,
                sections: [validSection()],
                mappings: 'AAAA',
            });
            expect(result.valid).toBe(false);
            expect(
                hasErrorMessage(
                    result.errors,
                    'cannot have both "sections" and "mappings"',
                ),
            ).toBe(true);
        });

        it('returns INDEX_MAP_WITH_MAPPINGS error code', () => {
            const result = validateSourceMap({
                version: 3,
                sections: [],
                mappings: 'AAAA',
            });
            expect(result.valid).toBe(false);
            expect(
                hasErrorCode(
                    result.errors,
                    SourceMapErrorCode.INDEX_MAP_WITH_MAPPINGS,
                ),
            ).toBe(true);
        });
    });

    describe('error codes', () => {
        it('returns INVALID_INDEX_MAP_SECTIONS for invalid sections array', () => {
            const result = validateSourceMap({
                version: 3,
                sections: 'invalid',
            });
            expect(
                hasErrorCode(
                    result.errors,
                    SourceMapErrorCode.INVALID_INDEX_MAP_SECTIONS,
                ),
            ).toBe(true);
        });

        it('returns INVALID_INDEX_MAP_OFFSET for offset errors', () => {
            const result = validateSourceMap({
                version: 3,
                sections: [{ offset: null, map: validRegularMap() }],
            });
            expect(
                hasErrorCode(
                    result.errors,
                    SourceMapErrorCode.INVALID_INDEX_MAP_OFFSET,
                ),
            ).toBe(true);
        });

        it('returns INVALID_INDEX_MAP_SECTION_MAP for map errors', () => {
            const result = validateSourceMap({
                version: 3,
                sections: [{ offset: { line: 0, column: 0 }, map: null }],
            });
            expect(
                hasErrorCode(
                    result.errors,
                    SourceMapErrorCode.INVALID_INDEX_MAP_SECTION_MAP,
                ),
            ).toBe(true);
        });

        it('returns INDEX_MAP_OVERLAP for overlapping sections', () => {
            const result = validateSourceMap(
                validIndexMap([validSection(0, 0), validSection(0, 0)]),
            );
            expect(
                hasErrorCode(
                    result.errors,
                    SourceMapErrorCode.INDEX_MAP_OVERLAP,
                ),
            ).toBe(true);
        });

        it('returns INDEX_MAP_INVALID_ORDER for out-of-order sections', () => {
            const result = validateSourceMap(
                validIndexMap([validSection(10, 0), validSection(5, 0)]),
            );
            expect(
                hasErrorCode(
                    result.errors,
                    SourceMapErrorCode.INDEX_MAP_INVALID_ORDER,
                ),
            ).toBe(true);
        });

        it('returns INDEX_MAP_NESTED for nested index maps', () => {
            const result = validateSourceMap({
                version: 3,
                sections: [
                    {
                        offset: { line: 0, column: 0 },
                        map: { version: 3, sections: [] },
                    },
                ],
            });
            expect(
                hasErrorCode(
                    result.errors,
                    SourceMapErrorCode.INDEX_MAP_NESTED,
                ),
            ).toBe(true);
        });

        it('returns INDEX_MAP_WITH_MAPPINGS for mixed format', () => {
            const result = validateSourceMap({
                version: 3,
                sections: [],
                mappings: 'AAAA',
            });
            expect(
                hasErrorCode(
                    result.errors,
                    SourceMapErrorCode.INDEX_MAP_WITH_MAPPINGS,
                ),
            ).toBe(true);
        });
    });
});
