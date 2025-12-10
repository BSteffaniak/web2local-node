/**
 * Tests for reconstructor.ts module
 *
 * Tests for:
 * - generateBundleStubs: Creating stub entry points for bundles without source maps
 * - saveBundles: Saving minified bundles to disk
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm, readFile, stat } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
    generateBundleStubs,
    saveBundles,
    type SavedBundle,
} from '@web2local/scraper';

// ============================================================================
// TEST HELPERS
// ============================================================================

/**
 * Creates a temporary directory for test fixtures with unique name for isolation
 */
async function createTempDir(): Promise<string> {
    const tempBase = join(tmpdir(), 'reconstructor-test');
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

/**
 * Checks if a file exists
 */
async function fileExists(filePath: string): Promise<boolean> {
    try {
        await stat(filePath);
        return true;
    } catch {
        return false;
    }
}

// ============================================================================
// generateBundleStubs Tests
// ============================================================================

describe('generateBundleStubs', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await createTempDir();
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    // ========================================================================
    // Basic stub generation
    // ========================================================================

    describe('basic stub generation', () => {
        test('should generate src/index.ts with bundle imports', async () => {
            const savedBundles: SavedBundle[] = [
                {
                    url: 'https://example.com/app.js',
                    localPath: join(
                        tempDir,
                        'example.com',
                        '_bundles',
                        'app.js',
                    ),
                    type: 'script',
                    size: 1000,
                },
            ];

            // Create the bundle file so paths are valid
            await createFile(
                tempDir,
                'example.com/_bundles/app.js',
                'var x=1;',
            );

            const result = await generateBundleStubs({
                outputDir: join(tempDir, 'example.com'),
                savedBundles,
                extractedBundles: [],
            });

            expect(result.stubsGenerated).toBe(1);
            expect(result.entryPointPath).toBe(
                join(tempDir, 'example.com', 'src', 'index.ts'),
            );

            const content = await readFile(result.entryPointPath, 'utf-8');
            expect(content).toContain("import '../_bundles/app.js';");
        });

        test('should generate JavaScript bundle imports', async () => {
            const savedBundles: SavedBundle[] = [
                {
                    url: 'https://example.com/vendor.js',
                    localPath: join(
                        tempDir,
                        'example.com',
                        '_bundles',
                        'js',
                        'vendor.js',
                    ),
                    type: 'script',
                    size: 500,
                },
                {
                    url: 'https://example.com/app.js',
                    localPath: join(
                        tempDir,
                        'example.com',
                        '_bundles',
                        'js',
                        'app.js',
                    ),
                    type: 'script',
                    size: 1000,
                },
            ];

            await createFile(
                tempDir,
                'example.com/_bundles/js/vendor.js',
                'var v=1;',
            );
            await createFile(
                tempDir,
                'example.com/_bundles/js/app.js',
                'var a=1;',
            );

            const result = await generateBundleStubs({
                outputDir: join(tempDir, 'example.com'),
                savedBundles,
                extractedBundles: [],
            });

            const content = await readFile(result.entryPointPath, 'utf-8');
            expect(content).toContain('// JavaScript bundles');
            expect(content).toContain("import '../_bundles/js/vendor.js';");
            expect(content).toContain("import '../_bundles/js/app.js';");
        });

        test('should generate CSS bundle imports', async () => {
            const savedBundles: SavedBundle[] = [
                {
                    url: 'https://example.com/styles.css',
                    localPath: join(
                        tempDir,
                        'example.com',
                        '_bundles',
                        'css',
                        'styles.css',
                    ),
                    type: 'stylesheet',
                    size: 200,
                },
            ];

            await createFile(
                tempDir,
                'example.com/_bundles/css/styles.css',
                '.btn{color:red}',
            );

            const result = await generateBundleStubs({
                outputDir: join(tempDir, 'example.com'),
                savedBundles,
                extractedBundles: [],
            });

            const content = await readFile(result.entryPointPath, 'utf-8');
            expect(content).toContain('// CSS bundles');
            expect(content).toContain("import '../_bundles/css/styles.css';");
        });

        test('should include header comment explaining fallback nature', async () => {
            const savedBundles: SavedBundle[] = [
                {
                    url: 'https://example.com/app.js',
                    localPath: join(
                        tempDir,
                        'example.com',
                        '_bundles',
                        'app.js',
                    ),
                    type: 'script',
                    size: 100,
                },
            ];

            await createFile(
                tempDir,
                'example.com/_bundles/app.js',
                'var x=1;',
            );

            const result = await generateBundleStubs({
                outputDir: join(tempDir, 'example.com'),
                savedBundles,
                extractedBundles: [],
            });

            const content = await readFile(result.entryPointPath, 'utf-8');
            expect(content).toContain('Auto-generated entry point');
            expect(content).toContain('source maps were not available');
        });

        test('should separate JS and CSS bundles in output', async () => {
            const savedBundles: SavedBundle[] = [
                {
                    url: 'https://example.com/app.js',
                    localPath: join(
                        tempDir,
                        'example.com',
                        '_bundles',
                        'app.js',
                    ),
                    type: 'script',
                    size: 100,
                },
                {
                    url: 'https://example.com/styles.css',
                    localPath: join(
                        tempDir,
                        'example.com',
                        '_bundles',
                        'styles.css',
                    ),
                    type: 'stylesheet',
                    size: 50,
                },
            ];

            await createFile(
                tempDir,
                'example.com/_bundles/app.js',
                'var x=1;',
            );
            await createFile(
                tempDir,
                'example.com/_bundles/styles.css',
                '.x{}',
            );

            const result = await generateBundleStubs({
                outputDir: join(tempDir, 'example.com'),
                savedBundles,
                extractedBundles: [],
            });

            const content = await readFile(result.entryPointPath, 'utf-8');
            const jsIndex = content.indexOf('// JavaScript bundles');
            const cssIndex = content.indexOf('// CSS bundles');

            expect(jsIndex).toBeLessThan(cssIndex);
        });
    });

    // ========================================================================
    // Extracted bundle re-exports
    // ========================================================================

    describe('extracted bundle re-exports', () => {
        test('should re-export extracted bundle entry points', async () => {
            // Create an extracted bundle with an entry point
            await createFile(
                tempDir,
                'example.com/navigation/src/index.ts',
                `
                export const Navigation = () => {};
            `,
            );

            const result = await generateBundleStubs({
                outputDir: join(tempDir, 'example.com'),
                savedBundles: [],
                extractedBundles: [{ bundleName: 'navigation' }],
            });

            const content = await readFile(result.entryPointPath, 'utf-8');
            expect(content).toContain(
                '// === Extracted source entry points ===',
            );
            expect(content).toContain(
                "export * from '../navigation/src/index';",
            );
        });

        test('should detect entry points in extracted bundles', async () => {
            // Create bundle with main.ts instead of index.ts
            await createFile(
                tempDir,
                'example.com/app/src/main.ts',
                'export const main = 1;',
            );

            const result = await generateBundleStubs({
                outputDir: join(tempDir, 'example.com'),
                savedBundles: [],
                extractedBundles: [{ bundleName: 'app' }],
            });

            const content = await readFile(result.entryPointPath, 'utf-8');
            expect(content).toContain("export * from '../app/src/main';");
        });

        test('should handle extracted bundle with index.tsx', async () => {
            await createFile(
                tempDir,
                'example.com/ui/src/index.tsx',
                'export const UI = () => <div/>;',
            );

            const result = await generateBundleStubs({
                outputDir: join(tempDir, 'example.com'),
                savedBundles: [],
                extractedBundles: [{ bundleName: 'ui' }],
            });

            const content = await readFile(result.entryPointPath, 'utf-8');
            // Extension should be stripped
            expect(content).toContain("export * from '../ui/src/index';");
            expect(content).not.toContain('.tsx');
        });

        test('should handle extracted bundle with index.jsx', async () => {
            await createFile(
                tempDir,
                'example.com/components/index.jsx',
                'export const Button = () => null;',
            );

            const result = await generateBundleStubs({
                outputDir: join(tempDir, 'example.com'),
                savedBundles: [],
                extractedBundles: [{ bundleName: 'components' }],
            });

            const content = await readFile(result.entryPointPath, 'utf-8');
            expect(content).toContain("export * from '../components/index';");
            expect(content).not.toContain('.jsx');
        });

        test('should skip extracted bundles without entry points', async () => {
            // Create a bundle directory without any entry file
            await mkdir(join(tempDir, 'example.com', 'empty-bundle', 'src'), {
                recursive: true,
            });

            const result = await generateBundleStubs({
                outputDir: join(tempDir, 'example.com'),
                savedBundles: [],
                extractedBundles: [{ bundleName: 'empty-bundle' }],
            });

            // Should return with no stubs generated (no entry points found)
            expect(result.stubsGenerated).toBe(0);
            expect(result.errors).toHaveLength(0);
        });

        test('should use provided entryPoint if specified', async () => {
            await createFile(
                tempDir,
                'example.com/custom/custom-entry.ts',
                'export const custom = 1;',
            );

            const result = await generateBundleStubs({
                outputDir: join(tempDir, 'example.com'),
                savedBundles: [],
                extractedBundles: [
                    { bundleName: 'custom', entryPoint: 'custom-entry.ts' },
                ],
            });

            const content = await readFile(result.entryPointPath, 'utf-8');
            expect(content).toContain(
                "export * from '../custom/custom-entry';",
            );
        });
    });

    // ========================================================================
    // Hybrid case (both saved and extracted)
    // ========================================================================

    describe('hybrid case (both saved and extracted)', () => {
        test('should include both imports and re-exports', async () => {
            await createFile(
                tempDir,
                'example.com/_bundles/vendor.js',
                'var v=1;',
            );
            await createFile(
                tempDir,
                'example.com/app/src/index.ts',
                'export const App = 1;',
            );

            const savedBundles: SavedBundle[] = [
                {
                    url: 'https://example.com/vendor.js',
                    localPath: join(
                        tempDir,
                        'example.com',
                        '_bundles',
                        'vendor.js',
                    ),
                    type: 'script',
                    size: 100,
                },
            ];

            const result = await generateBundleStubs({
                outputDir: join(tempDir, 'example.com'),
                savedBundles,
                extractedBundles: [{ bundleName: 'app' }],
            });

            const content = await readFile(result.entryPointPath, 'utf-8');
            expect(content).toContain("export * from '../app/src/index';");
            expect(content).toContain("import '../_bundles/vendor.js';");
        });

        test('should put re-exports before imports', async () => {
            await createFile(
                tempDir,
                'example.com/_bundles/app.js',
                'var a=1;',
            );
            await createFile(
                tempDir,
                'example.com/lib/src/index.ts',
                'export const lib = 1;',
            );

            const savedBundles: SavedBundle[] = [
                {
                    url: 'https://example.com/app.js',
                    localPath: join(
                        tempDir,
                        'example.com',
                        '_bundles',
                        'app.js',
                    ),
                    type: 'script',
                    size: 100,
                },
            ];

            const result = await generateBundleStubs({
                outputDir: join(tempDir, 'example.com'),
                savedBundles,
                extractedBundles: [{ bundleName: 'lib' }],
            });

            const content = await readFile(result.entryPointPath, 'utf-8');
            const exportIndex = content.indexOf('export *');
            const importIndex = content.indexOf("import '../_bundles");

            expect(exportIndex).toBeLessThan(importIndex);
        });
    });

    // ========================================================================
    // Return values
    // ========================================================================

    describe('return values', () => {
        test('should return stubsGenerated count', async () => {
            await createFile(
                tempDir,
                'example.com/_bundles/app.js',
                'var x=1;',
            );

            const result = await generateBundleStubs({
                outputDir: join(tempDir, 'example.com'),
                savedBundles: [
                    {
                        url: 'https://example.com/app.js',
                        localPath: join(
                            tempDir,
                            'example.com',
                            '_bundles',
                            'app.js',
                        ),
                        type: 'script',
                        size: 100,
                    },
                ],
                extractedBundles: [],
            });

            expect(result.stubsGenerated).toBe(1);
        });

        test('should return entryPointPath', async () => {
            await createFile(
                tempDir,
                'example.com/_bundles/app.js',
                'var x=1;',
            );

            const result = await generateBundleStubs({
                outputDir: join(tempDir, 'example.com'),
                savedBundles: [
                    {
                        url: 'https://example.com/app.js',
                        localPath: join(
                            tempDir,
                            'example.com',
                            '_bundles',
                            'app.js',
                        ),
                        type: 'script',
                        size: 100,
                    },
                ],
                extractedBundles: [],
            });

            expect(result.entryPointPath).toBe(
                join(tempDir, 'example.com', 'src', 'index.ts'),
            );
        });

        test('should handle empty savedBundles and extractedBundles', async () => {
            const result = await generateBundleStubs({
                outputDir: join(tempDir, 'example.com'),
                savedBundles: [],
                extractedBundles: [],
            });

            expect(result.stubsGenerated).toBe(0);
            expect(result.entryPointPath).toBe('');
            expect(result.errors).toHaveLength(0);
        });

        test('should return empty errors array on success', async () => {
            await createFile(
                tempDir,
                'example.com/_bundles/app.js',
                'var x=1;',
            );

            const result = await generateBundleStubs({
                outputDir: join(tempDir, 'example.com'),
                savedBundles: [
                    {
                        url: 'https://example.com/app.js',
                        localPath: join(
                            tempDir,
                            'example.com',
                            '_bundles',
                            'app.js',
                        ),
                        type: 'script',
                        size: 100,
                    },
                ],
                extractedBundles: [],
            });

            expect(result.errors).toEqual([]);
        });
    });

    // ========================================================================
    // Path handling
    // ========================================================================

    describe('path handling', () => {
        test('should generate relative paths correctly from src/ to _bundles/', async () => {
            await createFile(
                tempDir,
                'example.com/_bundles/deep/nested/bundle.js',
                'var x=1;',
            );

            const result = await generateBundleStubs({
                outputDir: join(tempDir, 'example.com'),
                savedBundles: [
                    {
                        url: 'https://example.com/deep/nested/bundle.js',
                        localPath: join(
                            tempDir,
                            'example.com',
                            '_bundles',
                            'deep',
                            'nested',
                            'bundle.js',
                        ),
                        type: 'script',
                        size: 100,
                    },
                ],
                extractedBundles: [],
            });

            const content = await readFile(result.entryPointPath, 'utf-8');
            expect(content).toContain(
                "import '../_bundles/deep/nested/bundle.js';",
            );
        });

        test('should use forward slashes in imports', async () => {
            await createFile(
                tempDir,
                'example.com/_bundles/app.js',
                'var x=1;',
            );

            const result = await generateBundleStubs({
                outputDir: join(tempDir, 'example.com'),
                savedBundles: [
                    {
                        url: 'https://example.com/app.js',
                        localPath: join(
                            tempDir,
                            'example.com',
                            '_bundles',
                            'app.js',
                        ),
                        type: 'script',
                        size: 100,
                    },
                ],
                extractedBundles: [],
            });

            const content = await readFile(result.entryPointPath, 'utf-8');
            // Should use forward slashes in imports regardless of OS
            expect(content).not.toContain('\\');
        });

        test('should strip TypeScript extensions from re-exports', async () => {
            await createFile(
                tempDir,
                'example.com/lib/src/index.ts',
                'export const x = 1;',
            );

            const result = await generateBundleStubs({
                outputDir: join(tempDir, 'example.com'),
                savedBundles: [],
                extractedBundles: [{ bundleName: 'lib' }],
            });

            const content = await readFile(result.entryPointPath, 'utf-8');
            expect(content).toContain("export * from '../lib/src/index';");
            expect(content).not.toContain('.ts');
        });
    });

    // ========================================================================
    // Edge cases
    // ========================================================================

    describe('edge cases', () => {
        test('should create src directory if it does not exist', async () => {
            await createFile(
                tempDir,
                'example.com/_bundles/app.js',
                'var x=1;',
            );

            const srcDir = join(tempDir, 'example.com', 'src');
            expect(await fileExists(srcDir)).toBe(false);

            await generateBundleStubs({
                outputDir: join(tempDir, 'example.com'),
                savedBundles: [
                    {
                        url: 'https://example.com/app.js',
                        localPath: join(
                            tempDir,
                            'example.com',
                            '_bundles',
                            'app.js',
                        ),
                        type: 'script',
                        size: 100,
                    },
                ],
                extractedBundles: [],
            });

            expect(await fileExists(srcDir)).toBe(true);
        });

        test('should handle hostname with special characters in outputDir', async () => {
            await createFile(
                tempDir,
                'my-site.example.com/_bundles/app.js',
                'var x=1;',
            );

            const result = await generateBundleStubs({
                outputDir: join(tempDir, 'my-site.example.com'),
                savedBundles: [
                    {
                        url: 'https://my-site.example.com/app.js',
                        localPath: join(
                            tempDir,
                            'my-site.example.com',
                            '_bundles',
                            'app.js',
                        ),
                        type: 'script',
                        size: 100,
                    },
                ],
                extractedBundles: [],
            });

            expect(result.stubsGenerated).toBe(1);
            expect(result.entryPointPath).toContain('my-site.example.com');
        });

        test('should handle many bundles', async () => {
            const savedBundles: SavedBundle[] = [];
            for (let i = 0; i < 10; i++) {
                await createFile(
                    tempDir,
                    `example.com/_bundles/bundle${i}.js`,
                    `var x${i}=1;`,
                );
                savedBundles.push({
                    url: `https://example.com/bundle${i}.js`,
                    localPath: join(
                        tempDir,
                        'example.com',
                        '_bundles',
                        `bundle${i}.js`,
                    ),
                    type: 'script',
                    size: 100,
                });
            }

            const result = await generateBundleStubs({
                outputDir: join(tempDir, 'example.com'),
                savedBundles,
                extractedBundles: [],
            });

            const content = await readFile(result.entryPointPath, 'utf-8');
            for (let i = 0; i < 10; i++) {
                expect(content).toContain(`bundle${i}.js`);
            }
        });
    });
});

