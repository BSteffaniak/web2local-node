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
