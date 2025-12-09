/**
 * Source Map Discovery Tests
 *
 * Tests for source map URL extraction from HTTP headers and file comments.
 */

import { describe, it, expect } from 'vitest';
import {
    findSourceMapInHeaders,
    findSourceMapInJsComment,
    findSourceMapInCssComment,
    findSourceMapInComment,
    isValidSourceMapContentType,
} from '../src/discovery.js';

describe('findSourceMapInHeaders', () => {
    it('finds SourceMap header', () => {
        const headers = new Headers({
            SourceMap: 'bundle.js.map',
        });
        expect(findSourceMapInHeaders(headers)).toBe('bundle.js.map');
    });

    it('finds X-SourceMap header', () => {
        const headers = new Headers({
            'X-SourceMap': 'bundle.js.map',
        });
        expect(findSourceMapInHeaders(headers)).toBe('bundle.js.map');
    });

    it('prefers SourceMap over X-SourceMap', () => {
        const headers = new Headers({
            SourceMap: 'preferred.map',
            'X-SourceMap': 'fallback.map',
        });
        expect(findSourceMapInHeaders(headers)).toBe('preferred.map');
    });

    it('returns null when no header present', () => {
        const headers = new Headers({
            'Content-Type': 'application/javascript',
        });
        expect(findSourceMapInHeaders(headers)).toBe(null);
    });

    it('handles absolute URLs in header', () => {
        const headers = new Headers({
            SourceMap: 'https://cdn.example.com/bundle.js.map',
        });
        expect(findSourceMapInHeaders(headers)).toBe(
            'https://cdn.example.com/bundle.js.map',
        );
    });
});

describe('findSourceMapInJsComment', () => {
    // Note: We split 'sourceMappingURL' to prevent Vite from parsing these as actual source maps
    const SOURCE_MAP_URL = 'source' + 'MappingURL';

    it('finds sourceMappingURL with # prefix', () => {
        const content = `
            var foo = 1;
            //# ${SOURCE_MAP_URL}=bundle.js.map
        `;
        expect(findSourceMapInJsComment(content)).toBe('bundle.js.map');
    });

    it('finds sourceMappingURL with @ prefix (legacy)', () => {
        const content = `
            var foo = 1;
            //@ ${SOURCE_MAP_URL}=bundle.js.map
        `;
        expect(findSourceMapInJsComment(content)).toBe('bundle.js.map');
    });

    it('handles inline data URI', () => {
        const content = `
            var foo = 1;
            //# ${SOURCE_MAP_URL}=data:application/json;base64,eyJ2ZXJzaW9uIjozfQ==
        `;
        expect(findSourceMapInJsComment(content)).toBe(
            'data:application/json;base64,eyJ2ZXJzaW9uIjozfQ==',
        );
    });

    it('returns null when no comment present', () => {
        const content = `var foo = 1;`;
        expect(findSourceMapInJsComment(content)).toBe(null);
    });

    it('handles URLs with special characters', () => {
        const content = `//# ${SOURCE_MAP_URL}=bundle.min.js.map?v=123`;
        expect(findSourceMapInJsComment(content)).toBe(
            'bundle.min.js.map?v=123',
        );
    });

    it('handles trailing whitespace', () => {
        const content = `//# ${SOURCE_MAP_URL}=bundle.js.map   `;
        expect(findSourceMapInJsComment(content)).toBe('bundle.js.map');
    });
});

describe('findSourceMapInCssComment', () => {
    // Note: We split 'sourceMappingURL' to prevent Vite from parsing these as actual source maps
    const SOURCE_MAP_URL = 'source' + 'MappingURL';

    it('finds sourceMappingURL in CSS comment', () => {
        const content = `
            .foo { color: red; }
            /*# ${SOURCE_MAP_URL}=styles.css.map */
        `;
        expect(findSourceMapInCssComment(content)).toBe('styles.css.map');
    });

    it('finds sourceMappingURL with @ prefix', () => {
        const content = `
            .foo { color: red; }
            /*@ ${SOURCE_MAP_URL}=styles.css.map */
        `;
        expect(findSourceMapInCssComment(content)).toBe('styles.css.map');
    });

    it('handles inline data URI', () => {
        const content = `
            .foo { color: red; }
            /*# ${SOURCE_MAP_URL}=data:application/json;base64,eyJ2ZXJzaW9uIjozfQ== */
        `;
        expect(findSourceMapInCssComment(content)).toBe(
            'data:application/json;base64,eyJ2ZXJzaW9uIjozfQ==',
        );
    });

    it('returns null when no comment present', () => {
        const content = `.foo { color: red; }`;
        expect(findSourceMapInCssComment(content)).toBe(null);
    });
});

