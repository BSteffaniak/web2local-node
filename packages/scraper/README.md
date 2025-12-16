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
import { extractBundleUrls, findAllSourceMaps, extractSourcesFromMap, reconstructSources } from '@web2local/scraper';

// Discover bundles from a webpage
const { bundles } = await extractBundleUrls('https://example.com');

// Find source maps for all bundles
const { bundlesWithMaps } = await findAllSourceMaps(bundles);

// Extract and reconstruct source files for each bundle with a source map
for (const bundle of bundlesWithMaps) {
    const extraction = await extractSourcesFromMap(bundle.sourceMapUrl!, bundle.url);

    const result = await reconstructSources(extraction.sources, {
        outputDir: './output/example.com',
        bundleName: 'main',
    });

    console.log(`Wrote ${result.filesWritten} files`);
}
```

## API

### extractBundleUrls(url, options?)

Fetches a webpage and extracts all JS/CSS bundle URLs.

```typescript
const { bundles, finalUrl, redirect } = await extractBundleUrls(url);
// bundles: Array of { url, type: 'script' | 'stylesheet' }
// finalUrl: The final URL after any redirects
// redirect: Optional redirect info { from, to, status }
```

### findAllSourceMaps(bundles, options?)

Discovers source maps for an array of bundles. Uses the `@web2local/sourcemap` package internally.

```typescript
const { bundlesWithMaps, vendorBundles, bundlesWithoutMaps } = await findAllSourceMaps(bundles, {
    concurrency: 5,
    onProgress: (completed, total) => console.log(`${completed}/${total}`),
});
// bundlesWithMaps: Bundles that have associated source maps (includes sourceMapUrl property)
// vendorBundles: Vendor bundles without source maps (for fingerprinting)
// bundlesWithoutMaps: All bundles without source maps (for fallback saving)
```

### reconstructSources(files, options)

Writes extracted source files to disk with proper directory structure.

```typescript
const result = await reconstructSources(extractedSources, {
    outputDir: './output/example.com',
    bundleName: 'main',
});
// result: { filesWritten, filesSkipped, filesUnchanged, errors, outputPath }
```

### Lower-Level Functions

- `findSourceMapUrl(bundleUrl)` - Find source map URL for a single bundle
- `extractSourcesFromMap(sourceMapUrl, bundleUrl, onFile?)` - Extract sources from a source map URL
- `normalizePath(path)` - Normalize source paths (handles webpack://, etc.)
- `saveBundles(bundlesWithoutMaps, options)` - Save minified bundles without source maps
