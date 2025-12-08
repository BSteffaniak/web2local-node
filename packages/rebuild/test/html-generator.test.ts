/**
 * Tests for html-generator.ts module
 *
 * Tests for:
 * - isServerRenderedHtml: Detecting server-rendered vs SPA shell HTML
 * - extractOriginalBundles: Extracting bundle paths from captured HTML
 * - buildAssetMapping: Mapping original to rebuilt asset paths
 * - preserveServerRenderedHtml: Transforming HTML with updated asset references
 * - preserveHtmlIfServerRendered: Orchestration of HTML preservation
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
    isServerRenderedHtml,
    extractOriginalBundles,
    buildAssetMapping,
    preserveServerRenderedHtml,
    preserveHtmlIfServerRendered,
    type AssetMapping,
} from '@web2local/rebuild';

// ============================================================================
// TEST HELPERS
// ============================================================================

/**
 * Creates a temporary directory for test fixtures with unique name for isolation
 */
async function createTempDir(): Promise<string> {
    const tempBase = join(tmpdir(), 'html-generator-test');
    const tempDir = join(
        tempBase,
        `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(tempDir, { recursive: true });
    return tempDir;
}

/**
 * Creates a file with content in the temp directory
 */
async function createFile(
    dir: string,
    relativePath: string,
    content: string,
): Promise<string> {
    const fullPath = join(dir, relativePath);
    await mkdir(join(fullPath, '..'), { recursive: true });
    await writeFile(fullPath, content, 'utf-8');
    return fullPath;
}

// ============================================================================
// isServerRenderedHtml Tests
// ============================================================================

describe('isServerRenderedHtml', () => {
    test('should return true for HTML with substantial body content', () => {
        const html = `
            <!DOCTYPE html>
            <html lang="en">
            <head><title>Test</title></head>
            <body>
                <header>
                    <nav>Navigation content</nav>
                </header>
                <main>
                    <h1>Welcome to the site</h1>
                    <p>This is actual content rendered by the server.</p>
                </main>
                <footer>Footer content</footer>
            </body>
            </html>
        `;

        expect(isServerRenderedHtml(html)).toBe(true);
    });

    test('should return false for SPA shell with just root div', () => {
        const html = `
            <!DOCTYPE html>
            <html lang="en">
            <head><title>SPA App</title></head>
            <body>
                <div id="root"></div>
                <script type="module" src="/assets/index.js"></script>
            </body>
            </html>
        `;

        expect(isServerRenderedHtml(html)).toBe(false);
    });

    test('should return false for SPA shell with app div', () => {
        const html = `
            <!DOCTYPE html>
            <html lang="en">
            <head><title>Vue App</title></head>
            <body>
                <div id="app"></div>
            </body>
            </html>
        `;

        expect(isServerRenderedHtml(html)).toBe(false);
    });

    test('should return false for Next.js shell', () => {
        const html = `
            <!DOCTYPE html>
            <html>
            <head><title>Next App</title></head>
            <body>
                <div id="__next"></div>
            </body>
            </html>
        `;

        expect(isServerRenderedHtml(html)).toBe(false);
    });

    test('should return false for Nuxt shell', () => {
        const html = `
            <!DOCTYPE html>
            <html>
            <head><title>Nuxt App</title></head>
            <body>
                <div id="__nuxt"></div>
            </body>
            </html>
        `;

        expect(isServerRenderedHtml(html)).toBe(false);
    });

    test('should return false for empty body', () => {
        const html = `
            <!DOCTYPE html>
            <html>
            <head><title>Empty</title></head>
            <body></body>
            </html>
        `;

        expect(isServerRenderedHtml(html)).toBe(false);
    });

    test('should ignore script tags when checking content', () => {
        const html = `
            <!DOCTYPE html>
            <html>
            <head><title>Scripts Only</title></head>
            <body>
                <div id="root"></div>
                <script src="/app.js"></script>
                <script>console.log("inline script");</script>
            </body>
            </html>
        `;

        expect(isServerRenderedHtml(html)).toBe(false);
    });

    test('should handle body with inline styles', () => {
        const html = `
            <!DOCTYPE html>
            <html style="height:100%">
            <head><title>Styled</title></head>
            <body style="margin:0">
                <header style="background:blue">
                    <h1>Real Content</h1>
                </header>
                <main>More content here</main>
            </body>
            </html>
        `;

        expect(isServerRenderedHtml(html)).toBe(true);
    });

    test('should return false when no body tag', () => {
        const html = `
            <!DOCTYPE html>
            <html>
            <head><title>No Body</title></head>
            </html>
        `;

        expect(isServerRenderedHtml(html)).toBe(false);
    });
});

// ============================================================================
// extractOriginalBundles Tests
// ============================================================================

describe('extractOriginalBundles', () => {
    test('should extract script src paths', () => {
        const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <script src="/js/vendor.js"></script>
                <script src="/js/app.js"></script>
            </head>
            <body></body>
            </html>
        `;

        const bundles = extractOriginalBundles(html);

        expect(bundles).toHaveLength(2);
        expect(bundles[0]).toEqual({
            originalPath: '/js/vendor.js',
            type: 'script',
        });
        expect(bundles[1]).toEqual({
            originalPath: '/js/app.js',
            type: 'script',
        });
    });

    test('should extract stylesheet href paths', () => {
        const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <link rel="stylesheet" href="/css/main.css">
                <link rel="stylesheet" href="/css/theme.css">
            </head>
            <body></body>
            </html>
        `;

        const bundles = extractOriginalBundles(html);

        expect(bundles).toHaveLength(2);
        expect(bundles[0]).toEqual({
            originalPath: '/css/main.css',
            type: 'stylesheet',
        });
        expect(bundles[1]).toEqual({
            originalPath: '/css/theme.css',
            type: 'stylesheet',
        });
    });

    test('should ignore external/CDN URLs', () => {
        const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <script src="https://cdn.example.com/lib.js"></script>
                <script src="/js/app.js"></script>
                <link rel="stylesheet" href="https://fonts.googleapis.com/css">
            </head>
            <body></body>
            </html>
        `;

        const bundles = extractOriginalBundles(html);

        expect(bundles).toHaveLength(1);
        expect(bundles[0].originalPath).toBe('/js/app.js');
    });

    test('should ignore protocol-relative URLs', () => {
        const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <script src="//cdn.example.com/lib.js"></script>
                <script src="/js/app.js"></script>
            </head>
            <body></body>
            </html>
        `;

        const bundles = extractOriginalBundles(html);

        expect(bundles).toHaveLength(1);
        expect(bundles[0].originalPath).toBe('/js/app.js');
    });

    test('should handle paths with query strings', () => {
        const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <script src="/js/app.js?v=123"></script>
                <link rel="stylesheet" href="/css/main.css?hash=abc">
            </head>
            <body></body>
            </html>
        `;

        const bundles = extractOriginalBundles(html);

        expect(bundles).toHaveLength(2);
        expect(bundles[0].originalPath).toBe('/js/app.js?v=123');
        expect(bundles[1].originalPath).toBe('/css/main.css?hash=abc');
    });

    test('should handle multiple bundles', () => {
        const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <link rel="stylesheet" href="/css/reset.css">
                <link rel="stylesheet" href="/css/main.css">
                <script src="/js/vendor.js"></script>
                <script src="/js/app.js"></script>
            </head>
            <body>
                <script src="/js/analytics.js"></script>
            </body>
            </html>
        `;

        const bundles = extractOriginalBundles(html);

        expect(bundles).toHaveLength(5);
        expect(bundles.filter((b) => b.type === 'script')).toHaveLength(3);
        expect(bundles.filter((b) => b.type === 'stylesheet')).toHaveLength(2);
    });

    test('should return empty array when no bundles found', () => {
        const html = `
            <!DOCTYPE html>
            <html>
            <head><title>No Bundles</title></head>
            <body><p>Just text</p></body>
            </html>
        `;

        const bundles = extractOriginalBundles(html);

        expect(bundles).toHaveLength(0);
    });

    test('should not extract non-stylesheet links', () => {
        const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <link rel="preload" href="/js/app.js" as="script">
                <link rel="icon" href="/favicon.ico">
                <link rel="stylesheet" href="/css/main.css">
            </head>
            <body></body>
            </html>
        `;

        const bundles = extractOriginalBundles(html);

        expect(bundles).toHaveLength(1);
        expect(bundles[0].type).toBe('stylesheet');
    });
});

