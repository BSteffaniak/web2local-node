/**
 * Tests for vite-config-generator.ts module
 *
 * Tests for:
 * - generateViteConfig with loadEnv support
 * - generateEnvExample
 */

import { describe, test, expect } from 'vitest';
import {
    generateViteConfig,
    generateEnvExample,
} from '../src/rebuild/vite-config-generator.js';
import type { EnvVariable, EntryPoint } from '../src/rebuild/types.js';

// Helper to create a minimal entry point
function createEntryPoint(
    path: string,
    framework:
        | 'react'
        | 'vue'
        | 'svelte'
        | 'solid'
        | 'preact'
        | 'unknown' = 'react',
): EntryPoint {
    return {
        path,
        framework,
        confidence: 0.9,
        detectionMethod: 'heuristic',
    };
}

describe('generateViteConfig', () => {
    test('should generate function-based config with loadEnv', () => {
        const config = generateViteConfig({
            entryPoints: [createEntryPoint('src/main.tsx')],
            aliases: [],
            envVariables: [{ name: 'API_URL', usedIn: ['api.ts'] }],
            framework: 'react',
            outDir: '_rebuilt',
            sourcemap: true,
        });

        expect(config).toContain(
            "import { defineConfig, loadEnv } from 'vite'",
        );
        expect(config).toContain('export default defineConfig(({ mode }) => {');
        expect(config).toContain(
            "const env = loadEnv(mode, process.cwd(), '')",
        );
    });

    test('should use mode for NODE_ENV', () => {
        const config = generateViteConfig({
            entryPoints: [createEntryPoint('src/main.tsx')],
            aliases: [],
            envVariables: [],
            framework: 'react',
            outDir: '_rebuilt',
            sourcemap: true,
        });

        expect(config).toContain(
            "'process.env.NODE_ENV': JSON.stringify(mode)",
        );
    });

    test('should reference env variables from loadEnv', () => {
        const config = generateViteConfig({
            entryPoints: [createEntryPoint('src/main.tsx')],
            aliases: [],
            envVariables: [
                { name: 'API_URL', usedIn: ['api.ts'] },
                { name: 'MAPBOX_TOKEN', usedIn: ['Map.tsx'] },
            ],
            framework: 'react',
            outDir: '_rebuilt',
            sourcemap: true,
        });

        expect(config).toContain(
            "'process.env.API_URL': JSON.stringify(env.API_URL || '')",
        );
        expect(config).toContain(
            "'process.env.MAPBOX_TOKEN': JSON.stringify(env.MAPBOX_TOKEN || '')",
        );
    });

    test('should include framework plugin', () => {
        const config = generateViteConfig({
            entryPoints: [createEntryPoint('src/main.tsx')],
            aliases: [],
            envVariables: [],
            framework: 'react',
            outDir: '_rebuilt',
            sourcemap: true,
        });

        expect(config).toContain("import react from '@vitejs/plugin-react'");
        expect(config).toContain('plugins: [react()]');
    });

    test('should include Vue plugin for Vue framework', () => {
        const config = generateViteConfig({
            entryPoints: [createEntryPoint('src/main.ts', 'vue')],
            aliases: [],
            envVariables: [],
            framework: 'vue',
            outDir: '_rebuilt',
            sourcemap: true,
        });

        expect(config).toContain("import vue from '@vitejs/plugin-vue'");
        expect(config).toContain('plugins: [vue()]');
    });

    test('should include aliases sorted by specificity', () => {
        const config = generateViteConfig({
            entryPoints: [createEntryPoint('src/main.tsx')],
            aliases: [
                { alias: 'shared', path: './navigation/shared' },
                { alias: 'shared/ui', path: './navigation/shared/ui' },
                {
                    alias: 'shared/ui/Button',
                    path: './navigation/shared/ui/Button',
                },
            ],
            envVariables: [],
            framework: 'react',
            outDir: '_rebuilt',
            sourcemap: true,
        });

        // More specific aliases should come first
        const sharedUiButtonIndex = config.indexOf("'shared/ui/Button'");
        const sharedUiIndex = config.indexOf("'shared/ui'");
        const sharedIndex = config.indexOf("'shared'");

        expect(sharedUiButtonIndex).toBeLessThan(sharedUiIndex);
        expect(sharedUiIndex).toBeLessThan(sharedIndex);
    });

    test('should include build configuration', () => {
        const config = generateViteConfig({
            entryPoints: [createEntryPoint('src/main.tsx')],
            aliases: [],
            envVariables: [],
            framework: 'react',
            outDir: 'dist',
            sourcemap: false,
        });

        expect(config).toContain("outDir: 'dist'");
        expect(config).toContain('sourcemap: false');
    });

    test('should handle multiple entry points', () => {
        const config = generateViteConfig({
            entryPoints: [
                createEntryPoint('src/main.tsx'),
                createEntryPoint('src/admin.tsx'),
            ],
            aliases: [],
            envVariables: [],
            framework: 'react',
            outDir: '_rebuilt',
            sourcemap: true,
        });

        expect(config).toContain('src_main_tsx');
        expect(config).toContain('src_admin_tsx');
    });

    test('should include CSS modules configuration', () => {
        const config = generateViteConfig({
            entryPoints: [createEntryPoint('src/main.tsx')],
            aliases: [],
            envVariables: [],
            framework: 'react',
            outDir: '_rebuilt',
            sourcemap: true,
        });

        expect(config).toContain('css: {');
        expect(config).toContain('modules: {');
        expect(config).toContain("localsConvention: 'camelCase'");
    });

    test('should return wrapped config in return statement', () => {
        const config = generateViteConfig({
            entryPoints: [createEntryPoint('src/main.tsx')],
            aliases: [],
            envVariables: [],
            framework: 'react',
            outDir: '_rebuilt',
            sourcemap: true,
        });

        expect(config).toContain('return {');
        // Ensure it closes properly
        expect(config).toContain('  }\n})');
    });
});

