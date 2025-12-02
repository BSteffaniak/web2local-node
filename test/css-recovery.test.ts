/**
 * Tests for css-recovery.ts module
 *
 * Comprehensive tests for the tiered CSS recovery pipeline:
 * - Tier 1: CSS source map extraction
 * - Tier 2: CSS module stub generation
 * - Tier 3: Global declaration fallback
 */

import {
  test,
  expect,
  describe,
  server,
  createCssHandler,
  createCssSourceMapHandler,
  create404Handler,
} from './helpers/fixtures.js';
import { http, HttpResponse } from 'msw';
import {
  findCssSourceMappingUrl,
  isDataUri,
  extractDataUriSourceMap,
  resolveSourceMapUrl,
  extractCssSourceMap,
  findCssModuleImports,
  extractUsedClassNames,
  resolveImportPath,
  generateCssModuleStub,
  generateCssModuleDeclaration,
  generateGlobalCssDeclarations,
  recoverCssSources,
} from '../src/css-recovery.js';

// ============================================================================
// TIER 1: CSS SOURCE MAP EXTRACTION
// ============================================================================

describe('Tier 1: CSS Source Map Extraction', () => {
  describe('findCssSourceMappingUrl', () => {
    test('should find external source map URL', () => {
      const css = '.container { color: red; }\n/*# sourceMappingURL=main.css.map */';
      expect(findCssSourceMappingUrl(css)).toBe('main.css.map');
    });

    test('should find inline data URI source map', () => {
      const css = '.btn { color: blue; }\n/*# sourceMappingURL=data:application/json;base64,abc123 */';
      expect(findCssSourceMappingUrl(css)).toBe('data:application/json;base64,abc123');
    });

    test('should return null when no source map comment', () => {
      const css = '.plain { color: green; }';
      expect(findCssSourceMappingUrl(css)).toBeNull();
    });

    test('should handle various whitespace', () => {
      const css = '.x{}\n/*#sourceMappingURL=min.css.map*/';
      expect(findCssSourceMappingUrl(css)).toBe('min.css.map');
    });

    test('should handle source map at different positions', () => {
      const css = '/*# sourceMappingURL=top.css.map */\n.class { }';
      expect(findCssSourceMappingUrl(css)).toBe('top.css.map');
    });
  });

  describe('isDataUri', () => {
    test('should return true for data URIs', () => {
      expect(isDataUri('data:application/json;base64,abc123')).toBe(true);
    });

    test('should return false for regular URLs', () => {
      expect(isDataUri('main.css.map')).toBe(false);
      expect(isDataUri('https://example.com/styles.css.map')).toBe(false);
    });
  });

  describe('extractDataUriSourceMap', () => {
    test('should extract and parse base64 source map', () => {
      const sourceMap = {
        version: 3,
        sources: ['test.scss'],
        sourcesContent: ['.test { color: red; }'],
        names: [],
        mappings: 'AAAA',
      };
      const base64 = Buffer.from(JSON.stringify(sourceMap)).toString('base64');
      const dataUri = `data:application/json;base64,${base64}`;

      const result = extractDataUriSourceMap(dataUri);
      expect(result).toEqual(sourceMap);
    });

    test('should return null for invalid data URI', () => {
      expect(extractDataUriSourceMap('data:text/plain;base64,abc')).toBeNull();
      expect(extractDataUriSourceMap('not-a-data-uri')).toBeNull();
    });

    test('should return null for invalid JSON', () => {
      const invalidJson = Buffer.from('not json').toString('base64');
      const dataUri = `data:application/json;base64,${invalidJson}`;
      expect(extractDataUriSourceMap(dataUri)).toBeNull();
    });
  });

  describe('resolveSourceMapUrl', () => {
    test('should resolve relative URL against CSS base', () => {
      const cssUrl = 'https://example.com/styles/main.css';
      const sourceMapUrl = 'main.css.map';
      expect(resolveSourceMapUrl(cssUrl, sourceMapUrl)).toBe(
        'https://example.com/styles/main.css.map'
      );
    });

    test('should handle parent directory references', () => {
      const cssUrl = 'https://example.com/dist/styles/main.css';
      const sourceMapUrl = '../maps/main.css.map';
      expect(resolveSourceMapUrl(cssUrl, sourceMapUrl)).toBe(
        'https://example.com/dist/maps/main.css.map'
      );
    });

    test('should return absolute URLs unchanged', () => {
      const cssUrl = 'https://example.com/styles/main.css';
      const sourceMapUrl = 'https://cdn.example.com/maps/main.css.map';
      expect(resolveSourceMapUrl(cssUrl, sourceMapUrl)).toBe(sourceMapUrl);
    });

    test('should return data URIs unchanged', () => {
      const cssUrl = 'https://example.com/styles/main.css';
      const sourceMapUrl = 'data:application/json;base64,abc123';
      expect(resolveSourceMapUrl(cssUrl, sourceMapUrl)).toBe(sourceMapUrl);
    });
  });

  describe('extractCssSourceMap', () => {
    test('should extract sources from external source map', async () => {
      const result = await extractCssSourceMap('https://example.com/styles/main.css');

      expect(result.cssUrl).toBe('https://example.com/styles/main.css');
      expect(result.sourceMapUrl).toBe('https://example.com/styles/main.css.map');
      expect(result.files).toHaveLength(2);
      expect(result.files[0].source).toBe('source-map');
      expect(result.errors).toHaveLength(0);
    });

    test('should extract sources from inline source map', async ({ cssInlineSourceMap }) => {
      // Set up handler with inline source map fixture
      server.use(
        http.get('https://example.com/styles/inline.css', () => {
          return new HttpResponse(cssInlineSourceMap.content, {
            headers: { 'Content-Type': 'text/css' },
          });
        })
      );

      const result = await extractCssSourceMap('https://example.com/styles/inline.css');

      expect(result.sourceMapUrl).toContain('data:application/json;base64,');
      expect(result.files.length).toBeGreaterThan(0);
      expect(result.errors).toHaveLength(0);
    });

    test('should return empty files for CSS without source map', async () => {
      const result = await extractCssSourceMap('https://example.com/styles/no-sourcemap.css');

      expect(result.sourceMapUrl).toBeNull();
      expect(result.files).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    test('should handle 404 for CSS file with URL in error message', async () => {
      server.use(create404Handler('https://example.com/missing/styles.css'));

      const result = await extractCssSourceMap('https://example.com/missing/styles.css');

      expect(result.files).toHaveLength(0);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('404');
      expect(result.errors[0]).toContain('https://example.com/missing/styles.css');
    });

    test('should handle 404 for source map file with URL in error message', async () => {
      server.use(
        createCssHandler(
          'https://example.com/styles/broken.css',
          '.broken { }',
          'missing.css.map'
        ),
        create404Handler('https://example.com/styles/missing.css.map')
      );

      const result = await extractCssSourceMap('https://example.com/styles/broken.css');

      expect(result.sourceMapUrl).toBe('https://example.com/styles/missing.css.map');
      expect(result.files).toHaveLength(0);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('https://example.com/styles/missing.css.map');
    });

    test('should include URL and preview when source map returns HTML', async () => {
      server.use(
        createCssHandler(
          'https://example.com/styles/html-error.css',
          '.x { }',
          'html-error.css.map'
        ),
        http.get('https://example.com/styles/html-error.css.map', () => {
          return new HttpResponse(
            '<!DOCTYPE html><html><body>Not Found</body></html>',
            { headers: { 'Content-Type': 'text/html' } }
          );
        })
      );

      const result = await extractCssSourceMap('https://example.com/styles/html-error.css');

      expect(result.files).toHaveLength(0);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('https://example.com/styles/html-error.css.map');
      expect(result.errors[0]).toContain('<!DOCTYPE');
    });

    test('should use provided CSS content instead of fetching', async () => {
      const cssContent = '.provided { }\n/*# sourceMappingURL=main.css.map */';

      // This should not fetch the CSS URL, just the source map
      const result = await extractCssSourceMap(
        'https://example.com/styles/main.css',
        cssContent
      );

      expect(result.sourceMapUrl).toBe('https://example.com/styles/main.css.map');
    });

    test('should skip sources with null content', async () => {
      server.use(
        createCssHandler(
          'https://example.com/styles/null.css',
          '.null { }',
          'null.css.map'
        ),
        http.get('https://example.com/styles/null.css.map', () => {
          return HttpResponse.json({
            version: 3,
            sources: ['valid.scss', 'external.scss', 'another.scss'],
            sourcesContent: ['.valid { }', null, '.another { }'],
            names: [],
            mappings: 'AAAA',
          });
        })
      );

      const result = await extractCssSourceMap('https://example.com/styles/null.css');

      // Should only include files with non-null content
      expect(result.files).toHaveLength(2);
      expect(result.files.map((f) => f.path)).not.toContain('external.scss');
    });
  });
});

// ============================================================================
// TIER 2: CSS MODULE STUB GENERATION
// ============================================================================

describe('Tier 2: CSS Module Stub Generation', () => {
  describe('findCssModuleImports', () => {
    test('should find ESM default imports', ({ reactComponent }) => {
      const imports = findCssModuleImports([reactComponent]);

      expect(imports).toHaveLength(1);
      expect(imports[0].importPath).toBe('./Button.module.scss');
      expect(imports[0].variableName).toBe('styles');
      expect(imports[0].sourceFile).toBe('src/components/Button.tsx');
    });

    test('should find multiple import types', ({ multipleImports }) => {
      const imports = findCssModuleImports([multipleImports]);

      expect(imports).toHaveLength(4);

      // Default import
      expect(imports.find((i) => i.importPath === './Page.module.scss')).toBeDefined();

      // Relative import
      expect(imports.find((i) => i.importPath === '../components/Button.module.css')).toBeDefined();

      // Namespace import
      expect(imports.find((i) => i.importPath === './Header.module.sass')).toBeDefined();

      // Require
      expect(imports.find((i) => i.importPath === './Legacy.module.less')).toBeDefined();
    });

    test('should extract used class names', ({ reactComponent }) => {
      const imports = findCssModuleImports([reactComponent]);

      expect(imports[0].usedClassNames).toContain('container');
      expect(imports[0].usedClassNames).toContain('btn-text');
      expect(imports[0].usedClassNames).toContain('icon');
      expect(imports[0].usedClassNames).toContain('disabled');
    });

    test('should not find non-module CSS imports', () => {
      const imports = findCssModuleImports([
        {
          path: 'src/index.tsx',
          content: "import './styles.css';\nimport globals from './global.scss';",
        },
      ]);

      // Only module imports should be found
      expect(imports).toHaveLength(0);
    });
  });

  describe('extractUsedClassNames', () => {
    test('should extract dot notation class names', () => {
      const content = 'className={styles.container}';
      const classNames = extractUsedClassNames(content, 'styles');

      expect(classNames.has('container')).toBe(true);
    });

    test('should extract bracket notation class names', () => {
      const content = "className={styles['nav-item']}";
      const classNames = extractUsedClassNames(content, 'styles');

      expect(classNames.has('nav-item')).toBe(true);
    });

    test('should extract double-quoted bracket notation', () => {
      const content = 'className={styles["btn-text"]}';
      const classNames = extractUsedClassNames(content, 'styles');

      expect(classNames.has('btn-text')).toBe(true);
    });

    test('should extract multiple class names', () => {
      const content = `
        <div className={styles.wrapper}>
          <button className={styles.btn}>
            <span className={styles['btn-icon']}/>
          </button>
        </div>
      `;
      const classNames = extractUsedClassNames(content, 'styles');

      expect(classNames.size).toBe(3);
      expect(classNames.has('wrapper')).toBe(true);
      expect(classNames.has('btn')).toBe(true);
      expect(classNames.has('btn-icon')).toBe(true);
    });

    test('should not extract common method names', () => {
      const content = 'styles.toString()';
      const classNames = extractUsedClassNames(content, 'styles');

      expect(classNames.has('toString')).toBe(false);
    });

    test('should handle different variable names', () => {
      const content = 'className={buttonCss.primary}';
      const classNames = extractUsedClassNames(content, 'buttonCss');

      expect(classNames.has('primary')).toBe(true);
    });

    test('should not match partial variable names', () => {
      const content = 'stylesManager.add() styles.real';
      const classNames = extractUsedClassNames(content, 'styles');

      // Should only find 'real', not 'add'
      expect(classNames.has('real')).toBe(true);
      expect(classNames.size).toBe(1);
    });
  });

  describe('resolveImportPath', () => {
    test('should resolve relative path from source file', () => {
      const result = resolveImportPath(
        'src/components/Button.tsx',
        './Button.module.scss'
      );
      expect(result).toMatch(/src\/components\/Button\.module\.scss$/);
    });

    test('should resolve parent directory reference', () => {
      const result = resolveImportPath(
        'src/pages/Page.tsx',
        '../components/Button.module.css'
      );
      expect(result).toMatch(/src\/components\/Button\.module\.css$/);
    });

    test('should handle non-relative paths', () => {
      const result = resolveImportPath('src/index.tsx', 'Button.module.scss');
      expect(result).toBe('Button.module.scss');
    });
  });

  describe('generateCssModuleStub', () => {
    test('should generate stub with class names', () => {
      const stub = generateCssModuleStub({
        importPath: './Button.module.scss',
        sourceFile: 'src/components/Button.tsx',
        variableName: 'styles',
        usedClassNames: ['container', 'btn', 'disabled'],
      });

      expect(stub.source).toBe('stub');
      expect(stub.content).toContain('.container {');
      expect(stub.content).toContain('.btn {');
      expect(stub.content).toContain('.disabled {');
      expect(stub.content).toContain('Auto-generated stub');
    });

    test('should add source file reference in comments', () => {
      const stub = generateCssModuleStub({
        importPath: './Button.module.scss',
        sourceFile: 'src/components/Button.tsx',
        variableName: 'styles',
        usedClassNames: ['btn'],
      });

      expect(stub.content).toContain('Used in: src/components/Button.tsx');
    });

    test('should handle empty class names', () => {
      const stub = generateCssModuleStub({
        importPath: './Empty.module.scss',
        sourceFile: 'src/Empty.tsx',
        variableName: 'styles',
        usedClassNames: [],
      });

      expect(stub.content).toContain('No class names were detected');
    });
  });

  describe('generateCssModuleDeclaration', () => {
    test('should generate TypeScript declaration', () => {
      const decl = generateCssModuleDeclaration({
        importPath: './Button.module.scss',
        sourceFile: 'src/components/Button.tsx',
        variableName: 'styles',
        usedClassNames: ['container', 'btn'],
      });

      expect(decl.source).toBe('declaration');
      expect(decl.path).toMatch(/\.d\.ts$/);
      expect(decl.content).toContain('declare const styles');
      expect(decl.content).toContain('readonly container: string');
      expect(decl.content).toContain('readonly btn: string');
      expect(decl.content).toContain('export default styles');
    });

    test('should quote kebab-case class names', () => {
      const decl = generateCssModuleDeclaration({
        importPath: './Nav.module.scss',
        sourceFile: 'src/Nav.tsx',
        variableName: 'styles',
        usedClassNames: ['nav-item', 'nav-link'],
      });

      expect(decl.content).toContain("readonly 'nav-item': string");
      expect(decl.content).toContain("readonly 'nav-link': string");
    });

    test('should include index signature', () => {
      const decl = generateCssModuleDeclaration({
        importPath: './Button.module.scss',
        sourceFile: 'src/Button.tsx',
        variableName: 'styles',
        usedClassNames: ['btn'],
      });

      expect(decl.content).toContain('readonly [key: string]: string');
    });
  });
});

// ============================================================================
// TIER 3: GLOBAL DECLARATIONS
// ============================================================================

describe('Tier 3: Global Declarations', () => {
  describe('generateGlobalCssDeclarations', () => {
    test('should generate global.d.ts file', () => {
      const decl = generateGlobalCssDeclarations();

      expect(decl.path).toBe('global.d.ts');
      expect(decl.source).toBe('declaration');
    });

    test('should include all CSS module extensions', () => {
      const decl = generateGlobalCssDeclarations();

      expect(decl.content).toContain("declare module '*.module.scss'");
      expect(decl.content).toContain("declare module '*.module.css'");
      expect(decl.content).toContain("declare module '*.module.sass'");
      expect(decl.content).toContain("declare module '*.module.less'");
    });

    test('should include raw CSS imports', () => {
      const decl = generateGlobalCssDeclarations();

      expect(decl.content).toContain("declare module '*.scss'");
      expect(decl.content).toContain("declare module '*.css'");
      expect(decl.content).toContain("declare module '*.sass'");
      expect(decl.content).toContain("declare module '*.less'");
    });
  });
});

// ============================================================================
// MAIN PIPELINE
// ============================================================================

describe('recoverCssSources (Main Pipeline)', () => {
  test('should run all tiers', async ({ reactComponent }) => {
    const result = await recoverCssSources({
      cssBundles: [{ url: 'https://example.com/styles/main.css' }],
      sourceFiles: [reactComponent],
      outputDir: '/output',
    });

    // Tier 1: Source map files
    expect(result.sourceMapFiles.length).toBeGreaterThan(0);
    expect(result.stats.cssSourceMapsFound).toBe(1);

    // Tier 2: Stub files (for CSS modules not in source maps)
    expect(result.stubFiles.length).toBeGreaterThan(0);

    // Tier 3: Global declarations
    expect(result.globalDeclarations).toHaveLength(1);
    expect(result.stats.globalDeclarationsGenerated).toBe(1);
  });

  test('should skip tiers when specified', async ({ reactComponent }) => {
    const result = await recoverCssSources({
      cssBundles: [{ url: 'https://example.com/styles/main.css' }],
      sourceFiles: [reactComponent],
      outputDir: '/output',
      skipTiers: ['source-map', 'global-declaration'],
    });

    // Tier 1 skipped
    expect(result.sourceMapFiles).toHaveLength(0);

    // Tier 2 still runs
    expect(result.stubFiles.length).toBeGreaterThanOrEqual(0);

    // Tier 3 skipped
    expect(result.globalDeclarations).toHaveLength(0);
  });

  test('should call progress callback', async ({ reactComponent }) => {
    const messages: string[] = [];

    await recoverCssSources({
      cssBundles: [{ url: 'https://example.com/styles/main.css' }],
      sourceFiles: [reactComponent],
      outputDir: '/output',
      onProgress: (msg) => messages.push(msg),
    });

    expect(messages.length).toBeGreaterThan(0);
    expect(messages.some((m) => m.includes('Tier 1'))).toBe(true);
    expect(messages.some((m) => m.includes('Tier 2'))).toBe(true);
    expect(messages.some((m) => m.includes('Tier 3'))).toBe(true);
  });

  test('should collect errors without throwing', async () => {
    server.use(
      createCssHandler('https://example.com/styles/error.css', '.x{}', 'error.css.map'),
      create404Handler('https://example.com/styles/error.css.map')
    );

    const result = await recoverCssSources({
      cssBundles: [{ url: 'https://example.com/styles/error.css' }],
      sourceFiles: [],
      outputDir: '/output',
    });

    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('should not generate stubs for files recovered from source maps', async () => {
    // Set up source map that includes the Button module
    server.use(
      createCssHandler(
        'https://example.com/styles/complete.css',
        '.x{}',
        'complete.css.map'
      ),
      createCssSourceMapHandler(
        'https://example.com/styles/complete.css.map',
        ['src/components/Button.module.scss'],
        ['.container { padding: 16px; }']
      )
    );

    // Source file imports the same module
    const sourceFile = {
      path: 'src/components/Button.tsx',
      content: "import styles from './Button.module.scss';\nstyles.container;",
    };

    const result = await recoverCssSources({
      cssBundles: [{ url: 'https://example.com/styles/complete.css' }],
      sourceFiles: [sourceFile],
      outputDir: '/output',
    });

    // Source map should have the file
    expect(result.sourceMapFiles.some((f) => f.path.includes('Button.module.scss'))).toBe(
      true
    );

    // Should NOT generate a stub since it's already in source maps
    const stubPaths = result.stubFiles
      .filter((f) => f.source === 'stub')
      .map((f) => f.path);
    expect(stubPaths.some((p) => p.includes('Button.module.scss'))).toBe(false);
  });

  test('should handle multiple CSS bundles', async () => {
    server.use(
      createCssHandler('https://example.com/styles/a.css', '.a{}', 'a.css.map'),
      createCssSourceMapHandler(
        'https://example.com/styles/a.css.map',
        ['components/A.scss'],
        ['.a { color: red; }']
      ),
      createCssHandler('https://example.com/styles/b.css', '.b{}', 'b.css.map'),
      createCssSourceMapHandler(
        'https://example.com/styles/b.css.map',
        ['components/B.scss'],
        ['.b { color: blue; }']
      )
    );

    const result = await recoverCssSources({
      cssBundles: [
        { url: 'https://example.com/styles/a.css' },
        { url: 'https://example.com/styles/b.css' },
      ],
      sourceFiles: [],
      outputDir: '/output',
    });

    expect(result.stats.cssSourceMapsFound).toBe(2);
    expect(result.stats.cssSourceMapsExtracted).toBe(2);
    expect(result.sourceMapFiles).toHaveLength(2);
  });

  test('should merge class names from multiple usages', async ({ multipleImports }) => {
    // Add another file that uses the same CSS module with different classes
    const anotherFile = {
      path: 'src/pages/AnotherPage.tsx',
      content: `
        import pageStyles from './Page.module.scss';
        pageStyles.footer;
        pageStyles.sidebar;
      `,
    };

    const result = await recoverCssSources({
      cssBundles: [],
      sourceFiles: [multipleImports, anotherFile],
      outputDir: '/output',
      skipTiers: ['source-map'],
    });

    // Find the stub for Page.module.scss
    const pageStub = result.stubFiles.find(
      (f) => f.path.includes('Page.module.scss') && f.source === 'stub'
    );

    expect(pageStub).toBeDefined();
    // Should include classes from both files
    expect(pageStub?.content).toContain('.wrapper');
    expect(pageStub?.content).toContain('.content');
    expect(pageStub?.content).toContain('.footer');
    expect(pageStub?.content).toContain('.sidebar');
  });
});
