/**
 * Tests for stub-generator.ts module
 *
 * Comprehensive tests for the index file and stub generation:
 * - extractExports: Parsing exports from TypeScript/JavaScript files
 * - generateIndexFile: Creating index.ts files with re-exports
 * - generateScssModuleDeclarations: Creating .d.ts files for CSS modules
 * - analyzePackage: Analyzing package structure
 * - findPackagesNeedingIndex: Finding packages that need index files
 */

import { test, expect, describe, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseSync } from '@swc/core';
import {
    extractExports,
    generateIndexFile,
    generateScssModuleDeclarations,
    analyzePackage,
    findPackagesNeedingIndex,
    scanImports,
    generateDirectoryIndexFiles,
    generateMissingCssModuleStubs,
    generateExternalPackageStubs,
    fixDuplicateExports,
    fixAllDuplicateExports,
    findMissingSourceFiles,
    generateMissingSourceStubs,
    findMissingBarrelExports,
    appendMissingBarrelExports,
    type AliasMapping,
} from '../src/stub-generator.js';

// ============================================================================
// TEST HELPERS
// ============================================================================

/**
 * Creates a temporary directory for test fixtures
 */
async function createTempDir(): Promise<string> {
    const tempBase = join(tmpdir(), 'stub-generator-test');
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
 * Reads a file and returns its content
 */
async function readFileContent(filePath: string): Promise<string> {
    return readFile(filePath, 'utf-8');
}

// ============================================================================
// EXTRACT EXPORTS
// ============================================================================

describe('extractExports', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await createTempDir();
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    describe('named exports', () => {
        test('should extract const exports', async () => {
            const filePath = await createFile(
                tempDir,
                'constants.ts',
                `
        export const FOO = 'foo';
        export const BAR = 42;
        export const baz = true;
      `,
            );

            const exports = await extractExports(filePath);

            expect(exports.named).toContain('FOO');
            expect(exports.named).toContain('BAR');
            expect(exports.named).toContain('baz');
            expect(exports.hasDefault).toBe(false);
        });

        test('should extract let and var exports', async () => {
            const filePath = await createFile(
                tempDir,
                'vars.ts',
                `
        export let mutableValue = 1;
        export var legacyValue = 2;
      `,
            );

            const exports = await extractExports(filePath);

            expect(exports.named).toContain('mutableValue');
            expect(exports.named).toContain('legacyValue');
        });

        test('should extract function exports', async () => {
            const filePath = await createFile(
                tempDir,
                'utils.ts',
                `
        export function helper() {}
        export function processData(data: any) { return data; }
      `,
            );

            const exports = await extractExports(filePath);

            expect(exports.named).toContain('helper');
            expect(exports.named).toContain('processData');
        });

        test('should extract class exports', async () => {
            const filePath = await createFile(
                tempDir,
                'classes.ts',
                `
        export class MyService {}
        export class DataProcessor {}
      `,
            );

            const exports = await extractExports(filePath);

            expect(exports.named).toContain('MyService');
            expect(exports.named).toContain('DataProcessor');
        });

        test('should extract enum exports', async () => {
            const filePath = await createFile(
                tempDir,
                'enums.ts',
                `
        export enum Status {
          Active,
          Inactive
        }
        export enum Color {
          Red = 'red',
          Blue = 'blue'
        }
      `,
            );

            const exports = await extractExports(filePath);

            expect(exports.named).toContain('Status');
            expect(exports.named).toContain('Color');
        });

        test('should extract bracket-style named exports', async () => {
            const filePath = await createFile(
                tempDir,
                'reexports.ts',
                `
        const internal1 = 1;
        const internal2 = 2;
        export { internal1, internal2 };
      `,
            );

            const exports = await extractExports(filePath);

            expect(exports.named).toContain('internal1');
            expect(exports.named).toContain('internal2');
        });

        test('should extract aliased bracket exports', async () => {
            const filePath = await createFile(
                tempDir,
                'aliased.ts',
                `
        const original = 1;
        export { original as renamed };
      `,
            );

            const exports = await extractExports(filePath);

            expect(exports.named).toContain('renamed');
            expect(exports.named).not.toContain('original');
        });

        test('should extract destructured object exports (RTK Query pattern)', async () => {
            // This is the pattern used by RTK Query for generated hooks
            const filePath = await createFile(
                tempDir,
                'api-slice.ts',
                `
        import { createApi } from '@reduxjs/toolkit/query/react';
        
        export const articlesApiSlice = createApi({
          reducerPath: 'articlesApi',
          endpoints: (builder) => ({
            fetchAllArticles: builder.query({}),
            fetchArticleById: builder.query({}),
            fetchFeaturedArticles: builder.query({}),
          }),
        });
        
        export const {
          useFetchAllArticlesQuery,
          useFetchArticleByIdQuery,
          useFetchFeaturedArticlesQuery,
          usePrefetch,
        } = articlesApiSlice;
      `,
            );

            const exports = await extractExports(filePath);

            expect(exports.named).toContain('articlesApiSlice');
            expect(exports.named).toContain('useFetchAllArticlesQuery');
            expect(exports.named).toContain('useFetchArticleByIdQuery');
            expect(exports.named).toContain('useFetchFeaturedArticlesQuery');
            expect(exports.named).toContain('usePrefetch');
        });

        test('should extract destructured exports from Redux slice actions', async () => {
            // This is the pattern used by Redux Toolkit for slice actions
            const filePath = await createFile(
                tempDir,
                'articles-slice.ts',
                `
        import { createSlice } from '@reduxjs/toolkit';
        
        const articlesSlice = createSlice({
          name: 'articles',
          initialState: { pageIndex: 0 },
          reducers: {
            incrementPageIndex: (state) => { state.pageIndex += 1; },
            resetPageIndex: (state) => { state.pageIndex = 0; },
          },
        });
        
        export const { incrementPageIndex, resetPageIndex } = articlesSlice.actions;
        export default articlesSlice.reducer;
      `,
            );

            const exports = await extractExports(filePath);

            expect(exports.named).toContain('incrementPageIndex');
            expect(exports.named).toContain('resetPageIndex');
            expect(exports.hasDefault).toBe(true);
        });

        test('should extract destructured array exports', async () => {
            const filePath = await createFile(
                tempDir,
                'array-destructure.ts',
                `
        const tuple = [1, 'two', true] as const;
        export const [first, second, third] = tuple;
      `,
            );

            const exports = await extractExports(filePath);

            expect(exports.named).toContain('first');
            expect(exports.named).toContain('second');
            expect(exports.named).toContain('third');
        });

        test('should extract renamed destructured exports', async () => {
            const filePath = await createFile(
                tempDir,
                'renamed-destructure.ts',
                `
        const obj = { originalName: 1, anotherProp: 2 };
        export const { originalName: renamedExport, anotherProp } = obj;
      `,
            );

            const exports = await extractExports(filePath);

            expect(exports.named).toContain('renamedExport');
            expect(exports.named).toContain('anotherProp');
            expect(exports.named).not.toContain('originalName');
        });

        test('should extract rest spread in destructured exports', async () => {
            const filePath = await createFile(
                tempDir,
                'rest-spread.ts',
                `
        const obj = { a: 1, b: 2, c: 3, d: 4 };
        export const { a, ...rest } = obj;
      `,
            );

            const exports = await extractExports(filePath);

            expect(exports.named).toContain('a');
            expect(exports.named).toContain('rest');
        });

        test('should extract destructured exports with default values', async () => {
            const filePath = await createFile(
                tempDir,
                'default-values.ts',
                `
        const obj = { a: 1 };
        export const { a, b = 2, c = 'default' } = obj;
      `,
            );

            const exports = await extractExports(filePath);

            expect(exports.named).toContain('a');
            expect(exports.named).toContain('b');
            expect(exports.named).toContain('c');
        });

        test('should extract nested destructured exports', async () => {
            const filePath = await createFile(
                tempDir,
                'nested-destructure.ts',
                `
        const obj = { outer: { inner: 1, deep: { value: 2 } } };
        export const { outer: { inner, deep: { value: deepValue } } } = obj;
      `,
            );

            const exports = await extractExports(filePath);

            expect(exports.named).toContain('inner');
            expect(exports.named).toContain('deepValue');
            expect(exports.named).not.toContain('outer');
            expect(exports.named).not.toContain('deep');
            expect(exports.named).not.toContain('value');
        });

        test('should extract mixed array and object destructured exports', async () => {
            const filePath = await createFile(
                tempDir,
                'mixed-destructure.ts',
                `
        const arr = [{ name: 'first' }, { name: 'second' }];
        export const [{ name: firstName }, { name: secondName }] = arr;
      `,
            );

            const exports = await extractExports(filePath);

            expect(exports.named).toContain('firstName');
            expect(exports.named).toContain('secondName');
            expect(exports.named).not.toContain('name');
        });

        test('should extract rest spread in array destructured exports', async () => {
            const filePath = await createFile(
                tempDir,
                'array-rest.ts',
                `
        const arr = [1, 2, 3, 4, 5];
        export const [first, second, ...remaining] = arr;
      `,
            );

            const exports = await extractExports(filePath);

            expect(exports.named).toContain('first');
            expect(exports.named).toContain('second');
            expect(exports.named).toContain('remaining');
        });

        test('should handle multiple destructured export statements', async () => {
            // Real-world pattern: multiple slices or APIs in one file
            const filePath = await createFile(
                tempDir,
                'multiple-destructure.ts',
                `
        const usersApi = { useGetUsersQuery: () => {}, useGetUserByIdQuery: () => {} };
        const postsApi = { useGetPostsQuery: () => {}, useCreatePostMutation: () => {} };
        
        export const { useGetUsersQuery, useGetUserByIdQuery } = usersApi;
        export const { useGetPostsQuery, useCreatePostMutation } = postsApi;
      `,
            );

            const exports = await extractExports(filePath);

            expect(exports.named).toContain('useGetUsersQuery');
            expect(exports.named).toContain('useGetUserByIdQuery');
            expect(exports.named).toContain('useGetPostsQuery');
            expect(exports.named).toContain('useCreatePostMutation');
        });

        test('should handle complex RTK Query file with all export types', async () => {
            // Mirrors a real-world RTK Query API slice file structure
            const filePath = await createFile(
                tempDir,
                'complete-api-slice.ts',
                `
        import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
        
        export interface Article {
          id: string;
          title: string;
        }
        
        export type ArticleResponse = Article[];
        
        export const articlesApi = createApi({
          reducerPath: 'articlesApi',
          baseQuery: fetchBaseQuery({ baseUrl: '/api' }),
          endpoints: (builder) => ({
            getArticles: builder.query<ArticleResponse, void>({}),
            getArticleById: builder.query<Article, string>({}),
            createArticle: builder.mutation<Article, Partial<Article>>({}),
          }),
        });
        
        export const {
          useGetArticlesQuery,
          useGetArticleByIdQuery,
          useCreateArticleMutation,
          usePrefetch,
        } = articlesApi;
        
        export default articlesApi.reducer;
      `,
            );

            const exports = await extractExports(filePath);

            // Type exports
            expect(exports.types).toContain('Article');
            expect(exports.types).toContain('ArticleResponse');

            // Named value exports
            expect(exports.named).toContain('articlesApi');
            expect(exports.named).toContain('useGetArticlesQuery');
            expect(exports.named).toContain('useGetArticleByIdQuery');
            expect(exports.named).toContain('useCreateArticleMutation');
            expect(exports.named).toContain('usePrefetch');

            // Default export
            expect(exports.hasDefault).toBe(true);
        });
    });

    describe('type exports', () => {
        test('should extract type exports', async () => {
            const filePath = await createFile(
                tempDir,
                'types.ts',
                `
        export type UserId = string;
        export type Config = { name: string };
      `,
            );

            const exports = await extractExports(filePath);

            expect(exports.types).toContain('UserId');
            expect(exports.types).toContain('Config');
            expect(exports.named).not.toContain('UserId');
        });

        test('should extract interface exports', async () => {
            const filePath = await createFile(
                tempDir,
                'interfaces.ts',
                `
        export interface User {
          id: string;
          name: string;
        }
        export interface Settings {
          theme: string;
        }
      `,
            );

            const exports = await extractExports(filePath);

            expect(exports.types).toContain('User');
            expect(exports.types).toContain('Settings');
        });

        test('should extract export type { } blocks', async () => {
            const filePath = await createFile(
                tempDir,
                'type-reexports.ts',
                `
        type InternalType = string;
        interface InternalInterface { x: number }
        export type { InternalType, InternalInterface };
      `,
            );

            const exports = await extractExports(filePath);

            expect(exports.types).toContain('InternalType');
            expect(exports.types).toContain('InternalInterface');
        });
    });

    describe('re-export exclusion', () => {
        test('should NOT extract named re-exports as local exports', async () => {
            // Barrel file that re-exports from other modules
            const filePath = await createFile(
                tempDir,
                'barrel.ts',
                `
        export { Button } from './Button';
        export { Input, Select } from './form';
        export { default as Modal } from './Modal';
      `,
            );

            const exports = await extractExports(filePath);

            // These are re-exports, not local exports - should be empty
            expect(exports.named).toHaveLength(0);
            expect(exports.hasDefault).toBe(false);
        });

        test('should NOT extract type re-exports as local exports', async () => {
            const filePath = await createFile(
                tempDir,
                'type-barrel.ts',
                `
        export type { ButtonProps } from './Button';
        export type { Config, Settings } from './types';
      `,
            );

            const exports = await extractExports(filePath);

            expect(exports.types).toHaveLength(0);
        });

        test('should distinguish between local exports and re-exports in same file', async () => {
            const filePath = await createFile(
                tempDir,
                'mixed.ts',
                `
        // Local export
        export const LOCAL_CONST = 'local';
        export function localHelper() {}
        
        // Re-export from another file
        export { ExternalThing } from './external';
        
        // Local type
        export type LocalType = string;
        
        // Type re-export
        export type { ExternalType } from './types';
      `,
            );

            const exports = await extractExports(filePath);

            // Should have local exports
            expect(exports.named).toContain('LOCAL_CONST');
            expect(exports.named).toContain('localHelper');
            expect(exports.types).toContain('LocalType');

            // Should NOT have re-exports
            expect(exports.named).not.toContain('ExternalThing');
            expect(exports.types).not.toContain('ExternalType');
        });
    });

    describe('default exports', () => {
        test('should detect default function export with name', async () => {
            const filePath = await createFile(
                tempDir,
                'Component.tsx',
                `
        export default function Button() {
          return <button>Click me</button>;
        }
      `,
            );

            const exports = await extractExports(filePath);

            expect(exports.hasDefault).toBe(true);
            expect(exports.defaultName).toBe('Button');
        });

        test('should detect default class export with name', async () => {
            const filePath = await createFile(
                tempDir,
                'Service.ts',
                `
        export default class ApiService {
          fetch() {}
        }
      `,
            );

            const exports = await extractExports(filePath);

            expect(exports.hasDefault).toBe(true);
            expect(exports.defaultName).toBe('ApiService');
        });

        test('should detect default export referencing a variable', async () => {
            const filePath = await createFile(
                tempDir,
                'Page.tsx',
                `
        const LoginPage = () => <div>Login</div>;
        export default LoginPage;
      `,
            );

            const exports = await extractExports(filePath);

            expect(exports.hasDefault).toBe(true);
            expect(exports.defaultName).toBe('LoginPage');
        });

        test('should detect anonymous default export', async () => {
            const filePath = await createFile(
                tempDir,
                'anonymous.ts',
                `
        export default () => console.log('anonymous');
      `,
            );

            const exports = await extractExports(filePath);

            expect(exports.hasDefault).toBe(true);
            expect(exports.defaultName).toBeUndefined();
        });
    });

    describe('deduplication', () => {
        test('should deduplicate named exports', async () => {
            // This can happen with complex re-export patterns
            const filePath = await createFile(
                tempDir,
                'dupe.ts',
                `
        export const foo = 1;
        export { foo };
      `,
            );

            const exports = await extractExports(filePath);

            // Should only appear once
            expect(exports.named.filter((n) => n === 'foo')).toHaveLength(1);
        });
    });

    describe('edge cases', () => {
        test('should handle empty file', async () => {
            const filePath = await createFile(tempDir, 'empty.ts', '');

            const exports = await extractExports(filePath);

            expect(exports.named).toHaveLength(0);
            expect(exports.types).toHaveLength(0);
            expect(exports.hasDefault).toBe(false);
        });

        test('should handle file with only imports', async () => {
            const filePath = await createFile(
                tempDir,
                'imports-only.ts',
                `
        import { something } from 'somewhere';
        import type { SomeType } from 'types';
      `,
            );

            const exports = await extractExports(filePath);

            expect(exports.named).toHaveLength(0);
            expect(exports.types).toHaveLength(0);
            expect(exports.hasDefault).toBe(false);
        });

        test('should handle file that does not exist', async () => {
            const exports = await extractExports(
                join(tempDir, 'nonexistent.ts'),
            );

            expect(exports.named).toHaveLength(0);
            expect(exports.types).toHaveLength(0);
            expect(exports.hasDefault).toBe(false);
        });
    });
});