// ============================================================================
// buildAssetMapping Tests
// ============================================================================

describe('buildAssetMapping', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await createTempDir();
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    test('should map JS bundles to rebuilt index-*.js', async () => {
        // Create rebuilt assets
        await createFile(tempDir, 'assets/index-abc123.js', 'rebuilt js');
        await createFile(tempDir, 'assets/index-abc123.js.map', 'sourcemap');

        const originalBundles = [
            { originalPath: '/js/vendor.js', type: 'script' as const },
            { originalPath: '/js/app.js', type: 'script' as const },
        ];

        const mapping = await buildAssetMapping(tempDir, originalBundles);

        expect(mapping.scripts.size).toBe(2);
        expect(mapping.scripts.get('/js/vendor.js')).toBe(
            '/assets/index-abc123.js',
        );
        expect(mapping.scripts.get('/js/app.js')).toBe(
            '/assets/index-abc123.js',
        );
    });

    test('should map CSS bundles to rebuilt index-*.css', async () => {
        await createFile(tempDir, 'assets/index-def456.js', 'rebuilt js');
        await createFile(tempDir, 'assets/index-def456.css', 'rebuilt css');

        const originalBundles = [
            { originalPath: '/js/app.js', type: 'script' as const },
            { originalPath: '/css/main.css', type: 'stylesheet' as const },
            { originalPath: '/css/theme.css', type: 'stylesheet' as const },
        ];

        const mapping = await buildAssetMapping(tempDir, originalBundles);

        expect(mapping.scripts.get('/js/app.js')).toBe(
            '/assets/index-def456.js',
        );
        expect(mapping.stylesheets.get('/css/main.css')).toBe(
            '/assets/index-def456.css',
        );
        expect(mapping.stylesheets.get('/css/theme.css')).toBe(
            '/assets/index-def456.css',
        );
    });

    test('should handle multiple original bundles mapping to single output', async () => {
        await createFile(tempDir, 'assets/index-xyz789.js', 'all in one');

        const originalBundles = [
            { originalPath: '/js/a.js', type: 'script' as const },
            { originalPath: '/js/b.js', type: 'script' as const },
            { originalPath: '/js/c.js', type: 'script' as const },
        ];

        const mapping = await buildAssetMapping(tempDir, originalBundles);

        expect(mapping.scripts.size).toBe(3);
        // All should map to the same rebuilt file
        const rebuiltPath = mapping.scripts.get('/js/a.js');
        expect(mapping.scripts.get('/js/b.js')).toBe(rebuiltPath);
        expect(mapping.scripts.get('/js/c.js')).toBe(rebuiltPath);
    });

    test('should return empty maps when no rebuilt assets exist', async () => {
        // No assets directory created
        const originalBundles = [
            { originalPath: '/js/app.js', type: 'script' as const },
        ];

        const mapping = await buildAssetMapping(tempDir, originalBundles);

        expect(mapping.scripts.size).toBe(0);
        expect(mapping.stylesheets.size).toBe(0);
    });

    test('should return empty maps when assets dir exists but no index files', async () => {
        await createFile(tempDir, 'assets/other-file.js', 'not an index');

        const originalBundles = [
            { originalPath: '/js/app.js', type: 'script' as const },
        ];

        const mapping = await buildAssetMapping(tempDir, originalBundles);

        expect(mapping.scripts.size).toBe(0);
    });
});

