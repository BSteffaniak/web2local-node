/**
 * Tests for responsive image URL extraction from static-downloader.ts
 */

import { describe, it, expect } from 'vitest';
import {
    parseSrcsetUrls,
    parseImageSetUrls,
    extractResponsiveUrlsFromHtml,
    extractResponsiveUrlsFromCss,
} from '../src/capture/static-downloader.js';

describe('parseSrcsetUrls', () => {
    it('parses srcset with width descriptors', () => {
        const srcset =
            '/img/foo-240.webp 240w, /img/foo-540.webp 540w, /img/foo.webp 1080w';
        const urls = parseSrcsetUrls(srcset);
        expect(urls).toEqual([
            '/img/foo-240.webp',
            '/img/foo-540.webp',
            '/img/foo.webp',
        ]);
    });

    it('parses srcset with pixel density descriptors', () => {
        const srcset =
            '/img/logo.png 1x, /img/logo@2x.png 2x, /img/logo@3x.png 3x';
        const urls = parseSrcsetUrls(srcset);
        expect(urls).toEqual([
            '/img/logo.png',
            '/img/logo@2x.png',
            '/img/logo@3x.png',
        ]);
    });

    it('parses srcset with mixed descriptors', () => {
        const srcset = '/img/small.jpg 100w, /img/medium.jpg 2x';
        const urls = parseSrcsetUrls(srcset);
        expect(urls).toEqual(['/img/small.jpg', '/img/medium.jpg']);
    });

    it('handles single URL without descriptor', () => {
        const srcset = '/img/only.png';
        const urls = parseSrcsetUrls(srcset);
        expect(urls).toEqual(['/img/only.png']);
    });

    it('handles single URL with descriptor', () => {
        const srcset = '/img/only.png 800w';
        const urls = parseSrcsetUrls(srcset);
        expect(urls).toEqual(['/img/only.png']);
    });

    it('handles empty string', () => {
        expect(parseSrcsetUrls('')).toEqual([]);
    });

    it('handles whitespace-only string', () => {
        expect(parseSrcsetUrls('   ')).toEqual([]);
    });

    it('filters out data: URLs', () => {
        const srcset = 'data:image/png;base64,abc123 1x, /img/real.png 2x';
        const urls = parseSrcsetUrls(srcset);
        expect(urls).toEqual(['/img/real.png']);
    });

    it('handles absolute URLs', () => {
        const srcset =
            'https://cdn.example.com/img/a.jpg 1x, https://cdn.example.com/img/b.jpg 2x';
        const urls = parseSrcsetUrls(srcset);
        expect(urls).toEqual([
            'https://cdn.example.com/img/a.jpg',
            'https://cdn.example.com/img/b.jpg',
        ]);
    });

    it('handles URLs with query strings', () => {
        const srcset =
            '/img/photo.jpg?v=1 1x, /img/photo.jpg?v=2&size=large 2x';
        const urls = parseSrcsetUrls(srcset);
        expect(urls).toEqual([
            '/img/photo.jpg?v=1',
            '/img/photo.jpg?v=2&size=large',
        ]);
    });

    it('handles extra whitespace between entries', () => {
        const srcset = '  /img/a.jpg 1x  ,   /img/b.jpg 2x  ';
        const urls = parseSrcsetUrls(srcset);
        expect(urls).toEqual(['/img/a.jpg', '/img/b.jpg']);
    });

    it('handles newlines in srcset', () => {
        const srcset = `/img/a.jpg 1x,
            /img/b.jpg 2x,
            /img/c.jpg 3x`;
        const urls = parseSrcsetUrls(srcset);
        expect(urls).toEqual(['/img/a.jpg', '/img/b.jpg', '/img/c.jpg']);
    });
});