describe('generateEnvExample', () => {
    test('should generate .env.example content with env vars', () => {
        const envVars: EnvVariable[] = [
            { name: 'API_URL', usedIn: ['api.ts', 'config.ts'] },
            { name: 'MAPBOX_TOKEN', usedIn: ['Map.tsx'] },
        ];
        const content = generateEnvExample(envVars);

        expect(content).toContain('API_URL=');
        expect(content).toContain('MAPBOX_TOKEN=');
        expect(content).toContain('# Used in: api.ts, config.ts');
        expect(content).toContain('# Used in: Map.tsx');
    });

    test('should include header comments', () => {
        const envVars: EnvVariable[] = [{ name: 'TEST', usedIn: ['test.ts'] }];
        const content = generateEnvExample(envVars);

        expect(content).toContain('# Environment Variables');
        expect(content).toContain('# Detected from source code analysis');
        expect(content).toContain(
            '# Copy this file to .env and fill in values',
        );
    });

    test('should truncate long usedIn lists', () => {
        const envVars: EnvVariable[] = [
            { name: 'API_URL', usedIn: ['a.ts', 'b.ts', 'c.ts', 'd.ts'] },
        ];
        const content = generateEnvExample(envVars);

        expect(content).toContain('# Used in: a.ts, b.ts (+2 more)');
    });

    test('should show exactly 2 files and count for 3+ files', () => {
        const envVars: EnvVariable[] = [
            { name: 'KEY', usedIn: ['one.ts', 'two.ts', 'three.ts'] },
        ];
        const content = generateEnvExample(envVars);

        expect(content).toContain('# Used in: one.ts, two.ts (+1 more)');
    });

    test('should not truncate when exactly 2 files', () => {
        const envVars: EnvVariable[] = [
            { name: 'KEY', usedIn: ['one.ts', 'two.ts'] },
        ];
        const content = generateEnvExample(envVars);

        expect(content).toContain('# Used in: one.ts, two.ts');
        expect(content).not.toContain('more');
    });

    test('should return only header for empty env vars', () => {
        const content = generateEnvExample([]);

        expect(content).toContain('# Environment Variables');
        // Should not have any VAR= lines
        const lines = content.split('\n');
        const varLines = lines.filter(
            (l) => !l.startsWith('#') && l.includes('='),
        );
        expect(varLines).toHaveLength(0);
    });

    test('should leave values empty (placeholders only)', () => {
        const envVars: EnvVariable[] = [
            { name: 'SECRET_KEY', usedIn: ['auth.ts'] },
            { name: 'DATABASE_URL', usedIn: ['db.ts'] },
        ];
        const content = generateEnvExample(envVars);

        // Values should be empty, just VAR=
        expect(content).toMatch(/^SECRET_KEY=$/m);
        expect(content).toMatch(/^DATABASE_URL=$/m);
    });

    test('should handle single file in usedIn', () => {
        const envVars: EnvVariable[] = [
            { name: 'SINGLE', usedIn: ['only-one.ts'] },
        ];
        const content = generateEnvExample(envVars);

        expect(content).toContain('# Used in: only-one.ts');
    });

    test('should preserve order of env vars', () => {
        const envVars: EnvVariable[] = [
            { name: 'FIRST', usedIn: ['a.ts'] },
            { name: 'SECOND', usedIn: ['b.ts'] },
            { name: 'THIRD', usedIn: ['c.ts'] },
        ];
        const content = generateEnvExample(envVars);

        const firstIndex = content.indexOf('FIRST=');
        const secondIndex = content.indexOf('SECOND=');
        const thirdIndex = content.indexOf('THIRD=');

        expect(firstIndex).toBeLessThan(secondIndex);
        expect(secondIndex).toBeLessThan(thirdIndex);
    });
});