// ============================================================================
// GENERATE INDEX FILE
// ============================================================================

describe('generateIndexFile', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await createTempDir();
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    describe('basic generation', () => {
        test('should generate index with named exports', async () => {
            await createFile(
                tempDir,
                'utils.ts',
                `
        export const helper = () => {};
        export function process() {}
      `,
            );

            const result = await generateIndexFile(tempDir, { dryRun: true });

            expect(result.generated).toBe(true);
            expect(result.content).toContain(
                "export { helper, process } from './utils';",
            );
            expect(result.exports).toContain('helper');
            expect(result.exports).toContain('process');
        });

        test('should generate index with type exports', async () => {
            await createFile(
                tempDir,
                'types.ts',
                `
        export type UserId = string;
        export interface User { id: UserId }
      `,
            );

            const result = await generateIndexFile(tempDir, { dryRun: true });

            expect(result.generated).toBe(true);
            expect(result.content).toContain(
                "export type { UserId, User } from './types';",
            );
        });

        test('should generate index with default export re-export', async () => {
            await createFile(
                tempDir,
                'Button.tsx',
                `
        export default function Button() {
          return <button />;
        }
      `,
            );

            const result = await generateIndexFile(tempDir, { dryRun: true });

            expect(result.generated).toBe(true);
            expect(result.content).toContain(
                "export { default as Button } from './Button';",
            );
        });

        test('should handle mixed exports from single file', async () => {
            await createFile(
                tempDir,
                'component.tsx',
                `
        export const CONSTANT = 'value';
        export type Props = { label: string };
        export default function Component() { return null; }
      `,
            );

            const result = await generateIndexFile(tempDir, { dryRun: true });

            expect(result.generated).toBe(true);
            expect(result.content).toContain(
                "export { CONSTANT } from './component';",
            );
            expect(result.content).toContain(
                "export type { Props } from './component';",
            );
            expect(result.content).toContain(
                "export { default as Component } from './component';",
            );
        });
    });

    describe('duplicate export prevention (regression test)', () => {
        test('should not generate duplicate exports when same name exists in multiple files', async () => {
            // This is the bug scenario: LogInPage is exported from its own file
            // AND re-exported from a barrel file
            await createFile(
                tempDir,
                'containers/LogInPage.tsx',
                `
        const LogInPage = () => <div>Login</div>;
        export default LogInPage;
      `,
            );

            // Barrel file that re-exports
            await createFile(
                tempDir,
                'containers/index.ts',
                `
        export { default as LogInPage } from './LogInPage';
        export { default as SignUpPage } from './SignUpPage';
      `,
            );

            await createFile(
                tempDir,
                'containers/SignUpPage.tsx',
                `
        const SignUpPage = () => <div>Sign Up</div>;
        export default SignUpPage;
      `,
            );

            const result = await generateIndexFile(tempDir, { dryRun: true });

            expect(result.generated).toBe(true);

            // Count occurrences of LogInPage as a named export - should only appear once
            // Note: `export { default }` lines may contain the name in the path but are not named exports
            const exportLineMatches = result.content
                .split('\n')
                .filter(
                    (line) =>
                        line.includes('export') &&
                        line.includes('as LogInPage'),
                );

            expect(exportLineMatches).toHaveLength(1);

            // Same for SignUpPage
            const signUpPageMatches = result.content
                .split('\n')
                .filter(
                    (line) =>
                        line.includes('export') &&
                        line.includes('as SignUpPage'),
                );

            expect(signUpPageMatches).toHaveLength(1);
        });

        test('should not duplicate when component is both default-exported and re-exported', async () => {
            // Component file with named default
            await createFile(
                tempDir,
                'MapContainer.tsx',
                `
        export default function MapContainer() {
          return <div>Map</div>;
        }
      `,
            );

            // Another file that re-exports it
            await createFile(
                tempDir,
                'homepage/MapContainer.tsx',
                `
        export { default as MapContainer } from '../MapContainer';
      `,
            );

            const result = await generateIndexFile(tempDir, { dryRun: true });

            // Count named exports of MapContainer - should only appear once
            // Note: `export { default }` lines may contain the name in the path but are not named exports
            const mapContainerExports = result.content
                .split('\n')
                .filter(
                    (line) =>
                        line.includes('export') &&
                        line.includes('as MapContainer'),
                );

            expect(mapContainerExports).toHaveLength(1);
        });

        test('should not duplicate when file has both named export and default export of same name', async () => {
            // This a pattern: file has both named and default export
            await createFile(
                tempDir,
                'containers/LogInPage.tsx',
                `
        export function LogInPage() {
          return <div>Login</div>;
        }
        export default LogInPage;
      `,
            );

            await createFile(
                tempDir,
                'containers/SignUpPage.tsx',
                `
        export function SignUpPage() {
          return <div>Sign Up</div>;
        }
        export default SignUpPage;
      `,
            );

            const result = await generateIndexFile(tempDir, { dryRun: true });

            expect(result.generated).toBe(true);

            // LogInPage should only appear once (either as named or default-as-named, not both)
            const logInPageExports = result.content
                .split('\n')
                .filter(
                    (line) =>
                        line.includes('export') && line.includes('LogInPage'),
                );

            expect(logInPageExports).toHaveLength(1);

            // Same for SignUpPage
            const signUpPageExports = result.content
                .split('\n')
                .filter(
                    (line) =>
                        line.includes('export') && line.includes('SignUpPage'),
                );

            expect(signUpPageExports).toHaveLength(1);
        });

        test('should handle complex barrel re-export scenarios', async () => {
            // Multiple component files
            await createFile(
                tempDir,
                'components/Button.tsx',
                `
        export default function Button() { return null; }
      `,
            );

            await createFile(
                tempDir,
                'components/Input.tsx',
                `
        export default function Input() { return null; }
      `,
            );

            await createFile(
                tempDir,
                'components/Modal.tsx',
                `
        export default function Modal() { return null; }
      `,
            );

            // Barrel file re-exporting all
            await createFile(
                tempDir,
                'components/index.ts',
                `
        export { default as Button } from './Button';
        export { default as Input } from './Input';
        export { default as Modal } from './Modal';
      `,
            );

            const result = await generateIndexFile(tempDir, { dryRun: true });

            // Each component should only appear once as a named export
            // Note: `export { default }` lines may contain names in paths but are not named exports
            for (const name of ['Button', 'Input', 'Modal']) {
                const exports = result.content
                    .split('\n')
                    .filter(
                        (line) =>
                            line.includes('export') &&
                            line.includes(`as ${name}`),
                    );

                expect(exports).toHaveLength(1);
            }
        });
    });

    describe('default re-export for directory imports', () => {
        test('should add export { default } when file name matches directory', async () => {
            // Common pattern: Portal/Portal.tsx with default export
            await createFile(
                tempDir,
                'Portal/Portal.tsx',
                `export default function Portal() { return <div />; }`,
            );

            const result = await generateIndexFile(join(tempDir, 'Portal'), {
                dryRun: true,
            });

            expect(result.generated).toBe(true);
            expect(result.content).toContain(
                "export { default as Portal } from './Portal';",
            );
            expect(result.content).toContain(
                "export { default } from './Portal';",
            );
        });

        test('should add export { default } from first default export when no file matches directory', async () => {
            // When directory has files that don't match the directory name
            await createFile(
                tempDir,
                'Portal/Component.tsx',
                `export default function Component() { return <div />; }`,
            );

            const result = await generateIndexFile(join(tempDir, 'Portal'), {
                dryRun: true,
            });

            expect(result.generated).toBe(true);
            expect(result.content).toContain(
                "export { default as Component } from './Component';",
            );
            // Should use first default export as fallback for `import X from './Portal'`
            expect(result.content).toContain(
                "export { default } from './Component';",
            );
        });

        test('should prefer root directory files for default re-export', async () => {
            // When there are files at different levels, prefer root directory
            await createFile(
                tempDir,
                'Modal/Modal.tsx',
                `export default function Modal() { return <div />; }`,
            );
            await createFile(
                tempDir,
                'Modal/sub/Other.tsx',
                `export default function Other() { return <div />; }`,
            );

            const result = await generateIndexFile(join(tempDir, 'Modal'), {
                dryRun: true,
            });

            expect(result.generated).toBe(true);
            // Should use Modal from root, not Other from subdirectory
            expect(result.content).toContain(
                "export { default } from './Modal';",
            );
        });

        test('should not add export { default } when there are no default exports', async () => {
            await createFile(
                tempDir,
                'utils/helpers.ts',
                `export function helper1() {} export function helper2() {}`,
            );

            const result = await generateIndexFile(join(tempDir, 'utils'), {
                dryRun: true,
            });

            expect(result.generated).toBe(true);
            expect(result.content).not.toContain('export { default }');
        });

        test('should work for package directories', async () => {
            // When the package directory name should be the default export
            await createFile(
                tempDir,
                'Tooltip.tsx',
                `export default function Tooltip() { return <div />; }`,
            );

            // Generate index for the parent directory (tempDir acts as "Tooltip" package)
            const result = await generateIndexFile(tempDir, { dryRun: true });

            expect(result.generated).toBe(true);
            expect(result.content).toContain(
                "export { default as Tooltip } from './Tooltip';",
            );
            // If the default export name matches the package directory, add default re-export
            // In this case, tempDir has a random name so it won't match, but the fallback should work
            expect(result.content).toContain(
                "export { default } from './Tooltip';",
            );
        });
    });

    describe('file exclusions', () => {
        test('should exclude test files', async () => {
            await createFile(tempDir, 'utils.ts', 'export const helper = 1;');
            await createFile(
                tempDir,
                'utils.test.ts',
                'export const testHelper = 1;',
            );
            await createFile(
                tempDir,
                'utils.spec.ts',
                'export const specHelper = 1;',
            );

            const result = await generateIndexFile(tempDir, { dryRun: true });

            expect(result.content).toContain('helper');
            expect(result.content).not.toContain('testHelper');
            expect(result.content).not.toContain('specHelper');
        });

        test('should exclude story files', async () => {
            await createFile(
                tempDir,
                'Button.tsx',
                'export default function Button() {}',
            );
            await createFile(
                tempDir,
                'Button.stories.tsx',
                'export default { title: "Button" };',
            );

            const result = await generateIndexFile(tempDir, { dryRun: true });

            expect(result.content).toContain('Button');
            expect(result.content).not.toContain('stories');
        });

        test('should exclude .d.ts files', async () => {
            await createFile(tempDir, 'types.ts', 'export type Foo = string;');
            await createFile(
                tempDir,
                'types.d.ts',
                'export type Bar = number;',
            );

            const result = await generateIndexFile(tempDir, { dryRun: true });

            expect(result.exports).toContain('Foo');
            expect(result.exports).not.toContain('Bar');
        });
    });

    describe('src/ directory handling', () => {
        test('should write to src/index.ts when src/ exists', async () => {
            await createFile(tempDir, 'src/utils.ts', 'export const util = 1;');

            const result = await generateIndexFile(tempDir, { dryRun: false });

            expect(result.generated).toBe(true);

            // Verify file was created in src/
            const indexContent = await readFileContent(
                join(tempDir, 'src', 'index.ts'),
            );
            expect(indexContent).toContain("from './utils'");
            // Should NOT have 'src/' in the path since index is inside src/
            expect(indexContent).not.toContain("from './src/");
        });

        test('should write to root when no src/ exists', async () => {
            await createFile(tempDir, 'utils.ts', 'export const util = 1;');

            const result = await generateIndexFile(tempDir, { dryRun: false });

            expect(result.generated).toBe(true);

            // Verify file was created at root
            const indexContent = await readFileContent(
                join(tempDir, 'index.ts'),
            );
            expect(indexContent).toContain("from './utils'");
        });
    });

    describe('subdirectory handling', () => {
        test('should handle index files in subdirectories', async () => {
            await createFile(
                tempDir,
                'components/Button/index.tsx',
                `
        export default function Button() { return null; }
        export const ButtonVariant = 'primary';
      `,
            );

            const result = await generateIndexFile(tempDir, { dryRun: true });

            expect(result.generated).toBe(true);
            // Should use directory path, not 'components/Button/index'
            expect(result.content).toContain("from './components/Button'");
            expect(result.content).not.toContain('/index');
        });
    });

    describe('edge cases', () => {
        test('should return generated: false for empty package', async () => {
            // Create temp dir but don't add any files

            const result = await generateIndexFile(tempDir, { dryRun: true });

            expect(result.generated).toBe(false);
            expect(result.content).toBe('');
            expect(result.exports).toHaveLength(0);
        });

        test('should return generated: false when no exports found', async () => {
            await createFile(
                tempDir,
                'internal.ts',
                `
        const internal = 1;
        function privateHelper() {}
      `,
            );

            const result = await generateIndexFile(tempDir, { dryRun: true });

            expect(result.generated).toBe(false);
        });

        test('should call onProgress callback', async () => {
            await createFile(tempDir, 'utils.ts', 'export const util = 1;');

            const messages: string[] = [];
            await generateIndexFile(tempDir, {
                dryRun: true,
                onProgress: (msg) => messages.push(msg),
            });

            expect(messages.length).toBeGreaterThan(0);
        });

        test('should use filename for anonymous default export', async () => {
            await createFile(
                tempDir,
                'MyComponent.tsx',
                `
        export default () => <div />;
      `,
            );

            const result = await generateIndexFile(tempDir, { dryRun: true });

            // Should use filename since no explicit name
            expect(result.content).toContain(
                'export { default as MyComponent }',
            );
        });
    });
});