// ============================================================================
// preserveServerRenderedHtml Tests
// ============================================================================

describe('preserveServerRenderedHtml', () => {
    test('should replace script src with rebuilt path', () => {
        const html = `<!DOCTYPE html>
<html>
<head>
    <script src="/js/app.js"></script>
</head>
<body><p>Content</p></body>
</html>`;

        const mapping: AssetMapping = {
            scripts: new Map([['/js/app.js', '/assets/index-abc123.js']]),
            stylesheets: new Map(),
        };

        const result = preserveServerRenderedHtml(html, mapping);

        expect(result).toContain('src="/assets/index-abc123.js"');
        expect(result).not.toContain('src="/js/app.js"');
    });

    test('should add type="module" to rebuilt scripts', () => {
        const html = `<!DOCTYPE html>
<html>
<head>
    <script src="/js/app.js"></script>
</head>
<body></body>
</html>`;

        const mapping: AssetMapping = {
            scripts: new Map([['/js/app.js', '/assets/index-abc123.js']]),
            stylesheets: new Map(),
        };

        const result = preserveServerRenderedHtml(html, mapping);

        expect(result).toContain('type="module"');
    });

    test('should add crossorigin attribute', () => {
        const html = `<!DOCTYPE html>
<html>
<head>
    <script src="/js/app.js"></script>
</head>
<body></body>
</html>`;

        const mapping: AssetMapping = {
            scripts: new Map([['/js/app.js', '/assets/index-abc123.js']]),
            stylesheets: new Map(),
        };

        const result = preserveServerRenderedHtml(html, mapping);

        expect(result).toContain('crossorigin');
    });

    test('should preserve body content', () => {
        const html = `<!DOCTYPE html>
<html>
<head>
    <script src="/js/app.js"></script>
</head>
<body>
    <header>Header Content</header>
    <main>Main Content</main>
    <footer>Footer Content</footer>
</body>
</html>`;

        const mapping: AssetMapping = {
            scripts: new Map([['/js/app.js', '/assets/index-abc123.js']]),
            stylesheets: new Map(),
        };

        const result = preserveServerRenderedHtml(html, mapping);

        expect(result).toContain('<header>Header Content</header>');
        expect(result).toContain('<main>Main Content</main>');
        expect(result).toContain('<footer>Footer Content</footer>');
    });

    test('should preserve inline styles', () => {
        const html = `<!DOCTYPE html>
<html style="height:100%">
<head>
    <style>body { margin: 0; }</style>
    <script src="/js/app.js"></script>
</head>
<body style="background:blue">
    <p style="color:red">Text</p>
</body>
</html>`;

        const mapping: AssetMapping = {
            scripts: new Map([['/js/app.js', '/assets/index-abc123.js']]),
            stylesheets: new Map(),
        };

        const result = preserveServerRenderedHtml(html, mapping);

        expect(result).toContain('style="height:100%"');
        expect(result).toContain('style="background:blue"');
        expect(result).toContain('style="color:red"');
        expect(result).toContain('<style>body { margin: 0; }</style>');
    });

    test('should preserve head meta tags', () => {
        const html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="description" content="Test site">
    <title>Test</title>
    <script src="/js/app.js"></script>
</head>
<body></body>
</html>`;

        const mapping: AssetMapping = {
            scripts: new Map([['/js/app.js', '/assets/index-abc123.js']]),
            stylesheets: new Map(),
        };

        const result = preserveServerRenderedHtml(html, mapping);

        expect(result).toContain('<meta charset="UTF-8">');
        expect(result).toContain(
            '<meta name="description" content="Test site">',
        );
        expect(result).toContain('<title>Test</title>');
    });

    test('should handle multiple script tags', () => {
        const html = `<!DOCTYPE html>
<html>
<head>
    <script src="/js/vendor.js"></script>
    <script src="/js/app.js"></script>
</head>
<body>
    <script src="/js/analytics.js"></script>
</body>
</html>`;

        const mapping: AssetMapping = {
            scripts: new Map([
                ['/js/vendor.js', '/assets/index-abc123.js'],
                ['/js/app.js', '/assets/index-abc123.js'],
                ['/js/analytics.js', '/assets/index-abc123.js'],
            ]),
            stylesheets: new Map(),
        };

        const result = preserveServerRenderedHtml(html, mapping);

        // All three should be replaced
        expect(result).not.toContain('/js/vendor.js');
        expect(result).not.toContain('/js/app.js');
        expect(result).not.toContain('/js/analytics.js');
        // Should have three script tags with rebuilt path
        const matches = result.match(/src="\/assets\/index-abc123\.js"/g);
        expect(matches).toHaveLength(3);
    });

    test('should not modify external/CDN scripts', () => {
        const html = `<!DOCTYPE html>
<html>
<head>
    <script src="https://cdn.example.com/lib.js"></script>
    <script src="/js/app.js"></script>
</head>
<body></body>
</html>`;

        const mapping: AssetMapping = {
            scripts: new Map([['/js/app.js', '/assets/index-abc123.js']]),
            stylesheets: new Map(),
        };

        const result = preserveServerRenderedHtml(html, mapping);

        expect(result).toContain('src="https://cdn.example.com/lib.js"');
        expect(result).toContain('src="/assets/index-abc123.js"');
    });

    test('should handle scripts with existing attributes', () => {
        const html = `<!DOCTYPE html>
<html>
<head>
    <script async src="/js/app.js" data-main="true"></script>
</head>
<body></body>
</html>`;

        const mapping: AssetMapping = {
            scripts: new Map([['/js/app.js', '/assets/index-abc123.js']]),
            stylesheets: new Map(),
        };

        const result = preserveServerRenderedHtml(html, mapping);

        expect(result).toContain('src="/assets/index-abc123.js"');
        expect(result).toContain('type="module"');
    });

    test('should remove defer attribute', () => {
        const html = `<!DOCTYPE html>
<html>
<head>
    <script defer src="/js/app.js"></script>
</head>
<body></body>
</html>`;

        const mapping: AssetMapping = {
            scripts: new Map([['/js/app.js', '/assets/index-abc123.js']]),
            stylesheets: new Map(),
        };

        const result = preserveServerRenderedHtml(html, mapping);

        expect(result).not.toMatch(/\bdefer\b/);
        expect(result).toContain('type="module"');
    });

    test('should replace stylesheet hrefs with rebuilt paths', () => {
        const html = `<!DOCTYPE html>
<html>
<head>
    <link rel="stylesheet" href="/css/main.css">
</head>
<body></body>
</html>`;

        const mapping: AssetMapping = {
            scripts: new Map(),
            stylesheets: new Map([
                ['/css/main.css', '/assets/index-abc123.css'],
            ]),
        };

        const result = preserveServerRenderedHtml(html, mapping);

        expect(result).toContain('href="/assets/index-abc123.css"');
        expect(result).not.toContain('href="/css/main.css"');
    });

    test('should preserve original script position in DOM', () => {
        const html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <script src="/js/app.js"></script>
    <title>Test</title>
</head>
<body></body>
</html>`;

        const mapping: AssetMapping = {
            scripts: new Map([['/js/app.js', '/assets/index-abc123.js']]),
            stylesheets: new Map(),
        };

        const result = preserveServerRenderedHtml(html, mapping);

        // Script should still be between meta and title
        const metaIndex = result.indexOf('<meta charset="UTF-8">');
        const scriptIndex = result.indexOf('src="/assets/index-abc123.js"');
        const titleIndex = result.indexOf('<title>Test</title>');

        expect(metaIndex).toBeLessThan(scriptIndex);
        expect(scriptIndex).toBeLessThan(titleIndex);
    });
});

