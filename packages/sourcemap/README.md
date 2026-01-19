# @web2local/sourcemap

Source map parsing, discovery, and extraction for the web2local toolchain.

## Quick Start

```typescript
import { extractSourceMap } from '@web2local/sourcemap';

const result = await extractSourceMap('https://example.com/app.js');

for (const source of result.sources) {
    console.log(source.path, source.content.length);
}
```

## Architecture

The package is organized into three layers:

| Layer          | Purpose                            | Main Function         |
| -------------- | ---------------------------------- | --------------------- |
| **Discovery**  | Find source maps from bundle URLs  | `discoverSourceMap()` |
| **Parsing**    | Parse and validate source map JSON | `parseSourceMap()`    |
| **Extraction** | Extract sources with filtering     | `extractSources()`    |

`extractSourceMap()` is a convenience function that orchestrates all three.

## API

### extractSourceMap(bundleUrl, options?)

High-level function that discovers, fetches, parses, and extracts in one call.

```typescript
const result = await extractSourceMap('https://example.com/app.js', {
    timeout: 30000,
});

console.log(result.metadata.extractedCount); // 42
console.log(result.errors); // []
```

### discoverSourceMap(bundleUrl, options?)

Finds the source map URL using multiple strategies (in order):

1. HTTP headers (`SourceMap`, `X-SourceMap`)
2. JS/CSS comments (`//# sourceMappingURL=...`)
3. URL probing (`{bundleUrl}.map`)

```typescript
const discovery = await discoverSourceMap('https://example.com/app.js');

if (discovery.found) {
    console.log(discovery.sourceMapUrl); // "https://example.com/app.js.map"
    console.log(discovery.locationType); // "js-comment"
}
```

### parseSourceMap(content, url?)

Parses JSON content and validates against Source Map V3 spec.

```typescript
const sourceMap = parseSourceMap(jsonString);
// Throws SourceMapError if invalid
```

Also available: `parseInlineSourceMap()` for base64 data URIs, `parseSourceMapAuto()` for auto-detection.

### extractSources(sourceMap, bundleUrl, sourceMapUrl, options?)

Extracts source files from a parsed source map with path normalization and filtering.

```typescript
const result = extractSources(sourceMap, bundleUrl, sourceMapUrl, {
    excludePatterns: [/\.test\.ts$/],
    onSource: (source) => console.log(`Extracted: ${source.path}`),
});
```

<details>
<summary><strong>Full Options Reference</strong></summary>

### ExtractSourceMapOptions

| Option            | Type                     | Default     | Description                                    |
| ----------------- | ------------------------ | ----------- | ---------------------------------------------- |
| `excludePatterns` | `RegExp[]`               | —           | Additional patterns to exclude                 |
| `onSource`        | `(source) => void`       | —           | Callback for each extracted source (streaming) |
| `maxSize`         | `number`                 | `104857600` | Maximum source map size in bytes (100MB)       |
| `timeout`         | `number`                 | `30000`     | Fetch timeout in milliseconds                  |
| `headers`         | `Record<string, string>` | —           | Custom HTTP headers                            |
| `signal`          | `AbortSignal`            | —           | For cancellation support                       |

### DiscoverSourceMapOptions

| Option    | Type                     | Default | Description                   |
| --------- | ------------------------ | ------- | ----------------------------- |
| `timeout` | `number`                 | —       | Fetch timeout in milliseconds |
| `headers` | `Record<string, string>` | —       | Custom HTTP headers           |
| `signal`  | `AbortSignal`            | —       | For cancellation support      |

</details>

## Error Handling

All errors are instances of `SourceMapError` with structured error codes:

```typescript
import { SourceMapError, SourceMapErrorCode } from '@web2local/sourcemap';

try {
    await extractSourceMap(url);
} catch (err) {
    if (err instanceof SourceMapError) {
        switch (err.code) {
            case SourceMapErrorCode.NO_SOURCE_MAP_FOUND:
                // Handle missing source map
                break;
            case SourceMapErrorCode.HTTP_ERROR:
                console.log(err.details?.status); // 404
                break;
        }
    }
}
```

## Spec Compliance

This package implements the [ECMA-426 Source Map](https://tc39.es/ecma426/) specification:

- 100% of the official [tc39/source-map-tests](https://github.com/tc39/source-map-tests) test suite passes
- Validates both regular source maps and index maps (concatenated source maps)
- Full VLQ mapping validation including:
    - Base64 character validation
    - Segment field count (1, 4, or 5 fields)
    - 32-bit integer range checking
    - Source/name index bounds checking
- `sourceMappingURL` extraction per sections 11.1.2.1 and 11.1.2.2