// ============================================================================
// GENERATE SCSS MODULE DECLARATIONS
// ============================================================================

describe('generateScssModuleDeclarations', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await createTempDir();
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    test('should generate .d.ts for .module.scss files', async () => {
        await createFile(
            tempDir,
            'Button.module.scss',
            '.button { color: red; }',
        );

        const count = await generateScssModuleDeclarations(tempDir, {
            dryRun: false,
        });

        expect(count).toBe(1);

        const dtsContent = await readFileContent(
            join(tempDir, 'Button.module.scss.d.ts'),
        );
        expect(dtsContent).toContain('declare const styles');
        expect(dtsContent).toContain('readonly [key: string]: string');
        expect(dtsContent).toContain('export default styles');
    });

    test('should generate .d.ts for .module.css files', async () => {
        await createFile(
            tempDir,
            'styles.module.css',
            '.container { padding: 16px; }',
        );

        const count = await generateScssModuleDeclarations(tempDir, {
            dryRun: false,
        });

        expect(count).toBe(1);

        const dtsContent = await readFileContent(
            join(tempDir, 'styles.module.css.d.ts'),
        );
        expect(dtsContent).toContain('declare const styles');
    });

    test('should generate .d.ts for .module.sass files', async () => {
        await createFile(
            tempDir,
            'legacy.module.sass',
            '.legacy\n  color: blue',
        );

        const count = await generateScssModuleDeclarations(tempDir, {
            dryRun: false,
        });

        expect(count).toBe(1);
    });

    test('should generate .d.ts for .module.less files', async () => {
        await createFile(tempDir, 'app.module.less', '.app { margin: 0; }');

        const count = await generateScssModuleDeclarations(tempDir, {
            dryRun: false,
        });

        expect(count).toBe(1);
    });

    test('should skip if .d.ts already exists', async () => {
        await createFile(tempDir, 'Existing.module.scss', '.existing { }');
        await createFile(
            tempDir,
            'Existing.module.scss.d.ts',
            '// existing declaration',
        );

        const count = await generateScssModuleDeclarations(tempDir, {
            dryRun: false,
        });

        expect(count).toBe(0);

        // Original should be unchanged
        const dtsContent = await readFileContent(
            join(tempDir, 'Existing.module.scss.d.ts'),
        );
        expect(dtsContent).toBe('// existing declaration');
    });

    test('should process nested directories', async () => {
        await createFile(
            tempDir,
            'components/Button/Button.module.scss',
            '.btn { }',
        );
        await createFile(tempDir, 'pages/Home/Home.module.scss', '.home { }');

        const count = await generateScssModuleDeclarations(tempDir, {
            dryRun: false,
        });

        expect(count).toBe(2);
    });

    test('should skip node_modules', async () => {
        await createFile(
            tempDir,
            'node_modules/some-package/styles.module.scss',
            '.x { }',
        );
        await createFile(tempDir, 'src/App.module.scss', '.app { }');

        const count = await generateScssModuleDeclarations(tempDir, {
            dryRun: false,
        });

        expect(count).toBe(1);
    });

    test('should not create files in dry run mode', async () => {
        await createFile(tempDir, 'DryRun.module.scss', '.dry { }');

        const count = await generateScssModuleDeclarations(tempDir, {
            dryRun: true,
        });

        expect(count).toBe(1);

        // File should not exist
        try {
            await readFileContent(join(tempDir, 'DryRun.module.scss.d.ts'));
            expect.fail('File should not exist in dry run');
        } catch {
            // Expected - file doesn't exist
        }
    });

    test('should call onProgress callback', async () => {
        await createFile(tempDir, 'Progress.module.scss', '.x { }');

        const messages: string[] = [];
        await generateScssModuleDeclarations(tempDir, {
            dryRun: false,
            onProgress: (msg) => messages.push(msg),
        });

        expect(messages.length).toBeGreaterThan(0);
        expect(messages.some((m) => m.includes('Progress.module.scss'))).toBe(
            true,
        );
    });
});

// ============================================================================
// ANALYZE PACKAGE
// ============================================================================

describe('analyzePackage', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await createTempDir();
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    test('should detect existing index.ts at root', async () => {
        await createFile(tempDir, 'my-package/index.ts', 'export const x = 1;');

        const info = await analyzePackage(join(tempDir, 'my-package'));

        expect(info.hasIndex).toBe(true);
        expect(info.name).toBe('my-package');
    });

    test('should detect existing index.ts in src/', async () => {
        await createFile(
            tempDir,
            'my-package/src/index.ts',
            'export const x = 1;',
        );

        const info = await analyzePackage(join(tempDir, 'my-package'));

        expect(info.hasIndex).toBe(true);
    });

    test('should detect index.tsx', async () => {
        await createFile(
            tempDir,
            'my-package/index.tsx',
            'export default () => null;',
        );

        const info = await analyzePackage(join(tempDir, 'my-package'));

        expect(info.hasIndex).toBe(true);
    });

    test('should report hasIndex: false when no index exists', async () => {
        await createFile(
            tempDir,
            'my-package/utils.ts',
            'export const util = 1;',
        );

        const info = await analyzePackage(join(tempDir, 'my-package'));

        expect(info.hasIndex).toBe(false);
    });

    test('should collect exported modules', async () => {
        await createFile(
            tempDir,
            'my-package/utils.ts',
            `
      export const helper = 1;
      export function process() {}
    `,
        );
        await createFile(
            tempDir,
            'my-package/types.ts',
            `
      export type Config = { x: number };
    `,
        );

        const info = await analyzePackage(join(tempDir, 'my-package'));

        expect(info.exportedModules).toContain('helper');
        expect(info.exportedModules).toContain('process');
        expect(info.exportedModules).toContain('Config');
    });

    test('should include default export names', async () => {
        await createFile(
            tempDir,
            'my-package/Button.tsx',
            `
      export default function Button() { return null; }
    `,
        );

        const info = await analyzePackage(join(tempDir, 'my-package'));

        expect(info.exportedModules).toContain('Button');
    });

    test('should deduplicate exported modules', async () => {
        await createFile(
            tempDir,
            'my-package/a.ts',
            'export const shared = 1;',
        );
        await createFile(
            tempDir,
            'my-package/b.ts',
            'export const shared = 2;',
        );

        const info = await analyzePackage(join(tempDir, 'my-package'));

        expect(
            info.exportedModules.filter((m: string) => m === 'shared'),
        ).toHaveLength(1);
    });
});

// ============================================================================
// FIND PACKAGES NEEDING INDEX
// ============================================================================

describe('findPackagesNeedingIndex', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await createTempDir();
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    test('should find internal packages without index files', async () => {
        await createFile(
            tempDir,
            'node_modules/internal-pkg/utils.ts',
            'export const x = 1;',
        );

        const internalPackages = new Set(['internal-pkg']);
        const packages = await findPackagesNeedingIndex(
            tempDir,
            internalPackages,
        );

        expect(packages).toHaveLength(1);
        expect(packages[0]).toContain('internal-pkg');
    });

    test('should not include packages that already have index', async () => {
        await createFile(
            tempDir,
            'node_modules/has-index/index.ts',
            'export const x = 1;',
        );
        await createFile(
            tempDir,
            'node_modules/has-index/other.ts',
            'export const y = 2;',
        );

        const internalPackages = new Set(['has-index']);
        const packages = await findPackagesNeedingIndex(
            tempDir,
            internalPackages,
        );

        expect(packages).toHaveLength(0);
    });

    test('should find scoped packages', async () => {
        await createFile(
            tempDir,
            'node_modules/@myorg/utils/helper.ts',
            'export const help = 1;',
        );

        const internalPackages = new Set(['@myorg/utils']);
        const packages = await findPackagesNeedingIndex(
            tempDir,
            internalPackages,
        );

        expect(packages).toHaveLength(1);
        expect(packages[0]).toContain('@myorg/utils');
    });

    test('should not include packages with no exports', async () => {
        await createFile(
            tempDir,
            'node_modules/empty-pkg/internal.ts',
            'const x = 1;',
        );

        const internalPackages = new Set(['empty-pkg']);
        const packages = await findPackagesNeedingIndex(
            tempDir,
            internalPackages,
        );

        expect(packages).toHaveLength(0);
    });

    test('should not include packages not in internalPackages set', async () => {
        await createFile(
            tempDir,
            'node_modules/external-pkg/utils.ts',
            'export const x = 1;',
        );

        const internalPackages = new Set(['different-pkg']);
        const packages = await findPackagesNeedingIndex(
            tempDir,
            internalPackages,
        );

        expect(packages).toHaveLength(0);
    });
});

