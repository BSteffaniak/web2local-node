/**
 * Tests for entry-point-detector.ts module
 *
 * Tests for:
 * - detectEntryPoints: Finding entry points in reconstructed source
 * - Fallback detection for vanilla JS entry points without framework code
 * - Detection priority between different methods
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { detectEntryPoints } from '../src/rebuild/entry-point-detector.js';

// ============================================================================
// TEST HELPERS
// ============================================================================

/**
 * Creates a temporary directory for test fixtures with unique name for isolation
 */
async function createTempDir(): Promise<string> {
    const tempBase = join(tmpdir(), 'entry-point-detector-test');
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
// detectEntryPoints Tests
// ============================================================================

describe('detectEntryPoints', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await createTempDir();
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    // ========================================================================
    // Render-call detection (high confidence)
    // ========================================================================

    describe('render-call detection (high confidence)', () => {
        test('should detect React createRoot entry point', async () => {
            await createFile(
                tempDir,
                'app/src/index.tsx',
                `
                import React from 'react';
                import { createRoot } from 'react-dom/client';
                import App from './App';

                const root = createRoot(document.getElementById('root'));
                root.render(<App />);
            `,
            );

            const entryPoints = await detectEntryPoints(tempDir);

            expect(entryPoints.length).toBeGreaterThanOrEqual(1);
            const reactEntry = entryPoints.find(
                (e) => e.detectionMethod === 'render-call',
            );
            expect(reactEntry).toBeDefined();
            expect(reactEntry?.framework).toBe('react');
            expect(reactEntry?.confidence).toBeGreaterThanOrEqual(0.7);
            expect(reactEntry?.mountElement).toBe('root');
        });

        test('should detect Vue createApp entry point', async () => {
            await createFile(
                tempDir,
                'app/src/main.ts',
                `
                import { createApp } from 'vue';
                import App from './App.vue';

                createApp(App).mount('#app');
            `,
            );

            const entryPoints = await detectEntryPoints(tempDir);

            const vueEntry = entryPoints.find(
                (e) => e.detectionMethod === 'render-call',
            );
            expect(vueEntry).toBeDefined();
            expect(vueEntry?.framework).toBe('vue');
            expect(vueEntry?.mountElement).toBe('app');
        });

        test('should detect legacy ReactDOM.render entry point', async () => {
            await createFile(
                tempDir,
                'app/src/index.tsx',
                `
                import React from 'react';
                import ReactDOM from 'react-dom';
                import App from './App';

                ReactDOM.render(<App />, document.getElementById('root'));
            `,
            );

            const entryPoints = await detectEntryPoints(tempDir);

            const reactEntry = entryPoints.find(
                (e) => e.detectionMethod === 'render-call',
            );
            expect(reactEntry).toBeDefined();
            expect(reactEntry?.framework).toBe('react');
        });
    });

    // ========================================================================
    // Main-file detection (medium confidence)
    // ========================================================================

    describe('main-file detection (medium confidence)', () => {
        test('should detect entry point with React import but no render call', async () => {
            await createFile(
                tempDir,
                'app/src/index.tsx',
                `
                import React from 'react';

                export const App = () => <div>Hello World</div>;
            `,
            );

            const entryPoints = await detectEntryPoints(tempDir);

            expect(entryPoints.length).toBeGreaterThanOrEqual(1);
            const mainFile = entryPoints.find(
                (e) =>
                    e.detectionMethod === 'main-file' ||
                    e.detectionMethod === 'fallback-index',
            );
            expect(mainFile).toBeDefined();
            if (mainFile?.detectionMethod === 'main-file') {
                expect(mainFile.framework).toBe('react');
                expect(mainFile.confidence).toBe(0.5);
            }
        });

        test('should detect entry point with Vue import but no mount call', async () => {
            await createFile(
                tempDir,
                'app/src/index.ts',
                `
                import { ref, computed } from 'vue';

                export const useCounter = () => {
                    const count = ref(0);
                    return { count };
                };
            `,
            );

            const entryPoints = await detectEntryPoints(tempDir);

            const entry = entryPoints.find((e) => e.path.includes('app'));
            expect(entry).toBeDefined();
        });
    });

    // ========================================================================
    // Fallback-index detection (low confidence) - NEW FUNCTIONALITY
    // ========================================================================

    describe('fallback-index detection (low confidence)', () => {
        test('should detect index.ts as entry point even without framework imports', async () => {
            await createFile(
                tempDir,
                'mybundle/src/index.ts',
                `
                import './module-a';
                import './module-b';
                console.log('Hello');
            `,
            );

            const entryPoints = await detectEntryPoints(tempDir);

            expect(entryPoints).toHaveLength(1);
            expect(entryPoints[0].path).toBe('mybundle/src/index.ts');
            expect(entryPoints[0].framework).toBe('vanilla');
            expect(entryPoints[0].confidence).toBe(0.3);
            expect(entryPoints[0].detectionMethod).toBe('fallback-index');
        });

        test('should detect main.ts as entry point even without framework imports', async () => {
            await createFile(
                tempDir,
                'mybundle/src/main.ts',
                `
                export function main() { return 42; }
            `,
            );

            const entryPoints = await detectEntryPoints(tempDir);

            expect(entryPoints).toHaveLength(1);
            expect(entryPoints[0].path).toBe('mybundle/src/main.ts');
            expect(entryPoints[0].detectionMethod).toBe('fallback-index');
        });

        test('should detect index.js as entry point', async () => {
            await createFile(
                tempDir,
                'mybundle/index.js',
                `
                console.log('vanilla js');
            `,
            );

            const entryPoints = await detectEntryPoints(tempDir);

            expect(entryPoints).toHaveLength(1);
            expect(entryPoints[0].path).toBe('mybundle/index.js');
            expect(entryPoints[0].detectionMethod).toBe('fallback-index');
        });

        test('should detect stub file with only imports as entry point', async () => {
            // This is the actual use case - generated stub entry point
            await createFile(
                tempDir,
                'src/index.ts',
                `
                /**
                 * Auto-generated entry point
                 */
                import '../_bundles/js/app.min.js';
                import '../_bundles/css/styles.min.css';
            `,
            );

            const entryPoints = await detectEntryPoints(tempDir);

            expect(entryPoints).toHaveLength(1);
            expect(entryPoints[0].framework).toBe('vanilla');
            expect(entryPoints[0].detectionMethod).toBe('fallback-index');
        });

        test('should use vanilla framework for fallback entries', async () => {
            await createFile(
                tempDir,
                'mybundle/src/index.ts',
                'export const x = 1;',
            );

            const entryPoints = await detectEntryPoints(tempDir);

            expect(entryPoints[0].framework).toBe('vanilla');
        });

        test('should have confidence 0.3 for fallback entries', async () => {
            await createFile(
                tempDir,
                'mybundle/src/index.ts',
                'export const x = 1;',
            );

            const entryPoints = await detectEntryPoints(tempDir);

            expect(entryPoints[0].confidence).toBe(0.3);
        });

        test('should have detectionMethod fallback-index', async () => {
            await createFile(
                tempDir,
                'mybundle/src/index.ts',
                'export const x = 1;',
            );

            const entryPoints = await detectEntryPoints(tempDir);

            expect(entryPoints[0].detectionMethod).toBe('fallback-index');
        });

        test('should detect index.tsx as fallback entry point', async () => {
            await createFile(
                tempDir,
                'mybundle/src/index.tsx',
                'export const Component = () => null;',
            );

            const entryPoints = await detectEntryPoints(tempDir);

            expect(entryPoints[0].path).toBe('mybundle/src/index.tsx');
            expect(entryPoints[0].detectionMethod).toBe('fallback-index');
        });

        test('should detect main.jsx as fallback entry point', async () => {
            await createFile(
                tempDir,
                'mybundle/main.jsx',
                'export default function() { return null; }',
            );

            const entryPoints = await detectEntryPoints(tempDir);

            expect(entryPoints[0].path).toBe('mybundle/main.jsx');
            expect(entryPoints[0].detectionMethod).toBe('fallback-index');
        });
    });

    // ========================================================================
    // Detection priority
    // ========================================================================

    describe('detection priority', () => {
        test('should prefer render-call entries over fallback entries', async () => {
            // Create two bundles: one with render call, one without
            await createFile(
                tempDir,
                'app/src/main.tsx',
                `
                import React from 'react';
                import { createRoot } from 'react-dom/client';
                createRoot(document.getElementById('root')).render(<App />);
            `,
            );
            await createFile(
                tempDir,
                'lib/src/index.ts',
                `
                export const helper = () => {};
            `,
            );

            const entryPoints = await detectEntryPoints(tempDir);

            // render-call should be first (higher confidence)
            expect(entryPoints[0].detectionMethod).toBe('render-call');
            expect(entryPoints[0].confidence).toBeGreaterThan(
                entryPoints[1]?.confidence || 0,
            );
        });

        test('should prefer main-file entries over fallback entries', async () => {
            // Create two bundles: one with React import, one without
            await createFile(
                tempDir,
                'app/src/index.tsx',
                `
                import React from 'react';
                export const App = () => <div>Hello</div>;
            `,
            );
            await createFile(
                tempDir,
                'util/src/index.ts',
                `
                export const util = () => {};
            `,
            );

            const entryPoints = await detectEntryPoints(tempDir);

            // main-file (with framework import) should have higher confidence
            const mainFile = entryPoints.find(
                (e) => e.detectionMethod === 'main-file',
            );
            const fallback = entryPoints.find(
                (e) => e.detectionMethod === 'fallback-index',
            );

            if (mainFile && fallback) {
                expect(mainFile.confidence).toBeGreaterThan(
                    fallback.confidence,
                );
            }
        });

        test('should sort entry points by confidence descending', async () => {
            await createFile(
                tempDir,
                'a/src/index.tsx',
                `
                import { createRoot } from 'react-dom/client';
                createRoot(document.getElementById('root')).render(<App />);
            `,
            );
            await createFile(tempDir, 'b/src/index.ts', 'export const x = 1;');

            const entryPoints = await detectEntryPoints(tempDir);

            for (let i = 1; i < entryPoints.length; i++) {
                expect(entryPoints[i - 1].confidence).toBeGreaterThanOrEqual(
                    entryPoints[i].confidence,
                );
            }
        });
    });

    // ========================================================================
    // Directory structure
    // ========================================================================

    describe('directory structure', () => {
        test('should find entry in src/ subdirectory', async () => {
            await createFile(
                tempDir,
                'mybundle/src/index.ts',
                'export const x = 1;',
            );

            const entryPoints = await detectEntryPoints(tempDir);

            expect(entryPoints[0].path).toBe('mybundle/src/index.ts');
        });

        test('should find entry in bundle root directory', async () => {
            await createFile(
                tempDir,
                'mybundle/index.ts',
                'export const x = 1;',
            );

            const entryPoints = await detectEntryPoints(tempDir);

            expect(entryPoints[0].path).toBe('mybundle/index.ts');
        });

        test('should skip _bundles directory', async () => {
            await createFile(
                tempDir,
                '_bundles/js/index.js',
                'console.log("minified");',
            );
            await createFile(tempDir, 'src/index.ts', 'export const x = 1;');

            const entryPoints = await detectEntryPoints(tempDir);

            expect(entryPoints.every((e) => !e.path.includes('_bundles'))).toBe(
                true,
            );
        });

        test('should skip node_modules directory', async () => {
            await createFile(
                tempDir,
                'node_modules/react/index.js',
                'module.exports = {};',
            );
            await createFile(tempDir, 'src/index.ts', 'export const x = 1;');

            const entryPoints = await detectEntryPoints(tempDir);

            expect(
                entryPoints.every((e) => !e.path.includes('node_modules')),
            ).toBe(true);
        });

        test('should skip _server directory', async () => {
            await createFile(
                tempDir,
                '_server/index.js',
                'console.log("server");',
            );
            await createFile(tempDir, 'src/index.ts', 'export const x = 1;');

            const entryPoints = await detectEntryPoints(tempDir);

            expect(entryPoints.every((e) => !e.path.includes('_server'))).toBe(
                true,
            );
        });

        test('should skip dist directory', async () => {
            await createFile(tempDir, 'dist/index.js', 'console.log("built");');
            await createFile(tempDir, 'src/index.ts', 'export const x = 1;');

            const entryPoints = await detectEntryPoints(tempDir);

            expect(entryPoints.every((e) => !e.path.includes('dist'))).toBe(
                true,
            );
        });

        test('should skip build directory', async () => {
            await createFile(
                tempDir,
                'build/index.js',
                'console.log("built");',
            );
            await createFile(tempDir, 'src/index.ts', 'export const x = 1;');

            const entryPoints = await detectEntryPoints(tempDir);

            expect(entryPoints.every((e) => !e.path.includes('build'))).toBe(
                true,
            );
        });
    });

    // ========================================================================
    // Edge cases
    // ========================================================================

    describe('edge cases', () => {
        test('should return empty array when no entry points found', async () => {
            // Empty project directory
            await mkdir(join(tempDir, 'empty'), { recursive: true });

            const entryPoints = await detectEntryPoints(tempDir);

            expect(entryPoints).toEqual([]);
        });

        test('should handle project with only CSS files', async () => {
            await createFile(
                tempDir,
                'styles/main.css',
                '.container { color: red; }',
            );

            const entryPoints = await detectEntryPoints(tempDir);

            expect(entryPoints).toEqual([]);
        });

        test('should handle multiple entry files in same bundle', async () => {
            await createFile(
                tempDir,
                'mybundle/src/index.ts',
                'export const a = 1;',
            );
            await createFile(
                tempDir,
                'mybundle/src/main.ts',
                'export const b = 2;',
            );

            const entryPoints = await detectEntryPoints(tempDir);

            // At least one should be found
            expect(entryPoints.length).toBeGreaterThanOrEqual(1);
        });

        test('should handle empty source file', async () => {
            await createFile(tempDir, 'mybundle/src/index.ts', '');

            const entryPoints = await detectEntryPoints(tempDir);

            // Empty file should still be detected as fallback
            expect(entryPoints).toHaveLength(1);
            expect(entryPoints[0].detectionMethod).toBe('fallback-index');
        });

        test('should handle file with only comments', async () => {
            await createFile(
                tempDir,
                'mybundle/src/index.ts',
                `
                // This is a comment
                /* Multi-line
                   comment */
            `,
            );

            const entryPoints = await detectEntryPoints(tempDir);

            expect(entryPoints).toHaveLength(1);
            expect(entryPoints[0].detectionMethod).toBe('fallback-index');
        });

        test('should handle multiple bundles with entry points', async () => {
            await createFile(
                tempDir,
                'bundle1/src/index.ts',
                'export const a = 1;',
            );
            await createFile(
                tempDir,
                'bundle2/src/index.ts',
                'export const b = 2;',
            );
            await createFile(
                tempDir,
                'bundle3/src/main.ts',
                'export const c = 3;',
            );

            const entryPoints = await detectEntryPoints(tempDir);

            expect(entryPoints.length).toBeGreaterThanOrEqual(3);
        });

        test('should handle non-existent directory gracefully', async () => {
            const nonExistent = join(tempDir, 'does-not-exist');

            const entryPoints = await detectEntryPoints(nonExistent);

            expect(entryPoints).toEqual([]);
        });
    });
});