describe('findSourceMapInComment', () => {
    // Note: We split 'sourceMappingURL' to prevent Vite from parsing these as actual source maps
    const SOURCE_MAP_URL = 'source' + 'MappingURL';

    it('finds JS comments when type is js', () => {
        const content = `//# ${SOURCE_MAP_URL}=bundle.js.map`;
        expect(findSourceMapInComment(content, 'js')).toBe('bundle.js.map');
    });

    it('finds CSS comments when type is css', () => {
        const content = `/*# ${SOURCE_MAP_URL}=styles.css.map */`;
        expect(findSourceMapInComment(content, 'css')).toBe('styles.css.map');
    });

    it('auto-detects JS comment', () => {
        const content = `//# ${SOURCE_MAP_URL}=bundle.js.map`;
        expect(findSourceMapInComment(content, 'auto')).toBe('bundle.js.map');
    });

    it('auto-detects CSS comment', () => {
        const content = `/*# ${SOURCE_MAP_URL}=styles.css.map */`;
        expect(findSourceMapInComment(content, 'auto')).toBe('styles.css.map');
    });

    it('defaults to auto detection', () => {
        const jsContent = `//# ${SOURCE_MAP_URL}=bundle.js.map`;
        const cssContent = `/*# ${SOURCE_MAP_URL}=styles.css.map */`;

        expect(findSourceMapInComment(jsContent)).toBe('bundle.js.map');
        expect(findSourceMapInComment(cssContent)).toBe('styles.css.map');
    });
});

// ============================================================================
// ECMA-426 SPEC COMPLIANCE TESTS
//
// These tests verify compliance with ECMA-426 section 11.1.2.1
// (JavaScriptExtractSourceMapURL) and 11.1.2.2 (CSSExtractSourceMapURL).
//
// Key spec behaviors tested:
// 1. Only URLs in TRAILING POSITION are valid (no code after)
// 2. Multiple URLs: LAST ONE WINS (spec uses `lastURL` variable)
// 3. Code resets the tracked URL to null
// 4. All line terminator types are supported
// 5. Multi-line comments spanning multiple lines are supported
//
// The "last URL wins" behavior is SPEC-COMPLIANT. The spec algorithm:
// - Tracks `lastURL`, updating it on each sourceMappingURL match
// - Resets `lastURL` to null when non-comment code is encountered
// - Returns `lastURL` at the end
//
// @see https://tc39.es/ecma426/
// ============================================================================

