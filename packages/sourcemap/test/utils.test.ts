import { describe, it, expect } from 'vitest';
import { normalizeSourcePath, getCleanFilename } from '../src/utils/path.js';
import {
    resolveSourceMapUrl,
    isDataUri,
    decodeDataUri,
} from '../src/utils/url.js';
import { shouldIncludeSource } from '../src/utils/filter.js';

describe('normalizeSourcePath', () => {
    describe('webpack:// protocol', () => {
        it('removes webpack:// prefix with app name', () => {
            expect(normalizeSourcePath('webpack://myapp/./src/index.ts')).toBe(
                'src/index.ts',
            );
        });

        it('removes webpack:// prefix with empty app name', () => {
            expect(normalizeSourcePath('webpack:///./src/index.ts')).toBe(
                'src/index.ts',
            );
        });

        it('handles nested paths', () => {
            expect(
                normalizeSourcePath(
                    'webpack://myapp/./src/components/Button/Button.tsx',
                ),
            ).toBe('src/components/Button/Button.tsx');
        });

        it('handles node_modules paths', () => {
            expect(
                normalizeSourcePath(
                    'webpack://myapp/./node_modules/react/index.js',
                ),
            ).toBe('node_modules/react/index.js');
        });
    });

    describe('vite virtual modules', () => {
        it('removes \\0 prefix', () => {
            expect(normalizeSourcePath('\0/src/App.tsx')).toBe('src/App.tsx');
        });

        it('handles vite-specific paths', () => {
            expect(normalizeSourcePath('\0vite/preload-helper')).toBe(
                'vite/preload-helper',
            );
        });
    });

    describe('sourceRoot handling', () => {
        it('prepends sourceRoot to relative paths', () => {
            expect(normalizeSourcePath('Button.tsx', 'src/components/')).toBe(
                'src/components/Button.tsx',
            );
        });

        it('does not prepend sourceRoot to absolute paths', () => {
            expect(normalizeSourcePath('/src/Button.tsx', 'components/')).toBe(
                'src/Button.tsx',
            );
        });

        it('does not prepend sourceRoot to paths starting with .', () => {
            expect(normalizeSourcePath('./src/Button.tsx', 'components/')).toBe(
                'src/Button.tsx',
            );
        });
    });

    describe('path normalization', () => {
        it('removes leading ./', () => {
            expect(normalizeSourcePath('./src/index.ts')).toBe('src/index.ts');
        });

        it('resolves .. segments', () => {
            expect(
                normalizeSourcePath('src/components/../utils/index.ts'),
            ).toBe('src/utils/index.ts');
        });

        it('handles multiple .. segments', () => {
            expect(
                normalizeSourcePath('src/deep/nested/../../shallow/file.ts'),
            ).toBe('src/shallow/file.ts');
        });

        it('handles leading .. segments gracefully', () => {
            expect(normalizeSourcePath('../outside/file.ts')).toBe(
                '../outside/file.ts',
            );
        });

        it('removes empty segments', () => {
            expect(normalizeSourcePath('src//components///Button.tsx')).toBe(
                'src/components/Button.tsx',
            );
        });

        it('removes . segments', () => {
            expect(normalizeSourcePath('src/./components/./Button.tsx')).toBe(
                'src/components/Button.tsx',
            );
        });
    });
});

describe('resolveSourceMapUrl', () => {
    const baseUrl = 'https://example.com/assets/js/bundle.js';

    it('returns absolute URLs unchanged', () => {
        expect(
            resolveSourceMapUrl(
                baseUrl,
                'https://cdn.example.com/bundle.js.map',
            ),
        ).toBe('https://cdn.example.com/bundle.js.map');
    });

    it('returns http URLs unchanged', () => {
        expect(
            resolveSourceMapUrl(
                baseUrl,
                'http://cdn.example.com/bundle.js.map',
            ),
        ).toBe('http://cdn.example.com/bundle.js.map');
    });

    it('returns data URIs unchanged', () => {
        const dataUri = 'data:application/json;base64,eyJ2ZXJzaW9uIjozfQ==';
        expect(resolveSourceMapUrl(baseUrl, dataUri)).toBe(dataUri);
    });

    it('resolves protocol-relative URLs', () => {
        expect(
            resolveSourceMapUrl(baseUrl, '//cdn.example.com/bundle.js.map'),
        ).toBe('https://cdn.example.com/bundle.js.map');
    });

    it('resolves absolute paths', () => {
        expect(resolveSourceMapUrl(baseUrl, '/maps/bundle.js.map')).toBe(
            'https://example.com/maps/bundle.js.map',
        );
    });

    it('resolves relative paths (same directory)', () => {
        expect(resolveSourceMapUrl(baseUrl, 'bundle.js.map')).toBe(
            'https://example.com/assets/js/bundle.js.map',
        );
    });

    it('resolves relative paths with ./', () => {
        expect(resolveSourceMapUrl(baseUrl, './bundle.js.map')).toBe(
            'https://example.com/assets/js/bundle.js.map',
        );
    });

    it('resolves parent directory paths', () => {
        expect(resolveSourceMapUrl(baseUrl, '../maps/bundle.js.map')).toBe(
            'https://example.com/assets/maps/bundle.js.map',
        );
    });
});

