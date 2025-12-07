/**
 * Tests for the global CSS injector module
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { CapturedCssBundle } from '@web2local/stubs';
import type { EntryPoint } from '@web2local/rebuild';
import {
    generateCapturedStylesContent,
    injectCssImport,
    injectGlobalCss,
    needsGlobalCssInjection,
} from '@web2local/rebuild';

// Helper to create temp directory
async function createTempDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'global-css-test-'));
}

// Helper to create file with content
async function createFile(
    baseDir: string,
    relativePath: string,
    content: string,
): Promise<void> {
    const fullPath = join(baseDir, relativePath);
    const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
    await mkdir(dir, { recursive: true });
    await writeFile(fullPath, content, 'utf-8');
}

// Helper to read file content
async function readFileContent(path: string): Promise<string> {
    return readFile(path, 'utf-8');
}

describe('generateCapturedStylesContent', () => {
    test('should generate CSS with imports for all bundles', () => {
        const bundles: CapturedCssBundle[] = [
            {
                url: 'https://example.com/index-abc.css',
                localPath: 'navigation/index-abc.css',
                filename: 'index-abc.css',
                baseName: 'index',
                content: '.body { margin: 0; }',
            },
            {
                url: 'https://example.com/theme-def.css',
                localPath: 'navigation/theme-def.css',
                filename: 'theme-def.css',
                baseName: 'theme',
                content: '.theme { color: blue; }',
            },
        ];

        const content = generateCapturedStylesContent(
            bundles,
            '/project',
            '/project',
        );

        expect(content).toContain(
            'Auto-generated: Imports captured CSS bundles',
        );
        expect(content).toContain(
            "@import '_server/static/navigation/index-abc.css';",
        );
        expect(content).toContain(
            "@import '_server/static/navigation/theme-def.css';",
        );
        expect(content).toContain('Bundle: index-abc.css');
        expect(content).toContain('Bundle: theme-def.css');
    });

    test('should handle bundles in different directories', () => {
        const bundles: CapturedCssBundle[] = [
            {
                url: 'https://example.com/deep/nested/styles.css',
                localPath: 'deep/nested/styles.css',
                filename: 'styles.css',
                baseName: 'styles',
                content: '.styles { }',
            },
        ];

        const content = generateCapturedStylesContent(
            bundles,
            '/project',
            '/project',
        );

        expect(content).toContain(
            "@import '_server/static/deep/nested/styles.css';",
        );
    });
});

describe('injectCssImport', () => {
    test('should inject import at the top of a basic file', () => {
        const source = `import React from 'react';

function App() {
  return <div>Hello</div>;
}`;

        const result = injectCssImport(source, './_captured-styles.css');

        expect(result).toContain(
            "import './_captured-styles.css'; // Auto-injected: captured CSS bundles",
        );
        // The import should be after the existing imports
        expect(result.indexOf('_captured-styles.css')).toBeLessThan(
            result.indexOf('function App'),
        );
    });

    test('should inject after existing imports', () => {
        const source = `import React from 'react';
import { useState } from 'react';
import './styles.css';

function App() {
  return <div>Hello</div>;
}`;

        const result = injectCssImport(source, '../_captured-styles.css');

        // Should be after the last import
        const capturedIndex = result.indexOf('_captured-styles.css');
        const lastImportIndex = result.lastIndexOf("import './styles.css'");

        expect(capturedIndex).toBeGreaterThan(lastImportIndex);
        expect(result).toContain('// Auto-injected: captured CSS bundles');
    });

    test('should handle files with "use strict"', () => {
        const source = `"use strict";

import React from 'react';

function App() {}`;

        const result = injectCssImport(source, './_captured-styles.css');

        const useStrictIndex = result.indexOf('"use strict"');
        const capturedIndex = result.indexOf('_captured-styles.css');

        expect(capturedIndex).toBeGreaterThan(useStrictIndex);
    });

    test('should handle files with hashbang', () => {
        const source = `#!/usr/bin/env node
import something from 'module';

console.log('hello');`;

        const result = injectCssImport(source, './_captured-styles.css');

        const hashbangIndex = result.indexOf('#!/usr/bin/env node');
        const capturedIndex = result.indexOf('_captured-styles.css');

        expect(capturedIndex).toBeGreaterThan(hashbangIndex);
    });

    test('should handle require style imports', () => {
        const source = `const React = require('react');
const path = require('path');

module.exports = function() {}`;

        const result = injectCssImport(source, './_captured-styles.css');

        const capturedIndex = result.indexOf('_captured-styles.css');
        const lastRequireIndex = result.lastIndexOf("require('path')");

        expect(capturedIndex).toBeGreaterThan(lastRequireIndex);
    });
});

describe('needsGlobalCssInjection', () => {
    test('should return true when there are unmatched stubs and significant unused bundles', () => {
        const unmatchedStubs = [
            'src/Button.module.scss',
            'src/Card.module.scss',
        ];
        const unusedBundles: CapturedCssBundle[] = [
            {
                url: 'https://example.com/index.css',
                localPath: 'index.css',
                filename: 'index.css',
                baseName: 'index',
                content: 'a'.repeat(2000), // 2KB - significant
            },
        ];

        expect(needsGlobalCssInjection(unmatchedStubs, unusedBundles)).toBe(
            true,
        );
    });

    test('should return false when bundles are too small', () => {
        const unmatchedStubs = ['src/Button.module.scss'];
        const unusedBundles: CapturedCssBundle[] = [
            {
                url: 'https://example.com/tiny.css',
                localPath: 'tiny.css',
                filename: 'tiny.css',
                baseName: 'tiny',
                content: '.tiny { }', // Very small
            },
        ];

        expect(needsGlobalCssInjection(unmatchedStubs, unusedBundles)).toBe(
            false,
        );
    });

    test('should return false when no unmatched stubs', () => {
        const unmatchedStubs: string[] = [];
        const unusedBundles: CapturedCssBundle[] = [
            {
                url: 'https://example.com/big.css',
                localPath: 'big.css',
                filename: 'big.css',
                baseName: 'big',
                content: 'a'.repeat(5000),
            },
        ];

        expect(needsGlobalCssInjection(unmatchedStubs, unusedBundles)).toBe(
            false,
        );
    });

    test('should return false when no unused bundles', () => {
        const unmatchedStubs = ['src/Button.module.scss'];
        const unusedBundles: CapturedCssBundle[] = [];

        expect(needsGlobalCssInjection(unmatchedStubs, unusedBundles)).toBe(
            false,
        );
    });

    test('should respect custom minBundleSize', () => {
        const unmatchedStubs = ['src/Button.module.scss'];
        const unusedBundles: CapturedCssBundle[] = [
            {
                url: 'https://example.com/medium.css',
                localPath: 'medium.css',
                filename: 'medium.css',
                baseName: 'medium',
                content: 'a'.repeat(500), // 500 bytes
            },
        ];

        // With default minBundleSize (1000), should be false
        expect(needsGlobalCssInjection(unmatchedStubs, unusedBundles)).toBe(
            false,
        );

        // With lower minBundleSize, should be true
        expect(
            needsGlobalCssInjection(unmatchedStubs, unusedBundles, 100),
        ).toBe(true);
    });
});

describe('injectGlobalCss', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await createTempDir();
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    test('should create _captured-styles.css and inject import into entry point', async () => {
        // Create entry point file
        await createFile(
            tempDir,
            'src/main.tsx',
            `import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
`,
        );

        // Create _server/static directory for bundles
        await createFile(
            tempDir,
            '_server/static/navigation/index-abc.css',
            '.body { margin: 0; }',
        );

        const unusedBundles: CapturedCssBundle[] = [
            {
                url: 'https://example.com/index-abc.css',
                localPath: 'navigation/index-abc.css',
                filename: 'index-abc.css',
                baseName: 'index',
                content: '.body { margin: 0; }',
            },
        ];

        const entryPoints: EntryPoint[] = [
            {
                path: 'src/main.tsx',
                framework: 'react',
                mountElement: 'root',
                confidence: 0.95,
                detectionMethod: 'render-call',
            },
        ];

        const result = await injectGlobalCss({
            projectDir: tempDir,
            unusedBundles,
            entryPoints,
        });

        expect(result.injected).toBe(true);
        expect(result.capturedStylesPath).toBe('_captured-styles.css');
        expect(result.modifiedEntryPoint).toBe('src/main.tsx');
        expect(result.includedBundles).toContain('index-abc.css');

        // Check _captured-styles.css was created
        const capturedStyles = await readFileContent(
            join(tempDir, '_captured-styles.css'),
        );
        expect(capturedStyles).toContain('@import');
        expect(capturedStyles).toContain('navigation/index-abc.css');

        // Check entry point was modified
        const entryContent = await readFileContent(
            join(tempDir, 'src/main.tsx'),
        );
        expect(entryContent).toContain('_captured-styles.css');
        expect(entryContent).toContain('// Auto-injected');
    });

    test('should return empty result when no bundles provided', async () => {
        await createFile(tempDir, 'src/main.tsx', `console.log('hello');`);

        const result = await injectGlobalCss({
            projectDir: tempDir,
            unusedBundles: [],
            entryPoints: [
                {
                    path: 'src/main.tsx',
                    framework: 'react',
                    confidence: 0.9,
                    detectionMethod: 'heuristic',
                },
            ],
        });

        expect(result.injected).toBe(false);
        expect(result.includedBundles).toHaveLength(0);
    });

    test('should return error when no entry points provided', async () => {
        const unusedBundles: CapturedCssBundle[] = [
            {
                url: 'https://example.com/styles.css',
                localPath: 'styles.css',
                filename: 'styles.css',
                baseName: 'styles',
                content: '.styles { }',
            },
        ];

        const result = await injectGlobalCss({
            projectDir: tempDir,
            unusedBundles,
            entryPoints: [],
        });

        expect(result.injected).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0]).toContain('No entry points');
    });

    test('should not inject twice if already injected', async () => {
        // Create entry point with existing injection
        await createFile(
            tempDir,
            'src/main.tsx',
            `import '../_captured-styles.css'; // Auto-injected: captured CSS bundles
import React from 'react';

function App() {}
`,
        );

        await createFile(tempDir, '_server/static/index.css', '.styles { }');

        await createFile(tempDir, '_captured-styles.css', '/* existing */');

        const unusedBundles: CapturedCssBundle[] = [
            {
                url: 'https://example.com/index.css',
                localPath: 'index.css',
                filename: 'index.css',
                baseName: 'index',
                content: '.styles { }',
            },
        ];

        const result = await injectGlobalCss({
            projectDir: tempDir,
            unusedBundles,
            entryPoints: [
                {
                    path: 'src/main.tsx',
                    framework: 'react',
                    confidence: 0.9,
                    detectionMethod: 'heuristic',
                },
            ],
        });

        expect(result.injected).toBe(true);
        // Entry point content should only have one import
        const content = await readFileContent(join(tempDir, 'src/main.tsx'));
        const matches = content.match(/_captured-styles\.css/g);
        expect(matches?.length).toBe(1); // Only one occurrence
    });

    test('should call onProgress callback', async () => {
        await createFile(tempDir, 'src/main.tsx', `import React from 'react';`);

        await createFile(tempDir, '_server/static/index.css', '.styles { }');

        const unusedBundles: CapturedCssBundle[] = [
            {
                url: 'https://example.com/index.css',
                localPath: 'index.css',
                filename: 'index.css',
                baseName: 'index',
                content: '.styles { }',
            },
        ];

        const messages: string[] = [];
        await injectGlobalCss({
            projectDir: tempDir,
            unusedBundles,
            entryPoints: [
                {
                    path: 'src/main.tsx',
                    framework: 'react',
                    confidence: 0.9,
                    detectionMethod: 'heuristic',
                },
            ],
            onProgress: (msg) => messages.push(msg),
        });

        expect(messages.length).toBeGreaterThan(0);
    });
});