describe('parseImageSetUrls', () => {
    it('parses image-set with url() syntax and double quotes', () => {
        const imageSet = 'image-set(url("foo.webp") 1x, url("foo@2x.webp") 2x)';
        const urls = parseImageSetUrls(imageSet);
        expect(urls).toEqual(['foo.webp', 'foo@2x.webp']);
    });

    it('parses image-set with url() syntax and single quotes', () => {
        const imageSet = "image-set(url('foo.webp') 1x, url('foo@2x.webp') 2x)";
        const urls = parseImageSetUrls(imageSet);
        expect(urls).toEqual(['foo.webp', 'foo@2x.webp']);
    });

    it('parses image-set with url() syntax without quotes', () => {
        const imageSet = 'image-set(url(foo.webp) 1x, url(foo@2x.webp) 2x)';
        const urls = parseImageSetUrls(imageSet);
        expect(urls).toEqual(['foo.webp', 'foo@2x.webp']);
    });

    it('parses -webkit-image-set', () => {
        const imageSet =
            '-webkit-image-set(url("foo.webp") 1x, url("foo@2x.webp") 2x)';
        const urls = parseImageSetUrls(imageSet);
        expect(urls).toEqual(['foo.webp', 'foo@2x.webp']);
    });

    it('handles single entry', () => {
        const imageSet = 'image-set(url("only.png") 1x)';
        const urls = parseImageSetUrls(imageSet);
        expect(urls).toEqual(['only.png']);
    });

    it('handles multiple entries with different densities', () => {
        const imageSet =
            'image-set(url("a.png") 1x, url("b.png") 1.5x, url("c.png") 2x, url("d.png") 3x)';
        const urls = parseImageSetUrls(imageSet);
        expect(urls).toEqual(['a.png', 'b.png', 'c.png', 'd.png']);
    });

    it('handles empty string', () => {
        expect(parseImageSetUrls('')).toEqual([]);
    });

    it('handles whitespace-only string', () => {
        expect(parseImageSetUrls('   ')).toEqual([]);
    });

    it('filters out data: URLs', () => {
        const imageSet =
            'image-set(url("data:image/png;base64,abc") 1x, url("real.png") 2x)';
        const urls = parseImageSetUrls(imageSet);
        expect(urls).toEqual(['real.png']);
    });

    it('handles absolute URLs', () => {
        const imageSet =
            'image-set(url("https://cdn.example.com/a.png") 1x, url("https://cdn.example.com/b.png") 2x)';
        const urls = parseImageSetUrls(imageSet);
        expect(urls).toEqual([
            'https://cdn.example.com/a.png',
            'https://cdn.example.com/b.png',
        ]);
    });

    it('handles relative paths', () => {
        const imageSet =
            'image-set(url("../images/a.png") 1x, url("./b.png") 2x)';
        const urls = parseImageSetUrls(imageSet);
        expect(urls).toEqual(['../images/a.png', './b.png']);
    });

    it('handles bare strings with quotes (less common syntax)', () => {
        const imageSet = 'image-set("image.webp" 1x, "image@2x.webp" 2x)';
        const urls = parseImageSetUrls(imageSet);
        expect(urls).toEqual(['image.webp', 'image@2x.webp']);
    });
});