describe('findSourceMapInJsComment - ECMA-426 spec compliance', () => {
    // Note: We split 'sourceMappingURL' to prevent build tools from parsing these
    const SOURCE_MAP_URL = 'source' + 'MappingURL';

    describe('trailing position behavior', () => {
        it('finds URL at end of file (no trailing newline)', () => {
            const content = `code();\n//# ${SOURCE_MAP_URL}=app.js.map`;
            expect(findSourceMapInJsComment(content)).toBe('app.js.map');
        });

        it('finds URL at end of file (with trailing newline)', () => {
            const content = `code();\n//# ${SOURCE_MAP_URL}=app.js.map\n`;
            expect(findSourceMapInJsComment(content)).toBe('app.js.map');
        });

        it('finds URL followed by whitespace-only lines', () => {
            const content = `code();\n//# ${SOURCE_MAP_URL}=app.js.map\n   \n\t\n`;
            expect(findSourceMapInJsComment(content)).toBe('app.js.map');
        });

        it('finds URL followed by more comments', () => {
            const content = `code();\n//# ${SOURCE_MAP_URL}=app.js.map\n// some other comment\n`;
            expect(findSourceMapInJsComment(content)).toBe('app.js.map');
        });

        it('returns null when URL is followed by code', () => {
            const content = `//# ${SOURCE_MAP_URL}=app.js.map\ncode();`;
            expect(findSourceMapInJsComment(content)).toBe(null);
        });

        it('returns null when URL is followed by code on same line', () => {
            const content = `//# ${SOURCE_MAP_URL}=app.js.map\nvar x = 1;`;
            expect(findSourceMapInJsComment(content)).toBe(null);
        });
    });

    describe('multiple URLs behavior (last one wins)', () => {
        it('returns last URL when multiple exist (last one in trailing position)', () => {
            const content = `//# ${SOURCE_MAP_URL}=first.js.map\ncode();\n//# ${SOURCE_MAP_URL}=last.js.map`;
            expect(findSourceMapInJsComment(content)).toBe('last.js.map');
        });

        it('returns null when all URLs are followed by code', () => {
            const content = `//# ${SOURCE_MAP_URL}=first.js.map\ncode();\n//# ${SOURCE_MAP_URL}=second.js.map\nmoreCode();`;
            expect(findSourceMapInJsComment(content)).toBe(null);
        });

        it('returns the last valid URL when some are invalidated by code', () => {
            const content = `//# ${SOURCE_MAP_URL}=first.js.map\ncode();\n//# ${SOURCE_MAP_URL}=second.js.map\n// comment`;
            expect(findSourceMapInJsComment(content)).toBe('second.js.map');
        });
    });

    describe('multi-line comment support', () => {
        it('handles multi-line comment style on single line', () => {
            const content = `code();\n/*# ${SOURCE_MAP_URL}=app.js.map */`;
            expect(findSourceMapInJsComment(content)).toBe('app.js.map');
        });

        it('handles multi-line comment spanning multiple lines', () => {
            const content = `code();\n/*\n# ${SOURCE_MAP_URL}=app.js.map\n*/`;
            expect(findSourceMapInJsComment(content)).toBe('app.js.map');
        });

        it('handles multi-line comment with content before URL', () => {
            const content = `code();\n/* some text\n# ${SOURCE_MAP_URL}=app.js.map\n*/`;
            expect(findSourceMapInJsComment(content)).toBe('app.js.map');
        });

        it('handles unclosed multi-line comment at end of file', () => {
            const content = `code();\n/*# ${SOURCE_MAP_URL}=app.js.map`;
            expect(findSourceMapInJsComment(content)).toBe('app.js.map');
        });
    });

    describe('line terminator handling', () => {
        it('handles \\n (Unix)', () => {
            const content = `code();\n//# ${SOURCE_MAP_URL}=app.js.map`;
            expect(findSourceMapInJsComment(content)).toBe('app.js.map');
        });

        it('handles \\r\\n (Windows)', () => {
            const content = `code();\r\n//# ${SOURCE_MAP_URL}=app.js.map`;
            expect(findSourceMapInJsComment(content)).toBe('app.js.map');
        });

        it('handles \\r (old Mac)', () => {
            const content = `code();\r//# ${SOURCE_MAP_URL}=app.js.map`;
            expect(findSourceMapInJsComment(content)).toBe('app.js.map');
        });

        it('handles U+2028 (Line Separator)', () => {
            const content = `code();\u2028//# ${SOURCE_MAP_URL}=app.js.map`;
            expect(findSourceMapInJsComment(content)).toBe('app.js.map');
        });

        it('handles U+2029 (Paragraph Separator)', () => {
            const content = `code();\u2029//# ${SOURCE_MAP_URL}=app.js.map`;
            expect(findSourceMapInJsComment(content)).toBe('app.js.map');
        });
    });

    describe('edge cases', () => {
        it('handles @ prefix (legacy)', () => {
            const content = `code();\n//@ ${SOURCE_MAP_URL}=app.js.map`;
            expect(findSourceMapInJsComment(content)).toBe('app.js.map');
        });

        it('handles division operator not as comment start', () => {
            const content = `var x = 10 / 2;\n//# ${SOURCE_MAP_URL}=app.js.map`;
            expect(findSourceMapInJsComment(content)).toBe('app.js.map');
        });

        it('handles regex literals (simple case)', () => {
            // Note: Full regex parsing would require a JS parser
            // This tests that forward slashes in code reset the URL
            const content = `//# ${SOURCE_MAP_URL}=app.js.map\nvar r = /test/;`;
            expect(findSourceMapInJsComment(content)).toBe(null);
        });

        it('handles empty file', () => {
            expect(findSourceMapInJsComment('')).toBe(null);
        });

        it('handles file with only whitespace', () => {
            expect(findSourceMapInJsComment('   \n\t\n   ')).toBe(null);
        });

        it('handles file with only comments', () => {
            const content = `// comment 1\n// comment 2\n//# ${SOURCE_MAP_URL}=app.js.map`;
            expect(findSourceMapInJsComment(content)).toBe('app.js.map');
        });
    });
});