// ============================================================================
// SCAN IMPORTS
// ============================================================================

describe('scanImports', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await createTempDir();
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    test('should detect directory imports without index files', async () => {
        // Create a directory with exports but no index
        await createFile(
            tempDir,
            'src/redux/store.ts',
            'export const store = {};',
        );
        await createFile(
            tempDir,
            'src/redux/hooks.ts',
            'export const useAppDispatch = () => {};',
        );

        // Create a file that imports from the directory
        await createFile(
            tempDir,
            'src/components/App.tsx',
            `
      import { useAppDispatch } from '../redux';
      export const App = () => null;
    `,
        );

        const result = await scanImports(tempDir);

        expect(result.directoryImports.length).toBe(1);
        expect(result.directoryImports[0].importPath).toBe('../redux');
        expect(result.directoryImports[0].isDirectoryImport).toBe(true);
    });

    test('should detect CSS module imports', async () => {
        await createFile(
            tempDir,
            'src/Button.tsx',
            `
      import styles from './Button.module.scss';
      export const Button = () => <div className={styles.btn} />;
    `,
        );

        const result = await scanImports(tempDir);

        expect(result.cssModuleImports.length).toBe(1);
        expect(result.cssModuleImports[0].importPath).toBe(
            './Button.module.scss',
        );
    });

    test('should detect external package imports', async () => {
        await createFile(
            tempDir,
            'src/App.tsx',
            `
      import React from 'react';
      import { Button } from 'sarsaparilla';
      import { helper } from 'shared-ui/utils';
      import { something } from '@scope/package';
      export const App = () => null;
    `,
        );

        const result = await scanImports(tempDir);

        const packageNames = result.externalPackageImports.map((i) => {
            if (i.importPath.startsWith('@')) {
                const parts = i.importPath.split('/');
                return `${parts[0]}/${parts[1]}`;
            }
            return i.importPath.split('/')[0];
        });

        expect(packageNames).toContain('react');
        expect(packageNames).toContain('sarsaparilla');
        expect(packageNames).toContain('shared-ui');
        expect(packageNames).toContain('@scope/package');
    });

    test('should not include Node.js built-in modules', async () => {
        await createFile(
            tempDir,
            'src/utils.ts',
            `
      import fs from 'fs';
      import path from 'path';
      import { readFile } from 'node:fs/promises';
      export const util = 1;
    `,
        );

        const result = await scanImports(tempDir);

        const packageNames = result.externalPackageImports.map(
            (i) => i.importPath.split('/')[0],
        );
        expect(packageNames).not.toContain('fs');
        expect(packageNames).not.toContain('path');
        expect(packageNames).not.toContain('node:fs');
    });

    test('should not flag directories with existing index files', async () => {
        await createFile(
            tempDir,
            'src/utils/index.ts',
            'export const helper = 1;',
        );
        await createFile(
            tempDir,
            'src/utils/math.ts',
            'export const add = (a, b) => a + b;',
        );
        await createFile(
            tempDir,
            'src/App.tsx',
            `
      import { helper } from './utils';
      export const App = () => null;
    `,
        );

        const result = await scanImports(tempDir);

        // Should not include utils since it has an index file
        expect(result.directoryImports.length).toBe(0);
    });
});

// ============================================================================
// GENERATE DIRECTORY INDEX FILES
// ============================================================================

describe('generateDirectoryIndexFiles', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await createTempDir();
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    test('should generate index for imported directories', async () => {
        // Create redux directory with exports
        await createFile(
            tempDir,
            'src/redux/store.ts',
            `
      export const store = {};
      export type RootState = {};
    `,
        );
        await createFile(
            tempDir,
            'src/redux/hooks.ts',
            `
      export const useAppDispatch = () => {};
      export const useAppSelector = () => {};
    `,
        );

        // Create file importing from redux directory
        await createFile(
            tempDir,
            'src/App.tsx',
            `
      import { useAppDispatch } from './redux';
    `,
        );

        // Scan for imports
        const imports = await scanImports(tempDir);

        // Generate index files
        const count = await generateDirectoryIndexFiles(
            tempDir,
            imports.directoryImports,
            { dryRun: false },
        );

        expect(count).toBe(1);

        // Verify index was created
        const indexContent = await readFileContent(
            join(tempDir, 'src/redux/index.ts'),
        );
        expect(indexContent).toContain('store');
        expect(indexContent).toContain('useAppDispatch');
        expect(indexContent).toContain('useAppSelector');
    });
});

// ============================================================================
// GENERATE MISSING CSS MODULE STUBS
// ============================================================================

describe('generateMissingCssModuleStubs', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await createTempDir();
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    test('should generate stub for missing CSS module', async () => {
        await createFile(
            tempDir,
            'src/Button.tsx',
            `
      import styles from './Button.module.scss';
      export const Button = () => <div className={styles.btn} />;
    `,
        );
        // Note: Button.module.scss does NOT exist

        const imports = await scanImports(tempDir);
        const count = await generateMissingCssModuleStubs(
            tempDir,
            imports.cssModuleImports,
            { dryRun: false },
        );

        expect(count).toBe(1);

        // Check that CSS file was created
        const cssContent = await readFileContent(
            join(tempDir, 'src/Button.module.scss'),
        );
        expect(cssContent).toContain('Auto-generated CSS module stub');

        // Check that .d.ts was created
        const dtsContent = await readFileContent(
            join(tempDir, 'src/Button.module.scss.d.ts'),
        );
        expect(dtsContent).toContain('declare const styles');
    });

    test('should not overwrite existing CSS modules', async () => {
        const originalCss = '.existing { color: red; }';
        await createFile(tempDir, 'src/Existing.module.scss', originalCss);
        await createFile(
            tempDir,
            'src/Component.tsx',
            `
      import styles from './Existing.module.scss';
    `,
        );

        const imports = await scanImports(tempDir);
        const count = await generateMissingCssModuleStubs(
            tempDir,
            imports.cssModuleImports,
            { dryRun: false },
        );

        expect(count).toBe(0);

        // Original should be unchanged
        const cssContent = await readFileContent(
            join(tempDir, 'src/Existing.module.scss'),
        );
        expect(cssContent).toBe(originalCss);
    });
});

// ============================================================================
// GENERATE EXTERNAL PACKAGE STUBS
// ============================================================================

describe('generateExternalPackageStubs', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await createTempDir();
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    test('should generate stubs for missing external packages', async () => {
        await createFile(
            tempDir,
            'src/App.tsx',
            `
      import { Button } from 'missing-ui-library';
      import { helper } from 'another-missing-pkg/utils';
    `,
        );

        const imports = await scanImports(tempDir);
        const installedPackages = new Set<string>();
        const count = await generateExternalPackageStubs(
            tempDir,
            imports.externalPackageImports,
            installedPackages,
            { dryRun: false },
        );

        expect(count).toBe(2);

        // Check that stub declarations were created
        const stub1 = await readFileContent(
            join(tempDir, '@types/missing-ui-library/index.d.ts'),
        );
        expect(stub1).toContain('missing-ui-library');
        expect(stub1).toContain('export default');

        const stub2 = await readFileContent(
            join(tempDir, '@types/another-missing-pkg/index.d.ts'),
        );
        expect(stub2).toContain('another-missing-pkg');
    });

    test('should not generate stubs for installed packages', async () => {
        await createFile(
            tempDir,
            'src/App.tsx',
            `
      import React from 'react';
      import { missing } from 'missing-pkg';
    `,
        );

        const imports = await scanImports(tempDir);
        const installedPackages = new Set(['react']);
        const count = await generateExternalPackageStubs(
            tempDir,
            imports.externalPackageImports,
            installedPackages,
            { dryRun: false },
        );

        expect(count).toBe(1); // Only missing-pkg, not react
    });

    test('should handle scoped packages', async () => {
        await createFile(
            tempDir,
            'src/App.tsx',
            `
      import { something } from '@company/internal-lib';
    `,
        );

        const imports = await scanImports(tempDir);
        const installedPackages = new Set<string>();
        const count = await generateExternalPackageStubs(
            tempDir,
            imports.externalPackageImports,
            installedPackages,
            { dryRun: false },
        );

        expect(count).toBe(1);

        // Check scoped package stub - uses __ instead of /
        const stubPath = join(
            tempDir,
            '@types/@company__internal-lib/index.d.ts',
        );
        const stub = await readFileContent(stubPath);
        expect(stub).toContain('@company/internal-lib');
    });
});

// ============================================================================
// REGRESSION TESTS - Internal Packages in node_modules
// ============================================================================

describe('internal packages in node_modules', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await createTempDir();
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    describe('scanImports with internal packages', () => {
        test('should find CSS module imports from internal packages in node_modules', async () => {
            // Setup: Create an internal package in node_modules with CSS module imports
            await createFile(
                tempDir,
                'node_modules/@fp/sarsaparilla/src/avatar/Avatar.tsx',
                `
        import React from 'react';
        import styles from './Avatar.module.scss';
        export const Avatar = () => <div className={styles.avatar}>Avatar</div>;
      `,
            );

            // Scan with internalPackages specified
            const imports = await scanImports(tempDir, {
                internalPackages: new Set(['@fp/sarsaparilla']),
            });

            // Should find the CSS module import
            expect(imports.cssModuleImports.length).toBeGreaterThanOrEqual(1);
            const avatarImport = imports.cssModuleImports.find((i) =>
                i.importPath.includes('Avatar.module.scss'),
            );
            expect(avatarImport).toBeDefined();
        });

        test('should find type file imports from internal packages in node_modules', async () => {
            // Setup: Create an internal package with type file imports
            await createFile(
                tempDir,
                'node_modules/@fp/sarsaparilla/src/card/Card.tsx',
                `
        import type { CardProps } from './Card.types';
        export const Card = (props: CardProps) => <div>{props.title}</div>;
      `,
            );

            const imports = await scanImports(tempDir, {
                internalPackages: new Set(['@fp/sarsaparilla']),
            });

            // Should find the missing type file import
            expect(
                imports.missingTypeFileImports.length,
            ).toBeGreaterThanOrEqual(1);
            const typeImport = imports.missingTypeFileImports.find((i) =>
                i.importPath.includes('Card.types'),
            );
            expect(typeImport).toBeDefined();
        });

        test('should find external package imports from internal packages', async () => {
            // Setup: Internal package importing external packages
            await createFile(
                tempDir,
                'node_modules/@fp/sarsaparilla/src/search/SearchBar.tsx',
                `
        import { Item, Section, useAsyncList } from 'react-stately';
        import { useOverlayTrigger } from 'react-aria';
        export const SearchBar = () => null;
      `,
            );

            const imports = await scanImports(tempDir, {
                internalPackages: new Set(['@fp/sarsaparilla']),
            });

            // Should find external package imports
            const reactStatelyImport = imports.externalPackageImports.find(
                (i) => i.importPath === 'react-stately',
            );
            const reactAriaImport = imports.externalPackageImports.find((i) =>
                i.importPath.startsWith('react-aria'),
            );
            expect(reactStatelyImport).toBeDefined();
            expect(reactAriaImport).toBeDefined();
        });

        test('should find directory imports without index files from internal packages', async () => {
            // Setup: Internal package importing a directory without index
            await createFile(
                tempDir,
                'node_modules/@fp/sarsaparilla/src/nav/Navbar.tsx',
                `
        import { Stack } from '../sharedComponents/LayoutPrimitives';
        export const Navbar = () => null;
      `,
            );
            // Create the directory but without an index file
            await mkdir(
                join(
                    tempDir,
                    'node_modules/@fp/sarsaparilla/src/sharedComponents/LayoutPrimitives',
                ),
                { recursive: true },
            );
            await createFile(
                tempDir,
                'node_modules/@fp/sarsaparilla/src/sharedComponents/LayoutPrimitives/Stack.tsx',
                `
        export const Stack = () => null;
      `,
            );

            const imports = await scanImports(tempDir, {
                internalPackages: new Set(['@fp/sarsaparilla']),
            });

            // Should find the directory import
            expect(imports.directoryImports.length).toBeGreaterThanOrEqual(1);
            const layoutImport = imports.directoryImports.find((i) =>
                i.importPath.includes('LayoutPrimitives'),
            );
            expect(layoutImport).toBeDefined();
        });
    });

    describe('generateStubFiles with internal packages', () => {
        test('should create CSS module stubs for imports in internal packages', async () => {
            // Setup: Internal package with CSS module import where the file doesn't exist
            await createFile(
                tempDir,
                'node_modules/@fp/sarsaparilla/src/avatar/Avatar.tsx',
                `
        import styles from './Avatar.module.scss';
        export const Avatar = () => <div className={styles.avatar} />;
      `,
            );

            const imports = await scanImports(tempDir, {
                internalPackages: new Set(['@fp/sarsaparilla']),
            });
            await generateMissingCssModuleStubs(
                tempDir,
                imports.cssModuleImports,
                { dryRun: false },
            );

            // CSS module stub should be created
            const cssPath = join(
                tempDir,
                'node_modules/@fp/sarsaparilla/src/avatar/Avatar.module.scss',
            );
            const cssContent = await readFileContent(cssPath);
            expect(cssContent).toContain('Auto-generated CSS module stub');

            // .d.ts should also be created
            const dtsPath = cssPath + '.d.ts';
            const dtsContent = await readFileContent(dtsPath);
            expect(dtsContent).toContain('declare const styles');
        });

        test('should create type file stubs for missing .types imports in internal packages', async () => {
            // Setup: Internal package with type file import where the file doesn't exist
            await createFile(
                tempDir,
                'node_modules/@fp/sarsaparilla/src/card/CardCarousel.tsx',
                `
        import type { CardCarouselProps, ResponsiveItems } from './CardCarousel.types';
        export const CardCarousel = (props: CardCarouselProps) => null;
      `,
            );

            const imports = await scanImports(tempDir, {
                internalPackages: new Set(['@fp/sarsaparilla']),
            });
            const { generateMissingTypeFileStubs } =
                await import('../src/stub-generator.js');
            await generateMissingTypeFileStubs(
                tempDir,
                imports.missingTypeFileImports,
                { dryRun: false },
            );

            // Type file stub should be created
            const typePath = join(
                tempDir,
                'node_modules/@fp/sarsaparilla/src/card/CardCarousel.types.ts',
            );
            const typeContent = await readFileContent(typePath);
            expect(typeContent).toContain('CardCarouselProps');
            expect(typeContent).toContain('ResponsiveItems');
        });

        test('should correctly extract type names from inline type modifiers (regression)', async () => {
            // Regression test: import { type ReduxStore } was being captured as "type ReduxStore"
            // instead of just "ReduxStore"
            await createFile(
                tempDir,
                'node_modules/@fp/sarsaparilla/src/redux/store.tsx',
                `
        import { type ReduxStore, type AppDispatch, useSelector } from './store.types';
        export const useAppStore = (store: ReduxStore) => store;
      `,
            );

            const imports = await scanImports(tempDir, {
                internalPackages: new Set(['@fp/sarsaparilla']),
            });
            const { generateMissingTypeFileStubs } =
                await import('../src/stub-generator.js');
            await generateMissingTypeFileStubs(
                tempDir,
                imports.missingTypeFileImports,
                { dryRun: false },
            );

            // Type file stub should be created with correct names (not "type ReduxStore")
            const typePath = join(
                tempDir,
                'node_modules/@fp/sarsaparilla/src/redux/store.types.ts',
            );
            const typeContent = await readFileContent(typePath);

            // Should have proper type names without the "type " prefix
            expect(typeContent).toContain('export type ReduxStore = any;');
            expect(typeContent).toContain('export type AppDispatch = any;');
            expect(typeContent).toContain('export type useSelector = any;');

            // Should NOT have the broken "type type ReduxStore" format
            expect(typeContent).not.toContain('type type ');
            expect(typeContent).not.toMatch(/export type type \w+/);
        });

        test('should handle mixed inline type modifiers and regular imports (regression)', async () => {
            // Mix of inline type modifiers and regular named imports
            await createFile(
                tempDir,
                'node_modules/@fp/sarsaparilla/src/components/Modal.tsx',
                `
        import { type ModalProps, Modal as BaseModal, type ModalState } from './Modal.types';
        import { useModal } from './Modal.types';
        export const CustomModal = (props: ModalProps) => <BaseModal {...props} />;
      `,
            );

            const imports = await scanImports(tempDir, {
                internalPackages: new Set(['@fp/sarsaparilla']),
            });
            const { generateMissingTypeFileStubs } =
                await import('../src/stub-generator.js');
            await generateMissingTypeFileStubs(
                tempDir,
                imports.missingTypeFileImports,
                { dryRun: false },
            );

            const typePath = join(
                tempDir,
                'node_modules/@fp/sarsaparilla/src/components/Modal.types.ts',
            );
            const typeContent = await readFileContent(typePath);

            // Should correctly extract: ModalProps, Modal (from "Modal as BaseModal"), ModalState, useModal
            expect(typeContent).toContain('export type ModalProps = any;');
            expect(typeContent).toContain('export type Modal = any;');
            expect(typeContent).toContain('export type ModalState = any;');
            expect(typeContent).toContain('export type useModal = any;');

            // Should NOT include BaseModal (that's the alias, not the original)
            expect(typeContent).not.toContain('BaseModal');
        });
    });
});

