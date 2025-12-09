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
