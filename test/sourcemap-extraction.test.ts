/**
 * Tests for sourcemap extraction and error handling
 *
 * These tests verify that:
 * - Source maps are correctly extracted
 * - Error messages include relevant URLs and context
 * - Various failure modes are handled gracefully
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { extractSourcesFromMap } from '../src/sourcemap.js';
import { server } from './helpers/msw-handlers.js';
import { initCache } from '../src/fingerprint-cache.js';

// ============================================================================
// Test Setup
// ============================================================================

beforeEach(async () => {
  // Disable caching for tests to ensure fresh fetches
  await initCache({ disabled: true });
});

// ============================================================================
// extractSourcesFromMap Tests
// ============================================================================

describe('extractSourcesFromMap', () => {
  describe('successful extraction', () => {
    it('should extract sources from a valid source map', async () => {
      server.use(
        http.get('https://example.com/bundle.js.map', () => {
          return HttpResponse.json({
            version: 3,
            sources: ['src/index.ts', 'src/utils.ts'],
            sourcesContent: [
              'export const main = () => console.log("hello");',
              'export const helper = () => "help";',
            ],
            names: [],
            mappings: 'AAAA',
          });
        })
      );

      const result = await extractSourcesFromMap(
        'https://example.com/bundle.js.map',
        'https://example.com/bundle.js'
      );

      expect(result.errors).toHaveLength(0);
      expect(result.files).toHaveLength(2);
      expect(result.files[0].path).toBe('src/index.ts');
      expect(result.files[0].content).toContain('main');
      expect(result.files[1].path).toBe('src/utils.ts');
    });

    it('should skip sources with null content', async () => {
      server.use(
        http.get('https://example.com/bundle.js.map', () => {
          return HttpResponse.json({
            version: 3,
            sources: ['src/index.ts', 'external.ts', 'src/utils.ts'],
            sourcesContent: [
              'export const main = () => {};',
              null,
              'export const helper = () => {};',
            ],
            names: [],
            mappings: 'AAAA',
          });
        })
      );

      const result = await extractSourcesFromMap(
        'https://example.com/bundle.js.map',
        'https://example.com/bundle.js'
      );

      expect(result.errors).toHaveLength(0);
      expect(result.files).toHaveLength(2);
      expect(result.files.map((f) => f.path)).not.toContain('external.ts');
    });
  });

  describe('error handling', () => {
    it('should include URL in error message when fetch returns 404', async () => {
      server.use(
        http.get('https://example.com/missing.js.map', () => {
          return new HttpResponse(null, { status: 404, statusText: 'Not Found' });
        })
      );

      const result = await extractSourcesFromMap(
        'https://example.com/missing.js.map',
        'https://example.com/bundle.js'
      );

      expect(result.files).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('https://example.com/missing.js.map');
      expect(result.errors[0]).toContain('404');
    });

    it('should include URL in error message when fetch returns 403', async () => {
      server.use(
        http.get('https://example.com/forbidden.js.map', () => {
          return new HttpResponse(null, { status: 403, statusText: 'Forbidden' });
        })
      );

      const result = await extractSourcesFromMap(
        'https://example.com/forbidden.js.map',
        'https://example.com/bundle.js'
      );

      expect(result.files).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('https://example.com/forbidden.js.map');
      expect(result.errors[0]).toContain('403');
    });

    it('should include URL and response preview when server returns HTML instead of JSON', async () => {
      server.use(
        http.get('https://example.com/fake-map.js.map', () => {
          return new HttpResponse(
            '<!DOCTYPE html><html><head><title>404 Not Found</title></head><body>Page not found</body></html>',
            {
              headers: { 'Content-Type': 'text/html' },
            }
          );
        })
      );

      const result = await extractSourcesFromMap(
        'https://example.com/fake-map.js.map',
        'https://example.com/bundle.js'
      );

      expect(result.files).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('https://example.com/fake-map.js.map');
      expect(result.errors[0]).toContain('<!DOCTYPE');
      expect(result.errors[0]).toMatch(/Response preview:/i);
    });

    it('should include URL and response preview when server returns JavaScript comment', async () => {
      server.use(
        http.get('https://example.com/comment.js.map', () => {
          return new HttpResponse(
            '/* PLEASE DO NOT COPY AND PASTE THIS CODE. */\nvar x = 1;',
            {
              headers: { 'Content-Type': 'application/javascript' },
            }
          );
        })
      );

      const result = await extractSourcesFromMap(
        'https://example.com/comment.js.map',
        'https://example.com/bundle.js'
      );

      expect(result.files).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('https://example.com/comment.js.map');
      expect(result.errors[0]).toContain('PLEASE DO NOT COPY');
    });

    it('should include URL when source map is missing sources array', async () => {
      server.use(
        http.get('https://example.com/invalid.js.map', () => {
          return HttpResponse.json({
            version: 3,
            // missing 'sources' and 'sourcesContent'
            names: [],
            mappings: 'AAAA',
          });
        })
      );

      const result = await extractSourcesFromMap(
        'https://example.com/invalid.js.map',
        'https://example.com/bundle.js'
      );

      expect(result.files).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('https://example.com/invalid.js.map');
      expect(result.errors[0]).toContain('missing sources or sourcesContent');
    });

    it('should include URL when source map is missing sourcesContent array', async () => {
      server.use(
        http.get('https://example.com/no-content.js.map', () => {
          return HttpResponse.json({
            version: 3,
            sources: ['src/index.ts'],
            // missing 'sourcesContent'
            names: [],
            mappings: 'AAAA',
          });
        })
      );

      const result = await extractSourcesFromMap(
        'https://example.com/no-content.js.map',
        'https://example.com/bundle.js'
      );

      expect(result.files).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('https://example.com/no-content.js.map');
      expect(result.errors[0]).toContain('missing sources or sourcesContent');
    });

    it('should handle empty source map gracefully', async () => {
      server.use(
        http.get('https://example.com/empty.js.map', () => {
          return HttpResponse.json({
            version: 3,
            sources: [],
            sourcesContent: [],
            names: [],
            mappings: '',
          });
        })
      );

      const result = await extractSourcesFromMap(
        'https://example.com/empty.js.map',
        'https://example.com/bundle.js'
      );

      expect(result.errors).toHaveLength(0);
      expect(result.files).toHaveLength(0);
    });

    it('should include URL in error for malformed JSON', async () => {
      server.use(
        http.get('https://example.com/malformed.js.map', () => {
          return new HttpResponse('{invalid json: true,}', {
            headers: { 'Content-Type': 'application/json' },
          });
        })
      );

      const result = await extractSourcesFromMap(
        'https://example.com/malformed.js.map',
        'https://example.com/bundle.js'
      );

      expect(result.files).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('https://example.com/malformed.js.map');
      expect(result.errors[0]).toContain('{invalid json');
    });

    it('should handle network errors gracefully', async () => {
      server.use(
        http.get('https://example.com/network-error.js.map', () => {
          return HttpResponse.error();
        })
      );

      const result = await extractSourcesFromMap(
        'https://example.com/network-error.js.map',
        'https://example.com/bundle.js'
      );

      expect(result.files).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('https://example.com/network-error.js.map');
    });
  });

  describe('path normalization', () => {
    it('should normalize webpack:// paths', async () => {
      server.use(
        http.get('https://example.com/webpack.js.map', () => {
          return HttpResponse.json({
            version: 3,
            sources: ['webpack://myapp/./src/components/Button.tsx'],
            sourcesContent: ['export const Button = () => <button>Click</button>;'],
            names: [],
            mappings: 'AAAA',
          });
        })
      );

      const result = await extractSourcesFromMap(
        'https://example.com/webpack.js.map',
        'https://example.com/bundle.js'
      );

      expect(result.errors).toHaveLength(0);
      expect(result.files).toHaveLength(1);
      expect(result.files[0].path).toBe('src/components/Button.tsx');
    });

    it('should apply sourceRoot to paths', async () => {
      server.use(
        http.get('https://example.com/with-root.js.map', () => {
          return HttpResponse.json({
            version: 3,
            sourceRoot: 'src/',
            sources: ['components/Button.tsx'],
            sourcesContent: ['export const Button = () => <button>Click</button>;'],
            names: [],
            mappings: 'AAAA',
          });
        })
      );

      const result = await extractSourcesFromMap(
        'https://example.com/with-root.js.map',
        'https://example.com/bundle.js'
      );

      expect(result.errors).toHaveLength(0);
      expect(result.files).toHaveLength(1);
      expect(result.files[0].path).toBe('src/components/Button.tsx');
    });
  });

  describe('callback support', () => {
    it('should call onFile callback for each extracted file', async () => {
      server.use(
        http.get('https://example.com/callback.js.map', () => {
          return HttpResponse.json({
            version: 3,
            sources: ['a.ts', 'b.ts', 'c.ts'],
            sourcesContent: ['const a = 1;', 'const b = 2;', 'const c = 3;'],
            names: [],
            mappings: 'AAAA',
          });
        })
      );

      const files: string[] = [];
      const result = await extractSourcesFromMap(
        'https://example.com/callback.js.map',
        'https://example.com/bundle.js',
        (file) => files.push(file.path)
      );

      expect(result.errors).toHaveLength(0);
      expect(files).toEqual(['a.ts', 'b.ts', 'c.ts']);
    });
  });
});
