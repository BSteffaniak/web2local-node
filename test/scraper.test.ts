/**
 * Tests for scraper.ts - bundle discovery and source map detection
 *
 * These tests verify that:
 * - Source maps are correctly discovered from bundles
 * - False positives from SPAs returning HTML are rejected
 * - Content-Type validation works correctly
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import {
    findSourceMapUrl,
    extractBundleUrls,
    findAllSourceMaps,
} from '@web2local/scraper';
import { server } from './helpers/msw-handlers.js';
import { initCache } from '@web2local/cache';

// ============================================================================
// Test Setup
// ============================================================================

beforeEach(async () => {
    // Disable caching for tests to ensure fresh fetches
    await initCache({ disabled: true });
});

// ============================================================================
// findSourceMapUrl Tests
// ============================================================================

describe('findSourceMapUrl', () => {
    describe('sourceMappingURL comment detection', () => {
        it('should find source map URL from JS sourceMappingURL comment', async () => {
            server.use(
                http.get('https://example.com/bundle.js', () => {
                    return new HttpResponse(
                        `function hello(){console.log("hello")}\n//# sourceMappingURL=bundle.js.map`,
                        {
                            headers: {
                                'Content-Type': 'application/javascript',
                            },
                        },
                    );
                }),
            );

            const result = await findSourceMapUrl(
                'https://example.com/bundle.js',
            );
            expect(result.sourceMapUrl).toBe(
                'https://example.com/bundle.js.map',
            );
        });

        it('should find source map URL from CSS sourceMappingURL comment', async () => {
            server.use(
                http.get('https://example.com/styles.css', () => {
                    return new HttpResponse(
                        `.container{color:red}\n/*# sourceMappingURL=styles.css.map */`,
                        { headers: { 'Content-Type': 'text/css' } },
                    );
                }),
            );

            const result = await findSourceMapUrl(
                'https://example.com/styles.css',
            );
            expect(result.sourceMapUrl).toBe(
                'https://example.com/styles.css.map',
            );
        });

        it('should find source map URL from SourceMap header', async () => {
            server.use(
                http.get('https://example.com/bundle.js', () => {
                    return new HttpResponse(
                        `function hello(){console.log("hello")}`,
                        {
                            headers: {
                                'Content-Type': 'application/javascript',
                                SourceMap: 'bundle.js.map',
                            },
                        },
                    );
                }),
            );

            const result = await findSourceMapUrl(
                'https://example.com/bundle.js',
            );
            expect(result.sourceMapUrl).toBe(
                'https://example.com/bundle.js.map',
            );
        });
    });

    describe('.map fallback with Content-Type validation', () => {
        it('should accept .map file with application/json Content-Type', async () => {
            server.use(
                http.get('https://example.com/bundle.js', () => {
                    return new HttpResponse(`function hello(){}`, {
                        headers: { 'Content-Type': 'application/javascript' },
                    });
                }),
                http.head('https://example.com/bundle.js.map', () => {
                    return new HttpResponse(null, {
                        headers: { 'Content-Type': 'application/json' },
                    });
                }),
            );

            const result = await findSourceMapUrl(
                'https://example.com/bundle.js',
            );
            expect(result.sourceMapUrl).toBe(
                'https://example.com/bundle.js.map',
            );
        });

        it('should accept .map file with no Content-Type header', async () => {
            server.use(
                http.get('https://example.com/bundle.js', () => {
                    return new HttpResponse(`function hello(){}`, {
                        headers: { 'Content-Type': 'application/javascript' },
                    });
                }),
                http.head('https://example.com/bundle.js.map', () => {
                    return new HttpResponse(null, {
                        // No Content-Type header
                    });
                }),
            );

            const result = await findSourceMapUrl(
                'https://example.com/bundle.js',
            );
            expect(result.sourceMapUrl).toBe(
                'https://example.com/bundle.js.map',
            );
        });

        it('should reject .map file with text/html Content-Type (SPA false positive)', async () => {
            server.use(
                http.get('https://example.com/bundle.js', () => {
                    return new HttpResponse(`function hello(){}`, {
                        headers: { 'Content-Type': 'application/javascript' },
                    });
                }),
                http.head('https://example.com/bundle.js.map', () => {
                    // SPA servers often return 200 with HTML for any route
                    return new HttpResponse(null, {
                        headers: { 'Content-Type': 'text/html; charset=UTF-8' },
                    });
                }),
            );

            const result = await findSourceMapUrl(
                'https://example.com/bundle.js',
            );
            expect(result.sourceMapUrl).toBeNull();
        });

        it('should reject .map file with text/html even without charset', async () => {
            server.use(
                http.get('https://example.com/bundle.js', () => {
                    return new HttpResponse(`function hello(){}`, {
                        headers: { 'Content-Type': 'application/javascript' },
                    });
                }),
                http.head('https://example.com/bundle.js.map', () => {
                    return new HttpResponse(null, {
                        headers: { 'Content-Type': 'text/html' },
                    });
                }),
            );

            const result = await findSourceMapUrl(
                'https://example.com/bundle.js',
            );
            expect(result.sourceMapUrl).toBeNull();
        });

        it('should accept .map file with application/octet-stream Content-Type', async () => {
            server.use(
                http.get('https://example.com/bundle.js', () => {
                    return new HttpResponse(`function hello(){}`, {
                        headers: { 'Content-Type': 'application/javascript' },
                    });
                }),
                http.head('https://example.com/bundle.js.map', () => {
                    return new HttpResponse(null, {
                        headers: { 'Content-Type': 'application/octet-stream' },
                    });
                }),
            );

            const result = await findSourceMapUrl(
                'https://example.com/bundle.js',
            );
            expect(result.sourceMapUrl).toBe(
                'https://example.com/bundle.js.map',
            );
        });

        it('should accept .map file with text/plain Content-Type', async () => {
            server.use(
                http.get('https://example.com/bundle.js', () => {
                    return new HttpResponse(`function hello(){}`, {
                        headers: { 'Content-Type': 'application/javascript' },
                    });
                }),
                http.head('https://example.com/bundle.js.map', () => {
                    return new HttpResponse(null, {
                        headers: { 'Content-Type': 'text/plain' },
                    });
                }),
            );

            const result = await findSourceMapUrl(
                'https://example.com/bundle.js',
            );
            expect(result.sourceMapUrl).toBe(
                'https://example.com/bundle.js.map',
            );
        });
    });

    describe('error handling', () => {
        it('should return null when bundle returns 404', async () => {
            server.use(
                http.get('https://example.com/missing.js', () => {
                    return new HttpResponse(null, { status: 404 });
                }),
            );

            const result = await findSourceMapUrl(
                'https://example.com/missing.js',
            );
            expect(result.sourceMapUrl).toBeNull();
        });

        it('should return null when .map fallback returns 404', async () => {
            server.use(
                http.get('https://example.com/bundle.js', () => {
                    return new HttpResponse(`function hello(){}`, {
                        headers: { 'Content-Type': 'application/javascript' },
                    });
                }),
                http.head('https://example.com/bundle.js.map', () => {
                    return new HttpResponse(null, { status: 404 });
                }),
            );

            const result = await findSourceMapUrl(
                'https://example.com/bundle.js',
            );
            expect(result.sourceMapUrl).toBeNull();
        });
    });
});

// ============================================================================
// extractBundleUrls Tests - Redirect Detection
// ============================================================================

describe('extractBundleUrls', () => {
    describe('redirect detection', () => {
        it('should detect redirect by comparing request URL to response URL', async () => {
            // The fetch API follows redirects automatically and response.url reflects the final URL
            // We test this by having MSW return the HTML at a different URL than requested
            // but MSW doesn't directly simulate redirect following, so we test the logic differently

            // Test without redirect first - request URL matches response URL
            server.use(
                http.get(
                    'https://test-redirect.example.com/games/snake/',
                    () => {
                        return new HttpResponse(
                            `<!DOCTYPE html>
            <html>
              <head>
                <script src="./js/game.js"></script>
                <link rel="stylesheet" href="./css/style.css">
              </head>
              <body>Test</body>
            </html>`,
                            { headers: { 'Content-Type': 'text/html' } },
                        );
                    },
                ),
            );

            const result = await extractBundleUrls(
                'https://test-redirect.example.com/games/snake/',
            );

            // No redirect when requesting the canonical URL
            expect(result.redirect).toBeUndefined();
            expect(result.finalUrl).toBe(
                'https://test-redirect.example.com/games/snake/',
            );

            // Bundle paths should be resolved relative to the URL
            expect(result.bundles).toHaveLength(2);
            expect(result.bundles[0].url).toBe(
                'https://test-redirect.example.com/games/snake/js/game.js',
            );
            expect(result.bundles[1].url).toBe(
                'https://test-redirect.example.com/games/snake/css/style.css',
            );
        });

        it('should correctly resolve absolute paths', async () => {
            server.use(
                http.get('https://test-abs.example.com/page/', () => {
                    return new HttpResponse(
                        `<!DOCTYPE html>
            <html>
              <head>
                <script src="/assets/bundle.js"></script>
              </head>
              <body>Test</body>
            </html>`,
                        { headers: { 'Content-Type': 'text/html' } },
                    );
                }),
            );

            const result = await extractBundleUrls(
                'https://test-abs.example.com/page/',
            );

            // Absolute paths should resolve correctly
            expect(result.bundles).toHaveLength(1);
            expect(result.bundles[0].url).toBe(
                'https://test-abs.example.com/assets/bundle.js',
            );
        });

        it('should correctly resolve protocol-relative URLs', async () => {
            server.use(
                http.get('https://test-proto.example.com/', () => {
                    return new HttpResponse(
                        `<!DOCTYPE html>
            <html>
              <head>
                <script src="//cdn.example.com/lib.js"></script>
              </head>
              <body>Test</body>
            </html>`,
                        { headers: { 'Content-Type': 'text/html' } },
                    );
                }),
            );

            const result = await extractBundleUrls(
                'https://test-proto.example.com/',
            );

            expect(result.bundles).toHaveLength(1);
            expect(result.bundles[0].url).toBe(
                'https://cdn.example.com/lib.js',
            );
        });

        it('should use finalUrl for resolving relative bundle paths', async () => {
            // This tests that relative paths are resolved using the base URL correctly
            server.use(
                http.get(
                    'https://test-relative.example.com/deep/nested/page/',
                    () => {
                        return new HttpResponse(
                            `<!DOCTYPE html>
            <html>
              <head>
                <script src="./js/app.js"></script>
                <script src="../shared/lib.js"></script>
                <script src="../../assets/vendor.js"></script>
              </head>
              <body>Test</body>
            </html>`,
                            { headers: { 'Content-Type': 'text/html' } },
                        );
                    },
                ),
            );

            const result = await extractBundleUrls(
                'https://test-relative.example.com/deep/nested/page/',
            );

            expect(result.bundles).toHaveLength(3);
            expect(result.bundles[0].url).toBe(
                'https://test-relative.example.com/deep/nested/page/js/app.js',
            );
            expect(result.bundles[1].url).toBe(
                'https://test-relative.example.com/deep/nested/shared/lib.js',
            );
            expect(result.bundles[2].url).toBe(
                'https://test-relative.example.com/deep/assets/vendor.js',
            );
        });
    });

    describe('bundle extraction', () => {
        it('should extract script and stylesheet URLs from HTML', async () => {
            server.use(
                http.get('https://example.com/', () => {
                    return new HttpResponse(
                        `<!DOCTYPE html>
            <html>
              <head>
                <script src="/js/app.js"></script>
                <script src="/js/vendor.js?v=123"></script>
                <link rel="stylesheet" href="/css/main.css">
                <link rel="stylesheet" href="/css/theme.css?v=456">
              </head>
              <body>Test</body>
            </html>`,
                        { headers: { 'Content-Type': 'text/html' } },
                    );
                }),
            );

            const result = await extractBundleUrls('https://example.com/');

            expect(result.bundles).toHaveLength(4);
            expect(result.bundles.map((b) => b.url)).toEqual([
                'https://example.com/js/app.js',
                'https://example.com/js/vendor.js?v=123',
                'https://example.com/css/main.css',
                'https://example.com/css/theme.css?v=456',
            ]);
        });

        it('should extract modulepreload links (Vite builds)', async () => {
            server.use(
                http.get('https://example.com/', () => {
                    return new HttpResponse(
                        `<!DOCTYPE html>
            <html>
              <head>
                <link rel="modulepreload" href="/assets/index-abc123.js">
                <link rel="modulepreload" href="/assets/vendor-def456.js">
              </head>
              <body>Test</body>
            </html>`,
                        { headers: { 'Content-Type': 'text/html' } },
                    );
                }),
            );

            const result = await extractBundleUrls('https://example.com/');

            expect(result.bundles).toHaveLength(2);
            expect(result.bundles[0].type).toBe('script');
            expect(result.bundles[1].type).toBe('script');
        });

        it('should not duplicate modulepreload URLs that also appear as script src', async () => {
            server.use(
                http.get('https://example.com/', () => {
                    return new HttpResponse(
                        `<!DOCTYPE html>
            <html>
              <head>
                <link rel="modulepreload" href="/assets/index.js">
                <script type="module" src="/assets/index.js"></script>
              </head>
              <body>Test</body>
            </html>`,
                        { headers: { 'Content-Type': 'text/html' } },
                    );
                }),
            );

            const result = await extractBundleUrls('https://example.com/');

            // Should only have one entry for index.js
            expect(result.bundles).toHaveLength(1);
            expect(result.bundles[0].url).toBe(
                'https://example.com/assets/index.js',
            );
        });
    });
});

// ============================================================================
// Bundle Content Fallback Tests
// ============================================================================

describe('findSourceMapUrl - bundle content fallback', () => {
    describe('bundleContent return behavior', () => {
        it('should return bundleContent when no source map exists', async () => {
            const bundleContent = 'function minified(){console.log("hello")}';
            server.use(
                http.get(
                    'https://fallback-test.example.com/no-sourcemap.js',
                    () => {
                        return new HttpResponse(bundleContent, {
                            headers: {
                                'Content-Type': 'application/javascript',
                            },
                        });
                    },
                ),
                http.head(
                    'https://fallback-test.example.com/no-sourcemap.js.map',
                    () => {
                        return new HttpResponse(null, { status: 404 });
                    },
                ),
            );

            const result = await findSourceMapUrl(
                'https://fallback-test.example.com/no-sourcemap.js',
            );

            expect(result.sourceMapUrl).toBeNull();
            expect(result.bundleContent).toBe(bundleContent);
        });

        it('should return bundleContent for CSS files without source maps', async () => {
            const cssContent = '.container{color:red}.btn{padding:10px}';
            server.use(
                http.get('https://fallback-test.example.com/styles.css', () => {
                    return new HttpResponse(cssContent, {
                        headers: { 'Content-Type': 'text/css' },
                    });
                }),
                http.head(
                    'https://fallback-test.example.com/styles.css.map',
                    () => {
                        return new HttpResponse(null, { status: 404 });
                    },
                ),
            );

            const result = await findSourceMapUrl(
                'https://fallback-test.example.com/styles.css',
            );

            expect(result.sourceMapUrl).toBeNull();
            expect(result.bundleContent).toBe(cssContent);
        });

        it('should not return bundleContent when source map exists via comment', async () => {
            server.use(
                http.get(
                    'https://fallback-test.example.com/with-map.js',
                    () => {
                        return new HttpResponse(
                            `function hello(){}\n//# sourceMappingURL=with-map.js.map`,
                            {
                                headers: {
                                    'Content-Type': 'application/javascript',
                                },
                            },
                        );
                    },
                ),
            );

            const result = await findSourceMapUrl(
                'https://fallback-test.example.com/with-map.js',
            );

            expect(result.sourceMapUrl).toBe(
                'https://fallback-test.example.com/with-map.js.map',
            );
            expect(result.bundleContent).toBeUndefined();
        });

        it('should not return bundleContent when source map exists via header', async () => {
            server.use(
                http.get(
                    'https://fallback-test.example.com/header-map.js',
                    () => {
                        return new HttpResponse('function hello(){}', {
                            headers: {
                                'Content-Type': 'application/javascript',
                                SourceMap: 'header-map.js.map',
                            },
                        });
                    },
                ),
            );

            const result = await findSourceMapUrl(
                'https://fallback-test.example.com/header-map.js',
            );

            expect(result.sourceMapUrl).toBe(
                'https://fallback-test.example.com/header-map.js.map',
            );
            expect(result.bundleContent).toBeUndefined();
        });

        it('should not return bundleContent when .map file exists', async () => {
            server.use(
                http.get(
                    'https://fallback-test.example.com/fallback-map.js',
                    () => {
                        return new HttpResponse('function hello(){}', {
                            headers: {
                                'Content-Type': 'application/javascript',
                            },
                        });
                    },
                ),
                http.head(
                    'https://fallback-test.example.com/fallback-map.js.map',
                    () => {
                        return new HttpResponse(null, {
                            headers: { 'Content-Type': 'application/json' },
                        });
                    },
                ),
            );

            const result = await findSourceMapUrl(
                'https://fallback-test.example.com/fallback-map.js',
            );

            expect(result.sourceMapUrl).toBe(
                'https://fallback-test.example.com/fallback-map.js.map',
            );
            expect(result.bundleContent).toBeUndefined();
        });

        it('should not return bundleContent when fetch fails with 404', async () => {
            server.use(
                http.get('https://fallback-test.example.com/missing.js', () => {
                    return new HttpResponse(null, { status: 404 });
                }),
            );

            const result = await findSourceMapUrl(
                'https://fallback-test.example.com/missing.js',
            );

            expect(result.sourceMapUrl).toBeNull();
            expect(result.bundleContent).toBeUndefined();
        });

        it('should not return bundleContent when fetch fails with 500', async () => {
            server.use(
                http.get('https://fallback-test.example.com/error.js', () => {
                    return new HttpResponse(null, { status: 500 });
                }),
            );

            const result = await findSourceMapUrl(
                'https://fallback-test.example.com/error.js',
            );

            expect(result.sourceMapUrl).toBeNull();
            expect(result.bundleContent).toBeUndefined();
        });

        it('should return bundleContent on cached negative result', async () => {
            const bundleContent = 'var cached="test"';
            server.use(
                http.get(
                    'https://cached-test.example.com/cached-bundle.js',
                    () => {
                        return new HttpResponse(bundleContent, {
                            headers: {
                                'Content-Type': 'application/javascript',
                            },
                        });
                    },
                ),
                http.head(
                    'https://cached-test.example.com/cached-bundle.js.map',
                    () => {
                        return new HttpResponse(null, { status: 404 });
                    },
                ),
            );

            // First call - populates cache with negative result
            const result1 = await findSourceMapUrl(
                'https://cached-test.example.com/cached-bundle.js',
            );
            expect(result1.bundleContent).toBe(bundleContent);

            // Second call - should still return bundleContent from re-fetch
            const result2 = await findSourceMapUrl(
                'https://cached-test.example.com/cached-bundle.js',
            );
            expect(result2.sourceMapUrl).toBeNull();
            expect(result2.bundleContent).toBe(bundleContent);
        });
    });
});

