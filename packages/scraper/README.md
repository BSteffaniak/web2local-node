# @web2local/scraper

Bundle discovery, source map extraction, and file reconstruction.

## Purpose

This package handles the first stage of the web2local pipeline:

1. Fetch a webpage and discover JS/CSS bundles
2. Find source maps (via headers, comments, or URL probing)
3. Extract original source files from source maps
4. Reconstruct the file structure on disk

## Quick Start

```typescript
import { extractBundleUrls, findAllSourceMaps, reconstructSources } from '@web2local/scraper';

// Discover bundles from a webpage
const { bundles } = await extractBundleUrls('https://example.com');

// Find source maps for all bundles
const sourceMaps = await findAllSourceMaps(bundles);

// Reconstruct source files to disk
const result = await reconstructSources(sourceMaps, {
    outputDir: './output/example.com',
    includeNodeModules: false,
});

console.log(`Wrote ${result.filesWritten} files`);
```

## API

### extractBundleUrls(url, options?)

Fetches a webpage and extracts all JS/CSS bundle URLs.

```typescript
const { bundles, redirects, pageContent } = await extractBundleUrls(url);
// bundles: Array of { url, type: 'script' | 'stylesheet' }
```

### findAllSourceMaps(bundles, options?)

Discovers source maps for an array of bundles. Uses the `@web2local/sourcemap` package internally.

```typescript
const results = await findAllSourceMaps(bundles, {
    concurrency: 5,
    onProgress: (msg) => console.log(msg),
});
```

### reconstructSources(sourceMaps, options)

Extracts source files from source maps and writes them to disk with proper directory structure.

```typescript
const result = await reconstructSources(sourceMaps, {
    outputDir: './output/example.com',
    includeNodeModules: false,
    bundleName: 'main',
});
```

### Lower-Level Functions

- `findSourceMapUrl(bundleUrl)` - Find source map URL for a single bundle
- `extractSourcesFromMap(sourceMap, options)` - Extract sources from a parsed source map
- `normalizePath(path)` - Normalize source paths (handles webpack://, etc.)
- `saveBundles(bundles, outputDir)` - Save minified bundles without source maps
