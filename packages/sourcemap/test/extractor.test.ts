import { describe, it, expect, vi } from 'vitest';
import {
    extractSources,
    hasExtractableContent,
    getSourceMapSummary,
} from '../src/extractor.js';
import type { SourceMapV3 } from '@web2local/types';

describe('extractSources', () => {
    const baseSourceMap: SourceMapV3 = {
        version: 3,
        sources: ['src/index.ts', 'src/utils.ts'],
        sourcesContent: [
            'export default 1;',
            'export const add = (a, b) => a + b;',
        ],
        mappings: 'AAAA',
    };

    it('extracts sources from a valid source map', () => {
        const result = extractSources(
            baseSourceMap,
            'https://example.com/bundle.js',
            'https://example.com/bundle.js.map',
        );

        expect(result.sources).toHaveLength(2);
        expect(result.sources[0]).toEqual({
            path: 'src/index.ts',
            content: 'export default 1;',
            originalPath: 'src/index.ts',
        });
        expect(result.metadata.extractedCount).toBe(2);
        expect(result.metadata.totalSources).toBe(2);
    });

    it('normalizes webpack paths', () => {
        const webpackMap: SourceMapV3 = {
            version: 3,
            sources: ['webpack://myapp/./src/index.ts'],
            sourcesContent: ['export default 1;'],
            mappings: 'AAAA',
        };

        const result = extractSources(
            webpackMap,
            'https://example.com/bundle.js',
            'https://example.com/bundle.js.map',
        );

        expect(result.sources[0].path).toBe('src/index.ts');
        expect(result.sources[0].originalPath).toBe(
            'webpack://myapp/./src/index.ts',
        );
    });

    it('skips null content entries', () => {
        const mapWithNulls: SourceMapV3 = {
            version: 3,
            sources: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
            sourcesContent: ['content a', null, 'content c'],
            mappings: 'AAAA',
        };

        const result = extractSources(
            mapWithNulls,
            'https://example.com/bundle.js',
            'https://example.com/bundle.js.map',
        );

        expect(result.sources).toHaveLength(2);
        expect(result.metadata.nullContentCount).toBe(1);
        expect(result.metadata.extractedCount).toBe(2);
    });

    it('filters out node_modules by default', () => {
        const mapWithNodeModules: SourceMapV3 = {
            version: 3,
            sources: ['src/index.ts', 'node_modules/react/index.js'],
            sourcesContent: ['app code', 'react code'],
            mappings: 'AAAA',
        };

        const result = extractSources(
            mapWithNodeModules,
            'https://example.com/bundle.js',
            'https://example.com/bundle.js.map',
        );

        expect(result.sources).toHaveLength(1);
        expect(result.sources[0].path).toBe('src/index.ts');
        expect(result.metadata.skippedCount).toBe(1);
    });

    it('includes node_modules when option is set', () => {
        const mapWithNodeModules: SourceMapV3 = {
            version: 3,
            sources: ['src/index.ts', 'node_modules/react/index.js'],
            sourcesContent: ['app code', 'react code'],
            mappings: 'AAAA',
        };

        const result = extractSources(
            mapWithNodeModules,
            'https://example.com/bundle.js',
            'https://example.com/bundle.js.map',
            { includeNodeModules: true },
        );

        expect(result.sources).toHaveLength(2);
        expect(result.metadata.skippedCount).toBe(0);
    });

    it('includes internal packages from node_modules', () => {
        const mapWithInternalPkg: SourceMapV3 = {
            version: 3,
            sources: [
                'src/index.ts',
                'node_modules/@myorg/shared/index.ts',
                'node_modules/react/index.js',
            ],
            sourcesContent: ['app', 'shared', 'react'],
            mappings: 'AAAA',
        };

        const result = extractSources(
            mapWithInternalPkg,
            'https://example.com/bundle.js',
            'https://example.com/bundle.js.map',
            { internalPackages: new Set(['@myorg/shared']) },
        );

        expect(result.sources).toHaveLength(2);
        expect(result.sources.map((s) => s.path)).toContain('src/index.ts');
        expect(result.sources.map((s) => s.path)).toContain(
            'node_modules/@myorg/shared/index.ts',
        );
    });

    it('applies custom exclude patterns', () => {
        const result = extractSources(
            baseSourceMap,
            'https://example.com/bundle.js',
            'https://example.com/bundle.js.map',
            { excludePatterns: [/utils\.ts$/] },
        );

        expect(result.sources).toHaveLength(1);
        expect(result.sources[0].path).toBe('src/index.ts');
    });

    it('calls onSource callback for each extracted source', () => {
        const onSource = vi.fn();

        extractSources(
            baseSourceMap,
            'https://example.com/bundle.js',
            'https://example.com/bundle.js.map',
            { onSource },
        );

        expect(onSource).toHaveBeenCalledTimes(2);
        expect(onSource).toHaveBeenCalledWith({
            path: 'src/index.ts',
            content: 'export default 1;',
            originalPath: 'src/index.ts',
        });
    });

    it('returns error when sourcesContent is missing', () => {
        const mapWithoutContent: SourceMapV3 = {
            version: 3,
            sources: ['src/index.ts'],
            mappings: 'AAAA',
        };

        const result = extractSources(
            mapWithoutContent,
            'https://example.com/bundle.js',
            'https://example.com/bundle.js.map',
        );

        expect(result.sources).toHaveLength(0);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toContain('no sourcesContent');
    });

    it('returns error when sourcesContent is empty array', () => {
        const mapWithEmptyContent: SourceMapV3 = {
            version: 3,
            sources: ['src/index.ts'],
            sourcesContent: [],
            mappings: 'AAAA',
        };

        const result = extractSources(
            mapWithEmptyContent,
            'https://example.com/bundle.js',
            'https://example.com/bundle.js.map',
        );

        expect(result.sources).toHaveLength(0);
        expect(result.errors).toHaveLength(1);
    });

    it('applies sourceRoot from source map', () => {
        const mapWithSourceRoot: SourceMapV3 = {
            version: 3,
            sourceRoot: 'src/',
            sources: ['index.ts', 'utils.ts'],
            sourcesContent: ['code1', 'code2'],
            mappings: 'AAAA',
        };

        const result = extractSources(
            mapWithSourceRoot,
            'https://example.com/bundle.js',
            'https://example.com/bundle.js.map',
        );

        expect(result.sources[0].path).toBe('src/index.ts');
        expect(result.sources[1].path).toBe('src/utils.ts');
        expect(result.metadata.sourceRoot).toBe('src/');
    });

    it('includes metadata in result', () => {
        const result = extractSources(
            baseSourceMap,
            'https://example.com/bundle.js',
            'https://example.com/bundle.js.map',
        );

        expect(result.bundleUrl).toBe('https://example.com/bundle.js');
        expect(result.sourceMapUrl).toBe('https://example.com/bundle.js.map');
        expect(result.metadata).toEqual({
            version: 3,
            sourceRoot: null,
            totalSources: 2,
            extractedCount: 2,
            skippedCount: 0,
            nullContentCount: 0,
        });
    });
});

