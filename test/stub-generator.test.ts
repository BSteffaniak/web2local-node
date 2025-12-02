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
} from '../src/stub-generator.js';

// ============================================================================
// TEST HELPERS
// ============================================================================

/**
 * Creates a temporary directory for test fixtures
 */
async function createTempDir(): Promise<string> {
  const tempBase = join(tmpdir(), 'stub-generator-test');
  const tempDir = join(tempBase, `test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tempDir, { recursive: true });
  return tempDir;
}

/**
 * Creates a file with content in the temp directory
 */
async function createFile(dir: string, relativePath: string, content: string): Promise<string> {
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
      const filePath = await createFile(tempDir, 'constants.ts', `
        export const FOO = 'foo';
        export const BAR = 42;
        export const baz = true;
      `);

      const exports = await extractExports(filePath);

      expect(exports.named).toContain('FOO');
      expect(exports.named).toContain('BAR');
      expect(exports.named).toContain('baz');
      expect(exports.hasDefault).toBe(false);
    });

    test('should extract let and var exports', async () => {
      const filePath = await createFile(tempDir, 'vars.ts', `
        export let mutableValue = 1;
        export var legacyValue = 2;
      `);

      const exports = await extractExports(filePath);

      expect(exports.named).toContain('mutableValue');
      expect(exports.named).toContain('legacyValue');
    });

    test('should extract function exports', async () => {
      const filePath = await createFile(tempDir, 'utils.ts', `
        export function helper() {}
        export function processData(data: any) { return data; }
      `);

      const exports = await extractExports(filePath);

      expect(exports.named).toContain('helper');
      expect(exports.named).toContain('processData');
    });

    test('should extract class exports', async () => {
      const filePath = await createFile(tempDir, 'classes.ts', `
        export class MyService {}
        export class DataProcessor {}
      `);

      const exports = await extractExports(filePath);

      expect(exports.named).toContain('MyService');
      expect(exports.named).toContain('DataProcessor');
    });

    test('should extract enum exports', async () => {
      const filePath = await createFile(tempDir, 'enums.ts', `
        export enum Status {
          Active,
          Inactive
        }
        export enum Color {
          Red = 'red',
          Blue = 'blue'
        }
      `);

      const exports = await extractExports(filePath);

      expect(exports.named).toContain('Status');
      expect(exports.named).toContain('Color');
    });

    test('should extract bracket-style named exports', async () => {
      const filePath = await createFile(tempDir, 'reexports.ts', `
        const internal1 = 1;
        const internal2 = 2;
        export { internal1, internal2 };
      `);

      const exports = await extractExports(filePath);

      expect(exports.named).toContain('internal1');
      expect(exports.named).toContain('internal2');
    });

    test('should extract aliased bracket exports', async () => {
      const filePath = await createFile(tempDir, 'aliased.ts', `
        const original = 1;
        export { original as renamed };
      `);

      const exports = await extractExports(filePath);

      expect(exports.named).toContain('renamed');
      expect(exports.named).not.toContain('original');
    });

    test('should extract destructured object exports (RTK Query pattern)', async () => {
      // This is the pattern used by RTK Query for generated hooks
      const filePath = await createFile(tempDir, 'api-slice.ts', `
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
      `);

      const exports = await extractExports(filePath);

      expect(exports.named).toContain('articlesApiSlice');
      expect(exports.named).toContain('useFetchAllArticlesQuery');
      expect(exports.named).toContain('useFetchArticleByIdQuery');
      expect(exports.named).toContain('useFetchFeaturedArticlesQuery');
      expect(exports.named).toContain('usePrefetch');
    });

    test('should extract destructured exports from Redux slice actions', async () => {
      // This is the pattern used by Redux Toolkit for slice actions
      const filePath = await createFile(tempDir, 'articles-slice.ts', `
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
      `);

      const exports = await extractExports(filePath);

      expect(exports.named).toContain('incrementPageIndex');
      expect(exports.named).toContain('resetPageIndex');
      expect(exports.hasDefault).toBe(true);
    });

    test('should extract destructured array exports', async () => {
      const filePath = await createFile(tempDir, 'array-destructure.ts', `
        const tuple = [1, 'two', true] as const;
        export const [first, second, third] = tuple;
      `);

      const exports = await extractExports(filePath);

      expect(exports.named).toContain('first');
      expect(exports.named).toContain('second');
      expect(exports.named).toContain('third');
    });

    test('should extract renamed destructured exports', async () => {
      const filePath = await createFile(tempDir, 'renamed-destructure.ts', `
        const obj = { originalName: 1, anotherProp: 2 };
        export const { originalName: renamedExport, anotherProp } = obj;
      `);

      const exports = await extractExports(filePath);

      expect(exports.named).toContain('renamedExport');
      expect(exports.named).toContain('anotherProp');
      expect(exports.named).not.toContain('originalName');
    });

    test('should extract rest spread in destructured exports', async () => {
      const filePath = await createFile(tempDir, 'rest-spread.ts', `
        const obj = { a: 1, b: 2, c: 3, d: 4 };
        export const { a, ...rest } = obj;
      `);

      const exports = await extractExports(filePath);

      expect(exports.named).toContain('a');
      expect(exports.named).toContain('rest');
    });

    test('should extract destructured exports with default values', async () => {
      const filePath = await createFile(tempDir, 'default-values.ts', `
        const obj = { a: 1 };
        export const { a, b = 2, c = 'default' } = obj;
      `);

      const exports = await extractExports(filePath);

      expect(exports.named).toContain('a');
      expect(exports.named).toContain('b');
      expect(exports.named).toContain('c');
    });

    test('should extract nested destructured exports', async () => {
      const filePath = await createFile(tempDir, 'nested-destructure.ts', `
        const obj = { outer: { inner: 1, deep: { value: 2 } } };
        export const { outer: { inner, deep: { value: deepValue } } } = obj;
      `);

      const exports = await extractExports(filePath);

      expect(exports.named).toContain('inner');
      expect(exports.named).toContain('deepValue');
      expect(exports.named).not.toContain('outer');
      expect(exports.named).not.toContain('deep');
      expect(exports.named).not.toContain('value');
    });

    test('should extract mixed array and object destructured exports', async () => {
      const filePath = await createFile(tempDir, 'mixed-destructure.ts', `
        const arr = [{ name: 'first' }, { name: 'second' }];
        export const [{ name: firstName }, { name: secondName }] = arr;
      `);

      const exports = await extractExports(filePath);

      expect(exports.named).toContain('firstName');
      expect(exports.named).toContain('secondName');
      expect(exports.named).not.toContain('name');
    });

    test('should extract rest spread in array destructured exports', async () => {
      const filePath = await createFile(tempDir, 'array-rest.ts', `
        const arr = [1, 2, 3, 4, 5];
        export const [first, second, ...remaining] = arr;
      `);

      const exports = await extractExports(filePath);

      expect(exports.named).toContain('first');
      expect(exports.named).toContain('second');
      expect(exports.named).toContain('remaining');
    });

    test('should handle multiple destructured export statements', async () => {
      // Real-world pattern: multiple slices or APIs in one file
      const filePath = await createFile(tempDir, 'multiple-destructure.ts', `
        const usersApi = { useGetUsersQuery: () => {}, useGetUserByIdQuery: () => {} };
        const postsApi = { useGetPostsQuery: () => {}, useCreatePostMutation: () => {} };
        
        export const { useGetUsersQuery, useGetUserByIdQuery } = usersApi;
        export const { useGetPostsQuery, useCreatePostMutation } = postsApi;
      `);

      const exports = await extractExports(filePath);

      expect(exports.named).toContain('useGetUsersQuery');
      expect(exports.named).toContain('useGetUserByIdQuery');
      expect(exports.named).toContain('useGetPostsQuery');
      expect(exports.named).toContain('useCreatePostMutation');
    });

    test('should handle complex RTK Query file with all export types', async () => {
      // Mirrors a real-world RTK Query API slice file structure
      const filePath = await createFile(tempDir, 'complete-api-slice.ts', `
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
      `);

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
      const filePath = await createFile(tempDir, 'types.ts', `
        export type UserId = string;
        export type Config = { name: string };
      `);

      const exports = await extractExports(filePath);

      expect(exports.types).toContain('UserId');
      expect(exports.types).toContain('Config');
      expect(exports.named).not.toContain('UserId');
    });

    test('should extract interface exports', async () => {
      const filePath = await createFile(tempDir, 'interfaces.ts', `
        export interface User {
          id: string;
          name: string;
        }
        export interface Settings {
          theme: string;
        }
      `);

      const exports = await extractExports(filePath);

      expect(exports.types).toContain('User');
      expect(exports.types).toContain('Settings');
    });

    test('should extract export type { } blocks', async () => {
      const filePath = await createFile(tempDir, 'type-reexports.ts', `
        type InternalType = string;
        interface InternalInterface { x: number }
        export type { InternalType, InternalInterface };
      `);

      const exports = await extractExports(filePath);

      expect(exports.types).toContain('InternalType');
      expect(exports.types).toContain('InternalInterface');
    });
  });

  describe('re-export exclusion', () => {
    test('should NOT extract named re-exports as local exports', async () => {
      // Barrel file that re-exports from other modules
      const filePath = await createFile(tempDir, 'barrel.ts', `
        export { Button } from './Button';
        export { Input, Select } from './form';
        export { default as Modal } from './Modal';
      `);

      const exports = await extractExports(filePath);

      // These are re-exports, not local exports - should be empty
      expect(exports.named).toHaveLength(0);
      expect(exports.hasDefault).toBe(false);
    });

    test('should NOT extract type re-exports as local exports', async () => {
      const filePath = await createFile(tempDir, 'type-barrel.ts', `
        export type { ButtonProps } from './Button';
        export type { Config, Settings } from './types';
      `);

      const exports = await extractExports(filePath);

      expect(exports.types).toHaveLength(0);
    });

    test('should distinguish between local exports and re-exports in same file', async () => {
      const filePath = await createFile(tempDir, 'mixed.ts', `
        // Local export
        export const LOCAL_CONST = 'local';
        export function localHelper() {}
        
        // Re-export from another file
        export { ExternalThing } from './external';
        
        // Local type
        export type LocalType = string;
        
        // Type re-export
        export type { ExternalType } from './types';
      `);

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
      const filePath = await createFile(tempDir, 'Component.tsx', `
        export default function Button() {
          return <button>Click me</button>;
        }
      `);

      const exports = await extractExports(filePath);

      expect(exports.hasDefault).toBe(true);
      expect(exports.defaultName).toBe('Button');
    });

    test('should detect default class export with name', async () => {
      const filePath = await createFile(tempDir, 'Service.ts', `
        export default class ApiService {
          fetch() {}
        }
      `);

      const exports = await extractExports(filePath);

      expect(exports.hasDefault).toBe(true);
      expect(exports.defaultName).toBe('ApiService');
    });

    test('should detect default export referencing a variable', async () => {
      const filePath = await createFile(tempDir, 'Page.tsx', `
        const LoginPage = () => <div>Login</div>;
        export default LoginPage;
      `);

      const exports = await extractExports(filePath);

      expect(exports.hasDefault).toBe(true);
      expect(exports.defaultName).toBe('LoginPage');
    });

    test('should detect anonymous default export', async () => {
      const filePath = await createFile(tempDir, 'anonymous.ts', `
        export default () => console.log('anonymous');
      `);

      const exports = await extractExports(filePath);

      expect(exports.hasDefault).toBe(true);
      expect(exports.defaultName).toBeUndefined();
    });
  });

  describe('deduplication', () => {
    test('should deduplicate named exports', async () => {
      // This can happen with complex re-export patterns
      const filePath = await createFile(tempDir, 'dupe.ts', `
        export const foo = 1;
        export { foo };
      `);

      const exports = await extractExports(filePath);

      // Should only appear once
      expect(exports.named.filter(n => n === 'foo')).toHaveLength(1);
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
      const filePath = await createFile(tempDir, 'imports-only.ts', `
        import { something } from 'somewhere';
        import type { SomeType } from 'types';
      `);

      const exports = await extractExports(filePath);

      expect(exports.named).toHaveLength(0);
      expect(exports.types).toHaveLength(0);
      expect(exports.hasDefault).toBe(false);
    });

    test('should handle file that does not exist', async () => {
      const exports = await extractExports(join(tempDir, 'nonexistent.ts'));

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
      await createFile(tempDir, 'utils.ts', `
        export const helper = () => {};
        export function process() {}
      `);

      const result = await generateIndexFile(tempDir, { dryRun: true });

      expect(result.generated).toBe(true);
      expect(result.content).toContain("export { helper, process } from './utils';");
      expect(result.exports).toContain('helper');
      expect(result.exports).toContain('process');
    });

    test('should generate index with type exports', async () => {
      await createFile(tempDir, 'types.ts', `
        export type UserId = string;
        export interface User { id: UserId }
      `);

      const result = await generateIndexFile(tempDir, { dryRun: true });

      expect(result.generated).toBe(true);
      expect(result.content).toContain("export type { UserId, User } from './types';");
    });

    test('should generate index with default export re-export', async () => {
      await createFile(tempDir, 'Button.tsx', `
        export default function Button() {
          return <button />;
        }
      `);

      const result = await generateIndexFile(tempDir, { dryRun: true });

      expect(result.generated).toBe(true);
      expect(result.content).toContain("export { default as Button } from './Button';");
    });

    test('should handle mixed exports from single file', async () => {
      await createFile(tempDir, 'component.tsx', `
        export const CONSTANT = 'value';
        export type Props = { label: string };
        export default function Component() { return null; }
      `);

      const result = await generateIndexFile(tempDir, { dryRun: true });

      expect(result.generated).toBe(true);
      expect(result.content).toContain("export { CONSTANT } from './component';");
      expect(result.content).toContain("export type { Props } from './component';");
      expect(result.content).toContain("export { default as Component } from './component';");
    });
  });

  describe('duplicate export prevention (regression test)', () => {
    test('should not generate duplicate exports when same name exists in multiple files', async () => {
      // This is the bug scenario: LogInPage is exported from its own file
      // AND re-exported from a barrel file
      await createFile(tempDir, 'containers/LogInPage.tsx', `
        const LogInPage = () => <div>Login</div>;
        export default LogInPage;
      `);

      // Barrel file that re-exports
      await createFile(tempDir, 'containers/index.ts', `
        export { default as LogInPage } from './LogInPage';
        export { default as SignUpPage } from './SignUpPage';
      `);

      await createFile(tempDir, 'containers/SignUpPage.tsx', `
        const SignUpPage = () => <div>Sign Up</div>;
        export default SignUpPage;
      `);

      const result = await generateIndexFile(tempDir, { dryRun: true });

      expect(result.generated).toBe(true);

      // Count occurrences of LogInPage export - should only appear once
      const exportLineMatches = result.content
        .split('\n')
        .filter(line => line.includes('export') && line.includes('LogInPage'));

      expect(exportLineMatches).toHaveLength(1);

      // Same for SignUpPage
      const signUpPageMatches = result.content
        .split('\n')
        .filter(line => line.includes('export') && line.includes('SignUpPage'));

      expect(signUpPageMatches).toHaveLength(1);
    });

    test('should not duplicate when component is both default-exported and re-exported', async () => {
      // Component file with named default
      await createFile(tempDir, 'MapContainer.tsx', `
        export default function MapContainer() {
          return <div>Map</div>;
        }
      `);

      // Another file that re-exports it
      await createFile(tempDir, 'homepage/MapContainer.tsx', `
        export { default as MapContainer } from '../MapContainer';
      `);

      const result = await generateIndexFile(tempDir, { dryRun: true });

      const mapContainerExports = result.content
        .split('\n')
        .filter(line => line.includes('export') && line.includes('MapContainer'));

      expect(mapContainerExports).toHaveLength(1);
    });

    test('should not duplicate when file has both named export and default export of same name', async () => {
      // This a pattern: file has both named and default export
      await createFile(tempDir, 'containers/LogInPage.tsx', `
        export function LogInPage() {
          return <div>Login</div>;
        }
        export default LogInPage;
      `);

      await createFile(tempDir, 'containers/SignUpPage.tsx', `
        export function SignUpPage() {
          return <div>Sign Up</div>;
        }
        export default SignUpPage;
      `);

      const result = await generateIndexFile(tempDir, { dryRun: true });

      expect(result.generated).toBe(true);

      // LogInPage should only appear once (either as named or default-as-named, not both)
      const logInPageExports = result.content
        .split('\n')
        .filter(line => line.includes('export') && line.includes('LogInPage'));

      expect(logInPageExports).toHaveLength(1);

      // Same for SignUpPage
      const signUpPageExports = result.content
        .split('\n')
        .filter(line => line.includes('export') && line.includes('SignUpPage'));

      expect(signUpPageExports).toHaveLength(1);
    });

    test('should handle complex barrel re-export scenarios', async () => {
      // Multiple component files
      await createFile(tempDir, 'components/Button.tsx', `
        export default function Button() { return null; }
      `);

      await createFile(tempDir, 'components/Input.tsx', `
        export default function Input() { return null; }
      `);

      await createFile(tempDir, 'components/Modal.tsx', `
        export default function Modal() { return null; }
      `);

      // Barrel file re-exporting all
      await createFile(tempDir, 'components/index.ts', `
        export { default as Button } from './Button';
        export { default as Input } from './Input';
        export { default as Modal } from './Modal';
      `);

      const result = await generateIndexFile(tempDir, { dryRun: true });

      // Each component should only appear once
      for (const name of ['Button', 'Input', 'Modal']) {
        const exports = result.content
          .split('\n')
          .filter(line => line.includes('export') && line.includes(name));

        expect(exports).toHaveLength(1);
      }
    });
  });

  describe('file exclusions', () => {
    test('should exclude test files', async () => {
      await createFile(tempDir, 'utils.ts', 'export const helper = 1;');
      await createFile(tempDir, 'utils.test.ts', 'export const testHelper = 1;');
      await createFile(tempDir, 'utils.spec.ts', 'export const specHelper = 1;');

      const result = await generateIndexFile(tempDir, { dryRun: true });

      expect(result.content).toContain('helper');
      expect(result.content).not.toContain('testHelper');
      expect(result.content).not.toContain('specHelper');
    });

    test('should exclude story files', async () => {
      await createFile(tempDir, 'Button.tsx', 'export default function Button() {}');
      await createFile(tempDir, 'Button.stories.tsx', 'export default { title: "Button" };');

      const result = await generateIndexFile(tempDir, { dryRun: true });

      expect(result.content).toContain('Button');
      expect(result.content).not.toContain('stories');
    });

    test('should exclude .d.ts files', async () => {
      await createFile(tempDir, 'types.ts', 'export type Foo = string;');
      await createFile(tempDir, 'types.d.ts', 'export type Bar = number;');

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
      const indexContent = await readFileContent(join(tempDir, 'src', 'index.ts'));
      expect(indexContent).toContain("from './utils'");
      // Should NOT have 'src/' in the path since index is inside src/
      expect(indexContent).not.toContain("from './src/");
    });

    test('should write to root when no src/ exists', async () => {
      await createFile(tempDir, 'utils.ts', 'export const util = 1;');

      const result = await generateIndexFile(tempDir, { dryRun: false });

      expect(result.generated).toBe(true);

      // Verify file was created at root
      const indexContent = await readFileContent(join(tempDir, 'index.ts'));
      expect(indexContent).toContain("from './utils'");
    });
  });

  describe('subdirectory handling', () => {
    test('should handle index files in subdirectories', async () => {
      await createFile(tempDir, 'components/Button/index.tsx', `
        export default function Button() { return null; }
        export const ButtonVariant = 'primary';
      `);

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
      await createFile(tempDir, 'internal.ts', `
        const internal = 1;
        function privateHelper() {}
      `);

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
      await createFile(tempDir, 'MyComponent.tsx', `
        export default () => <div />;
      `);

      const result = await generateIndexFile(tempDir, { dryRun: true });

      // Should use filename since no explicit name
      expect(result.content).toContain("export { default as MyComponent }");
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
    await createFile(tempDir, 'Button.module.scss', '.button { color: red; }');

    const count = await generateScssModuleDeclarations(tempDir, { dryRun: false });

    expect(count).toBe(1);

    const dtsContent = await readFileContent(join(tempDir, 'Button.module.scss.d.ts'));
    expect(dtsContent).toContain('declare const styles');
    expect(dtsContent).toContain('readonly [key: string]: string');
    expect(dtsContent).toContain('export default styles');
  });

  test('should generate .d.ts for .module.css files', async () => {
    await createFile(tempDir, 'styles.module.css', '.container { padding: 16px; }');

    const count = await generateScssModuleDeclarations(tempDir, { dryRun: false });

    expect(count).toBe(1);

    const dtsContent = await readFileContent(join(tempDir, 'styles.module.css.d.ts'));
    expect(dtsContent).toContain('declare const styles');
  });

  test('should generate .d.ts for .module.sass files', async () => {
    await createFile(tempDir, 'legacy.module.sass', '.legacy\n  color: blue');

    const count = await generateScssModuleDeclarations(tempDir, { dryRun: false });

    expect(count).toBe(1);
  });

  test('should generate .d.ts for .module.less files', async () => {
    await createFile(tempDir, 'app.module.less', '.app { margin: 0; }');

    const count = await generateScssModuleDeclarations(tempDir, { dryRun: false });

    expect(count).toBe(1);
  });

  test('should skip if .d.ts already exists', async () => {
    await createFile(tempDir, 'Existing.module.scss', '.existing { }');
    await createFile(tempDir, 'Existing.module.scss.d.ts', '// existing declaration');

    const count = await generateScssModuleDeclarations(tempDir, { dryRun: false });

    expect(count).toBe(0);

    // Original should be unchanged
    const dtsContent = await readFileContent(join(tempDir, 'Existing.module.scss.d.ts'));
    expect(dtsContent).toBe('// existing declaration');
  });

  test('should process nested directories', async () => {
    await createFile(tempDir, 'components/Button/Button.module.scss', '.btn { }');
    await createFile(tempDir, 'pages/Home/Home.module.scss', '.home { }');

    const count = await generateScssModuleDeclarations(tempDir, { dryRun: false });

    expect(count).toBe(2);
  });

  test('should skip node_modules', async () => {
    await createFile(tempDir, 'node_modules/some-package/styles.module.scss', '.x { }');
    await createFile(tempDir, 'src/App.module.scss', '.app { }');

    const count = await generateScssModuleDeclarations(tempDir, { dryRun: false });

    expect(count).toBe(1);
  });

  test('should not create files in dry run mode', async () => {
    await createFile(tempDir, 'DryRun.module.scss', '.dry { }');

    const count = await generateScssModuleDeclarations(tempDir, { dryRun: true });

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
    expect(messages.some(m => m.includes('Progress.module.scss'))).toBe(true);
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
    await createFile(tempDir, 'my-package/src/index.ts', 'export const x = 1;');

    const info = await analyzePackage(join(tempDir, 'my-package'));

    expect(info.hasIndex).toBe(true);
  });

  test('should detect index.tsx', async () => {
    await createFile(tempDir, 'my-package/index.tsx', 'export default () => null;');

    const info = await analyzePackage(join(tempDir, 'my-package'));

    expect(info.hasIndex).toBe(true);
  });

  test('should report hasIndex: false when no index exists', async () => {
    await createFile(tempDir, 'my-package/utils.ts', 'export const util = 1;');

    const info = await analyzePackage(join(tempDir, 'my-package'));

    expect(info.hasIndex).toBe(false);
  });

  test('should collect exported modules', async () => {
    await createFile(tempDir, 'my-package/utils.ts', `
      export const helper = 1;
      export function process() {}
    `);
    await createFile(tempDir, 'my-package/types.ts', `
      export type Config = { x: number };
    `);

    const info = await analyzePackage(join(tempDir, 'my-package'));

    expect(info.exportedModules).toContain('helper');
    expect(info.exportedModules).toContain('process');
    expect(info.exportedModules).toContain('Config');
  });

  test('should include default export names', async () => {
    await createFile(tempDir, 'my-package/Button.tsx', `
      export default function Button() { return null; }
    `);

    const info = await analyzePackage(join(tempDir, 'my-package'));

    expect(info.exportedModules).toContain('Button');
  });

    test('should deduplicate exported modules', async () => {
      await createFile(tempDir, 'my-package/a.ts', 'export const shared = 1;');
      await createFile(tempDir, 'my-package/b.ts', 'export const shared = 2;');

      const info = await analyzePackage(join(tempDir, 'my-package'));

      expect(info.exportedModules.filter((m: string) => m === 'shared')).toHaveLength(1);
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
    await createFile(tempDir, 'node_modules/internal-pkg/utils.ts', 'export const x = 1;');

    const internalPackages = new Set(['internal-pkg']);
    const packages = await findPackagesNeedingIndex(tempDir, internalPackages);

    expect(packages).toHaveLength(1);
    expect(packages[0]).toContain('internal-pkg');
  });

  test('should not include packages that already have index', async () => {
    await createFile(tempDir, 'node_modules/has-index/index.ts', 'export const x = 1;');
    await createFile(tempDir, 'node_modules/has-index/other.ts', 'export const y = 2;');

    const internalPackages = new Set(['has-index']);
    const packages = await findPackagesNeedingIndex(tempDir, internalPackages);

    expect(packages).toHaveLength(0);
  });

  test('should find scoped packages', async () => {
    await createFile(tempDir, 'node_modules/@myorg/utils/helper.ts', 'export const help = 1;');

    const internalPackages = new Set(['@myorg/utils']);
    const packages = await findPackagesNeedingIndex(tempDir, internalPackages);

    expect(packages).toHaveLength(1);
    expect(packages[0]).toContain('@myorg/utils');
  });

  test('should not include packages with no exports', async () => {
    await createFile(tempDir, 'node_modules/empty-pkg/internal.ts', 'const x = 1;');

    const internalPackages = new Set(['empty-pkg']);
    const packages = await findPackagesNeedingIndex(tempDir, internalPackages);

    expect(packages).toHaveLength(0);
  });

  test('should not include packages not in internalPackages set', async () => {
    await createFile(tempDir, 'node_modules/external-pkg/utils.ts', 'export const x = 1;');

    const internalPackages = new Set(['different-pkg']);
    const packages = await findPackagesNeedingIndex(tempDir, internalPackages);

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
    await createFile(tempDir, 'src/redux/store.ts', 'export const store = {};');
    await createFile(tempDir, 'src/redux/hooks.ts', 'export const useAppDispatch = () => {};');
    
    // Create a file that imports from the directory
    await createFile(tempDir, 'src/components/App.tsx', `
      import { useAppDispatch } from '../redux';
      export const App = () => null;
    `);

    const result = await scanImports(tempDir);

    expect(result.directoryImports.length).toBe(1);
    expect(result.directoryImports[0].importPath).toBe('../redux');
    expect(result.directoryImports[0].isDirectoryImport).toBe(true);
  });

  test('should detect CSS module imports', async () => {
    await createFile(tempDir, 'src/Button.tsx', `
      import styles from './Button.module.scss';
      export const Button = () => <div className={styles.btn} />;
    `);

    const result = await scanImports(tempDir);

    expect(result.cssModuleImports.length).toBe(1);
    expect(result.cssModuleImports[0].importPath).toBe('./Button.module.scss');
  });

  test('should detect external package imports', async () => {
    await createFile(tempDir, 'src/App.tsx', `
      import React from 'react';
      import { Button } from 'sarsaparilla';
      import { helper } from 'shared-ui/utils';
      import { something } from '@scope/package';
      export const App = () => null;
    `);

    const result = await scanImports(tempDir);

    const packageNames = result.externalPackageImports.map(i => {
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
    await createFile(tempDir, 'src/utils.ts', `
      import fs from 'fs';
      import path from 'path';
      import { readFile } from 'node:fs/promises';
      export const util = 1;
    `);

    const result = await scanImports(tempDir);

    const packageNames = result.externalPackageImports.map(i => i.importPath.split('/')[0]);
    expect(packageNames).not.toContain('fs');
    expect(packageNames).not.toContain('path');
    expect(packageNames).not.toContain('node:fs');
  });

  test('should not flag directories with existing index files', async () => {
    await createFile(tempDir, 'src/utils/index.ts', 'export const helper = 1;');
    await createFile(tempDir, 'src/utils/math.ts', 'export const add = (a, b) => a + b;');
    await createFile(tempDir, 'src/App.tsx', `
      import { helper } from './utils';
      export const App = () => null;
    `);

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
    await createFile(tempDir, 'src/redux/store.ts', `
      export const store = {};
      export type RootState = {};
    `);
    await createFile(tempDir, 'src/redux/hooks.ts', `
      export const useAppDispatch = () => {};
      export const useAppSelector = () => {};
    `);

    // Create file importing from redux directory
    await createFile(tempDir, 'src/App.tsx', `
      import { useAppDispatch } from './redux';
    `);

    // Scan for imports
    const imports = await scanImports(tempDir);
    
    // Generate index files
    const count = await generateDirectoryIndexFiles(tempDir, imports.directoryImports, { dryRun: false });

    expect(count).toBe(1);

    // Verify index was created
    const indexContent = await readFileContent(join(tempDir, 'src/redux/index.ts'));
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
    await createFile(tempDir, 'src/Button.tsx', `
      import styles from './Button.module.scss';
      export const Button = () => <div className={styles.btn} />;
    `);
    // Note: Button.module.scss does NOT exist

    const imports = await scanImports(tempDir);
    const count = await generateMissingCssModuleStubs(tempDir, imports.cssModuleImports, { dryRun: false });

    expect(count).toBe(1);

    // Check that CSS file was created
    const cssContent = await readFileContent(join(tempDir, 'src/Button.module.scss'));
    expect(cssContent).toContain('Auto-generated CSS module stub');

    // Check that .d.ts was created
    const dtsContent = await readFileContent(join(tempDir, 'src/Button.module.scss.d.ts'));
    expect(dtsContent).toContain('declare const styles');
  });

  test('should not overwrite existing CSS modules', async () => {
    const originalCss = '.existing { color: red; }';
    await createFile(tempDir, 'src/Existing.module.scss', originalCss);
    await createFile(tempDir, 'src/Component.tsx', `
      import styles from './Existing.module.scss';
    `);

    const imports = await scanImports(tempDir);
    const count = await generateMissingCssModuleStubs(tempDir, imports.cssModuleImports, { dryRun: false });

    expect(count).toBe(0);

    // Original should be unchanged
    const cssContent = await readFileContent(join(tempDir, 'src/Existing.module.scss'));
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
    await createFile(tempDir, 'src/App.tsx', `
      import { Button } from 'missing-ui-library';
      import { helper } from 'another-missing-pkg/utils';
    `);

    const imports = await scanImports(tempDir);
    const installedPackages = new Set<string>();
    const count = await generateExternalPackageStubs(tempDir, imports.externalPackageImports, installedPackages, { dryRun: false });

    expect(count).toBe(2);

    // Check that stub declarations were created
    const stub1 = await readFileContent(join(tempDir, '@types/missing-ui-library/index.d.ts'));
    expect(stub1).toContain('missing-ui-library');
    expect(stub1).toContain('export default');

    const stub2 = await readFileContent(join(tempDir, '@types/another-missing-pkg/index.d.ts'));
    expect(stub2).toContain('another-missing-pkg');
  });

  test('should not generate stubs for installed packages', async () => {
    await createFile(tempDir, 'src/App.tsx', `
      import React from 'react';
      import { missing } from 'missing-pkg';
    `);

    const imports = await scanImports(tempDir);
    const installedPackages = new Set(['react']);
    const count = await generateExternalPackageStubs(tempDir, imports.externalPackageImports, installedPackages, { dryRun: false });

    expect(count).toBe(1); // Only missing-pkg, not react
  });

  test('should handle scoped packages', async () => {
    await createFile(tempDir, 'src/App.tsx', `
      import { something } from '@company/internal-lib';
    `);

    const imports = await scanImports(tempDir);
    const installedPackages = new Set<string>();
    const count = await generateExternalPackageStubs(tempDir, imports.externalPackageImports, installedPackages, { dryRun: false });

    expect(count).toBe(1);

    // Check scoped package stub - uses __ instead of /
    const stubPath = join(tempDir, '@types/@company__internal-lib/index.d.ts');
    const stub = await readFileContent(stubPath);
    expect(stub).toContain('@company/internal-lib');
  });
});