describe('findSourceMapInCssComment - ECMA-426 spec compliance', () => {
    const SOURCE_MAP_URL = 'source' + 'MappingURL';

    describe('trailing position behavior', () => {
        it('finds URL at end of file', () => {
            const content = `.class { color: red; }\n/*# ${SOURCE_MAP_URL}=styles.css.map */`;
            expect(findSourceMapInCssComment(content)).toBe('styles.css.map');
        });

        it('finds URL followed by whitespace', () => {
            const content = `.class { color: red; }\n/*# ${SOURCE_MAP_URL}=styles.css.map */\n  \n`;
            expect(findSourceMapInCssComment(content)).toBe('styles.css.map');
        });

        it('returns null when URL is followed by CSS', () => {
            const content = `/*# ${SOURCE_MAP_URL}=styles.css.map */\n.class { color: red; }`;
            expect(findSourceMapInCssComment(content)).toBe(null);
        });

        it('returns null when URL is followed by CSS on same line', () => {
            const content = `/*# ${SOURCE_MAP_URL}=styles.css.map */ .class { }`;
            expect(findSourceMapInCssComment(content)).toBe(null);
        });
    });

    describe('multiple URLs behavior', () => {
        it('returns last URL when multiple exist', () => {
            const content = `/*# ${SOURCE_MAP_URL}=first.css.map */\n.a{}\n/*# ${SOURCE_MAP_URL}=last.css.map */`;
            expect(findSourceMapInCssComment(content)).toBe('last.css.map');
        });

        it('returns null when all URLs are followed by CSS', () => {
            const content = `/*# ${SOURCE_MAP_URL}=first.css.map */\n.a{}\n/*# ${SOURCE_MAP_URL}=second.css.map */\n.b{}`;
            expect(findSourceMapInCssComment(content)).toBe(null);
        });
    });

    describe('multi-line comment support', () => {
        it('handles multi-line comment spanning multiple lines', () => {
            const content = `.class { }\n/*\n# ${SOURCE_MAP_URL}=styles.css.map\n*/`;
            expect(findSourceMapInCssComment(content)).toBe('styles.css.map');
        });

        it('handles unclosed multi-line comment at end of file', () => {
            const content = `.class { }\n/*# ${SOURCE_MAP_URL}=styles.css.map`;
            expect(findSourceMapInCssComment(content)).toBe('styles.css.map');
        });
    });

    describe('edge cases', () => {
        it('handles @ prefix', () => {
            const content = `.class { }\n/*@ ${SOURCE_MAP_URL}=styles.css.map */`;
            expect(findSourceMapInCssComment(content)).toBe('styles.css.map');
        });

        it('handles empty file', () => {
            expect(findSourceMapInCssComment('')).toBe(null);
        });

        it('handles file with only comments', () => {
            const content = `/* comment */\n/*# ${SOURCE_MAP_URL}=styles.css.map */`;
            expect(findSourceMapInCssComment(content)).toBe('styles.css.map');
        });

        it('handles various line terminators', () => {
            expect(
                findSourceMapInCssComment(
                    `.a{}\r\n/*# ${SOURCE_MAP_URL}=styles.css.map */`,
                ),
            ).toBe('styles.css.map');
            expect(
                findSourceMapInCssComment(
                    `.a{}\r/*# ${SOURCE_MAP_URL}=styles.css.map */`,
                ),
            ).toBe('styles.css.map');
        });
    });
});

describe('isValidSourceMapContentType', () => {
    it('accepts application/json', () => {
        expect(isValidSourceMapContentType('application/json')).toBe(true);
    });

    it('accepts application/json with charset', () => {
        expect(
            isValidSourceMapContentType('application/json; charset=utf-8'),
        ).toBe(true);
    });

    it('accepts application/octet-stream', () => {
        expect(isValidSourceMapContentType('application/octet-stream')).toBe(
            true,
        );
    });

    it('accepts text/plain', () => {
        expect(isValidSourceMapContentType('text/plain')).toBe(true);
    });

    it('accepts empty content type', () => {
        expect(isValidSourceMapContentType('')).toBe(true);
    });

    it('rejects text/html (SPA fallback)', () => {
        expect(isValidSourceMapContentType('text/html')).toBe(false);
    });

    it('rejects text/html with charset', () => {
        expect(isValidSourceMapContentType('text/html; charset=utf-8')).toBe(
            false,
        );
    });

    it('handles case insensitivity', () => {
        expect(isValidSourceMapContentType('Application/JSON')).toBe(true);
        expect(isValidSourceMapContentType('TEXT/HTML')).toBe(false);
    });
});

