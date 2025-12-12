import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../../helpers/msw-handlers.js';
import { extractSourceMap } from '../src/index.js';
import { SourceMapError, SourceMapErrorCode } from '../src/errors.js';

// ============================================================================
// HELPERS
// ============================================================================

// Split to prevent build tools from parsing as actual source map reference
const SOURCE_MAPPING_URL = 'source' + 'MappingURL';

function createJsBundle(sourceMapUrl: string): string {
    return `function hello(){console.log("hello")}\n//# ${SOURCE_MAPPING_URL}=${sourceMapUrl}`;
}

function createCssBundle(sourceMapUrl: string): string {
    return `.container{padding:16px}\n/*# ${SOURCE_MAPPING_URL}=${sourceMapUrl} */`;
}

function createSourceMap(options?: {
    sources?: string[];
    sourcesContent?: (string | null)[];
    sourceRoot?: string;
}) {
    return {
        version: 3,
        sources: options?.sources ?? ['src/index.ts'],
        sourcesContent: options?.sourcesContent ?? ['export const x = 1;'],
        sourceRoot: options?.sourceRoot,
        mappings: 'AAAA',
    };
}

// ============================================================================
// extractSourceMap - BASIC FUNCTIONALITY
// ============================================================================

describe('extractSourceMap', () => {
    describe('basic functionality', () => {
        it('extracts sources from a JS bundle with external source map', async () => {
            server.use(
                http.get('https://example.com/bundle.js', () => {
                    return new HttpResponse(createJsBundle('bundle.js.map'), {
                        headers: { 'Content-Type': 'application/javascript' },
                    });
                }),
                http.get('https://example.com/bundle.js.map', () => {
                    return HttpResponse.json(
                        createSourceMap({
                            sources: ['src/index.ts', 'src/utils.ts'],
                            sourcesContent: [
                                'export const x = 1;',
                                'export const y = 2;',
                            ],
                        }),
                    );
                }),
            );

            const result = await extractSourceMap(
                'https://example.com/bundle.js',
            );

            expect(result.bundleUrl).toBe('https://example.com/bundle.js');
            expect(result.sourceMapUrl).toBe(
                'https://example.com/bundle.js.map',
            );
            expect(result.sources).toHaveLength(2);
            expect(result.errors).toHaveLength(0);
            expect(result.metadata.extractedCount).toBe(2);
        });

        it('extracts sources from a CSS bundle', async () => {
            server.use(
                http.get('https://example.com/styles.css', () => {
                    return new HttpResponse(createCssBundle('styles.css.map'), {
                        headers: { 'Content-Type': 'text/css' },
                    });
                }),
                http.get('https://example.com/styles.css.map', () => {
                    return HttpResponse.json(
                        createSourceMap({
                            sources: ['src/styles.scss'],
                            sourcesContent: ['.container { padding: 16px; }'],
                        }),
                    );
                }),
            );

            const result = await extractSourceMap(
                'https://example.com/styles.css',
            );

            expect(result.sources).toHaveLength(1);
            expect(result.sources[0].path).toBe('src/styles.scss');
        });

        it('extracts sources from inline base64 source map', async () => {
            const sourceMap = createSourceMap({
                sources: ['inline.ts'],
                sourcesContent: ['console.log("inline");'],
            });
            const base64 = Buffer.from(JSON.stringify(sourceMap)).toString(
                'base64',
            );
            const dataUri = `data:application/json;base64,${base64}`;

            server.use(
                http.get('https://example.com/inline.js', () => {
                    return new HttpResponse(createJsBundle(dataUri), {
                        headers: { 'Content-Type': 'application/javascript' },
                    });
                }),
            );

            const result = await extractSourceMap(
                'https://example.com/inline.js',
            );

            expect(result.sources).toHaveLength(1);
            expect(result.sources[0].path).toBe('inline.ts');
            expect(result.sources[0].content).toBe('console.log("inline");');
        });

        it('discovers source map from HTTP header', async () => {
            server.use(
                http.get('https://example.com/bundle.js', () => {
                    return new HttpResponse('function x(){}', {
                        headers: {
                            'Content-Type': 'application/javascript',
                            SourceMap: 'bundle.js.map',
                        },
                    });
                }),
                http.get('https://example.com/bundle.js.map', () => {
                    return HttpResponse.json(createSourceMap());
                }),
            );

            const result = await extractSourceMap(
                'https://example.com/bundle.js',
            );

            expect(result.sources).toHaveLength(1);
        });
    });

    // ============================================================================
    // PATH NORMALIZATION
    // ============================================================================

    describe('path normalization', () => {
        it('normalizes webpack:// paths', async () => {
            server.use(
                http.get('https://example.com/bundle.js', () => {
                    return new HttpResponse(createJsBundle('bundle.js.map'), {
                        headers: { 'Content-Type': 'application/javascript' },
                    });
                }),
                http.get('https://example.com/bundle.js.map', () => {
                    return HttpResponse.json(
                        createSourceMap({
                            sources: ['webpack://myapp/./src/index.ts'],
                            sourcesContent: ['export default 1;'],
                        }),
                    );
                }),
            );

            const result = await extractSourceMap(
                'https://example.com/bundle.js',
            );

            expect(result.sources[0].path).toBe('src/index.ts');
            expect(result.sources[0].originalPath).toBe(
                'webpack://myapp/./src/index.ts',
            );
        });

        it('applies sourceRoot to paths', async () => {
            server.use(
                http.get('https://example.com/bundle.js', () => {
                    return new HttpResponse(createJsBundle('bundle.js.map'), {
                        headers: { 'Content-Type': 'application/javascript' },
                    });
                }),
                http.get('https://example.com/bundle.js.map', () => {
                    return HttpResponse.json(
                        createSourceMap({
                            sources: ['index.ts'],
                            sourcesContent: ['export default 1;'],
                            sourceRoot: 'src/',
                        }),
                    );
                }),
            );

            const result = await extractSourceMap(
                'https://example.com/bundle.js',
            );

            expect(result.sources[0].path).toBe('src/index.ts');
            expect(result.metadata.sourceRoot).toBe('src/');
        });
    });

    // ============================================================================
    // FILTERING
    // ============================================================================

    describe('filtering', () => {
        it('includes node_modules sources', async () => {
            server.use(
                http.get('https://example.com/bundle.js', () => {
                    return new HttpResponse(createJsBundle('bundle.js.map'), {
                        headers: { 'Content-Type': 'application/javascript' },
                    });
                }),
                http.get('https://example.com/bundle.js.map', () => {
                    return HttpResponse.json(
                        createSourceMap({
                            sources: [
                                'src/index.ts',
                                'node_modules/lodash/lodash.js',
                            ],
                            sourcesContent: ['app code', 'lodash code'],
                        }),
                    );
                }),
            );

            const result = await extractSourceMap(
                'https://example.com/bundle.js',
            );

            // node_modules are now included by default (no filtering)
            expect(result.sources).toHaveLength(2);
            expect(result.sources[0].path).toBe('src/index.ts');
            expect(result.sources[1].path).toBe(
                'node_modules/lodash/lodash.js',
            );
            expect(result.metadata.skippedCount).toBe(0);
        });

        it('skips sources with null content', async () => {
            server.use(
                http.get('https://example.com/bundle.js', () => {
                    return new HttpResponse(createJsBundle('bundle.js.map'), {
                        headers: { 'Content-Type': 'application/javascript' },
                    });
                }),
                http.get('https://example.com/bundle.js.map', () => {
                    return HttpResponse.json(
                        createSourceMap({
                            sources: ['a.ts', 'b.ts', 'c.ts'],
                            sourcesContent: ['content a', null, 'content c'],
                        }),
                    );
                }),
            );

            const result = await extractSourceMap(
                'https://example.com/bundle.js',
            );

            expect(result.sources).toHaveLength(2);
            expect(result.metadata.nullContentCount).toBe(1);
        });
    });

    // ============================================================================
    // ERROR HANDLING
    // ============================================================================

    describe('error handling', () => {
        it('returns error when no source map found', async () => {
            server.use(
                http.get('https://example.com/bundle.js', () => {
                    return new HttpResponse('function x(){}', {
                        headers: { 'Content-Type': 'application/javascript' },
                    });
                }),
                // No .map file exists - probe uses HEAD request
                http.head('https://example.com/bundle.js.map', () => {
                    return new HttpResponse(null, { status: 404 });
                }),
            );

            const result = await extractSourceMap(
                'https://example.com/bundle.js',
            );

            expect(result.sources).toHaveLength(0);
            expect(result.errors).toHaveLength(1);
            expect(result.errors[0]).toBeInstanceOf(SourceMapError);
            expect((result.errors[0] as SourceMapError).code).toBe(
                SourceMapErrorCode.NO_SOURCE_MAP_FOUND,
            );
        });

        it('returns error on HTTP failure fetching source map', async () => {
            server.use(
                http.get('https://example.com/bundle.js', () => {
                    return new HttpResponse(createJsBundle('bundle.js.map'), {
                        headers: { 'Content-Type': 'application/javascript' },
                    });
                }),
                http.get('https://example.com/bundle.js.map', () => {
                    return new HttpResponse('Forbidden', { status: 403 });
                }),
            );

            const result = await extractSourceMap(
                'https://example.com/bundle.js',
            );

            expect(result.sources).toHaveLength(0);
            expect(result.errors).toHaveLength(1);
            expect((result.errors[0] as SourceMapError).code).toBe(
                SourceMapErrorCode.HTTP_ERROR,
            );
            expect((result.errors[0] as SourceMapError).details?.status).toBe(
                403,
            );
        });

        it('returns error on invalid JSON in source map', async () => {
            server.use(
                http.get('https://example.com/bundle.js', () => {
                    return new HttpResponse(createJsBundle('bundle.js.map'), {
                        headers: { 'Content-Type': 'application/javascript' },
                    });
                }),
                http.get('https://example.com/bundle.js.map', () => {
                    return new HttpResponse('{ invalid json }', {
                        headers: { 'Content-Type': 'application/json' },
                    });
                }),
            );

            const result = await extractSourceMap(
                'https://example.com/bundle.js',
            );

            expect(result.sources).toHaveLength(0);
            expect(result.errors).toHaveLength(1);
        });

        it('returns error when source map has no sourcesContent', async () => {
            server.use(
                http.get('https://example.com/bundle.js', () => {
                    return new HttpResponse(createJsBundle('bundle.js.map'), {
                        headers: { 'Content-Type': 'application/javascript' },
                    });
                }),
                http.get('https://example.com/bundle.js.map', () => {
                    return HttpResponse.json({
                        version: 3,
                        sources: ['index.ts'],
                        mappings: 'AAAA',
                        // No sourcesContent
                    });
                }),
            );

            const result = await extractSourceMap(
                'https://example.com/bundle.js',
            );

            expect(result.sources).toHaveLength(0);
            expect(result.errors).toHaveLength(1);
            expect((result.errors[0] as SourceMapError).code).toBe(
                SourceMapErrorCode.NO_EXTRACTABLE_SOURCES,
            );
        });

        it('returns error when source map exceeds size limit', async () => {
            server.use(
                http.get('https://example.com/bundle.js', () => {
                    return new HttpResponse(createJsBundle('bundle.js.map'), {
                        headers: { 'Content-Type': 'application/javascript' },
                    });
                }),
                http.get('https://example.com/bundle.js.map', () => {
                    return HttpResponse.json(createSourceMap(), {
                        headers: {
                            'Content-Length': '200000000', // 200MB
                        },
                    });
                }),
            );

            const result = await extractSourceMap(
                'https://example.com/bundle.js',
                {
                    maxSize: 100 * 1024 * 1024, // 100MB
                },
            );

            expect(result.sources).toHaveLength(0);
            expect(result.errors).toHaveLength(1);
            expect((result.errors[0] as SourceMapError).code).toBe(
                SourceMapErrorCode.SOURCE_MAP_TOO_LARGE,
            );
        });
    });

    // ============================================================================
    // METADATA
    // ============================================================================

    describe('metadata', () => {
        it('includes accurate metadata counts', async () => {
            server.use(
                http.get('https://example.com/bundle.js', () => {
                    return new HttpResponse(createJsBundle('bundle.js.map'), {
                        headers: { 'Content-Type': 'application/javascript' },
                    });
                }),
                http.get('https://example.com/bundle.js.map', () => {
                    return HttpResponse.json(
                        createSourceMap({
                            sources: [
                                'src/a.ts',
                                'src/b.ts',
                                'node_modules/x/index.js',
                                'src/c.ts',
                            ],
                            sourcesContent: ['a', null, 'x', 'c'],
                        }),
                    );
                }),
            );

            const result = await extractSourceMap(
                'https://example.com/bundle.js',
            );

            expect(result.metadata.version).toBe(3);
            expect(result.metadata.totalSources).toBe(4);
            expect(result.metadata.extractedCount).toBe(3); // a.ts, c.ts, and node_modules/x/index.js
            expect(result.metadata.skippedCount).toBe(0); // no filtering
            expect(result.metadata.nullContentCount).toBe(1); // b.ts
        });

        it('includes sourceRoot in metadata', async () => {
            server.use(
                http.get('https://example.com/bundle.js', () => {
                    return new HttpResponse(createJsBundle('bundle.js.map'), {
                        headers: { 'Content-Type': 'application/javascript' },
                    });
                }),
                http.get('https://example.com/bundle.js.map', () => {
                    return HttpResponse.json(
                        createSourceMap({
                            sourceRoot: 'webpack://myapp/',
                        }),
                    );
                }),
            );

            const result = await extractSourceMap(
                'https://example.com/bundle.js',
            );

            expect(result.metadata.sourceRoot).toBe('webpack://myapp/');
        });
    });

    // ============================================================================
    // OPTIONS
    // ============================================================================

    describe('options', () => {
        it('passes custom headers to requests', async () => {
            let receivedHeaders: Headers | null = null;

            server.use(
                http.get('https://example.com/bundle.js', ({ request }) => {
                    receivedHeaders = request.headers;
                    return new HttpResponse(createJsBundle('bundle.js.map'), {
                        headers: { 'Content-Type': 'application/javascript' },
                    });
                }),
                http.get('https://example.com/bundle.js.map', () => {
                    return HttpResponse.json(createSourceMap());
                }),
            );

            await extractSourceMap('https://example.com/bundle.js', {
                headers: { Authorization: 'Bearer token123' },
            });

            expect(receivedHeaders?.get('Authorization')).toBe(
                'Bearer token123',
            );
        });

        it('calls onSource callback for each extracted source', async () => {
            server.use(
                http.get('https://example.com/bundle.js', () => {
                    return new HttpResponse(createJsBundle('bundle.js.map'), {
                        headers: { 'Content-Type': 'application/javascript' },
                    });
                }),
                http.get('https://example.com/bundle.js.map', () => {
                    return HttpResponse.json(
                        createSourceMap({
                            sources: ['a.ts', 'b.ts'],
                            sourcesContent: ['content a', 'content b'],
                        }),
                    );
                }),
            );

            const extractedSources: string[] = [];

            await extractSourceMap('https://example.com/bundle.js', {
                onSource: (source) => {
                    extractedSources.push(source.path);
                },
            });

            expect(extractedSources).toEqual(['a.ts', 'b.ts']);
        });
    });
});
