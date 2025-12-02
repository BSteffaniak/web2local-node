/**
 * Tests for scraper.ts - bundle discovery and source map detection
 *
 * These tests verify that:
 * - Source maps are correctly discovered from bundles
 * - False positives from SPAs returning HTML are rejected
 * - Content-Type validation works correctly
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { findSourceMapUrl } from '../src/scraper.js';
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
// findSourceMapUrl Tests
// ============================================================================

describe('findSourceMapUrl', () => {
  describe('sourceMappingURL comment detection', () => {
    it('should find source map URL from JS sourceMappingURL comment', async () => {
      server.use(
        http.get('https://example.com/bundle.js', () => {
          return new HttpResponse(
            `function hello(){console.log("hello")}\n//# sourceMappingURL=bundle.js.map`,
            { headers: { 'Content-Type': 'application/javascript' } }
          );
        })
      );

      const result = await findSourceMapUrl('https://example.com/bundle.js');
      expect(result.sourceMapUrl).toBe('https://example.com/bundle.js.map');
    });

    it('should find source map URL from CSS sourceMappingURL comment', async () => {
      server.use(
        http.get('https://example.com/styles.css', () => {
          return new HttpResponse(
            `.container{color:red}\n/*# sourceMappingURL=styles.css.map */`,
            { headers: { 'Content-Type': 'text/css' } }
          );
        })
      );

      const result = await findSourceMapUrl('https://example.com/styles.css');
      expect(result.sourceMapUrl).toBe('https://example.com/styles.css.map');
    });

    it('should find source map URL from SourceMap header', async () => {
      server.use(
        http.get('https://example.com/bundle.js', () => {
          return new HttpResponse(
            `function hello(){console.log("hello")}`,
            { 
              headers: { 
                'Content-Type': 'application/javascript',
                'SourceMap': 'bundle.js.map'
              } 
            }
          );
        })
      );

      const result = await findSourceMapUrl('https://example.com/bundle.js');
      expect(result.sourceMapUrl).toBe('https://example.com/bundle.js.map');
    });
  });

  describe('.map fallback with Content-Type validation', () => {
    it('should accept .map file with application/json Content-Type', async () => {
      server.use(
        http.get('https://example.com/bundle.js', () => {
          return new HttpResponse(
            `function hello(){}`,
            { headers: { 'Content-Type': 'application/javascript' } }
          );
        }),
        http.head('https://example.com/bundle.js.map', () => {
          return new HttpResponse(null, {
            headers: { 'Content-Type': 'application/json' }
          });
        })
      );

      const result = await findSourceMapUrl('https://example.com/bundle.js');
      expect(result.sourceMapUrl).toBe('https://example.com/bundle.js.map');
    });

    it('should accept .map file with no Content-Type header', async () => {
      server.use(
        http.get('https://example.com/bundle.js', () => {
          return new HttpResponse(
            `function hello(){}`,
            { headers: { 'Content-Type': 'application/javascript' } }
          );
        }),
        http.head('https://example.com/bundle.js.map', () => {
          return new HttpResponse(null, {
            // No Content-Type header
          });
        })
      );

      const result = await findSourceMapUrl('https://example.com/bundle.js');
      expect(result.sourceMapUrl).toBe('https://example.com/bundle.js.map');
    });

    it('should reject .map file with text/html Content-Type (SPA false positive)', async () => {
      server.use(
        http.get('https://example.com/bundle.js', () => {
          return new HttpResponse(
            `function hello(){}`,
            { headers: { 'Content-Type': 'application/javascript' } }
          );
        }),
        http.head('https://example.com/bundle.js.map', () => {
          // SPA servers often return 200 with HTML for any route
          return new HttpResponse(null, {
            headers: { 'Content-Type': 'text/html; charset=UTF-8' }
          });
        })
      );

      const result = await findSourceMapUrl('https://example.com/bundle.js');
      expect(result.sourceMapUrl).toBeNull();
    });

    it('should reject .map file with text/html even without charset', async () => {
      server.use(
        http.get('https://example.com/bundle.js', () => {
          return new HttpResponse(
            `function hello(){}`,
            { headers: { 'Content-Type': 'application/javascript' } }
          );
        }),
        http.head('https://example.com/bundle.js.map', () => {
          return new HttpResponse(null, {
            headers: { 'Content-Type': 'text/html' }
          });
        })
      );

      const result = await findSourceMapUrl('https://example.com/bundle.js');
      expect(result.sourceMapUrl).toBeNull();
    });

    it('should accept .map file with application/octet-stream Content-Type', async () => {
      server.use(
        http.get('https://example.com/bundle.js', () => {
          return new HttpResponse(
            `function hello(){}`,
            { headers: { 'Content-Type': 'application/javascript' } }
          );
        }),
        http.head('https://example.com/bundle.js.map', () => {
          return new HttpResponse(null, {
            headers: { 'Content-Type': 'application/octet-stream' }
          });
        })
      );

      const result = await findSourceMapUrl('https://example.com/bundle.js');
      expect(result.sourceMapUrl).toBe('https://example.com/bundle.js.map');
    });

    it('should accept .map file with text/plain Content-Type', async () => {
      server.use(
        http.get('https://example.com/bundle.js', () => {
          return new HttpResponse(
            `function hello(){}`,
            { headers: { 'Content-Type': 'application/javascript' } }
          );
        }),
        http.head('https://example.com/bundle.js.map', () => {
          return new HttpResponse(null, {
            headers: { 'Content-Type': 'text/plain' }
          });
        })
      );

      const result = await findSourceMapUrl('https://example.com/bundle.js');
      expect(result.sourceMapUrl).toBe('https://example.com/bundle.js.map');
    });
  });

  describe('error handling', () => {
    it('should return null when bundle returns 404', async () => {
      server.use(
        http.get('https://example.com/missing.js', () => {
          return new HttpResponse(null, { status: 404 });
        })
      );

      const result = await findSourceMapUrl('https://example.com/missing.js');
      expect(result.sourceMapUrl).toBeNull();
    });

    it('should return null when .map fallback returns 404', async () => {
      server.use(
        http.get('https://example.com/bundle.js', () => {
          return new HttpResponse(
            `function hello(){}`,
            { headers: { 'Content-Type': 'application/javascript' } }
          );
        }),
        http.head('https://example.com/bundle.js.map', () => {
          return new HttpResponse(null, { status: 404 });
        })
      );

      const result = await findSourceMapUrl('https://example.com/bundle.js');
      expect(result.sourceMapUrl).toBeNull();
    });
  });
});