describe('hasExtractableContent', () => {
    it('returns true when sourcesContent has content', () => {
        const map: SourceMapV3 = {
            version: 3,
            sources: ['index.ts'],
            sourcesContent: ['content'],
            mappings: 'AAAA',
        };
        expect(hasExtractableContent(map)).toBe(true);
    });

    it('returns false when sourcesContent is missing', () => {
        const map: SourceMapV3 = {
            version: 3,
            sources: ['index.ts'],
            mappings: 'AAAA',
        };
        expect(hasExtractableContent(map)).toBe(false);
    });

    it('returns false when sourcesContent is empty', () => {
        const map: SourceMapV3 = {
            version: 3,
            sources: ['index.ts'],
            sourcesContent: [],
            mappings: 'AAAA',
        };
        expect(hasExtractableContent(map)).toBe(false);
    });

    it('returns false when all sourcesContent entries are null', () => {
        const map: SourceMapV3 = {
            version: 3,
            sources: ['a.ts', 'b.ts'],
            sourcesContent: [null, null],
            mappings: 'AAAA',
        };
        expect(hasExtractableContent(map)).toBe(false);
    });

    it('returns true when at least one entry has content', () => {
        const map: SourceMapV3 = {
            version: 3,
            sources: ['a.ts', 'b.ts'],
            sourcesContent: [null, 'content'],
            mappings: 'AAAA',
        };
        expect(hasExtractableContent(map)).toBe(true);
    });
});

describe('getSourceMapSummary', () => {
    it('returns accurate summary', () => {
        const map: SourceMapV3 = {
            version: 3,
            sourceRoot: 'src/',
            sources: ['a.ts', 'b.ts', 'c.ts'],
            sourcesContent: ['content', null, 'more content'],
            mappings: 'AAAA',
        };

        const summary = getSourceMapSummary(map);
        expect(summary).toEqual({
            totalSources: 3,
            withContent: 2,
            nullContent: 1,
            sourceRoot: 'src/',
        });
    });

    it('handles missing sourcesContent', () => {
        const map: SourceMapV3 = {
            version: 3,
            sources: ['a.ts', 'b.ts'],
            mappings: 'AAAA',
        };

        const summary = getSourceMapSummary(map);
        expect(summary).toEqual({
            totalSources: 2,
            withContent: 0,
            nullContent: 0,
            sourceRoot: null,
        });
    });

    it('handles missing sourceRoot', () => {
        const map: SourceMapV3 = {
            version: 3,
            sources: ['a.ts'],
            sourcesContent: ['content'],
            mappings: 'AAAA',
        };

        const summary = getSourceMapSummary(map);
        expect(summary.sourceRoot).toBe(null);
    });
});
