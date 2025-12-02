/**
 * MSW (Mock Service Worker) Handlers
 *
 * Default HTTP handlers for testing. These provide baseline responses for
 * common endpoints. Individual tests can override these handlers using
 * server.use() for test-specific scenarios.
 */

import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

// ============================================================================
// DEFAULT HANDLERS
// ============================================================================

/**
 * Default handlers that provide baseline responses for tests.
 * These can be overridden per-test using server.use().
 */
export const handlers = [
  // Default CSS file with source map reference
  http.get('https://example.com/styles/main.css', () => {
    return new HttpResponse(
      '.container{padding:16px}.btn{color:blue}\n/*# sourceMappingURL=main.css.map */',
      {
        headers: { 'Content-Type': 'text/css' },
      }
    );
  }),

  // Default CSS source map
  http.get('https://example.com/styles/main.css.map', () => {
    return HttpResponse.json({
      version: 3,
      file: 'main.css',
      sources: ['../src/components/Button.module.scss', '../src/styles/_variables.scss'],
      sourcesContent: [
        '.container {\n  padding: 16px;\n}\n\n.btn {\n  color: blue;\n}',
        '$primary-color: blue;\n$spacing: 16px;',
      ],
      names: [],
      mappings: 'AAAA;AACA',
    });
  }),

  // CSS without source map
  http.get('https://example.com/styles/no-sourcemap.css', () => {
    return new HttpResponse('.plain { color: red; }', {
      headers: { 'Content-Type': 'text/css' },
    });
  }),

  // 404 handler for missing resources
  http.get('https://example.com/missing/*', () => {
    return new HttpResponse(null, { status: 404 });
  }),

  // JS bundle with source map
  // Note: We use a template literal with interpolation to break up the sourceMappingURL
  // comment pattern, otherwise Vite's source map loader mistakenly tries to load
  // 'bundle.js.map' as if it were a real source map for this test file.
  http.get('https://example.com/js/bundle.js', () => {
    return new HttpResponse(
      `function hello(){console.log("hello")}\n//${'#'} sourceMappingURL=bundle.js.map`,
      {
        headers: { 'Content-Type': 'application/javascript' },
      }
    );
  }),

  // JS source map
  http.get('https://example.com/js/bundle.js.map', () => {
    return HttpResponse.json({
      version: 3,
      file: 'bundle.js',
      sources: ['../src/index.ts'],
      sourcesContent: ['export function hello() {\n  console.log("hello");\n}'],
      names: [],
      mappings: 'AAAA',
    });
  }),
];

// ============================================================================
// SERVER SETUP
// ============================================================================

/**
 * MSW server instance for Node.js testing.
 * Started in test/setup.ts via beforeAll/afterAll hooks.
 */
export const server = setupServer(...handlers);

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Creates a handler that returns a CSS file with a source map URL.
 */
export function createCssHandler(url: string, content: string, sourceMapUrl?: string) {
  const cssContent = sourceMapUrl
    ? `${content}\n/*# sourceMappingURL=${sourceMapUrl} */`
    : content;

  return http.get(url, () => {
    return new HttpResponse(cssContent, {
      headers: { 'Content-Type': 'text/css' },
    });
  });
}

/**
 * Creates a handler that returns a CSS source map.
 */
export function createCssSourceMapHandler(
  url: string,
  sources: string[],
  sourcesContent: (string | null)[]
) {
  return http.get(url, () => {
    return HttpResponse.json({
      version: 3,
      sources,
      sourcesContent,
      names: [],
      mappings: 'AAAA',
    });
  });
}

/**
 * Creates a handler that returns a 404 error.
 */
export function create404Handler(url: string) {
  return http.get(url, () => {
    return new HttpResponse(null, { status: 404 });
  });
}

/**
 * Creates a handler that returns a 500 error.
 */
export function create500Handler(url: string) {
  return http.get(url, () => {
    return new HttpResponse('Internal Server Error', { status: 500 });
  });
}

/**
 * Creates a handler that simulates a network timeout.
 */
export function createTimeoutHandler(url: string, delayMs: number = 10000) {
  return http.get(url, async () => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return new HttpResponse(null, { status: 408 });
  });
}