// ============================================================================
// REGRESSION TESTS - Duplicate Identifier Prevention
// ============================================================================

describe('duplicate identifier prevention', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await createTempDir();
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    test('should not create duplicate exports when same name exported as type and value', async () => {
        // This is the LocationSuggestion case:
        // - types.ts exports: export type { LocationSuggestion }
        // - LocationSuggestion.tsx exports: export { LocationSuggestion }
        await createFile(
            tempDir,
            'src/types.ts',
            `
      export type LocationSuggestion = { id: string; name: string };
      export type OtherType = { value: number };
    `,
        );
        await createFile(
            tempDir,
            'src/LocationSuggestion.tsx',
            `
      import React from 'react';
      export const LocationSuggestion = () => <div>Location</div>;
    `,
        );

        const { generated, content } = await generateIndexFile(tempDir, {
            dryRun: true,
        });

        expect(generated).toBe(true);

        // Count occurrences of LocationSuggestion exports
        const matches = content.match(/LocationSuggestion/g) || [];
        // Should only appear once in an export statement (either as type or value, not both)
        const exportMatches =
            content.match(/export.*LocationSuggestion/g) || [];
        expect(exportMatches.length).toBe(1);
    });

    test('should handle re-export of same name from default and named', async () => {
        // Case where a component is both:
        // - export function LogInPage() {}
        // - export default LogInPage;
        await createFile(
            tempDir,
            'src/LogInPage.tsx',
            `
      export function LogInPage() { return <div>Login</div>; }
      export default LogInPage;
    `,
        );

        const { generated, content } = await generateIndexFile(tempDir, {
            dryRun: true,
        });

        expect(generated).toBe(true);

        // LogInPage should only be exported once
        const exportMatches = content.match(/export.*LogInPage/g) || [];
        expect(exportMatches.length).toBe(1);
    });
});

// ============================================================================
// REGRESSION TESTS - SCSS Module Declarations in Internal Packages
// ============================================================================

describe('SCSS module declarations in internal packages', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await createTempDir();
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    test('should generate .d.ts for existing SCSS modules in internal packages', async () => {
        // Setup: Internal package with existing SCSS module (no .d.ts)
        await createFile(
            tempDir,
            'node_modules/@fp/sarsaparilla/src/button/Button.module.scss',
            `
      .button { color: blue; }
    `,
        );

        const count = await generateScssModuleDeclarations(tempDir, {
            dryRun: false,
            internalPackages: new Set(['@fp/sarsaparilla']),
        });

        expect(count).toBe(1);

        // .d.ts should be created
        const dtsPath = join(
            tempDir,
            'node_modules/@fp/sarsaparilla/src/button/Button.module.scss.d.ts',
        );
        const dtsContent = await readFileContent(dtsPath);
        expect(dtsContent).toContain('declare const styles');
    });

    test('should NOT generate .d.ts for non-internal packages in node_modules', async () => {
        // Setup: External package (not in internalPackages) with SCSS module
        await createFile(
            tempDir,
            'node_modules/some-external-pkg/src/Widget.module.scss',
            `
      .widget { color: red; }
    `,
        );

        const count = await generateScssModuleDeclarations(tempDir, {
            dryRun: false,
            internalPackages: new Set(['@fp/sarsaparilla']), // some-external-pkg not listed
        });

        // Should not process external package
        expect(count).toBe(0);
    });
});

// ============================================================================
// FIX DUPLICATE EXPORTS
// ============================================================================

describe('fixDuplicateExports', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await createTempDir();
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    test('SWC parses exports correctly', () => {
        const code = `export type { Foo } from './types';
export { Foo } from './foo';
`;
        const ast = parseSync(code, { syntax: 'typescript', tsx: true });

        // Should have 2 export statements
        expect(ast.body.length).toBe(2);
        expect(ast.body[0].type).toBe('ExportNamedDeclaration');
        expect(ast.body[1].type).toBe('ExportNamedDeclaration');

        // Check first export (type export)
        const first = ast.body[0] as any;
        expect(first.typeOnly).toBe(true);
        expect(first.specifiers.length).toBe(1);
        expect(first.specifiers[0].type).toBe('ExportSpecifier');

        // Check second export (value export)
        const second = ast.body[1] as any;
        expect(second.typeOnly).toBeFalsy();
        expect(second.specifiers.length).toBe(1);
    });

    test('should remove duplicate exports when same name appears as type and value', async () => {
        // This is the LocationSuggestion case
        const indexContent = `// Auto-generated index file for reconstructed package
export type { ContentSuggestion, LocationSuggestion, HistorySuggestion } from './types';
export type { OtherType } from './other';
export { LocationSuggestion } from './LocationSuggestion';
export { SomeComponent } from './SomeComponent';
`;
        await createFile(tempDir, 'index.ts', indexContent);

        const { fixed, duplicatesRemoved } = await fixDuplicateExports(
            join(tempDir, 'index.ts'),
            { dryRun: false },
        );

        expect(fixed).toBe(true);
        expect(duplicatesRemoved).toContain('LocationSuggestion');

        // Read the fixed file
        const fixedContent = await readFileContent(join(tempDir, 'index.ts'));

        // LocationSuggestion should only appear once
        const matches = fixedContent.match(/LocationSuggestion/g) || [];
        expect(matches.length).toBe(1);

        // Other exports should still be present
        expect(fixedContent).toContain('ContentSuggestion');
        expect(fixedContent).toContain('HistorySuggestion');
        expect(fixedContent).toContain('SomeComponent');
    });

    test('should handle line with all duplicates by removing it', async () => {
        const indexContent = `// Auto-generated index file for reconstructed package
export { Foo, Bar } from './first';
export { Foo, Bar } from './second';
export { Baz } from './third';
`;
        await createFile(tempDir, 'index.ts', indexContent);

        const { fixed, duplicatesRemoved } = await fixDuplicateExports(
            join(tempDir, 'index.ts'),
            { dryRun: false },
        );

        expect(fixed).toBe(true);
        expect(duplicatesRemoved).toContain('Foo');
        expect(duplicatesRemoved).toContain('Bar');

        const fixedContent = await readFileContent(join(tempDir, 'index.ts'));

        // Should only have one export line for Foo, Bar and one for Baz
        const lines = fixedContent
            .split('\n')
            .filter((l) => l.startsWith('export'));
        expect(lines.length).toBe(2); // Foo,Bar from first + Baz from third
    });

    test('should not modify file without duplicates', async () => {
        const indexContent = `// Auto-generated index file for reconstructed package
export { Foo } from './foo';
export { Bar } from './bar';
export type { FooType } from './foo.types';
`;
        await createFile(tempDir, 'index.ts', indexContent);

        const { fixed, duplicatesRemoved } = await fixDuplicateExports(
            join(tempDir, 'index.ts'),
            { dryRun: false },
        );

        expect(fixed).toBe(false);
        expect(duplicatesRemoved).toHaveLength(0);
    });

    test('should work in dry run mode', async () => {
        const indexContent = `// Auto-generated index file for reconstructed package
export type { Foo } from './types';
export { Foo } from './foo';
`;
        await createFile(tempDir, 'index.ts', indexContent);

        const { fixed, duplicatesRemoved } = await fixDuplicateExports(
            join(tempDir, 'index.ts'),
            { dryRun: true },
        );

        expect(fixed).toBe(true);
        expect(duplicatesRemoved).toContain('Foo');

        // File should be unchanged in dry run
        const content = await readFileContent(join(tempDir, 'index.ts'));
        expect(content).toBe(indexContent);
    });
});

describe('fixAllDuplicateExports', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await createTempDir();
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    test('should fix duplicates in internal packages within node_modules', async () => {
        // Create internal package with duplicate exports
        const indexContent = `// Auto-generated index file for reconstructed package
export type { LocationSuggestion } from './types';
export { LocationSuggestion } from './LocationSuggestion';
`;
        await createFile(
            tempDir,
            'node_modules/@fp/sarsaparilla/src/index.ts',
            indexContent,
        );

        const fixedCount = await fixAllDuplicateExports(tempDir, {
            internalPackages: new Set(['@fp/sarsaparilla']),
            dryRun: false,
        });

        expect(fixedCount).toBe(1);

        // Verify the file was fixed
        const fixedContent = await readFileContent(
            join(tempDir, 'node_modules/@fp/sarsaparilla/src/index.ts'),
        );
        const matches = fixedContent.match(/LocationSuggestion/g) || [];
        expect(matches.length).toBe(1);
    });

    test('should NOT fix files in non-internal packages', async () => {
        // Create external package with duplicate exports (should not be touched)
        const indexContent = `// Auto-generated index file for reconstructed package
export type { Foo } from './types';
export { Foo } from './foo';
`;
        await createFile(
            tempDir,
            'node_modules/external-pkg/src/index.ts',
            indexContent,
        );

        const fixedCount = await fixAllDuplicateExports(tempDir, {
            internalPackages: new Set(['@fp/sarsaparilla']), // external-pkg not listed
            dryRun: false,
        });

        expect(fixedCount).toBe(0);

        // File should be unchanged
        const content = await readFileContent(
            join(tempDir, 'node_modules/external-pkg/src/index.ts'),
        );
        expect(content).toBe(indexContent);
    });
});

