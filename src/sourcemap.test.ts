/**
 * Tests for sourcemap.ts utility functions
 */

import { describe, it, expect } from 'vitest';
import { normalizePath, shouldIncludePath, getCleanFilename } from './sourcemap.js';

// ============================================================================
// normalizePath Tests
// ============================================================================

describe('normalizePath', () => {
  it('should remove webpack:// protocol with package name', () => {
    const result = normalizePath('webpack://myapp/./src/components/Button.tsx');
    expect(result).toBe('src/components/Button.tsx');
  });

  it('should remove webpack:// protocol with scoped package', () => {
    // Note: The regex [^/]* matches @scope (first segment), so:
    // webpack://@scope/pkg/./src/index.ts -> pkg/./src/index.ts -> pkg/src/index.ts
    const result = normalizePath('webpack://@scope/pkg/./src/index.ts');
    expect(result).toBe('pkg/src/index.ts');
  });

  it('should handle vite null byte prefix', () => {
    const result = normalizePath('\u0000vite/modulepreload-polyfill');
    expect(result).toBe('vite/modulepreload-polyfill');
  });

  it('should apply source root to relative paths', () => {
    const result = normalizePath('components/Button.tsx', 'src/');
    expect(result).toBe('src/components/Button.tsx');
  });

  it('should not apply source root to absolute paths', () => {
    const result = normalizePath('/absolute/path.ts', 'src/');
    expect(result).toBe('absolute/path.ts');
  });

  it('should remove leading ./', () => {
    const result = normalizePath('./src/index.ts');
    expect(result).toBe('src/index.ts');
  });

  it('should preserve .. segments at start that cannot be resolved', () => {
    // When there are no parent segments to pop, .. is preserved
    const result = normalizePath('../../src/components/Button.tsx');
    expect(result).toBe('../../src/components/Button.tsx');
  });

  it('should keep .. at start if cannot be resolved', () => {
    const result = normalizePath('../outside/file.ts');
    expect(result).toBe('../outside/file.ts');
  });

  it('should resolve mixed path segments', () => {
    const result = normalizePath('src/utils/../components/./Button.tsx');
    expect(result).toBe('src/components/Button.tsx');
  });

  it('should handle empty source root', () => {
    const result = normalizePath('src/index.ts', '');
    expect(result).toBe('src/index.ts');
  });

  it('should handle paths with multiple slashes', () => {
    const result = normalizePath('src//components///Button.tsx');
    expect(result).toBe('src/components/Button.tsx');
  });
});

// ============================================================================
// shouldIncludePath Tests
// ============================================================================

describe('shouldIncludePath', () => {
  it('should exclude paths with null byte', () => {
    expect(shouldIncludePath('\u0000virtual:module', false)).toBe(false);
  });

  it('should exclude node_modules by default', () => {
    expect(shouldIncludePath('node_modules/react/index.js', false)).toBe(false);
  });

  it('should include node_modules when flag is set', () => {
    expect(shouldIncludePath('node_modules/react/index.js', true)).toBe(true);
  });

  it('should include internal packages even when node_modules excluded', () => {
    const internalPackages = new Set(['@myorg/shared']);
    expect(shouldIncludePath('node_modules/@myorg/shared/index.ts', false, internalPackages)).toBe(
      true
    );
  });

  it('should exclude external packages when internal packages specified', () => {
    const internalPackages = new Set(['@myorg/shared']);
    expect(shouldIncludePath('node_modules/react/index.js', false, internalPackages)).toBe(false);
  });

  it('should exclude (webpack) virtual paths', () => {
    expect(shouldIncludePath('(webpack)/container.js', false)).toBe(false);
  });

  it('should exclude __vite paths', () => {
    expect(shouldIncludePath('__vite-browser-external', false)).toBe(false);
  });

  it('should exclude vite/ internal paths', () => {
    expect(shouldIncludePath('vite/modulepreload-polyfill', false)).toBe(false);
  });

  it('should exclude query string paths', () => {
    expect(shouldIncludePath('?commonjs-external', false)).toBe(false);
  });

  it('should exclude data: URIs', () => {
    expect(shouldIncludePath('data:text/javascript,export default {}', false)).toBe(false);
  });

  it('should include normal source paths', () => {
    expect(shouldIncludePath('src/components/Button.tsx', false)).toBe(true);
  });

  it('should include paths starting with ./', () => {
    expect(shouldIncludePath('./src/index.ts', false)).toBe(true);
  });

  it('should handle scoped internal packages', () => {
    const internalPackages = new Set(['@fp/sarsaparilla']);
    expect(shouldIncludePath('node_modules/@fp/sarsaparilla/src/index.ts', false, internalPackages)).toBe(true);
  });

  it('should handle unscoped internal packages', () => {
    const internalPackages = new Set(['internal-lib']);
    expect(shouldIncludePath('node_modules/internal-lib/index.ts', false, internalPackages)).toBe(true);
  });
});

// ============================================================================
// getCleanFilename Tests
// ============================================================================

describe('getCleanFilename', () => {
  it('should return filename from path', () => {
    expect(getCleanFilename('src/components/Button.tsx')).toBe('Button.tsx');
  });

  it('should remove query strings', () => {
    expect(getCleanFilename('src/index.ts?v=123')).toBe('index.ts');
  });

  it('should add .js extension if missing', () => {
    expect(getCleanFilename('src/utils/helper')).toBe('helper.js');
  });

  it('should preserve existing extension', () => {
    expect(getCleanFilename('styles/main.css')).toBe('main.css');
  });

  it('should handle deep paths', () => {
    expect(getCleanFilename('a/b/c/d/e/f/file.ts')).toBe('file.ts');
  });

  it('should handle just filename', () => {
    expect(getCleanFilename('index.ts')).toBe('index.ts');
  });

  it('should handle filename without extension', () => {
    expect(getCleanFilename('Makefile')).toBe('Makefile.js');
  });

  it('should handle complex query strings', () => {
    expect(getCleanFilename('module.ts?type=script&lang=ts')).toBe('module.ts');
  });
});