describe('extractResponsiveUrlsFromHtml', () => {
    const baseUrl = 'https://example.com';

    it('extracts srcset from img elements', () => {
        const html = `
            <html>
            <body>
                <img src="/img/photo.jpg" srcset="/img/photo-240.jpg 240w, /img/photo-480.jpg 480w">
            </body>
            </html>
        `;
        const urls = extractResponsiveUrlsFromHtml(html, baseUrl);
        expect(urls).toContain('https://example.com/img/photo-240.jpg');
        expect(urls).toContain('https://example.com/img/photo-480.jpg');
    });

    it('extracts srcset from source elements in picture', () => {
        const html = `
            <picture>
                <source srcset="/img/hero-mobile.webp 480w, /img/hero-desktop.webp 1200w" type="image/webp">
                <img src="/img/hero.jpg">
            </picture>
        `;
        const urls = extractResponsiveUrlsFromHtml(html, baseUrl);
        expect(urls).toContain('https://example.com/img/hero-mobile.webp');
        expect(urls).toContain('https://example.com/img/hero-desktop.webp');
    });

    it('extracts src from source elements in video', () => {
        const html = `
            <video controls>
                <source src="/video/intro.mp4" type="video/mp4">
                <source src="/video/intro.webm" type="video/webm">
            </video>
        `;
        const urls = extractResponsiveUrlsFromHtml(html, baseUrl);
        expect(urls).toContain('https://example.com/video/intro.mp4');
        expect(urls).toContain('https://example.com/video/intro.webm');
    });

    it('extracts src from source elements in audio', () => {
        const html = `
            <audio controls>
                <source src="/audio/song.mp3" type="audio/mpeg">
                <source src="/audio/song.ogg" type="audio/ogg">
            </audio>
        `;
        const urls = extractResponsiveUrlsFromHtml(html, baseUrl);
        expect(urls).toContain('https://example.com/audio/song.mp3');
        expect(urls).toContain('https://example.com/audio/song.ogg');
    });

    it('extracts image-set from inline style tags', () => {
        const html = `
            <html>
            <head>
                <style>
                    .hero {
                        background-image: image-set(url("/img/bg.webp") 1x, url("/img/bg@2x.webp") 2x);
                    }
                </style>
            </head>
            </html>
        `;
        const urls = extractResponsiveUrlsFromHtml(html, baseUrl);
        expect(urls).toContain('https://example.com/img/bg.webp');
        expect(urls).toContain('https://example.com/img/bg@2x.webp');
    });

    it('extracts -webkit-image-set from inline style tags', () => {
        const html = `
            <style>
                .logo {
                    background: -webkit-image-set(url("/img/logo.png") 1x, url("/img/logo@2x.png") 2x);
                }
            </style>
        `;
        const urls = extractResponsiveUrlsFromHtml(html, baseUrl);
        expect(urls).toContain('https://example.com/img/logo.png');
        expect(urls).toContain('https://example.com/img/logo@2x.png');
    });

    it('resolves relative URLs correctly', () => {
        const html = `<img srcset="../images/a.jpg 1x, ./b.jpg 2x">`;
        const urls = extractResponsiveUrlsFromHtml(
            html,
            'https://example.com/pages/about/',
        );
        // ../images/a.jpg from /pages/about/ goes up to /pages/ then into images/
        expect(urls).toContain('https://example.com/pages/images/a.jpg');
        expect(urls).toContain('https://example.com/pages/about/b.jpg');
    });

    it('resolves protocol-relative URLs', () => {
        const html = `<img srcset="//cdn.example.com/img/a.jpg 1x">`;
        const urls = extractResponsiveUrlsFromHtml(html, baseUrl);
        expect(urls).toContain('https://cdn.example.com/img/a.jpg');
    });

    it('deduplicates URLs', () => {
        const html = `
            <img srcset="/img/same.jpg 1x">
            <img srcset="/img/same.jpg 2x">
        `;
        const urls = extractResponsiveUrlsFromHtml(html, baseUrl);
        const sameUrls = urls.filter(
            (u) => u === 'https://example.com/img/same.jpg',
        );
        expect(sameUrls.length).toBe(1);
    });

    it('handles HTML with no responsive images', () => {
        const html = `
            <html>
            <body>
                <img src="/img/simple.jpg">
                <p>No srcset here</p>
            </body>
            </html>
        `;
        const urls = extractResponsiveUrlsFromHtml(html, baseUrl);
        expect(urls).toEqual([]);
    });

    it('handles multiple srcset attributes in same element', () => {
        const html = `
            <picture>
                <source srcset="/img/a-sm.webp 480w, /img/a-lg.webp 1200w" media="(max-width: 800px)">
                <source srcset="/img/b-sm.webp 480w, /img/b-lg.webp 1200w">
                <img src="/img/fallback.jpg" srcset="/img/fallback-sm.jpg 480w, /img/fallback-lg.jpg 1200w">
            </picture>
        `;
        const urls = extractResponsiveUrlsFromHtml(html, baseUrl);
        expect(urls.length).toBe(6);
    });

    it('handles srcset with single quotes', () => {
        const html = `<img srcset='/img/a.jpg 1x, /img/b.jpg 2x'>`;
        const urls = extractResponsiveUrlsFromHtml(html, baseUrl);
        expect(urls).toContain('https://example.com/img/a.jpg');
        expect(urls).toContain('https://example.com/img/b.jpg');
    });

    it('filters out data: URLs in srcset', () => {
        const html = `<img srcset="data:image/png;base64,abc 1x, /img/real.png 2x">`;
        const urls = extractResponsiveUrlsFromHtml(html, baseUrl);
        expect(urls).toEqual(['https://example.com/img/real.png']);
    });

    it('handles multiple style tags', () => {
        const html = `
            <style>.a { background: image-set(url("/img/a.png") 1x); }</style>
            <style>.b { background: image-set(url("/img/b.png") 1x); }</style>
        `;
        const urls = extractResponsiveUrlsFromHtml(html, baseUrl);
        expect(urls).toContain('https://example.com/img/a.png');
        expect(urls).toContain('https://example.com/img/b.png');
    });
});