// ============================================================================
// DISCOVER SOURCE MAP & PROBE SOURCE MAP URL TESTS
//
// These tests use MSW for HTTP mocking. They test the full discovery flow
// and probing functionality.
// ============================================================================

import { http, HttpResponse } from 'msw';
import { discoverSourceMap, probeSourceMapUrl } from '../src/discovery.js';
import { server } from '../../../helpers/msw-handlers.js';

describe('probeSourceMapUrl', () => {
    it('returns map URL when probe succeeds with valid content type', async () => {
        server.use(
            http.head('https://example.com/bundle.js.map', () => {
                return new HttpResponse(null, {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }),
        );

        const result = await probeSourceMapUrl('https://example.com/bundle.js');
        expect(result).toBe('https://example.com/bundle.js.map');
    });

    it('returns null when probe returns 404', async () => {
        server.use(
            http.head('https://example.com/bundle.js.map', () => {
                return new HttpResponse(null, { status: 404 });
            }),
        );

        const result = await probeSourceMapUrl('https://example.com/bundle.js');
        expect(result).toBe(null);
    });

    it('returns null when probe returns text/html (SPA fallback)', async () => {
        server.use(
            http.head('https://example.com/bundle.js.map', () => {
                return new HttpResponse(null, {
                    status: 200,
                    headers: { 'Content-Type': 'text/html' },
                });
            }),
        );

        const result = await probeSourceMapUrl('https://example.com/bundle.js');
        expect(result).toBe(null);
    });

    it('returns map URL when content type is missing', async () => {
        server.use(
            http.head('https://example.com/bundle.js.map', () => {
                return new HttpResponse(null, { status: 200 });
            }),
        );

        const result = await probeSourceMapUrl('https://example.com/bundle.js');
        expect(result).toBe('https://example.com/bundle.js.map');
    });

    it('returns null when network fails', async () => {
        server.use(
            http.head('https://example.com/bundle.js.map', () => {
                return HttpResponse.error();
            }),
        );

        const result = await probeSourceMapUrl('https://example.com/bundle.js');
        expect(result).toBe(null);
    });
});

describe('discoverSourceMap', () => {
    const SOURCE_MAP_URL = 'source' + 'MappingURL';

    describe('HTTP header discovery', () => {
        it('discovers source map from SourceMap header', async () => {
            server.use(
                http.get('https://example.com/bundle.js', () => {
                    return new HttpResponse('var x = 1;', {
                        status: 200,
                        headers: {
                            'Content-Type': 'application/javascript',
                            SourceMap: 'bundle.js.map',
                        },
                    });
                }),
            );

            const result = await discoverSourceMap(
                'https://example.com/bundle.js',
            );
            expect(result.found).toBe(true);
            expect(result.sourceMapUrl).toBe(
                'https://example.com/bundle.js.map',
            );
            expect(result.locationType).toBe('http-header');
        });

        it('discovers source map from X-SourceMap header', async () => {
            server.use(
                http.get('https://example.com/bundle.js', () => {
                    return new HttpResponse('var x = 1;', {
                        status: 200,
                        headers: {
                            'Content-Type': 'application/javascript',
                            'X-SourceMap': 'bundle.js.map',
                        },
                    });
                }),
            );

            const result = await discoverSourceMap(
                'https://example.com/bundle.js',
            );
            expect(result.found).toBe(true);
            expect(result.sourceMapUrl).toBe(
                'https://example.com/bundle.js.map',
            );
            expect(result.locationType).toBe('http-header');
        });
    });

    describe('JS comment discovery', () => {
        it('discovers source map from JS comment', async () => {
            server.use(
                http.get('https://example.com/bundle.js', () => {
                    return new HttpResponse(
                        `var x = 1;\n//# ${SOURCE_MAP_URL}=bundle.js.map`,
                        {
                            status: 200,
                            headers: {
                                'Content-Type': 'application/javascript',
                            },
                        },
                    );
                }),
            );

            const result = await discoverSourceMap(
                'https://example.com/bundle.js',
            );
            expect(result.found).toBe(true);
            expect(result.sourceMapUrl).toBe(
                'https://example.com/bundle.js.map',
            );
            expect(result.locationType).toBe('js-comment');
            expect(result.bundleContent).toContain('var x = 1;');
        });
    });

    describe('CSS comment discovery', () => {
        it('discovers source map from CSS comment', async () => {
            server.use(
                http.get('https://example.com/styles.css', () => {
                    return new HttpResponse(
                        `.foo { color: red; }\n/*# ${SOURCE_MAP_URL}=styles.css.map */`,
                        {
                            status: 200,
                            headers: { 'Content-Type': 'text/css' },
                        },
                    );
                }),
            );

            const result = await discoverSourceMap(
                'https://example.com/styles.css',
            );
            expect(result.found).toBe(true);
            expect(result.sourceMapUrl).toBe(
                'https://example.com/styles.css.map',
            );
            expect(result.locationType).toBe('css-comment');
        });
    });

    describe('inline data URI discovery', () => {
        it('discovers inline source map from data URI', async () => {
            const dataUri = 'data:application/json;base64,eyJ2ZXJzaW9uIjozfQ==';
            server.use(
                http.get('https://example.com/bundle.js', () => {
                    return new HttpResponse(
                        `var x = 1;\n//# ${SOURCE_MAP_URL}=${dataUri}`,
                        {
                            status: 200,
                            headers: {
                                'Content-Type': 'application/javascript',
                            },
                        },
                    );
                }),
            );

            const result = await discoverSourceMap(
                'https://example.com/bundle.js',
            );
            expect(result.found).toBe(true);
            expect(result.sourceMapUrl).toBe(dataUri);
            expect(result.locationType).toBe('inline-data-uri');
        });
    });

    describe('URL probe fallback', () => {
        it('falls back to probing when no header or comment', async () => {
            server.use(
                http.get('https://example.com/bundle.js', () => {
                    return new HttpResponse('var x = 1;', {
                        status: 200,
                        headers: { 'Content-Type': 'application/javascript' },
                    });
                }),
                http.head('https://example.com/bundle.js.map', () => {
                    return new HttpResponse(null, {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' },
                    });
                }),
            );

            const result = await discoverSourceMap(
                'https://example.com/bundle.js',
            );
            expect(result.found).toBe(true);
            expect(result.sourceMapUrl).toBe(
                'https://example.com/bundle.js.map',
            );
            expect(result.locationType).toBe('url-probe');
        });
    });

    describe('not found cases', () => {
        it('returns not found when bundle returns 404', async () => {
            server.use(
                http.get('https://example.com/bundle.js', () => {
                    return new HttpResponse(null, { status: 404 });
                }),
            );

            const result = await discoverSourceMap(
                'https://example.com/bundle.js',
            );
            expect(result.found).toBe(false);
            expect(result.sourceMapUrl).toBe(null);
            expect(result.locationType).toBe(null);
        });

        it('returns not found when no source map exists', async () => {
            server.use(
                http.get('https://example.com/bundle.js', () => {
                    return new HttpResponse('var x = 1;', {
                        status: 200,
                        headers: { 'Content-Type': 'application/javascript' },
                    });
                }),
                http.head('https://example.com/bundle.js.map', () => {
                    return new HttpResponse(null, { status: 404 });
                }),
            );

            const result = await discoverSourceMap(
                'https://example.com/bundle.js',
            );
            expect(result.found).toBe(false);
            expect(result.sourceMapUrl).toBe(null);
            expect(result.bundleContent).toBe('var x = 1;');
        });

        it('returns not found when network fails', async () => {
            server.use(
                http.get('https://example.com/bundle.js', () => {
                    return HttpResponse.error();
                }),
            );

            const result = await discoverSourceMap(
                'https://example.com/bundle.js',
            );
            expect(result.found).toBe(false);
            expect(result.sourceMapUrl).toBe(null);
        });
    });

    describe('URL resolution', () => {
        it('resolves relative URLs in headers', async () => {
            server.use(
                http.get('https://example.com/js/bundle.js', () => {
                    return new HttpResponse('var x = 1;', {
                        status: 200,
                        headers: {
                            SourceMap: '../maps/bundle.js.map',
                        },
                    });
                }),
            );

            const result = await discoverSourceMap(
                'https://example.com/js/bundle.js',
            );
            expect(result.found).toBe(true);
            expect(result.sourceMapUrl).toBe(
                'https://example.com/maps/bundle.js.map',
            );
        });

        it('handles absolute URLs in comments', async () => {
            server.use(
                http.get('https://example.com/bundle.js', () => {
                    return new HttpResponse(
                        `var x = 1;\n//# ${SOURCE_MAP_URL}=https://cdn.example.com/bundle.js.map`,
                        { status: 200 },
                    );
                }),
            );

            const result = await discoverSourceMap(
                'https://example.com/bundle.js',
            );
            expect(result.found).toBe(true);
            expect(result.sourceMapUrl).toBe(
                'https://cdn.example.com/bundle.js.map',
            );
        });
    });
});