// ============================================================================
// EDGE CASE REGRESSION TESTS - Duplicate Export Fixing
// ============================================================================

describe('fixDuplicateExports edge cases', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await createTempDir();
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    test('should handle multi-line exports', async () => {
        const indexContent = `// Auto-generated index file
export {
  Foo,
  Bar,
  Baz
} from './components';
export { Foo } from './other';
`;
        await createFile(tempDir, 'index.ts', indexContent);

        const { fixed, duplicatesRemoved } = await fixDuplicateExports(
            join(tempDir, 'index.ts'),
            { dryRun: false },
        );

        expect(fixed).toBe(true);
        expect(duplicatesRemoved).toContain('Foo');

        const fixedContent = await readFileContent(join(tempDir, 'index.ts'));
        // Foo should only appear once in the entire file (duplicates removed)
        // Note: multi-line exports have 'Foo' on a different line than 'export'
        const fooMatches = fixedContent.match(/\bFoo\b/g) || [];
        expect(fooMatches.length).toBe(1);
        // And the duplicate export line should be gone
        expect(fixedContent).not.toContain('from "./other"');
    });

    test('should handle exports with aliases correctly', async () => {
        // When aliased, we should track by the EXPORTED name, not the original
        const indexContent = `// Auto-generated index file
export { Original as Foo } from './a';
export { Foo } from './b';
`;
        await createFile(tempDir, 'index.ts', indexContent);

        const { fixed, duplicatesRemoved } = await fixDuplicateExports(
            join(tempDir, 'index.ts'),
            { dryRun: false },
        );

        expect(fixed).toBe(true);
        expect(duplicatesRemoved).toContain('Foo');
    });

    test('should handle exports with inline comments', async () => {
        const indexContent = `// Auto-generated index file
export { Foo /* primary */ } from './a';
export { Foo /* secondary */ } from './b';
`;
        await createFile(tempDir, 'index.ts', indexContent);

        const { fixed, duplicatesRemoved } = await fixDuplicateExports(
            join(tempDir, 'index.ts'),
            { dryRun: false },
        );

        expect(fixed).toBe(true);
        expect(duplicatesRemoved).toContain('Foo');

        const fixedContent = await readFileContent(join(tempDir, 'index.ts'));
        const fooMatches = fixedContent.match(/\bFoo\b/g) || [];
        expect(fooMatches.length).toBe(1);
    });

    test('should preserve leading comments', async () => {
        const indexContent = `// Auto-generated index file for reconstructed package
// This file was created because the original index.ts was not in the source map

export type { Foo } from './types';
export { Foo } from './foo';
`;
        await createFile(tempDir, 'index.ts', indexContent);

        const { fixed } = await fixDuplicateExports(join(tempDir, 'index.ts'), {
            dryRun: false,
        });

        expect(fixed).toBe(true);

        const fixedContent = await readFileContent(join(tempDir, 'index.ts'));
        // Leading comments should be preserved
        expect(fixedContent).toContain('// Auto-generated index file');
        expect(fixedContent).toContain('// This file was created');
    });

    test('should handle mixed type and value exports with same name correctly', async () => {
        // Complex case: type export first, then value export of same name
        const indexContent = `// Auto-generated index file
export type { Button, ButtonProps } from './Button.types';
export { Button } from './Button';
export { Icon } from './Icon';
`;
        await createFile(tempDir, 'index.ts', indexContent);

        const { fixed, duplicatesRemoved } = await fixDuplicateExports(
            join(tempDir, 'index.ts'),
            { dryRun: false },
        );

        expect(fixed).toBe(true);
        expect(duplicatesRemoved).toContain('Button');
        expect(duplicatesRemoved).not.toContain('ButtonProps');
        expect(duplicatesRemoved).not.toContain('Icon');

        const fixedContent = await readFileContent(join(tempDir, 'index.ts'));
        // Button should appear only once, ButtonProps and Icon should remain
        expect(fixedContent).toContain('ButtonProps');
        expect(fixedContent).toContain('Icon');
    });

    test('should handle UTF-8 multi-byte characters in comments (regression)', async () => {
        // Regression test: SWC spans are byte-based, but we need character indices
        // Multi-byte characters (emoji, CJK, etc.) could cause offset miscalculation
        const indexContent = `// 日本語コメント - Japanese comment
// Emoji test: 🚀🔥💻
export { Foo } from './foo';
export { Foo } from './bar';
`;
        await createFile(tempDir, 'index.ts', indexContent);

        const { fixed, duplicatesRemoved } = await fixDuplicateExports(
            join(tempDir, 'index.ts'),
            { dryRun: false },
        );

        expect(fixed).toBe(true);
        expect(duplicatesRemoved).toContain('Foo');

        const fixedContent = await readFileContent(join(tempDir, 'index.ts'));
        // Comments with multi-byte characters should be preserved
        expect(fixedContent).toContain('日本語コメント');
        expect(fixedContent).toContain('🚀🔥💻');
        // Only one Foo export should remain
        const fooMatches = fixedContent.match(/\bFoo\b/g) || [];
        expect(fooMatches.length).toBe(1);
    });

    test('should handle UTF-8 multi-byte characters in export names (regression)', async () => {
        // Export names with unicode characters
        const indexContent = `// Auto-generated index
export { Café } from './cafe';
export { Naïve } from './naive';
export { Café } from './duplicate';
`;
        await createFile(tempDir, 'index.ts', indexContent);

        const { fixed, duplicatesRemoved } = await fixDuplicateExports(
            join(tempDir, 'index.ts'),
            { dryRun: false },
        );

        expect(fixed).toBe(true);
        expect(duplicatesRemoved).toContain('Café');

        const fixedContent = await readFileContent(join(tempDir, 'index.ts'));
        // Café should appear only once, Naïve should still be there
        // Note: \b word boundary doesn't work with Unicode characters in JS regex
        const cafeMatches = fixedContent.match(/Café/g) || [];
        expect(cafeMatches.length).toBe(1);
        expect(fixedContent).toContain('Naïve');
        // Duplicate export should be removed
        expect(fixedContent).not.toContain('./duplicate');
    });

    test('should handle CJK characters in source paths and comments (regression)', async () => {
        // Chinese/Japanese/Korean characters in paths and comments
        const indexContent = `// 组件导出 - Component exports
// コンポーネント
export { Button } from './组件/Button';
export { Icon } from './아이콘/Icon';
export { Button } from './duplicate';
`;
        await createFile(tempDir, 'index.ts', indexContent);

        const { fixed, duplicatesRemoved } = await fixDuplicateExports(
            join(tempDir, 'index.ts'),
            { dryRun: false },
        );

        expect(fixed).toBe(true);
        expect(duplicatesRemoved).toContain('Button');

        const fixedContent = await readFileContent(join(tempDir, 'index.ts'));
        // Multi-byte path strings should be preserved
        expect(fixedContent).toContain('./组件/Button');
        expect(fixedContent).toContain('./아이콘/Icon');
        // Comments should be preserved
        expect(fixedContent).toContain('组件导出');
        expect(fixedContent).toContain('コンポーネント');
    });

    test('should handle mixed ASCII and multi-byte on same line (regression)', async () => {
        // This tests the byte-to-char offset conversion more rigorously
        const indexContent = `export { A } from './a'; // 注释 Comment
export { B } from './b'; // More ASCII
export { A } from './c'; // Duplicate 重复
`;
        await createFile(tempDir, 'index.ts', indexContent);

        const { fixed, duplicatesRemoved } = await fixDuplicateExports(
            join(tempDir, 'index.ts'),
            { dryRun: false },
        );

        expect(fixed).toBe(true);
        expect(duplicatesRemoved).toContain('A');

        const fixedContent = await readFileContent(join(tempDir, 'index.ts'));
        // A should appear only once - count export statements with A
        const aExportMatches = fixedContent.match(/export\s*{\s*A\s*}/g) || [];
        expect(aExportMatches.length).toBe(1);
        // B should still be there
        expect(fixedContent).toContain("export { B } from './b'");
        // Comments should be preserved
        expect(fixedContent).toContain('注释');
        // Duplicate export line should be gone
        expect(fixedContent).not.toContain("from './c'");
    });
});

// ============================================================================
// INTEGRATION TEST - Real LocationSuggestion Case
// ============================================================================

describe('real-world LocationSuggestion duplicate (integration)', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await createTempDir();
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    test('should fix the exact LocationSuggestion duplicate pattern from @fp/sarsaparilla', async () => {
        // This is the EXACT pattern from the real error:
        // Line 23: export type { ..., LocationSuggestion, ... } from './LocationSuggestion.types';
        // Line 168: export { LocationSuggestion } from './LocationSuggestion';
        const indexContent = `// Auto-generated index file for reconstructed package
// This file was created because the original index.ts was not in the source map

export type { AriaPopoverProps, PopoverAria } from './js/components/Autosuggest/usePopover';
export type { ContentSuggestion, InventorySuggestion, LocationSuggestion, HistorySuggestion, Suggestion, LocationSuggestionOptionType } from './js/components/sharedComponents/LocationSuggestion/LocationSuggestion.types';
export type { LocationSuggestionProps } from './js/components/sharedComponents/LocationSuggestion/LocationSuggestion';
export { Accordion } from './js/components/sharedComponents/Accordion/Accordion';
export { LocationContent } from './js/components/sharedComponents/LocationSuggestion/LocationContent';
export { LocationIcon } from './js/components/sharedComponents/LocationSuggestion/LocationIcon';
export { LocationSubtitle } from './js/components/sharedComponents/LocationSuggestion/LocationSubtitle';
export { LocationSuggestion } from './js/components/sharedComponents/LocationSuggestion/LocationSuggestion';
export { LocationTitle } from './js/components/sharedComponents/LocationSuggestion/LocationTitle';
`;
        await createFile(
            tempDir,
            'node_modules/@fp/sarsaparilla/src/index.ts',
            indexContent,
        );

        const fixedCount = await fixAllDuplicateExports(tempDir, {
            internalPackages: new Set(['@fp/sarsaparilla']),
            dryRun: false,
        });

        expect(fixedCount).toBe(1);

        const fixedContent = await readFileContent(
            join(tempDir, 'node_modules/@fp/sarsaparilla/src/index.ts'),
        );

        // LocationSuggestion should appear exactly once as an EXPORTED NAME
        // We check by looking for "{ LocationSuggestion" or ", LocationSuggestion" patterns
        // to distinguish from paths like '/LocationSuggestion/'
        const exportedLocationSuggestionCount = (
            fixedContent.match(
                /\{\s*LocationSuggestion\s*[,}]|,\s*LocationSuggestion\s*[,}]/g,
            ) || []
        ).length;
        expect(exportedLocationSuggestionCount).toBe(1);

        // Other exports should still be present
        expect(fixedContent).toContain('ContentSuggestion');
        expect(fixedContent).toContain('HistorySuggestion');
        expect(fixedContent).toContain('Accordion');
        expect(fixedContent).toContain('LocationContent');
        expect(fixedContent).toContain('LocationTitle');

        // The type export line should no longer have LocationSuggestion (it was first, kept)
        // or the value export line should be removed (depending on which was first)
        // Either way, no duplicate identifier error should occur
    });
});

// ============================================================================
// MISSING SOURCE FILE STUBS
// ============================================================================