describe('shouldIncludeSource', () => {
    it('includes regular source files', () => {
        expect(shouldIncludeSource('src/components/Button.tsx')).toBe(true);
    });

    it('excludes node_modules by default', () => {
        expect(shouldIncludeSource('node_modules/react/index.js')).toBe(false);
    });

    it('includes node_modules when includeNodeModules is true', () => {
        expect(
            shouldIncludeSource('node_modules/react/index.js', {
                includeNodeModules: true,
            }),
        ).toBe(true);
    });

    it('includes internal packages from node_modules', () => {
        expect(
            shouldIncludeSource('node_modules/@myorg/shared/index.ts', {
                internalPackages: new Set(['@myorg/shared']),
            }),
        ).toBe(true);
    });

    it('includes scoped internal packages', () => {
        expect(
            shouldIncludeSource('node_modules/@company/ui-kit/Button.tsx', {
                internalPackages: new Set(['@company/ui-kit']),
            }),
        ).toBe(true);
    });

    it('excludes webpack internal modules', () => {
        expect(shouldIncludeSource('(webpack)/buildin/module.js')).toBe(false);
    });

    it('excludes vite internal modules', () => {
        expect(shouldIncludeSource('__vite/preload-helper')).toBe(false);
        expect(shouldIncludeSource('vite/modulepreload-polyfill')).toBe(false);
    });

    it('excludes query string paths', () => {
        expect(shouldIncludeSource('?commonjs-exports')).toBe(false);
    });

    it('excludes data URIs', () => {
        expect(
            shouldIncludeSource('data:text/javascript,export default 1'),
        ).toBe(false);
    });

    it('excludes paths with virtual module marker', () => {
        expect(shouldIncludeSource('src/\0virtual.ts')).toBe(false);
    });

    it('applies custom exclude patterns', () => {
        expect(
            shouldIncludeSource('src/generated/schema.ts', {
                excludePatterns: [/generated\//],
            }),
        ).toBe(false);
    });

    it('does not exclude non-matching custom patterns', () => {
        expect(
            shouldIncludeSource('src/components/Button.tsx', {
                excludePatterns: [/generated\//],
            }),
        ).toBe(true);
    });
});

describe('isDataUri', () => {
    it('returns true for data URIs', () => {
        expect(
            isDataUri('data:application/json;base64,eyJ2ZXJzaW9uIjozfQ=='),
        ).toBe(true);
    });

    it('returns true for minimal data URIs', () => {
        expect(isDataUri('data:,')).toBe(true);
    });

    it('returns false for http URLs', () => {
        expect(isDataUri('http://example.com/file.json')).toBe(false);
    });

    it('returns false for https URLs', () => {
        expect(isDataUri('https://example.com/file.json')).toBe(false);
    });

    it('returns false for relative paths', () => {
        expect(isDataUri('./file.json')).toBe(false);
    });
});

describe('decodeDataUri', () => {
    it('decodes valid base64 data URIs', () => {
        // {"version":3}
        const dataUri = 'data:application/json;base64,eyJ2ZXJzaW9uIjozfQ==';
        expect(decodeDataUri(dataUri)).toBe('{"version":3}');
    });

    it('returns null for non-data URIs', () => {
        expect(decodeDataUri('https://example.com/file.json')).toBe(null);
    });

    it('returns null for non-base64 data URIs', () => {
        expect(decodeDataUri('data:application/json,{"version":3}')).toBe(null);
    });

    it('returns null for invalid base64 characters', () => {
        // Base64 only allows A-Z, a-z, 0-9, +, /, and = for padding
        expect(decodeDataUri('data:application/json;base64,!!invalid!!')).toBe(
            null,
        );
    });

    it('returns null for base64 with invalid padding', () => {
        // Invalid padding (= in wrong position)
        expect(decodeDataUri('data:application/json;base64,abc=def')).toBe(
            null,
        );
    });
});

describe('getCleanFilename', () => {
    it('extracts filename from path', () => {
        expect(getCleanFilename('src/components/Button.tsx')).toBe(
            'Button.tsx',
        );
    });

    it('removes query strings', () => {
        expect(getCleanFilename('src/index.ts?v=123')).toBe('index.ts');
    });

    it('adds .js extension for extensionless files', () => {
        expect(getCleanFilename('src/index')).toBe('index.js');
    });

    it('keeps existing extensions', () => {
        expect(getCleanFilename('styles.css')).toBe('styles.css');
    });

    it('handles files with dots in name', () => {
        expect(getCleanFilename('src/config.prod.ts')).toBe('config.prod.ts');
    });
});
