import { describe, it, expect } from 'vitest';
import {
    buildUrlMap,
    rewriteHtml,
    rewriteCss,
    rewriteAllCssUrls,
    rewriteCssImports,
} from '../src/url-rewriter.js';

describe('url-rewriter', () => {
    describe('buildUrlMap', () => {
        it('should build a map from asset URLs to local paths', () => {
            const assets = [
                {
                    url: 'https://example.com/image.png',
                    localPath: 'image.png',
                },
                {
                    url: 'https://cdn.cloudfront.net/logo.svg',
                    localPath: '_external/abc123_logo.svg',
                },
            ];
            const map = buildUrlMap(assets, 'https://example.com');

            expect(map.get('https://example.com/image.png')).toBe('/image.png');
            expect(map.get('https://cdn.cloudfront.net/logo.svg')).toBe(
                '/_external/abc123_logo.svg',
            );
        });

        it('should add pathname-only mapping for same-origin URLs', () => {
            const assets = [
                {
                    url: 'https://example.com/assets/image.png',
                    localPath: 'assets/image.png',
                },
            ];
            const map = buildUrlMap(assets, 'https://example.com');

            expect(map.get('https://example.com/assets/image.png')).toBe(
                '/assets/image.png',
            );
            expect(map.get('/assets/image.png')).toBe('/assets/image.png');
        });

        it('should handle URLs with query strings', () => {
            const assets = [
                {
                    url: 'https://example.com/image.png?v=123',
                    localPath: 'image.png',
                },
            ];
            const map = buildUrlMap(assets, 'https://example.com');

            expect(map.get('https://example.com/image.png?v=123')).toBe(
                '/image.png',
            );
            expect(map.get('/image.png?v=123')).toBe('/image.png');
        });
    });

    describe('rewriteHtml', () => {
        const baseUrl = 'https://example.com';

        it('should rewrite src attributes', () => {
            const urlMap = new Map([
                [
                    'https://cdn.example.net/image.png',
                    '/_external/abc_image.png',
                ],
            ]);
            const html = '<img src="https://cdn.example.net/image.png">';
            const result = rewriteHtml(html, urlMap, baseUrl);

            expect(result).toBe('<img src="/_external/abc_image.png">');
        });

        it('should rewrite href attributes', () => {
            const urlMap = new Map([
                [
                    'https://cdn.example.net/style.css',
                    '/_external/abc_style.css',
                ],
            ]);
            const html =
                '<link rel="stylesheet" href="https://cdn.example.net/style.css">';
            const result = rewriteHtml(html, urlMap, baseUrl);

            expect(result).toBe(
                '<link rel="stylesheet" href="/_external/abc_style.css">',
            );
        });

        it('should rewrite srcset attributes', () => {
            const urlMap = new Map([
                [
                    'https://cdn.example.net/img-1x.png',
                    '/_external/abc_img-1x.png',
                ],
                [
                    'https://cdn.example.net/img-2x.png',
                    '/_external/abc_img-2x.png',
                ],
            ]);
            const html =
                '<img srcset="https://cdn.example.net/img-1x.png 1x, https://cdn.example.net/img-2x.png 2x">';
            const result = rewriteHtml(html, urlMap, baseUrl);

            expect(result).toBe(
                '<img srcset="/_external/abc_img-1x.png 1x, /_external/abc_img-2x.png 2x">',
            );
        });

        it('should rewrite inline style url() references', () => {
            const urlMap = new Map([
                ['https://cdn.example.net/bg.png', '/_external/abc_bg.png'],
            ]);
            const html =
                '<div style="background-image: url(https://cdn.example.net/bg.png)"></div>';
            const result = rewriteHtml(html, urlMap, baseUrl);

            expect(result).toBe(
                '<div style="background-image: url(/_external/abc_bg.png)"></div>',
            );
        });

        it('should rewrite URLs in inline <style> blocks', () => {
            const urlMap = new Map([
                ['https://cdn.example.net/bg.png', '/_external/abc_bg.png'],
            ]);
            const html = `<style>
                .hero { background: url(https://cdn.example.net/bg.png); }
            </style>`;
            const result = rewriteHtml(html, urlMap, baseUrl);

            expect(result).toContain('url(/_external/abc_bg.png)');
        });

        it('should preserve data: URLs', () => {
            const urlMap = new Map<string, string>();
            const html =
                '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==">';
            const result = rewriteHtml(html, urlMap, baseUrl);

            expect(result).toBe(html);
        });

        it('should preserve javascript: URLs', () => {
            const urlMap = new Map<string, string>();
            const html = '<a href="javascript:void(0)">Click</a>';
            const result = rewriteHtml(html, urlMap, baseUrl);

            expect(result).toBe(html);
        });

        it('should preserve anchor-only hrefs', () => {
            const urlMap = new Map<string, string>();
            const html = '<a href="#section">Jump</a>';
            const result = rewriteHtml(html, urlMap, baseUrl);

            expect(result).toBe(html);
        });

        it('should leave URLs not in map unchanged', () => {
            const urlMap = new Map<string, string>();
            const html = '<img src="https://unknown.cdn.net/image.png">';
            const result = rewriteHtml(html, urlMap, baseUrl);

            expect(result).toBe(html);
        });

        it('should handle protocol-relative URLs', () => {
            const urlMap = new Map([
                [
                    'https://cdn.example.net/image.png',
                    '/_external/abc_image.png',
                ],
            ]);
            const html = '<img src="//cdn.example.net/image.png">';
            const result = rewriteHtml(html, urlMap, baseUrl);

            expect(result).toBe('<img src="/_external/abc_image.png">');
        });

        it('should handle relative URLs resolved against base', () => {
            const urlMap = new Map([
                ['https://example.com/assets/image.png', '/assets/image.png'],
            ]);
            const html = '<img src="/assets/image.png">';
            const result = rewriteHtml(html, urlMap, baseUrl);

            expect(result).toBe('<img src="/assets/image.png">');
        });

        it('should handle multiple attributes on same element', () => {
            const urlMap = new Map([
                [
                    'https://cdn.example.net/video.mp4',
                    '/_external/abc_video.mp4',
                ],
                [
                    'https://cdn.example.net/poster.jpg',
                    '/_external/abc_poster.jpg',
                ],
            ]);
            const html =
                '<video src="https://cdn.example.net/video.mp4" poster="https://cdn.example.net/poster.jpg"></video>';
            const result = rewriteHtml(html, urlMap, baseUrl);

            expect(result).toBe(
                '<video src="/_external/abc_video.mp4" poster="/_external/abc_poster.jpg"></video>',
            );
        });

        it('should preserve HTML structure and formatting', () => {
            const urlMap = new Map([
                [
                    'https://cdn.example.net/image.png',
                    '/_external/abc_image.png',
                ],
            ]);
            const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <title>Test</title>
</head>
<body>
    <img src="https://cdn.example.net/image.png" alt="Test Image" class="hero-img">
</body>
</html>`;
            const result = rewriteHtml(html, urlMap, baseUrl);

            expect(result).toContain('<!DOCTYPE html>');
            expect(result).toContain('<html lang="en">');
            expect(result).toContain('<title>Test</title>');
            expect(result).toContain('alt="Test Image"');
            expect(result).toContain('class="hero-img"');
            expect(result).toContain('src="/_external/abc_image.png"');
        });

        it('should rewrite og:image meta tags', () => {
            const urlMap = new Map([
                [
                    'https://cdn.example.net/og-image.jpg',
                    '/_external/abc_og-image.jpg',
                ],
            ]);
            const html =
                '<meta property="og:image" content="https://cdn.example.net/og-image.jpg">';
            const result = rewriteHtml(html, urlMap, baseUrl);

            expect(result).toBe(
                '<meta property="og:image" content="/_external/abc_og-image.jpg">',
            );
        });

        it('should handle single-quoted attributes', () => {
            const urlMap = new Map([
                [
                    'https://cdn.example.net/image.png',
                    '/_external/abc_image.png',
                ],
            ]);
            const html = "<img src='https://cdn.example.net/image.png'>";
            const result = rewriteHtml(html, urlMap, baseUrl);

            expect(result).toBe("<img src='/_external/abc_image.png'>");
        });
    });

    describe('rewriteCss', () => {
        it('should rewrite url() with double quotes', () => {
            const urlMap = new Map([
                ['https://cdn.example.net/bg.png', '/_external/abc_bg.png'],
            ]);
            const css =
                '.hero { background: url("https://cdn.example.net/bg.png"); }';
            const result = rewriteCss(
                css,
                urlMap,
                'https://example.com/style.css',
            );

            expect(result).toBe(
                '.hero { background: url("/_external/abc_bg.png"); }',
            );
        });

        it('should rewrite url() with single quotes', () => {
            const urlMap = new Map([
                ['https://cdn.example.net/bg.png', '/_external/abc_bg.png'],
            ]);
            const css =
                ".hero { background: url('https://cdn.example.net/bg.png'); }";
            const result = rewriteCss(
                css,
                urlMap,
                'https://example.com/style.css',
            );

            expect(result).toBe(
                ".hero { background: url('/_external/abc_bg.png'); }",
            );
        });

        it('should rewrite url() without quotes', () => {
            const urlMap = new Map([
                ['https://cdn.example.net/bg.png', '/_external/abc_bg.png'],
            ]);
            const css =
                '.hero { background: url(https://cdn.example.net/bg.png); }';
            const result = rewriteCss(
                css,
                urlMap,
                'https://example.com/style.css',
            );

            expect(result).toBe(
                '.hero { background: url(/_external/abc_bg.png); }',
            );
        });

        it('should rewrite @font-face src', () => {
            const urlMap = new Map([
                [
                    'https://fonts.example.net/font.woff2',
                    '/_external/abc_font.woff2',
                ],
            ]);
            const css = `@font-face {
                font-family: 'MyFont';
                src: url('https://fonts.example.net/font.woff2') format('woff2');
            }`;
            const result = rewriteCss(
                css,
                urlMap,
                'https://example.com/style.css',
            );

            expect(result).toContain("url('/_external/abc_font.woff2')");
        });

        it('should handle multiple url() in one rule', () => {
            const urlMap = new Map([
                [
                    'https://cdn.example.net/icon1.png',
                    '/_external/abc_icon1.png',
                ],
                [
                    'https://cdn.example.net/icon2.png',
                    '/_external/abc_icon2.png',
                ],
            ]);
            const css =
                '.icons { background: url(https://cdn.example.net/icon1.png), url(https://cdn.example.net/icon2.png); }';
            const result = rewriteCss(
                css,
                urlMap,
                'https://example.com/style.css',
            );

            expect(result).toBe(
                '.icons { background: url(/_external/abc_icon1.png), url(/_external/abc_icon2.png); }',
            );
        });

        it('should preserve data: URLs', () => {
            const urlMap = new Map<string, string>();
            const css =
                '.icon { background: url(data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=); }';
            const result = rewriteCss(
                css,
                urlMap,
                'https://example.com/style.css',
            );

            expect(result).toBe(css);
        });

        it('should resolve relative URLs against CSS file URL', () => {
            const urlMap = new Map([
                [
                    'https://example.com/assets/images/bg.png',
                    '/assets/images/bg.png',
                ],
            ]);
            const css = '.hero { background: url(../images/bg.png); }';
            const result = rewriteCss(
                css,
                urlMap,
                'https://example.com/assets/css/style.css',
            );

            expect(result).toBe(
                '.hero { background: url(/assets/images/bg.png); }',
            );
        });

        it('should leave URLs not in map unchanged', () => {
            const urlMap = new Map<string, string>();
            const css =
                '.hero { background: url(https://unknown.cdn.net/bg.png); }';
            const result = rewriteCss(
                css,
                urlMap,
                'https://example.com/style.css',
            );

            expect(result).toBe(css);
        });
    });

    describe('rewriteCssImports', () => {
        it('should rewrite @import url() with quotes', () => {
            const urlMap = new Map([
                [
                    'https://cdn.example.net/reset.css',
                    '/_external/abc_reset.css',
                ],
            ]);
            const css = '@import url("https://cdn.example.net/reset.css");';
            const result = rewriteCssImports(
                css,
                urlMap,
                'https://example.com/style.css',
            );

            // The semicolon is preserved from the original CSS
            expect(result).toBe('@import url("/_external/abc_reset.css");');
        });

        it('should rewrite @import with direct string', () => {
            const urlMap = new Map([
                [
                    'https://cdn.example.net/reset.css',
                    '/_external/abc_reset.css',
                ],
            ]);
            const css = '@import "https://cdn.example.net/reset.css";';
            const result = rewriteCssImports(
                css,
                urlMap,
                'https://example.com/style.css',
            );

            // The semicolon is preserved from the original CSS
            expect(result).toBe('@import "/_external/abc_reset.css";');
        });

        it('should handle relative @import paths', () => {
            const urlMap = new Map([
                ['https://example.com/css/base.css', '/css/base.css'],
            ]);
            const css = '@import "./base.css";';
            const result = rewriteCssImports(
                css,
                urlMap,
                'https://example.com/css/style.css',
            );

            // The semicolon is preserved from the original CSS
            expect(result).toBe('@import "/css/base.css";');
        });
    });

    describe('rewriteAllCssUrls', () => {
        it('should rewrite both @import and url() references', () => {
            const urlMap = new Map([
                ['https://cdn.example.net/base.css', '/_external/abc_base.css'],
                ['https://cdn.example.net/bg.png', '/_external/abc_bg.png'],
            ]);
            const css = `@import url("https://cdn.example.net/base.css");
.hero { background: url(https://cdn.example.net/bg.png); }`;
            const result = rewriteAllCssUrls(
                css,
                urlMap,
                'https://example.com/style.css',
            );

            expect(result).toContain('@import url("/_external/abc_base.css")');
            expect(result).toContain('url(/_external/abc_bg.png)');
        });
    });

    describe('edge cases', () => {
        it('should handle empty content', () => {
            const urlMap = new Map<string, string>();

            expect(rewriteHtml('', urlMap, 'https://example.com')).toBe('');
            expect(
                rewriteCss('', urlMap, 'https://example.com/style.css'),
            ).toBe('');
        });

        it('should handle content with no URLs', () => {
            const urlMap = new Map<string, string>();
            const html = '<div class="container"><p>Hello World</p></div>';
            const css = '.container { display: flex; }';

            expect(rewriteHtml(html, urlMap, 'https://example.com')).toBe(html);
            expect(
                rewriteCss(css, urlMap, 'https://example.com/style.css'),
            ).toBe(css);
        });

        it('should handle malformed URLs gracefully', () => {
            const urlMap = new Map<string, string>();
            const html = '<img src="not-a-valid-url">';
            const result = rewriteHtml(html, urlMap, 'https://example.com');

            // Should not throw, should leave as-is or handle gracefully
            expect(result).toBe(html);
        });

        it('should handle very long srcset values', () => {
            const urlMap = new Map([
                [
                    'https://cdn.example.net/img-320.jpg',
                    '/_external/a_img-320.jpg',
                ],
                [
                    'https://cdn.example.net/img-640.jpg',
                    '/_external/a_img-640.jpg',
                ],
                [
                    'https://cdn.example.net/img-1280.jpg',
                    '/_external/a_img-1280.jpg',
                ],
                [
                    'https://cdn.example.net/img-1920.jpg',
                    '/_external/a_img-1920.jpg',
                ],
            ]);
            const html = `<img srcset="https://cdn.example.net/img-320.jpg 320w, https://cdn.example.net/img-640.jpg 640w, https://cdn.example.net/img-1280.jpg 1280w, https://cdn.example.net/img-1920.jpg 1920w">`;
            const result = rewriteHtml(html, urlMap, 'https://example.com');

            expect(result).toContain('/_external/a_img-320.jpg 320w');
            expect(result).toContain('/_external/a_img-640.jpg 640w');
            expect(result).toContain('/_external/a_img-1280.jpg 1280w');
            expect(result).toContain('/_external/a_img-1920.jpg 1920w');
        });
    });
});