describe('findMissingSourceFiles', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await createTempDir();
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    test('should find missing default import', async () => {
        // Create a file that imports from a non-existent file
        await createFile(
            tempDir,
            'src/App.tsx',
            `
      import MissingComponent from './components/MissingComponent';
      export default function App() {
        return <MissingComponent />;
      }
    `,
        );

        const missing = await findMissingSourceFiles(tempDir);

        expect(missing.size).toBe(1);
        const entry = Array.from(missing.values())[0];
        expect(entry.needsDefaultExport).toBe(true);
        expect(entry.namedExports.size).toBe(0);
        expect(entry.filePath).toContain('MissingComponent.tsx');
    });

    test('should find missing named imports', async () => {
        await createFile(
            tempDir,
            'src/utils.ts',
            `
      import { helper1, helper2 } from './helpers/missing';
      export const result = helper1() + helper2();
    `,
        );

        const missing = await findMissingSourceFiles(tempDir);

        expect(missing.size).toBe(1);
        const entry = Array.from(missing.values())[0];
        expect(entry.needsDefaultExport).toBe(false);
        expect(entry.namedExports.has('helper1')).toBe(true);
        expect(entry.namedExports.has('helper2')).toBe(true);
    });

    test('should find missing type imports', async () => {
        await createFile(
            tempDir,
            'src/types.ts',
            `
      import type { FooType, BarType } from './missing-types';
      export type Combined = FooType & BarType;
    `,
        );

        const missing = await findMissingSourceFiles(tempDir);

        expect(missing.size).toBe(1);
        const entry = Array.from(missing.values())[0];
        expect(entry.typeExports.has('FooType')).toBe(true);
        expect(entry.typeExports.has('BarType')).toBe(true);
        expect(entry.namedExports.size).toBe(0);
    });

    test('should handle mixed imports with inline type modifier', async () => {
        await createFile(
            tempDir,
            'src/mixed.ts',
            `
      import { Component, type ComponentProps } from './missing-mixed';
      export const C = Component;
      export type Props = ComponentProps;
    `,
        );

        const missing = await findMissingSourceFiles(tempDir);

        expect(missing.size).toBe(1);
        const entry = Array.from(missing.values())[0];
        expect(entry.namedExports.has('Component')).toBe(true);
        expect(entry.typeExports.has('ComponentProps')).toBe(true);
    });

    test('should combine requirements from multiple importers', async () => {
        // Two files import from the same missing file with different requirements
        await createFile(
            tempDir,
            'src/fileA.ts',
            `
      import DefaultExport from './shared/missing';
      export const a = DefaultExport;
    `,
        );
        await createFile(
            tempDir,
            'src/fileB.ts',
            `
      import { namedExport } from './shared/missing';
      export const b = namedExport;
    `,
        );

        const missing = await findMissingSourceFiles(tempDir);

        expect(missing.size).toBe(1);
        const entry = Array.from(missing.values())[0];
        expect(entry.needsDefaultExport).toBe(true);
        expect(entry.namedExports.has('namedExport')).toBe(true);
        expect(entry.importedBy.length).toBe(2);
    });

    test('should not report existing files as missing', async () => {
        // Create both the importer and the target file
        await createFile(
            tempDir,
            'src/existing.ts',
            `
      export const existing = true;
    `,
        );
        await createFile(
            tempDir,
            'src/importer.ts',
            `
      import { existing } from './existing';
      export const value = existing;
    `,
        );

        const missing = await findMissingSourceFiles(tempDir);

        expect(missing.size).toBe(0);
    });

    test('should handle dynamic imports (React.lazy)', async () => {
        await createFile(
            tempDir,
            'src/routes.tsx',
            `
      import React from 'react';
      const LazyComponent = React.lazy(() => import('./pages/LazyPage'));
      export default LazyComponent;
    `,
        );

        const missing = await findMissingSourceFiles(tempDir);

        expect(missing.size).toBe(1);
        const entry = Array.from(missing.values())[0];
        expect(entry.filePath).toContain('LazyPage.tsx');
    });

    test('should not report external package imports as missing', async () => {
        await createFile(
            tempDir,
            'src/app.ts',
            `
      import React from 'react';
      import { useState } from 'react';
      export const App = () => useState(null);
    `,
        );

        const missing = await findMissingSourceFiles(tempDir);

        expect(missing.size).toBe(0);
    });
});

describe('generateMissingSourceStubs', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await createTempDir();
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    test('should generate stub with default export', async () => {
        await createFile(
            tempDir,
            'src/App.tsx',
            `
      import MissingComponent from './components/Missing';
      export default MissingComponent;
    `,
        );

        const missing = await findMissingSourceFiles(tempDir);
        const count = await generateMissingSourceStubs(tempDir, missing);

        expect(count).toBe(1);

        const stubContent = await readFileContent(
            join(tempDir, 'src/components/Missing.tsx'),
        );
        expect(stubContent).toContain('export default');
        expect(stubContent).toContain('any');
    });

    test('should generate stub with named exports', async () => {
        await createFile(
            tempDir,
            'src/utils.ts',
            `
      import { foo, bar, baz } from './helpers';
      export const result = foo + bar + baz;
    `,
        );

        const missing = await findMissingSourceFiles(tempDir);
        const count = await generateMissingSourceStubs(tempDir, missing);

        expect(count).toBe(1);

        const stubContent = await readFileContent(
            join(tempDir, 'src/helpers.tsx'),
        );
        expect(stubContent).toContain('export const foo: any');
        expect(stubContent).toContain('export const bar: any');
        expect(stubContent).toContain('export const baz: any');
    });

    test('should generate stub with type exports', async () => {
        await createFile(
            tempDir,
            'src/types.ts',
            `
      import type { UserType, ConfigType } from './shared-types';
      export type MyUser = UserType;
    `,
        );

        const missing = await findMissingSourceFiles(tempDir);
        const count = await generateMissingSourceStubs(tempDir, missing);

        expect(count).toBe(1);

        const stubContent = await readFileContent(
            join(tempDir, 'src/shared-types.tsx'),
        );
        expect(stubContent).toContain('export type UserType = any');
        expect(stubContent).toContain('export type ConfigType = any');
    });

    test('should generate stub with mixed exports', async () => {
        await createFile(
            tempDir,
            'src/consumer.ts',
            `
      import Widget, { helper, type WidgetProps } from './Widget';
      export const w = Widget;
    `,
        );

        const missing = await findMissingSourceFiles(tempDir);
        const count = await generateMissingSourceStubs(tempDir, missing);

        expect(count).toBe(1);

        const stubContent = await readFileContent(
            join(tempDir, 'src/Widget.tsx'),
        );
        expect(stubContent).toContain('export default');
        expect(stubContent).toContain('export const helper: any');
        expect(stubContent).toContain('export type WidgetProps = any');
    });

    test('should create parent directories as needed', async () => {
        await createFile(
            tempDir,
            'src/deep/nested/file.ts',
            `
      import Thing from '../../other/very/deep/Missing';
      export const t = Thing;
    `,
        );

        const missing = await findMissingSourceFiles(tempDir);
        const count = await generateMissingSourceStubs(tempDir, missing);

        expect(count).toBe(1);

        // ../../other from src/deep/nested resolves to src/other
        const stubContent = await readFileContent(
            join(tempDir, 'src/other/very/deep/Missing.tsx'),
        );
        expect(stubContent).toContain('export default');
    });

    test('should respect dryRun option', async () => {
        await createFile(
            tempDir,
            'src/app.ts',
            `
      import Missing from './Missing';
      export const m = Missing;
    `,
        );

        const missing = await findMissingSourceFiles(tempDir);
        const count = await generateMissingSourceStubs(tempDir, missing, {
            dryRun: true,
        });

        expect(count).toBe(1);

        // File should NOT be created in dry run mode
        const stubPath = join(tempDir, 'src/Missing.tsx');
        await expect(readFileContent(stubPath)).rejects.toThrow();
    });

    test('should handle side-effect only imports', async () => {
        await createFile(
            tempDir,
            'src/app.ts',
            `
      import './side-effects';
      export const x = 1;
    `,
        );

        const missing = await findMissingSourceFiles(tempDir);
        const count = await generateMissingSourceStubs(tempDir, missing);

        expect(count).toBe(1);

        const stubContent = await readFileContent(
            join(tempDir, 'src/side-effects.tsx'),
        );
        expect(stubContent).toContain('export {}');
        expect(stubContent).toContain('side-effect');
    });

    test('should handle namespace imports', async () => {
        await createFile(
            tempDir,
            'src/app.ts',
            `
      import * as Utils from './utils-ns';
      export const u = Utils.something;
    `,
        );

        const missing = await findMissingSourceFiles(tempDir);
        const count = await generateMissingSourceStubs(tempDir, missing);

        expect(count).toBe(1);

        const stubContent = await readFileContent(
            join(tempDir, 'src/utils-ns.tsx'),
        );
        // Namespace imports just need the file to exist
        expect(stubContent).toContain('export {}');
    });

    test('should find missing aliased imports', async () => {
        // Create a file that imports from an aliased path
        await createFile(
            tempDir,
            'src/app.ts',
            `
      import { helper } from 'myalias/utils/helper';
      export const h = helper;
    `,
        );

        // Create the base alias directory but not the subpath
        await createFile(
            tempDir,
            'libs/mypackage/index.ts',
            `
      export const base = true;
    `,
        );

        const aliases: AliasMapping[] = [
            { alias: 'myalias', path: './libs/mypackage' },
        ];

        const missing = await findMissingSourceFiles(tempDir, { aliases });

        expect(missing.size).toBe(1);
        const entry = Array.from(missing.values())[0];
        expect(entry.filePath).toContain('libs/mypackage/utils/helper');
        expect(entry.namedExports.has('helper')).toBe(true);
    });

    test('should generate stubs for missing aliased imports', async () => {
        await createFile(
            tempDir,
            'src/consumer.ts',
            `
      import Component, { type Props } from 'components/Missing';
      export const C = Component;
    `,
        );

        // Create base directory
        await mkdir(join(tempDir, 'src/components'), { recursive: true });

        const aliases: AliasMapping[] = [
            { alias: 'components', path: './src/components' },
        ];

        const missing = await findMissingSourceFiles(tempDir, { aliases });
        const count = await generateMissingSourceStubs(tempDir, missing);

        expect(count).toBe(1);

        const stubContent = await readFileContent(
            join(tempDir, 'src/components/Missing.tsx'),
        );
        expect(stubContent).toContain('export default');
        expect(stubContent).toContain('export type Props = any');
    });

    test('should match more specific aliases first', async () => {
        await createFile(
            tempDir,
            'src/app.ts',
            `
      import { AuthModal } from 'sarsaparilla/auth';
      export const A = AuthModal;
    `,
        );

        // Create both potential target directories
        await mkdir(join(tempDir, 'node_modules/@fp/sarsaparilla/src'), {
            recursive: true,
        });
        await mkdir(join(tempDir, 'shared/auth'), { recursive: true });

        // The specific alias 'sarsaparilla/auth' -> './shared/auth' should be used
        // instead of the general 'sarsaparilla' -> './node_modules/@fp/sarsaparilla'
        const aliases: AliasMapping[] = [
            { alias: 'sarsaparilla', path: './node_modules/@fp/sarsaparilla' },
            { alias: 'sarsaparilla/auth', path: './shared/auth' },
        ];

        const missing = await findMissingSourceFiles(tempDir, { aliases });

        expect(missing.size).toBe(1);
        const entry = Array.from(missing.values())[0];
        // Should resolve to shared/auth, not node_modules/@fp/sarsaparilla/auth
        expect(entry.filePath).toContain('shared/auth');
        expect(entry.filePath).not.toContain('node_modules');
    });
});

// ============================================================================
// MISSING BARREL EXPORTS
// ============================================================================

describe('findMissingBarrelExports', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await createTempDir();
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    test('should find missing named exports from generated index', async () => {
        // Create a directory with a generated index that exports some things
        await createFile(
            tempDir,
            'constants/index.ts',
            `// Auto-generated index file for reconstructed package
export { FOO, BAR } from './values';
`,
        );

        await createFile(
            tempDir,
            'constants/values.ts',
            `export const FOO = 'foo';
export const BAR = 'bar';`,
        );

        // Create a file that imports something not in the index
        await createFile(
            tempDir,
            'app.ts',
            `import { FOO, DEFAULT_TIMEZONE, MAX_RETRIES } from './constants';
export const x = FOO;`,
        );

        const indexPath = join(tempDir, 'constants/index.ts');
        const missing = await findMissingBarrelExports(tempDir, [indexPath]);

        expect(missing.size).toBe(1);
        const entry = missing.get(join(tempDir, 'constants'))!;
        expect(entry.missingNamedExports).toContain('DEFAULT_TIMEZONE');
        expect(entry.missingNamedExports).toContain('MAX_RETRIES');
        expect(entry.missingNamedExports).not.toContain('FOO');
    });

    test('should find missing type exports from generated index', async () => {
        await createFile(
            tempDir,
            'types/index.ts',
            `// Auto-generated index file for reconstructed package
export type { UserType } from './user';
`,
        );

        await createFile(
            tempDir,
            'types/user.ts',
            `export type UserType = { name: string };`,
        );

        // File importing a type that doesn't exist
        await createFile(
            tempDir,
            'app.ts',
            `import type { UserType, ConfigType } from './types';
export type MyUser = UserType;`,
        );

        const indexPath = join(tempDir, 'types/index.ts');
        const missing = await findMissingBarrelExports(tempDir, [indexPath]);

        expect(missing.size).toBe(1);
        const entry = missing.get(join(tempDir, 'types'))!;
        expect(entry.missingTypeExports).toContain('ConfigType');
        expect(entry.missingTypeExports).not.toContain('UserType');
    });

    test('should handle inline type imports', async () => {
        await createFile(
            tempDir,
            'shared/index.ts',
            `// Auto-generated index file for reconstructed package
export { getValue } from './utils';
`,
        );

        await createFile(
            tempDir,
            'shared/utils.ts',
            `export const getValue = () => 42;`,
        );

        // Mixed import with inline type keyword
        await createFile(
            tempDir,
            'app.ts',
            `import { getValue, type ValueType } from './shared';
export const x = getValue();`,
        );

        const indexPath = join(tempDir, 'shared/index.ts');
        const missing = await findMissingBarrelExports(tempDir, [indexPath]);

        expect(missing.size).toBe(1);
        const entry = missing.get(join(tempDir, 'shared'))!;
        expect(entry.missingTypeExports).toContain('ValueType');
        expect(entry.missingNamedExports.size).toBe(0);
    });

    test('should not report exports that already exist', async () => {
        await createFile(
            tempDir,
            'constants/index.ts',
            `// Auto-generated index file for reconstructed package
export { A, B, C } from './values';
export type { TypeA, TypeB } from './types';
`,
        );

        await createFile(
            tempDir,
            'constants/values.ts',
            `export const A = 1; export const B = 2; export const C = 3;`,
        );
        await createFile(
            tempDir,
            'constants/types.ts',
            `export type TypeA = any; export type TypeB = any;`,
        );

        await createFile(
            tempDir,
            'app.ts',
            `import { A, B, C } from './constants';
import type { TypeA, TypeB } from './constants';
export const x = A + B + C;`,
        );

        const indexPath = join(tempDir, 'constants/index.ts');
        const missing = await findMissingBarrelExports(tempDir, [indexPath]);

        expect(missing.size).toBe(0);
    });
});