describe('extractResponsiveUrlsFromCss', () => {
    const cssUrl = 'https://example.com/css/styles.css';

    it('extracts image-set URLs', () => {
        const css = `
            .hero {
                background-image: image-set(url("/img/hero.webp") 1x, url("/img/hero@2x.webp") 2x);
            }
        `;
        const urls = extractResponsiveUrlsFromCss(css, cssUrl);
        expect(urls).toContain('https://example.com/img/hero.webp');
        expect(urls).toContain('https://example.com/img/hero@2x.webp');
    });

    it('extracts -webkit-image-set URLs', () => {
        const css = `
            .logo {
                background: -webkit-image-set(url("/img/logo.png") 1x, url("/img/logo@2x.png") 2x);
            }
        `;
        const urls = extractResponsiveUrlsFromCss(css, cssUrl);
        expect(urls).toContain('https://example.com/img/logo.png');
        expect(urls).toContain('https://example.com/img/logo@2x.png');
    });

    it('resolves relative URLs based on CSS file location', () => {
        const css = `
            .icon {
                background: image-set(url("../images/icon.png") 1x);
            }
        `;
        const urls = extractResponsiveUrlsFromCss(css, cssUrl);
        expect(urls).toContain('https://example.com/images/icon.png');
    });

    it('handles multiple image-set occurrences', () => {
        const css = `
            .a { background: image-set(url("/img/a.png") 1x); }
            .b { background: image-set(url("/img/b.png") 1x); }
            .c { background: -webkit-image-set(url("/img/c.png") 1x); }
        `;
        const urls = extractResponsiveUrlsFromCss(css, cssUrl);
        expect(urls).toContain('https://example.com/img/a.png');
        expect(urls).toContain('https://example.com/img/b.png');
        expect(urls).toContain('https://example.com/img/c.png');
    });

    it('handles CSS with no image-set', () => {
        const css = `
            .simple {
                background: url("/img/simple.jpg");
                color: red;
            }
        `;
        const urls = extractResponsiveUrlsFromCss(css, cssUrl);
        expect(urls).toEqual([]);
    });

    it('handles image-set with multiple densities', () => {
        const css = `
            .retina {
                background: image-set(
                    url("/img/photo.jpg") 1x,
                    url("/img/photo@1.5x.jpg") 1.5x,
                    url("/img/photo@2x.jpg") 2x,
                    url("/img/photo@3x.jpg") 3x
                );
            }
        `;
        const urls = extractResponsiveUrlsFromCss(css, cssUrl);
        expect(urls.length).toBe(4);
        expect(urls).toContain('https://example.com/img/photo.jpg');
        expect(urls).toContain('https://example.com/img/photo@2x.jpg');
    });

    it('filters out data: URLs', () => {
        const css = `
            .icon {
                background: image-set(
                    url("data:image/svg+xml,...") 1x,
                    url("/img/icon.png") 2x
                );
            }
        `;
        const urls = extractResponsiveUrlsFromCss(css, cssUrl);
        expect(urls).toEqual(['https://example.com/img/icon.png']);
    });

    it('deduplicates URLs', () => {
        const css = `
            .a { background: image-set(url("/img/same.png") 1x); }
            .b { background: image-set(url("/img/same.png") 2x); }
        `;
        const urls = extractResponsiveUrlsFromCss(css, cssUrl);
        expect(urls.length).toBe(1);
        expect(urls[0]).toBe('https://example.com/img/same.png');
    });

    it('handles absolute URLs in CSS', () => {
        const css = `
            .cdn {
                background: image-set(url("https://cdn.example.com/img/photo.jpg") 1x);
            }
        `;
        const urls = extractResponsiveUrlsFromCss(css, cssUrl);
        expect(urls).toContain('https://cdn.example.com/img/photo.jpg');
    });

    it('handles protocol-relative URLs', () => {
        const css = `
            .cdn {
                background: image-set(url("//cdn.example.com/img/photo.jpg") 1x);
            }
        `;
        const urls = extractResponsiveUrlsFromCss(css, cssUrl);
        expect(urls).toContain('https://cdn.example.com/img/photo.jpg');
    });
});
