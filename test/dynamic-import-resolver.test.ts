/**
 * Tests for dynamic import resolution
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { http, HttpResponse } from 'msw';
import { server } from './helpers/msw-handlers.js';
import {
    extractDynamicImportPaths,
    extractCssImportUrls,
    resolveRelativePath,
    resolveMissingDynamicImports,
    updateManifestWithResolvedFiles,
} from '@web2local/analyzer';

describe('extractDynamicImportPaths', () => {
    it('extracts basic dynamic import', () => {
        const code = `const x = import("./foo.js");`;
        const paths = extractDynamicImportPaths(code);
        expect(paths).toEqual(['./foo.js']);
    });

    it('extracts multiple dynamic imports', () => {
        const code = `
            import("./a.js");
            import("../b.js");
            import("./c/d.js");
        `;
        const paths = extractDynamicImportPaths(code);
        expect(paths).toContain('./a.js');
        expect(paths).toContain('../b.js');
        expect(paths).toContain('./c/d.js');
        expect(paths).toHaveLength(3);
    });

    it('extracts dynamic imports inside functions', () => {
        const code = `
            function load() {
                return import("./chunk.js");
            }
            const loader = () => import("../other.js");
        `;
        const paths = extractDynamicImportPaths(code);
        expect(paths).toContain('./chunk.js');
        expect(paths).toContain('../other.js');
    });

    it('extracts dynamic imports in async functions', () => {
        const code = `
            async function loadModule() {
                const mod = await import("./module.js");
                return mod;
            }
        `;
        const paths = extractDynamicImportPaths(code);
        expect(paths).toEqual(['./module.js']);
    });

    it('ignores static imports', () => {
        const code = `
            import foo from "./foo.js";
            import { bar } from "./bar.js";
            import * as baz from "./baz.js";
        `;
        const paths = extractDynamicImportPaths(code);
        expect(paths).toEqual([]);
    });

    it('ignores package imports (no relative path)', () => {
        const code = `
            import("react");
            import("lodash/debounce");
            import("@scope/package");
        `;
        const paths = extractDynamicImportPaths(code);
        expect(paths).toEqual([]);
    });

    it('ignores absolute URLs', () => {
        const code = `
            import("https://cdn.example.com/lib.js");
            import("http://example.com/module.js");
        `;
        const paths = extractDynamicImportPaths(code);
        expect(paths).toEqual([]);
    });

    it('ignores template literals (non-static)', () => {
        const code = 'const x = import(`./dynamic-${name}.js`);';
        const paths = extractDynamicImportPaths(code);
        expect(paths).toEqual([]);
    });

    it('handles minified code', () => {
        const code = `function a(){return import("./x.js")}function b(){import("../y.js")}`;
        const paths = extractDynamicImportPaths(code);
        expect(paths).toContain('./x.js');
        expect(paths).toContain('../y.js');
    });

    it('handles SvelteKit-style dynamic imports', () => {
        // Real-world pattern from SvelteKit app.js
        const code = `
            const nodes = [
                () => import("./nodes/0.js"),
                () => import("./nodes/1.js"),
                () => import("../nodes/2.8b6097a1.js")
            ];
        `;
        const paths = extractDynamicImportPaths(code);
        expect(paths).toContain('./nodes/0.js');
        expect(paths).toContain('./nodes/1.js');
        expect(paths).toContain('../nodes/2.8b6097a1.js');
    });

    it('deduplicates repeated imports', () => {
        const code = `
            import("./same.js");
            import("./same.js");
            import("./same.js");
        `;
        const paths = extractDynamicImportPaths(code);
        expect(paths).toEqual(['./same.js']);
    });

    it('handles empty code', () => {
        expect(extractDynamicImportPaths('')).toEqual([]);
    });

    it('handles code with syntax errors gracefully', () => {
        const code = `this is not valid javascript {{{`;
        const paths = extractDynamicImportPaths(code);
        expect(paths).toEqual([]);
    });
});

describe('extractCssImportUrls', () => {
    it('extracts @import url() with double quotes', () => {
        const css = `@import url("./theme.css");`;
        const urls = extractCssImportUrls(css);
        expect(urls).toEqual(['./theme.css']);
    });

    it('extracts @import url() with single quotes', () => {
        const css = `@import url('./theme.css');`;
        const urls = extractCssImportUrls(css);
        expect(urls).toEqual(['./theme.css']);
    });

    it('extracts @import url() without quotes', () => {
        const css = `@import url(./no-quotes.css);`;
        const urls = extractCssImportUrls(css);
        expect(urls).toEqual(['./no-quotes.css']);
    });

    it('extracts @import with direct string (double quotes)', () => {
        const css = `@import "./direct.css";`;
        const urls = extractCssImportUrls(css);
        expect(urls).toEqual(['./direct.css']);
    });

    it('extracts @import with direct string (single quotes)', () => {
        const css = `@import '../parent.css';`;
        const urls = extractCssImportUrls(css);
        expect(urls).toEqual(['../parent.css']);
    });

    it('extracts multiple @imports', () => {
        const css = `
            @import url("./a.css");
            @import "../b.css";
            @import url('./c/d.css');
        `;
        const urls = extractCssImportUrls(css);
        expect(urls).toContain('./a.css');
        expect(urls).toContain('../b.css');
        expect(urls).toContain('./c/d.css');
    });

    it('ignores absolute URLs', () => {
        const css = `
            @import url("https://fonts.googleapis.com/css?family=Roboto");
            @import "https://cdn.example.com/styles.css";
        `;
        const urls = extractCssImportUrls(css);
        expect(urls).toEqual([]);
    });

    it('ignores data URLs', () => {
        const css = `@import url("data:text/css,body{color:red}");`;
        const urls = extractCssImportUrls(css);
        expect(urls).toEqual([]);
    });

    it('ignores package-style imports', () => {
        const css = `
            @import "normalize.css";
            @import "bootstrap/dist/css/bootstrap.css";
        `;
        const urls = extractCssImportUrls(css);
        expect(urls).toEqual([]);
    });

    it('handles empty CSS', () => {
        expect(extractCssImportUrls('')).toEqual([]);
    });

    it('handles CSS with no imports', () => {
        const css = `
            body { color: red; }
            .class { background: blue; }
        `;
        const urls = extractCssImportUrls(css);
        expect(urls).toEqual([]);
    });

    it('deduplicates repeated imports', () => {
        const css = `
            @import "./same.css";
            @import url("./same.css");
            @import './same.css';
        `;
        const urls = extractCssImportUrls(css);
        expect(urls).toEqual(['./same.css']);
    });
});

describe('resolveRelativePath', () => {
    it('resolves sibling file with ./', () => {
        const result = resolveRelativePath('a/b/c.js', './d.js');
        expect(result).toBe('a/b/d.js');
    });

    it('resolves parent directory with ../', () => {
        const result = resolveRelativePath('a/b/c.js', '../d.js');
        expect(result).toBe('a/d.js');
    });

    it('resolves multiple parent directories', () => {
        const result = resolveRelativePath('a/b/c/d.js', '../../e.js');
        expect(result).toBe('a/e.js');
    });

    it('resolves to root level', () => {
        const result = resolveRelativePath('a/b/c.js', '../../d.js');
        expect(result).toBe('d.js');
    });

    it('handles hashes in filenames', () => {
        const result = resolveRelativePath(
            '_app/entry/app.js',
            '../nodes/6.8b6097a1.js',
        );
        expect(result).toBe('_app/nodes/6.8b6097a1.js');
    });

    it('handles nested relative paths', () => {
        const result = resolveRelativePath('src/main.js', './utils/helper.js');
        expect(result).toBe('src/utils/helper.js');
    });

    it('handles Windows-style paths', () => {
        const result = resolveRelativePath('a\\b\\c.js', '../d.js');
        expect(result).toBe('a/d.js');
    });

    it('normalizes double slashes', () => {
        const result = resolveRelativePath('a/b/c.js', './/d.js');
        expect(result).toBe('a/b/d.js');
    });
});

describe('resolveMissingDynamicImports', () => {
    let testDir: string;
    let bundlesDir: string;
    let staticDir: string;

    beforeEach(async () => {
        // Create temporary test directories
        testDir = join(tmpdir(), `dynamic-import-test-${Date.now()}`);
        bundlesDir = join(testDir, '_bundles');
        staticDir = join(testDir, '_server', 'static');

        await mkdir(bundlesDir, { recursive: true });
        await mkdir(staticDir, { recursive: true });
    });

    afterEach(async () => {
        // Clean up test directories
        await rm(testDir, { recursive: true, force: true });
    });

    it('resolves imports from local staticDir', async () => {
        // Create a bundle file with dynamic imports
        const bundleContent = `
            const a = import("./chunk-a.js");
            const b = import("../shared/chunk-b.js");
        `;
        await mkdir(join(bundlesDir, 'entry'), { recursive: true });
        await writeFile(
            join(bundlesDir, 'entry', 'main.js'),
            bundleContent,
            'utf-8',
        );

        // Create the chunks in staticDir (simulating captured files)
        await mkdir(join(staticDir, 'entry'), { recursive: true });
        await mkdir(join(staticDir, 'shared'), { recursive: true });
        await writeFile(
            join(staticDir, 'entry', 'chunk-a.js'),
            'export const a = 1;',
            'utf-8',
        );
        await writeFile(
            join(staticDir, 'shared', 'chunk-b.js'),
            'export const b = 2;',
            'utf-8',
        );

        const result = await resolveMissingDynamicImports({
            bundlesDir,
            staticDir,
            baseUrl: 'https://test-dynamic-imports.local',
            maxIterations: 5,
        });

        expect(result.copiedFiles).toBe(2);
        expect(result.fetchedFiles).toBe(0);
        expect(result.errors).toHaveLength(0);

        // Verify files were copied to bundlesDir
        const chunkA = await readFile(
            join(bundlesDir, 'entry', 'chunk-a.js'),
            'utf-8',
        );
        expect(chunkA).toBe('export const a = 1;');
    });

    it('fetches missing imports from remote server', async () => {
        // Set up handler for this specific test
        server.use(
            http.get('https://test-dynamic-fetch.local/entry/remote.js', () => {
                return HttpResponse.text('export const remote = true;', {
                    headers: { 'Content-Type': 'application/javascript' },
                });
            }),
            http.get(
                'https://test-dynamic-fetch.local/entry/remote.js.map',
                () => {
                    return new HttpResponse(null, { status: 404 });
                },
            ),
        );

        // Create a bundle file with dynamic import
        await mkdir(join(bundlesDir, 'entry'), { recursive: true });
        await writeFile(
            join(bundlesDir, 'entry', 'main.js'),
            `const x = import("./remote.js");`,
            'utf-8',
        );

        const result = await resolveMissingDynamicImports({
            bundlesDir,
            staticDir,
            baseUrl: 'https://test-dynamic-fetch.local',
            maxIterations: 5,
        });

        expect(result.fetchedFiles).toBe(1);
        expect(result.copiedFiles).toBe(0);

        // Verify file was fetched and saved
        const remoteContent = await readFile(
            join(bundlesDir, 'entry', 'remote.js'),
            'utf-8',
        );
        expect(remoteContent).toBe('export const remote = true;');
    });

    it('handles cascade resolution (A imports B, B imports C)', async () => {
        // Set up handlers for cascading imports
        server.use(
            http.get('https://test-cascade.local/b.js', () => {
                return HttpResponse.text(
                    'import("./c.js"); export const b = 2;',
                    { headers: { 'Content-Type': 'application/javascript' } },
                );
            }),
            http.get('https://test-cascade.local/b.js.map', () => {
                return new HttpResponse(null, { status: 404 });
            }),
            http.get('https://test-cascade.local/c.js', () => {
                return HttpResponse.text('export const c = 3;', {
                    headers: { 'Content-Type': 'application/javascript' },
                });
            }),
            http.get('https://test-cascade.local/c.js.map', () => {
                return new HttpResponse(null, { status: 404 });
            }),
        );

        // Create initial bundle that imports B
        await writeFile(
            join(bundlesDir, 'a.js'),
            `import("./b.js"); export const a = 1;`,
            'utf-8',
        );

        const result = await resolveMissingDynamicImports({
            bundlesDir,
            staticDir,
            baseUrl: 'https://test-cascade.local',
            maxIterations: 5,
        });

        // Should fetch both B and C (cascade)
        expect(result.fetchedFiles).toBe(2);
        expect(result.iterations).toBeGreaterThanOrEqual(2);
    });

    it('respects maxIterations limit', async () => {
        // Create an infinite chain (each file imports the next)
        server.use(
            http.get('https://test-max-iter.local/:filename', ({ params }) => {
                const num = parseInt(
                    (params.filename as string).replace(/\D/g, ''),
                );
                const nextNum = num + 1;
                return HttpResponse.text(
                    `import("./file${nextNum}.js"); export const x = ${num};`,
                    { headers: { 'Content-Type': 'application/javascript' } },
                );
            }),
        );

        await writeFile(
            join(bundlesDir, 'start.js'),
            `import("./file1.js");`,
            'utf-8',
        );

        const result = await resolveMissingDynamicImports({
            bundlesDir,
            staticDir,
            baseUrl: 'https://test-max-iter.local',
            maxIterations: 3,
        });

        // Should stop after 3 iterations even though chain continues
        expect(result.iterations).toBeLessThanOrEqual(3);
    });

    it('handles 404 errors gracefully', async () => {
        server.use(
            http.get('https://test-404.local/missing.js', () => {
                return new HttpResponse(null, { status: 404 });
            }),
        );

        await writeFile(
            join(bundlesDir, 'main.js'),
            `import("./missing.js");`,
            'utf-8',
        );

        const result = await resolveMissingDynamicImports({
            bundlesDir,
            staticDir,
            baseUrl: 'https://test-404.local',
            maxIterations: 5,
        });

        expect(result.failedFiles).toBe(1);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain('404');
        expect(result.errors).toHaveLength(0); // Warnings, not errors
    });

    it('also fetches source map files', async () => {
        server.use(
            http.get('https://test-sourcemap.local/bundle.js', () => {
                return HttpResponse.text('export const x = 1;', {
                    headers: { 'Content-Type': 'application/javascript' },
                });
            }),
            http.get('https://test-sourcemap.local/bundle.js.map', () => {
                return HttpResponse.json(
                    {
                        version: 3,
                        sources: ['original.ts'],
                        mappings: 'AAAA',
                    },
                    { headers: { 'Content-Type': 'application/json' } },
                );
            }),
        );

        await writeFile(
            join(bundlesDir, 'main.js'),
            `import("./bundle.js");`,
            'utf-8',
        );

        const result = await resolveMissingDynamicImports({
            bundlesDir,
            staticDir,
            baseUrl: 'https://test-sourcemap.local',
            maxIterations: 5,
        });

        expect(result.fetchedFiles).toBe(1);

        // Verify source map was also fetched
        const mapContent = await readFile(
            join(bundlesDir, 'bundle.js.map'),
            'utf-8',
        );
        const map = JSON.parse(mapContent);
        expect(map.version).toBe(3);

        // Check that the resolved file indicates it has a source map
        const bundleFile = result.resolvedFiles.find(
            (f) => f.localPath === 'bundle.js',
        );
        expect(bundleFile?.hasSourceMap).toBe(true);
    });

    it('resolves CSS @import statements', async () => {
        // Create CSS files
        await mkdir(join(staticDir, 'styles'), { recursive: true });
        await writeFile(
            join(staticDir, 'styles', 'theme.css'),
            'body { color: red; }',
            'utf-8',
        );

        // Create main CSS file in bundles with @import
        await mkdir(join(bundlesDir, 'styles'), { recursive: true });
        await writeFile(
            join(bundlesDir, 'styles', 'main.css'),
            `@import url("./theme.css");`,
            'utf-8',
        );

        const result = await resolveMissingDynamicImports({
            bundlesDir,
            staticDir,
            baseUrl: 'https://test-css-import.local',
            maxIterations: 5,
        });

        expect(result.copiedFiles).toBe(1);

        // Verify CSS was copied
        const themeContent = await readFile(
            join(bundlesDir, 'styles', 'theme.css'),
            'utf-8',
        );
        expect(themeContent).toBe('body { color: red; }');
    });

    it('skips already existing files', async () => {
        // File already exists in bundlesDir
        await writeFile(
            join(bundlesDir, 'existing.js'),
            'export const existing = true;',
            'utf-8',
        );

        // Main file imports the existing file
        await writeFile(
            join(bundlesDir, 'main.js'),
            `import("./existing.js");`,
            'utf-8',
        );

        const result = await resolveMissingDynamicImports({
            bundlesDir,
            staticDir,
            baseUrl: 'https://test-skip.local',
            maxIterations: 5,
        });

        // Nothing should be fetched or copied
        expect(result.fetchedFiles).toBe(0);
        expect(result.copiedFiles).toBe(0);
    });

    it('prefers copying from staticDir over fetching', async () => {
        let fetchCalled = false;
        server.use(
            http.get('https://test-prefer-copy.local/chunk.js', () => {
                fetchCalled = true;
                return HttpResponse.text('export const remote = true;', {
                    headers: { 'Content-Type': 'application/javascript' },
                });
            }),
        );

        // File exists in staticDir
        await writeFile(
            join(staticDir, 'chunk.js'),
            'export const local = true;',
            'utf-8',
        );

        // Main file imports chunk
        await writeFile(
            join(bundlesDir, 'main.js'),
            `import("./chunk.js");`,
            'utf-8',
        );

        const result = await resolveMissingDynamicImports({
            bundlesDir,
            staticDir,
            baseUrl: 'https://test-prefer-copy.local',
            maxIterations: 5,
        });

        expect(result.copiedFiles).toBe(1);
        expect(result.fetchedFiles).toBe(0);
        expect(fetchCalled).toBe(false);

        // Verify local file was used
        const content = await readFile(join(bundlesDir, 'chunk.js'), 'utf-8');
        expect(content).toBe('export const local = true;');
    });

    it('handles empty bundlesDir', async () => {
        const result = await resolveMissingDynamicImports({
            bundlesDir,
            staticDir,
            baseUrl: 'https://test-empty.local',
            maxIterations: 5,
        });

        expect(result.fetchedFiles).toBe(0);
        expect(result.copiedFiles).toBe(0);
        expect(result.iterations).toBe(1);
    });

    it('handles files without any imports', async () => {
        await writeFile(
            join(bundlesDir, 'no-imports.js'),
            'export const x = 1;',
            'utf-8',
        );

        const result = await resolveMissingDynamicImports({
            bundlesDir,
            staticDir,
            baseUrl: 'https://test-no-imports.local',
            maxIterations: 5,
        });

        expect(result.fetchedFiles).toBe(0);
        expect(result.copiedFiles).toBe(0);
    });
});

describe('updateManifestWithResolvedFiles', () => {
    let testDir: string;
    let manifestPath: string;

    beforeEach(async () => {
        testDir = join(tmpdir(), `manifest-test-${Date.now()}`);
        await mkdir(testDir, { recursive: true });
        manifestPath = join(testDir, 'manifest.json');
    });

    afterEach(async () => {
        await rm(testDir, { recursive: true, force: true });
    });

    it('adds resolvedDynamicImports section to manifest', async () => {
        // Create initial manifest
        const initialManifest = {
            name: 'test-site',
            sourceUrl: 'https://example.com',
            static: {
                assetCount: 10,
            },
        };
        await writeFile(manifestPath, JSON.stringify(initialManifest), 'utf-8');

        // Update with resolved files
        await updateManifestWithResolvedFiles(manifestPath, [
            {
                url: 'https://example.com/chunk.js',
                localPath: 'chunk.js',
                contentType: 'application/javascript',
                size: 1000,
                source: 'fetched',
                hasSourceMap: true,
            },
        ]);

        // Read and verify
        const content = await readFile(manifestPath, 'utf-8');
        const manifest = JSON.parse(content);

        expect(manifest.resolvedDynamicImports).toBeDefined();
        expect(manifest.resolvedDynamicImports.count).toBe(1);
        expect(manifest.resolvedDynamicImports.files).toHaveLength(1);
        expect(manifest.resolvedDynamicImports.files[0].localPath).toBe(
            'chunk.js',
        );
        expect(manifest.static.assetCount).toBe(11); // 10 + 1
    });

    it('does nothing when no files to add', async () => {
        const initialManifest = { name: 'test' };
        await writeFile(manifestPath, JSON.stringify(initialManifest), 'utf-8');

        await updateManifestWithResolvedFiles(manifestPath, []);

        const content = await readFile(manifestPath, 'utf-8');
        const manifest = JSON.parse(content);
        expect(manifest.resolvedDynamicImports).toBeUndefined();
    });

    it('handles missing manifest file gracefully', async () => {
        // Should not throw
        await expect(
            updateManifestWithResolvedFiles(join(testDir, 'nonexistent.json'), [
                {
                    url: 'https://example.com/chunk.js',
                    localPath: 'chunk.js',
                    contentType: 'application/javascript',
                    size: 1000,
                    source: 'fetched',
                },
            ]),
        ).resolves.not.toThrow();
    });
});