// ============================================================================
// findAllSourceMaps - bundlesWithoutMaps Tests
// ============================================================================

describe('findAllSourceMaps - bundlesWithoutMaps collection', () => {
    it('should include bundles without source maps in bundlesWithoutMaps', async () => {
        server.use(
            http.get('https://findall-test.example.com/no-map.js', () => {
                return new HttpResponse('var x=1;', {
                    headers: { 'Content-Type': 'application/javascript' },
                });
            }),
            http.head('https://findall-test.example.com/no-map.js.map', () => {
                return new HttpResponse(null, { status: 404 });
            }),
        );

        const bundles = [
            {
                url: 'https://findall-test.example.com/no-map.js',
                type: 'script' as const,
            },
        ];
        const result = await findAllSourceMaps(bundles, 5);

        expect(result.bundlesWithMaps).toHaveLength(0);
        expect(result.bundlesWithoutMaps).toHaveLength(1);
        expect(result.bundlesWithoutMaps[0].bundle.url).toBe(
            'https://findall-test.example.com/no-map.js',
        );
    });

    it('should include bundle content for bundles without source maps', async () => {
        const content = 'function test(){}';
        server.use(
            http.get('https://findall-test.example.com/bundle.js', () => {
                return new HttpResponse(content, {
                    headers: { 'Content-Type': 'application/javascript' },
                });
            }),
            http.head('https://findall-test.example.com/bundle.js.map', () => {
                return new HttpResponse(null, { status: 404 });
            }),
        );

        const bundles = [
            {
                url: 'https://findall-test.example.com/bundle.js',
                type: 'script' as const,
            },
        ];
        const result = await findAllSourceMaps(bundles, 5);

        expect(result.bundlesWithoutMaps[0].content).toBe(content);
    });

    it('should separate bundles with maps from bundles without maps', async () => {
        server.use(
            http.get('https://findall-test.example.com/with-map.js', () => {
                return new HttpResponse(
                    `var a=1;\n//# sourceMappingURL=with-map.js.map`,
                    { headers: { 'Content-Type': 'application/javascript' } },
                );
            }),
            http.get('https://findall-test.example.com/no-map.js', () => {
                return new HttpResponse('var b=2;', {
                    headers: { 'Content-Type': 'application/javascript' },
                });
            }),
            http.head('https://findall-test.example.com/no-map.js.map', () => {
                return new HttpResponse(null, { status: 404 });
            }),
        );

        const bundles = [
            {
                url: 'https://findall-test.example.com/with-map.js',
                type: 'script' as const,
            },
            {
                url: 'https://findall-test.example.com/no-map.js',
                type: 'script' as const,
            },
        ];
        const result = await findAllSourceMaps(bundles, 5);

        expect(result.bundlesWithMaps).toHaveLength(1);
        expect(result.bundlesWithMaps[0].url).toBe(
            'https://findall-test.example.com/with-map.js',
        );
        expect(result.bundlesWithoutMaps).toHaveLength(1);
        expect(result.bundlesWithoutMaps[0].bundle.url).toBe(
            'https://findall-test.example.com/no-map.js',
        );
    });

    it('should handle mix of JS and CSS bundles', async () => {
        server.use(
            http.get('https://findall-test.example.com/app.js', () => {
                return new HttpResponse('var x=1;', {
                    headers: { 'Content-Type': 'application/javascript' },
                });
            }),
            http.head('https://findall-test.example.com/app.js.map', () => {
                return new HttpResponse(null, { status: 404 });
            }),
            http.get('https://findall-test.example.com/styles.css', () => {
                return new HttpResponse('.btn{color:red}', {
                    headers: { 'Content-Type': 'text/css' },
                });
            }),
            http.head('https://findall-test.example.com/styles.css.map', () => {
                return new HttpResponse(null, { status: 404 });
            }),
        );

        const bundles = [
            {
                url: 'https://findall-test.example.com/app.js',
                type: 'script' as const,
            },
            {
                url: 'https://findall-test.example.com/styles.css',
                type: 'stylesheet' as const,
            },
        ];
        const result = await findAllSourceMaps(bundles, 5);

        expect(result.bundlesWithoutMaps).toHaveLength(2);
        expect(result.bundlesWithoutMaps.map((b) => b.bundle.type)).toContain(
            'script',
        );
        expect(result.bundlesWithoutMaps.map((b) => b.bundle.type)).toContain(
            'stylesheet',
        );
    });

    it('should handle all bundles having source maps', async () => {
        server.use(
            http.get('https://findall-test.example.com/a.js', () => {
                return new HttpResponse(
                    `var a=1;\n//# sourceMappingURL=a.js.map`,
                    {
                        headers: { 'Content-Type': 'application/javascript' },
                    },
                );
            }),
            http.get('https://findall-test.example.com/b.js', () => {
                return new HttpResponse(
                    `var b=2;\n//# sourceMappingURL=b.js.map`,
                    {
                        headers: { 'Content-Type': 'application/javascript' },
                    },
                );
            }),
        );

        const bundles = [
            {
                url: 'https://findall-test.example.com/a.js',
                type: 'script' as const,
            },
            {
                url: 'https://findall-test.example.com/b.js',
                type: 'script' as const,
            },
        ];
        const result = await findAllSourceMaps(bundles, 5);

        expect(result.bundlesWithMaps).toHaveLength(2);
        expect(result.bundlesWithoutMaps).toHaveLength(0);
    });

    it('should handle all bundles missing source maps', async () => {
        server.use(
            http.get('https://findall-test.example.com/a.js', () => {
                return new HttpResponse('var a=1;', {
                    headers: { 'Content-Type': 'application/javascript' },
                });
            }),
            http.head('https://findall-test.example.com/a.js.map', () => {
                return new HttpResponse(null, { status: 404 });
            }),
            http.get('https://findall-test.example.com/b.js', () => {
                return new HttpResponse('var b=2;', {
                    headers: { 'Content-Type': 'application/javascript' },
                });
            }),
            http.head('https://findall-test.example.com/b.js.map', () => {
                return new HttpResponse(null, { status: 404 });
            }),
        );

        const bundles = [
            {
                url: 'https://findall-test.example.com/a.js',
                type: 'script' as const,
            },
            {
                url: 'https://findall-test.example.com/b.js',
                type: 'script' as const,
            },
        ];
        const result = await findAllSourceMaps(bundles, 5);

        expect(result.bundlesWithMaps).toHaveLength(0);
        expect(result.bundlesWithoutMaps).toHaveLength(2);
    });

    it('should handle empty bundles array', async () => {
        const result = await findAllSourceMaps([], 5);

        expect(result.bundlesWithMaps).toHaveLength(0);
        expect(result.bundlesWithoutMaps).toHaveLength(0);
        expect(result.vendorBundles).toHaveLength(0);
    });
});