describe('appendMissingBarrelExports', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await createTempDir();
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    test('should append stub exports for missing named exports', async () => {
        await createFile(
            tempDir,
            'constants/index.ts',
            `// Auto-generated index file for reconstructed package
export { FOO } from './values';
`,
        );

        await createFile(
            tempDir,
            'constants/values.ts',
            `export const FOO = 'foo';`,
        );

        await createFile(
            tempDir,
            'app.ts',
            `import { FOO, DEFAULT_TIMEZONE } from './constants';
export const x = FOO;`,
        );

        const indexPath = join(tempDir, 'constants/index.ts');
        const missing = await findMissingBarrelExports(tempDir, [indexPath]);
        await appendMissingBarrelExports(tempDir, missing);

        const content = await readFileContent(indexPath);
        expect(content).toContain(
            'export const DEFAULT_TIMEZONE: any = undefined;',
        );
        expect(content).toContain(
            'Stub exports for values imported but not found in source maps',
        );
    });

    test('should append stub type exports for missing type exports', async () => {
        await createFile(
            tempDir,
            'types/index.ts',
            `// Auto-generated index file for reconstructed package
export type { ExistingType } from './existing';
`,
        );

        await createFile(
            tempDir,
            'types/existing.ts',
            `export type ExistingType = any;`,
        );

        await createFile(
            tempDir,
            'app.ts',
            `import type { ExistingType, MissingType } from './types';
export type X = ExistingType;`,
        );

        const indexPath = join(tempDir, 'types/index.ts');
        const missing = await findMissingBarrelExports(tempDir, [indexPath]);
        await appendMissingBarrelExports(tempDir, missing);

        const content = await readFileContent(indexPath);
        expect(content).toContain('export type MissingType = any;');
    });

    test('should handle both named and type exports together', async () => {
        await createFile(
            tempDir,
            'shared/index.ts',
            `// Auto-generated index file for reconstructed package
export { existingValue } from './values';
`,
        );

        await createFile(
            tempDir,
            'shared/values.ts',
            `export const existingValue = 1;`,
        );

        await createFile(
            tempDir,
            'app.ts',
            `import { existingValue, missingValue, type MissingType } from './shared';
export const x = existingValue + missingValue;`,
        );

        const indexPath = join(tempDir, 'shared/index.ts');
        const missing = await findMissingBarrelExports(tempDir, [indexPath]);
        await appendMissingBarrelExports(tempDir, missing);

        const content = await readFileContent(indexPath);
        expect(content).toContain(
            'export const missingValue: any = undefined;',
        );
        expect(content).toContain('export type MissingType = any;');
    });

    test('should not modify files in dry run mode', async () => {
        await createFile(
            tempDir,
            'constants/index.ts',
            `// Auto-generated index file for reconstructed package
export { FOO } from './values';
`,
        );

        await createFile(
            tempDir,
            'constants/values.ts',
            `export const FOO = 'foo';`,
        );

        await createFile(
            tempDir,
            'app.ts',
            `import { FOO, MISSING } from './constants';`,
        );

        const indexPath = join(tempDir, 'constants/index.ts');
        const originalContent = await readFileContent(indexPath);

        const missing = await findMissingBarrelExports(tempDir, [indexPath]);
        await appendMissingBarrelExports(tempDir, missing, { dryRun: true });

        const newContent = await readFileContent(indexPath);
        expect(newContent).toBe(originalContent);
    });
});

// ============================================================================
// ASSET STUB RESOLVER
// ============================================================================

import {
    analyzeAssetStub,
    generatePlaceholderContent,
    findAssetStubs,
    resolveAssetStubs,
    findAndResolveAssetStubs,
} from '../src/asset-stub-resolver.js';

describe('analyzeAssetStub', () => {
    test('should detect Vite asset stub pattern', () => {
        const content = 'export default "__VITE_ASSET__DmmghgNB__"';
        const result = analyzeAssetStub(content, 'icon.svg');

        expect(result).not.toBeNull();
        expect(result?.bundler).toBe('vite');
        expect(result?.assetId).toBe('DmmghgNB');
        expect(result?.extension).toBe('.svg');
        expect(result?.stubValue).toBe('__VITE_ASSET__DmmghgNB__');
    });

    test('should detect Vite asset stub with special characters in hash', () => {
        const content = 'export default "__VITE_ASSET__B_uop8$S__"';
        const result = analyzeAssetStub(content, 'image.webp');

        expect(result).not.toBeNull();
        expect(result?.bundler).toBe('vite');
        expect(result?.assetId).toBe('B_uop8$S');
        expect(result?.extension).toBe('.webp');
    });

    test('should detect Vite public asset stub pattern', () => {
        const content = 'export default "__VITE_PUBLIC_ASSET__abc123__"';
        const result = analyzeAssetStub(content, 'logo.png');

        expect(result).not.toBeNull();
        expect(result?.bundler).toBe('vite');
        expect(result?.assetId).toBe('abc123');
    });

    test('should handle variable reference pattern', () => {
        const content = `const asset = "__VITE_ASSET__xyz789__";
export default asset;`;
        const result = analyzeAssetStub(content, 'photo.jpg');

        expect(result).not.toBeNull();
        expect(result?.bundler).toBe('vite');
        expect(result?.assetId).toBe('xyz789');
    });

    test('should return null for non-asset files', () => {
        const content = 'export default "__VITE_ASSET__abc123__"';
        const result = analyzeAssetStub(content, 'utils.ts');

        expect(result).toBeNull();
    });

    test('should return null for regular TypeScript files', () => {
        const content = `export const foo = "bar";
export default foo;`;
        const result = analyzeAssetStub(content, 'config.svg');

        expect(result).toBeNull();
    });

    test('should return null for data URI exports', () => {
        const content =
            'export default "data:image/svg+xml;base64,PHN2ZyB4bWxucz0..."';
        const result = analyzeAssetStub(content, 'icon.svg');

        expect(result).toBeNull();
    });

    test('should return null for URL exports', () => {
        const content = 'export default "/assets/image.png"';
        const result = analyzeAssetStub(content, 'image.png');

        expect(result).toBeNull();
    });
});

describe('generatePlaceholderContent', () => {
    test('should generate valid SVG placeholder', () => {
        const content = generatePlaceholderContent('.svg');
        expect(content).not.toBeNull();
        expect(typeof content).toBe('string');
        expect(content).toContain('<svg');
        expect(content).toContain('xmlns');
    });

    test('should generate PNG placeholder as Buffer', () => {
        const content = generatePlaceholderContent('.png');
        expect(content).not.toBeNull();
        expect(Buffer.isBuffer(content)).toBe(true);
        // PNG magic bytes
        expect((content as Buffer)[0]).toBe(0x89);
        expect((content as Buffer)[1]).toBe(0x50);
    });

    test('should generate JPG placeholder as Buffer', () => {
        const content = generatePlaceholderContent('.jpg');
        expect(content).not.toBeNull();
        expect(Buffer.isBuffer(content)).toBe(true);
        // JPG magic bytes (0xFF 0xD8)
        expect((content as Buffer)[0]).toBe(0xff);
        expect((content as Buffer)[1]).toBe(0xd8);
    });

    test('should generate WebP placeholder as Buffer', () => {
        const content = generatePlaceholderContent('.webp');
        expect(content).not.toBeNull();
        expect(Buffer.isBuffer(content)).toBe(true);
        // RIFF header
        expect((content as Buffer).slice(0, 4).toString()).toBe('RIFF');
    });

    test('should generate GIF placeholder as Buffer', () => {
        const content = generatePlaceholderContent('.gif');
        expect(content).not.toBeNull();
        expect(Buffer.isBuffer(content)).toBe(true);
        // GIF magic bytes
        expect((content as Buffer).slice(0, 3).toString()).toBe('GIF');
    });

    test('should return null for unknown extension', () => {
        const content = generatePlaceholderContent('.xyz');
        expect(content).toBeNull();
    });
});

describe('findAssetStubs', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await createTempDir();
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    test('should find Vite asset stubs in directory', async () => {
        await createFile(
            tempDir,
            'images/icon.svg',
            'export default "__VITE_ASSET__abc123__"',
        );
        await createFile(
            tempDir,
            'images/photo.jpg',
            'export default "__VITE_ASSET__def456__"',
        );
        await createFile(tempDir, 'utils.ts', 'export const foo = "bar";');

        const stubs = await findAssetStubs(tempDir);

        expect(stubs.size).toBe(2);
        expect(stubs.has(join(tempDir, 'images/icon.svg'))).toBe(true);
        expect(stubs.has(join(tempDir, 'images/photo.jpg'))).toBe(true);
    });

    test('should not include regular TypeScript files', async () => {
        await createFile(
            tempDir,
            'component.tsx',
            'export default () => null;',
        );
        await createFile(
            tempDir,
            'icon.svg',
            'export default "__VITE_ASSET__abc123__"',
        );

        const stubs = await findAssetStubs(tempDir);

        expect(stubs.size).toBe(1);
        expect(stubs.has(join(tempDir, 'icon.svg'))).toBe(true);
    });
});

describe('resolveAssetStubs', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await createTempDir();
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    test('should replace SVG stub with placeholder', async () => {
        const svgPath = await createFile(
            tempDir,
            'icon.svg',
            'export default "__VITE_ASSET__abc123__"',
        );

        const stubs = await findAssetStubs(tempDir);
        await resolveAssetStubs(tempDir, stubs);

        const content = await readFileContent(svgPath);
        expect(content).toContain('<svg');
        expect(content).not.toContain('__VITE_ASSET__');
    });

    test('should replace PNG stub with placeholder', async () => {
        const pngPath = await createFile(
            tempDir,
            'image.png',
            'export default "__VITE_ASSET__def456__"',
        );

        const stubs = await findAssetStubs(tempDir);
        await resolveAssetStubs(tempDir, stubs);

        const content = await readFile(pngPath);
        // PNG magic bytes
        expect(content[0]).toBe(0x89);
        expect(content[1]).toBe(0x50);
    });

    test('should not modify files in dry run mode', async () => {
        const svgPath = await createFile(
            tempDir,
            'icon.svg',
            'export default "__VITE_ASSET__abc123__"',
        );
        const originalContent = await readFileContent(svgPath);

        const stubs = await findAssetStubs(tempDir);
        await resolveAssetStubs(tempDir, stubs, { dryRun: true });

        const content = await readFileContent(svgPath);
        expect(content).toBe(originalContent);
    });

    test('should return correct counts', async () => {
        await createFile(
            tempDir,
            'icon.svg',
            'export default "__VITE_ASSET__abc__"',
        );
        await createFile(
            tempDir,
            'photo.jpg',
            'export default "__VITE_ASSET__def__"',
        );
        await createFile(
            tempDir,
            'logo.png',
            'export default "__VITE_ASSET__ghi__"',
        );

        const stubs = await findAssetStubs(tempDir);
        const result = await resolveAssetStubs(tempDir, stubs);

        expect(result.resolved).toBe(3);
        expect(result.failed).toBe(0);
        expect(result.byExtension['.svg']).toBe(1);
        expect(result.byExtension['.jpg']).toBe(1);
        expect(result.byExtension['.png']).toBe(1);
    });
});

describe('findAndResolveAssetStubs', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await createTempDir();
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    test('should find and resolve all asset stubs', async () => {
        await createFile(
            tempDir,
            'assets/icon.svg',
            'export default "__VITE_ASSET__abc__"',
        );
        await createFile(
            tempDir,
            'assets/bg.webp',
            'export default "__VITE_ASSET__def__"',
        );

        const result = await findAndResolveAssetStubs(tempDir);

        expect(result.found).toBe(2);
        expect(result.resolved).toBe(2);
        expect(result.failed).toBe(0);

        // Verify files were actually replaced
        const svgContent = await readFileContent(
            join(tempDir, 'assets/icon.svg'),
        );
        expect(svgContent).toContain('<svg');
    });

    test('should return zeros when no stubs found', async () => {
        await createFile(tempDir, 'app.ts', 'export const x = 1;');

        const result = await findAndResolveAssetStubs(tempDir);

        expect(result.found).toBe(0);
        expect(result.resolved).toBe(0);
        expect(result.failed).toBe(0);
    });
});
