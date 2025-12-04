import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
    findNamespaceSourceFile,
    findDependencyReexport,
    generateExportStatement,
    groupResolutionsByType,
    type ExportResolution,
    type MissingExportInfo,
} from '../src/export-resolver';

describe('findNamespaceSourceFile', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'export-resolver-test-'));
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    it('should find a file that exports all required names', async () => {
        // Create a source file with multiple exports
        const srcDir = join(tempDir, 'src');
        await mkdir(srcDir, { recursive: true });

        await writeFile(
            join(srcDir, 'InventoryTag.tsx'),
            `
            export const InventoryCamping = () => <span>Camping</span>;
            export const InventoryDayUse = () => <span>Day Use</span>;
            export const InventoryPermit = () => <span>Permit</span>;
            `,
        );

        const result = await findNamespaceSourceFile(tempDir, [
            'InventoryCamping',
            'InventoryDayUse',
        ]);

        expect(result).toBe('src/InventoryTag.tsx');
    });

    it('should return null if no file exports all required names', async () => {
        const srcDir = join(tempDir, 'src');
        await mkdir(srcDir, { recursive: true });

        // File only exports some of the required names
        await writeFile(
            join(srcDir, 'Partial.tsx'),
            `
            export const Foo = 1;
            export const Bar = 2;
            `,
        );

        const result = await findNamespaceSourceFile(tempDir, [
            'Foo',
            'Bar',
            'Baz', // Not exported
        ]);

        expect(result).toBeNull();
    });

    it('should warn and return null when multiple files match', async () => {
        const srcDir = join(tempDir, 'src');
        await mkdir(srcDir, { recursive: true });

        // Two files both export the required names
        await writeFile(
            join(srcDir, 'File1.ts'),
            `
            export const Foo = 1;
            export const Bar = 2;
            `,
        );

        await writeFile(
            join(srcDir, 'File2.ts'),
            `
            export const Foo = 'a';
            export const Bar = 'b';
            `,
        );

        const warnings: string[] = [];
        const result = await findNamespaceSourceFile(tempDir, ['Foo', 'Bar'], {
            onWarning: (msg) => warnings.push(msg),
        });

        expect(result).toBeNull();
        expect(warnings.length).toBeGreaterThan(0);
        expect(warnings[0]).toContain('Multiple files');
    });

    it('should handle type exports', async () => {
        const srcDir = join(tempDir, 'src');
        await mkdir(srcDir, { recursive: true });

        await writeFile(
            join(srcDir, 'Types.ts'),
            `
            export interface User { name: string; }
            export type UserRole = 'admin' | 'user';
            export const DEFAULT_ROLE: UserRole = 'user';
            `,
        );

        const result = await findNamespaceSourceFile(tempDir, [
            'User',
            'UserRole',
            'DEFAULT_ROLE',
        ]);

        expect(result).toBe('src/Types.ts');
    });
});

describe('findDependencyReexport', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'export-resolver-test-'));
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    it('should find an import from an external dependency', async () => {
        const srcDir = join(tempDir, 'src');
        await mkdir(srcDir, { recursive: true });

        await writeFile(
            join(srcDir, 'FeatureFlag.tsx'),
            `
            import { useFlags, useLDClient } from 'launchdarkly-react-client-sdk';
            
            export function MyComponent() {
                const flags = useFlags();
                return <div>{flags.newFeature}</div>;
            }
            `,
        );

        const result = await findDependencyReexport(tempDir, 'useFlags');

        expect(result).not.toBeNull();
        expect(result?.source).toBe('launchdarkly-react-client-sdk');
        expect(result?.isTypeOnly).toBe(false);
    });

    it('should detect type-only imports', async () => {
        const srcDir = join(tempDir, 'src');
        await mkdir(srcDir, { recursive: true });

        await writeFile(
            join(srcDir, 'Types.ts'),
            `
            import type { LDClient } from 'launchdarkly-react-client-sdk';
            
            export function getClient(): LDClient {
                throw new Error('Not implemented');
            }
            `,
        );

        const result = await findDependencyReexport(tempDir, 'LDClient');

        expect(result).not.toBeNull();
        expect(result?.isTypeOnly).toBe(true);
    });

    it('should return null if name is not imported from any dependency', async () => {
        const srcDir = join(tempDir, 'src');
        await mkdir(srcDir, { recursive: true });

        await writeFile(
            join(srcDir, 'Local.ts'),
            `
            // No external imports
            export const localThing = 42;
            `,
        );

        const result = await findDependencyReexport(tempDir, 'nonExistent');

        expect(result).toBeNull();
    });

    it('should warn and return null when imported from multiple dependencies', async () => {
        const srcDir = join(tempDir, 'src');
        await mkdir(srcDir, { recursive: true });

        // Same name imported from different dependencies in different files
        await writeFile(
            join(srcDir, 'File1.ts'),
            `
            import { format } from 'date-fns';
            export const formatDate = format;
            `,
        );

        await writeFile(
            join(srcDir, 'File2.ts'),
            `
            import { format } from 'util';
            export const formatString = format;
            `,
        );

        const warnings: string[] = [];
        const result = await findDependencyReexport(tempDir, 'format', {
            onWarning: (msg) => warnings.push(msg),
        });

        expect(result).toBeNull();
        expect(warnings.length).toBeGreaterThan(0);
        expect(warnings[0]).toContain('multiple dependencies');
    });

    it('should return the dependency if all imports are from the same source', async () => {
        const srcDir = join(tempDir, 'src');
        await mkdir(srcDir, { recursive: true });

        // Same name imported from same dependency in multiple files
        await writeFile(
            join(srcDir, 'File1.ts'),
            `
            import { useSelector } from 'react-redux';
            export const selectUser = () => useSelector(s => s.user);
            `,
        );

        await writeFile(
            join(srcDir, 'File2.ts'),
            `
            import { useSelector } from 'react-redux';
            export const selectPosts = () => useSelector(s => s.posts);
            `,
        );

        const result = await findDependencyReexport(tempDir, 'useSelector');

        expect(result).not.toBeNull();
        expect(result?.source).toBe('react-redux');
    });
});

