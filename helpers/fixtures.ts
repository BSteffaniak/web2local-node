/**
 * Test Fixtures
 *
 * Uses Vitest's test.extend() pattern (Playwright-style) for type-safe fixture loading.
 * Fixtures are lazily loaded and cached, providing a clean API for tests.
 */

import { test as base } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Get the fixtures directory path
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES_DIR = join(__dirname, '../fixtures');

// ============================================================================
// FIXTURE TYPES
// ============================================================================

/**
 * Source map fixture with parsed JSON content
 */
export interface SourceMapFixture {
    version: number;
    file?: string;
    sources: string[];
    sourcesContent: (string | null)[];
    names: string[];
    mappings: string;
    sourceRoot?: string;
}

/**
 * Source file fixture with path and content
 */
export interface SourceFileFixture {
    path: string;
    content: string;
}

/**
 * CSS bundle fixture
 */
export interface CssBundleFixture {
    content: string;
    hasSourceMap: boolean;
    sourceMapUrl?: string;
}

/**
 * All available fixtures
 */
export interface TestFixtures {
    // CSS Source Maps
    viteScssSourceMap: SourceMapFixture;
    webpackSassSourceMap: SourceMapFixture;
    withNullContentSourceMap: SourceMapFixture;

    // CSS Bundles
    cssWithSourceMap: CssBundleFixture;
    cssNoSourceMap: CssBundleFixture;
    cssInlineSourceMap: CssBundleFixture;

    // Source Files
    reactComponent: SourceFileFixture;
    multipleImports: SourceFileFixture;

    // Helpers
    loadFixture: (relativePath: string) => string;
    loadJsonFixture: <T>(relativePath: string) => T;
}

// ============================================================================
// FIXTURE LOADERS
// ============================================================================

/**
 * Loads a fixture file as a string
 */
function loadFixture(relativePath: string): string {
    return readFileSync(join(FIXTURES_DIR, relativePath), 'utf-8');
}

/**
 * Loads a fixture file as parsed JSON
 */
function loadJsonFixture<T>(relativePath: string): T {
    return JSON.parse(loadFixture(relativePath)) as T;
}

/**
 * Extracts sourceMappingURL from CSS content
 */
function extractSourceMapUrl(content: string): string | undefined {
    const match = content.match(/\/\*#\s*sourceMappingURL=([^\s*]+)\s*\*\//);
    return match?.[1];
}

// ============================================================================
// EXTENDED TEST
// ============================================================================

/**
 * Extended test with typed fixtures.
 *
 * Usage:
 * ```ts
 * import { test, expect } from './helpers/fixtures.js';
 *
 * test('extracts SCSS from source map', async ({ viteScssSourceMap }) => {
 *   expect(viteScssSourceMap.sources).toHaveLength(3);
 * });
 * ```
 */
export const test = base.extend<TestFixtures>({
    // CSS Source Maps
    viteScssSourceMap: async ({}, use) => {
        const sourceMap = loadJsonFixture<SourceMapFixture>(
            'css-source-maps/vite-scss.json',
        );
        await use(sourceMap);
    },

    webpackSassSourceMap: async ({}, use) => {
        const sourceMap = loadJsonFixture<SourceMapFixture>(
            'css-source-maps/webpack-sass.json',
        );
        await use(sourceMap);
    },

    withNullContentSourceMap: async ({}, use) => {
        const sourceMap = loadJsonFixture<SourceMapFixture>(
            'css-source-maps/with-null-content.json',
        );
        await use(sourceMap);
    },

    // CSS Bundles
    cssWithSourceMap: async ({}, use) => {
        const content = loadFixture('css-bundles/with-sourcemap.css');
        const sourceMapUrl = extractSourceMapUrl(content);
        await use({
            content,
            hasSourceMap: !!sourceMapUrl,
            sourceMapUrl,
        });
    },

    cssNoSourceMap: async ({}, use) => {
        try {
            const content = loadFixture('css-bundles/no-sourcemap.css');
            await use({
                content,
                hasSourceMap: false,
            });
        } catch {
            // File doesn't exist yet, provide default
            await use({
                content: '.plain { color: red; }',
                hasSourceMap: false,
            });
        }
    },

    cssInlineSourceMap: async ({}, use) => {
        try {
            const content = loadFixture('css-bundles/inline-sourcemap.css');
            const sourceMapUrl = extractSourceMapUrl(content);
            await use({
                content,
                hasSourceMap: !!sourceMapUrl,
                sourceMapUrl,
            });
        } catch {
            // File doesn't exist yet, provide default with inline source map
            const inlineMap = Buffer.from(
                JSON.stringify({
                    version: 3,
                    sources: ['inline.scss'],
                    sourcesContent: ['.inline { display: block; }'],
                    names: [],
                    mappings: 'AAAA',
                }),
            ).toString('base64');
            await use({
                content: `.inline{display:block}\n/*# sourceMappingURL=data:application/json;base64,${inlineMap} */`,
                hasSourceMap: true,
                sourceMapUrl: `data:application/json;base64,${inlineMap}`,
            });
        }
    },

    // Source Files
    reactComponent: async ({}, use) => {
        const content = loadFixture('source-files/react-component.tsx');
        await use({
            path: 'src/components/Button.tsx',
            content,
        });
    },

    multipleImports: async ({}, use) => {
        const content = loadFixture('source-files/multiple-imports.tsx');
        await use({
            path: 'src/pages/Page.tsx',
            content,
        });
    },

    // Helpers - expose loader functions for custom fixtures
    loadFixture: async ({}, use) => {
        await use(loadFixture);
    },

    loadJsonFixture: async ({}, use) => {
        await use(loadJsonFixture);
    },
});

// ============================================================================
// RE-EXPORTS
// ============================================================================

// Re-export everything from vitest for convenience
export {
    expect,
    describe,
    beforeEach,
    afterEach,
    beforeAll,
    afterAll,
    vi,
} from 'vitest';

// Re-export MSW helpers
export {
    server,
    createCssHandler,
    createCssSourceMapHandler,
    create404Handler,
} from './msw-handlers.js';