// ============================================================================
// saveBundles Tests
// ============================================================================

describe('saveBundles', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await createTempDir();
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    // ========================================================================
    // Basic functionality
    // ========================================================================

    describe('basic functionality', () => {
        test('should save bundle content to _bundles directory', async () => {
            const bundlesWithoutMaps = [
                {
                    bundle: {
                        url: 'https://example.com/app.js',
                        type: 'script' as const,
                    },
                    content: 'var app = 1;',
                },
            ];

            const result = await saveBundles(bundlesWithoutMaps, {
                outputDir: join(tempDir, 'example.com'),
            });

            expect(result.saved).toHaveLength(1);
            expect(result.errors).toHaveLength(0);

            const savedPath = result.saved[0].localPath;
            const content = await readFile(savedPath, 'utf-8');
            expect(content).toBe('var app = 1;');
        });

        test('should preserve path structure from URL', async () => {
            const bundlesWithoutMaps = [
                {
                    bundle: {
                        url: 'https://example.com/js/bundles/app.min.js',
                        type: 'script' as const,
                    },
                    content: 'var app = 1;',
                },
            ];

            const result = await saveBundles(bundlesWithoutMaps, {
                outputDir: join(tempDir, 'example.com'),
            });

            expect(result.saved[0].localPath).toContain('js');
            expect(result.saved[0].localPath).toContain('bundles');
            expect(result.saved[0].localPath).toContain('app.min.js');
        });

        test('should save to _bundles subdirectory', async () => {
            const bundlesWithoutMaps = [
                {
                    bundle: {
                        url: 'https://example.com/app.js',
                        type: 'script' as const,
                    },
                    content: 'var x=1;',
                },
            ];

            const result = await saveBundles(bundlesWithoutMaps, {
                outputDir: join(tempDir, 'example.com'),
            });

            expect(result.saved[0].localPath).toContain('_bundles');
        });
    });

    // ========================================================================
    // Return values
    // ========================================================================

    describe('return values', () => {
        test('should return size of saved bundle', async () => {
            const content = 'var test = "hello world";';
            const bundlesWithoutMaps = [
                {
                    bundle: {
                        url: 'https://example.com/test.js',
                        type: 'script' as const,
                    },
                    content,
                },
            ];

            const result = await saveBundles(bundlesWithoutMaps, {
                outputDir: join(tempDir, 'example.com'),
            });

            expect(result.saved[0].size).toBe(content.length);
        });

        test('should return bundle type', async () => {
            const bundlesWithoutMaps = [
                {
                    bundle: {
                        url: 'https://example.com/app.js',
                        type: 'script' as const,
                    },
                    content: 'var x=1;',
                },
                {
                    bundle: {
                        url: 'https://example.com/styles.css',
                        type: 'stylesheet' as const,
                    },
                    content: '.x{color:red}',
                },
            ];

            const result = await saveBundles(bundlesWithoutMaps, {
                outputDir: join(tempDir, 'example.com'),
            });

            expect(result.saved.find((b) => b.url.endsWith('.js'))?.type).toBe(
                'script',
            );
            expect(result.saved.find((b) => b.url.endsWith('.css'))?.type).toBe(
                'stylesheet',
            );
        });

        test('should return URL in saved bundle info', async () => {
            const bundlesWithoutMaps = [
                {
                    bundle: {
                        url: 'https://example.com/app.js',
                        type: 'script' as const,
                    },
                    content: 'var x=1;',
                },
            ];

            const result = await saveBundles(bundlesWithoutMaps, {
                outputDir: join(tempDir, 'example.com'),
            });

            expect(result.saved[0].url).toBe('https://example.com/app.js');
        });

        test('should return localPath in saved bundle info', async () => {
            const bundlesWithoutMaps = [
                {
                    bundle: {
                        url: 'https://example.com/app.js',
                        type: 'script' as const,
                    },
                    content: 'var x=1;',
                },
            ];

            const result = await saveBundles(bundlesWithoutMaps, {
                outputDir: join(tempDir, 'example.com'),
            });

            expect(result.saved[0].localPath).toContain(tempDir);
            expect(result.saved[0].localPath).toContain('app.js');
        });
    });

    // ========================================================================
    // Caching behavior
    // ========================================================================

    describe('caching behavior', () => {
        test('should skip saving if file exists with same content', async () => {
            const content = 'var unchanged = 1;';

            // Pre-create the file
            await createFile(
                tempDir,
                'example.com/_bundles/existing.js',
                content,
            );

            const bundlesWithoutMaps = [
                {
                    bundle: {
                        url: 'https://example.com/existing.js',
                        type: 'script' as const,
                    },
                    content,
                },
            ];

            const result = await saveBundles(bundlesWithoutMaps, {
                outputDir: join(tempDir, 'example.com'),
            });

            // Should still be in saved array but didn't actually write
            expect(result.saved).toHaveLength(1);
            expect(result.errors).toHaveLength(0);
        });

        test('should overwrite if file exists with different content', async () => {
            const oldContent = 'var old = 1;';
            const newContent = 'var new = 2;';

            // Pre-create the file with old content
            await createFile(
                tempDir,
                'example.com/_bundles/changing.js',
                oldContent,
            );

            const bundlesWithoutMaps = [
                {
                    bundle: {
                        url: 'https://example.com/changing.js',
                        type: 'script' as const,
                    },
                    content: newContent,
                },
            ];

            const result = await saveBundles(bundlesWithoutMaps, {
                outputDir: join(tempDir, 'example.com'),
            });

            const savedContent = await readFile(
                result.saved[0].localPath,
                'utf-8',
            );
            expect(savedContent).toBe(newContent);
        });
    });

    // ========================================================================
    // Multiple bundles
    // ========================================================================

    describe('multiple bundles', () => {
        test('should handle multiple bundles', async () => {
            const bundlesWithoutMaps = [
                {
                    bundle: {
                        url: 'https://example.com/a.js',
                        type: 'script' as const,
                    },
                    content: 'var a=1;',
                },
                {
                    bundle: {
                        url: 'https://example.com/b.js',
                        type: 'script' as const,
                    },
                    content: 'var b=2;',
                },
                {
                    bundle: {
                        url: 'https://example.com/c.css',
                        type: 'stylesheet' as const,
                    },
                    content: '.c{}',
                },
            ];

            const result = await saveBundles(bundlesWithoutMaps, {
                outputDir: join(tempDir, 'example.com'),
            });

            expect(result.saved).toHaveLength(3);
            expect(result.errors).toHaveLength(0);
        });

        test('should handle mix of JS and CSS bundles', async () => {
            const bundlesWithoutMaps = [
                {
                    bundle: {
                        url: 'https://example.com/app.js',
                        type: 'script' as const,
                    },
                    content: 'var x=1;',
                },
                {
                    bundle: {
                        url: 'https://example.com/styles.css',
                        type: 'stylesheet' as const,
                    },
                    content: '.btn{color:red}',
                },
            ];

            const result = await saveBundles(bundlesWithoutMaps, {
                outputDir: join(tempDir, 'example.com'),
            });

            expect(result.saved).toHaveLength(2);

            // Verify both files exist
            for (const saved of result.saved) {
                expect(await fileExists(saved.localPath)).toBe(true);
            }
        });
    });

    // ========================================================================
    // Edge cases
    // ========================================================================

    describe('edge cases', () => {
        test('should handle empty bundles array', async () => {
            const result = await saveBundles([], {
                outputDir: tempDir,
            });

            expect(result.saved).toHaveLength(0);
            expect(result.errors).toHaveLength(0);
        });

        test('should handle bundle with empty content', async () => {
            const bundlesWithoutMaps = [
                {
                    bundle: {
                        url: 'https://example.com/empty.js',
                        type: 'script' as const,
                    },
                    content: '',
                },
            ];

            const result = await saveBundles(bundlesWithoutMaps, {
                outputDir: join(tempDir, 'example.com'),
            });

            expect(result.saved).toHaveLength(1);
            expect(result.saved[0].size).toBe(0);
        });

        test('should handle bundle with query string in URL', async () => {
            const bundlesWithoutMaps = [
                {
                    bundle: {
                        url: 'https://example.com/app.js?v=123&t=456',
                        type: 'script' as const,
                    },
                    content: 'var x=1;',
                },
            ];

            const result = await saveBundles(bundlesWithoutMaps, {
                outputDir: join(tempDir, 'example.com'),
            });

            expect(result.saved).toHaveLength(1);
            // Query string handling depends on implementation
        });

        test('should handle deeply nested URL path', async () => {
            const bundlesWithoutMaps = [
                {
                    bundle: {
                        url: 'https://example.com/assets/js/vendor/lib/bundle.min.js',
                        type: 'script' as const,
                    },
                    content: 'var x=1;',
                },
            ];

            const result = await saveBundles(bundlesWithoutMaps, {
                outputDir: join(tempDir, 'example.com'),
            });

            expect(result.saved).toHaveLength(1);
            expect(result.saved[0].localPath).toContain('assets');
            expect(result.saved[0].localPath).toContain('vendor');
        });

        test('should handle large bundle content', async () => {
            const largeContent = 'var x=1;'.repeat(10000);
            const bundlesWithoutMaps = [
                {
                    bundle: {
                        url: 'https://example.com/large.js',
                        type: 'script' as const,
                    },
                    content: largeContent,
                },
            ];

            const result = await saveBundles(bundlesWithoutMaps, {
                outputDir: join(tempDir, 'example.com'),
            });

            expect(result.saved).toHaveLength(1);
            expect(result.saved[0].size).toBe(largeContent.length);

            const savedContent = await readFile(
                result.saved[0].localPath,
                'utf-8',
            );
            expect(savedContent).toBe(largeContent);
        });
    });
});