describe('generateExportStatement', () => {
    it('should generate namespace export statement', () => {
        const resolution: ExportResolution = {
            type: 'namespace',
            sourcePath: 'src/components/InventoryTag.tsx',
            exportName: 'InventoryTag',
        };

        const result = generateExportStatement(resolution);

        expect(result).toContain(
            "import * as InventoryTag from './src/components/InventoryTag'",
        );
        expect(result).toContain('export { InventoryTag }');
    });

    it('should generate re-export statement', () => {
        const resolution: ExportResolution = {
            type: 'reexport',
            dependencySource: 'launchdarkly-react-client-sdk',
            exportName: 'useFlags',
            isTypeOnly: false,
        };

        const result = generateExportStatement(resolution);

        expect(result).toBe(
            "export { useFlags } from 'launchdarkly-react-client-sdk';",
        );
    });

    it('should generate type re-export statement', () => {
        const resolution: ExportResolution = {
            type: 'reexport',
            dependencySource: 'launchdarkly-react-client-sdk',
            exportName: 'LDClient',
            isTypeOnly: true,
        };

        const result = generateExportStatement(resolution);

        expect(result).toBe(
            "export type { LDClient } from 'launchdarkly-react-client-sdk';",
        );
    });

    it('should return empty string for stub resolution', () => {
        const resolution: ExportResolution = {
            type: 'stub',
            exportName: 'SomeMissingExport',
            reason: 'Could not find source',
        };

        const result = generateExportStatement(resolution);

        expect(result).toBe('');
    });
});

describe('groupResolutionsByType', () => {
    it('should group resolutions by type', () => {
        const resolutions: MissingExportInfo[] = [
            {
                exportName: 'InventoryTag',
                usagePattern: 'namespace',
                accessedProperties: ['Camping', 'DayUse'],
                importedBy: ['file1.tsx'],
                resolution: {
                    type: 'namespace',
                    sourcePath: 'src/InventoryTag.tsx',
                    exportName: 'InventoryTag',
                },
            },
            {
                exportName: 'useFlags',
                usagePattern: 'direct',
                accessedProperties: [],
                importedBy: ['file2.tsx'],
                resolution: {
                    type: 'reexport',
                    dependencySource: 'launchdarkly',
                    exportName: 'useFlags',
                    isTypeOnly: false,
                },
            },
            {
                exportName: 'MissingThing',
                usagePattern: 'unknown',
                accessedProperties: [],
                importedBy: ['file3.tsx'],
                resolution: {
                    type: 'stub',
                    exportName: 'MissingThing',
                    reason: 'Not found',
                },
            },
        ];

        const { namespaces, reexports, stubs } =
            groupResolutionsByType(resolutions);

        expect(namespaces).toHaveLength(1);
        expect(namespaces[0].exportName).toBe('InventoryTag');

        expect(reexports).toHaveLength(1);
        expect(reexports[0].exportName).toBe('useFlags');

        expect(stubs).toHaveLength(1);
        expect(stubs[0].exportName).toBe('MissingThing');
    });

    it('should put items without resolution in stubs', () => {
        const resolutions: MissingExportInfo[] = [
            {
                exportName: 'NoResolution',
                usagePattern: 'unknown',
                accessedProperties: [],
                importedBy: [],
                resolution: null,
            },
        ];

        const { namespaces, reexports, stubs } =
            groupResolutionsByType(resolutions);

        expect(namespaces).toHaveLength(0);
        expect(reexports).toHaveLength(0);
        expect(stubs).toHaveLength(1);
    });
});