// ============================================================================
// preserveHtmlIfServerRendered Tests (Integration)
// ============================================================================

describe('preserveHtmlIfServerRendered', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await createTempDir();
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    test('should preserve server-rendered HTML after build', async () => {
        // Setup: captured server-rendered HTML
        const capturedHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <title>Test Site</title>
    <script src="/js/app.js"></script>
</head>
<body>
    <header>Real Header</header>
    <main>Real Content</main>
</body>
</html>`;

        await createFile(
            tempDir,
            'project/_server/static/index.html',
            capturedHtml,
        );

        // Setup: rebuilt assets
        await createFile(
            tempDir,
            'project/_rebuilt/assets/index-xyz789.js',
            'rebuilt',
        );

        // Also create the Vite-generated HTML (would be overwritten)
        await createFile(
            tempDir,
            'project/_rebuilt/index.html',
            '<div id="root"></div>',
        );

        const projectDir = join(tempDir, 'project');
        const outputDir = join(projectDir, '_rebuilt');

        const result = await preserveHtmlIfServerRendered(
            projectDir,
            outputDir,
        );

        expect(result).toBe(true);

        // Verify the HTML was preserved
        const outputHtml = await readFile(
            join(outputDir, 'index.html'),
            'utf-8',
        );
        expect(outputHtml).toContain('<header>Real Header</header>');
        expect(outputHtml).toContain('<main>Real Content</main>');
        expect(outputHtml).toContain('/assets/index-xyz789.js');
    });

    test('should keep Vite HTML for SPA shells', async () => {
        // Setup: captured SPA shell HTML
        const capturedHtml = `<!DOCTYPE html>
<html>
<head><title>SPA</title></head>
<body>
    <div id="root"></div>
    <script src="/js/app.js"></script>
</body>
</html>`;

        await createFile(
            tempDir,
            'project/_server/static/index.html',
            capturedHtml,
        );

        // Setup: Vite's generated HTML
        const viteHtml = `<!DOCTYPE html>
<html>
<head><title>Vite SPA</title></head>
<body>
    <div id="root"></div>
    <script type="module" src="/assets/index-abc.js"></script>
</body>
</html>`;

        await createFile(tempDir, 'project/_rebuilt/index.html', viteHtml);
        await createFile(
            tempDir,
            'project/_rebuilt/assets/index-abc.js',
            'rebuilt',
        );

        const projectDir = join(tempDir, 'project');
        const outputDir = join(projectDir, '_rebuilt');

        const result = await preserveHtmlIfServerRendered(
            projectDir,
            outputDir,
        );

        expect(result).toBe(false);

        // Vite's HTML should be unchanged
        const outputHtml = await readFile(
            join(outputDir, 'index.html'),
            'utf-8',
        );
        expect(outputHtml).toContain('<title>Vite SPA</title>');
    });

    test('should handle missing captured HTML gracefully', async () => {
        // No captured HTML exists
        await mkdir(join(tempDir, 'project/_rebuilt/assets'), {
            recursive: true,
        });

        const projectDir = join(tempDir, 'project');
        const outputDir = join(projectDir, '_rebuilt');

        const result = await preserveHtmlIfServerRendered(
            projectDir,
            outputDir,
        );

        expect(result).toBe(false);
    });

    test('should handle missing rebuilt assets gracefully', async () => {
        const capturedHtml = `<!DOCTYPE html>
<html>
<head><script src="/js/app.js"></script></head>
<body><main>Content</main></body>
</html>`;

        await createFile(
            tempDir,
            'project/_server/static/index.html',
            capturedHtml,
        );

        // No rebuilt assets directory
        await mkdir(join(tempDir, 'project/_rebuilt'), { recursive: true });

        const projectDir = join(tempDir, 'project');
        const outputDir = join(projectDir, '_rebuilt');

        const result = await preserveHtmlIfServerRendered(
            projectDir,
            outputDir,
        );

        expect(result).toBe(false);
    });
});
