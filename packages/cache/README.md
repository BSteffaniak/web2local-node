# @web2local/cache

Disk and memory caching for web2local operations.

## Purpose

Provides a two-tier caching system (memory + disk) to speed up repeated operations:

- npm package metadata
- Source map fetches and extractions
- Content fingerprints for version matching
- Dependency analysis results
- Page scraping results

Cache is stored in `~/.cache/web2local-node` with a 7-day TTL by default.

## Quick Start

```typescript
import { getCache, initCache } from '@web2local/cache';

// Initialize with custom options
await initCache({
    cacheDir: './my-cache',
    ttl: 24 * 60 * 60 * 1000, // 1 day
});

// Get the cache instance
const cache = getCache();

// Use cache for source maps
const cached = await cache.getSourceMap(url);
if (!cached) {
    const content = await fetch(url).then((r) => r.text());
    await cache.setSourceMap(url, content);
}
```

## Main Exports

```typescript
import {
    FingerprintCache, // Cache class
    getCache, // Get global instance
    initCache, // Initialize with options
    computeExtractionHash, // Hash extracted files
    computeUrlHash, // Hash URLs for cache keys
    computeNormalizedHash, // Hash normalized source content
} from '@web2local/cache';
```

## Cache Types

| Cache           | Purpose                             | TTL     |
| --------------- | ----------------------------------- | ------- |
| `metadata`      | npm package versions                | 7 days  |
| `fingerprints`  | Content hashes for version matching | 7 days  |
| `sourcemaps`    | Raw source map content              | 7 days  |
| `extractions`   | Extracted source files              | 7 days  |
| `pages`         | Bundle URLs from pages              | 7 days  |
| `npm-existence` | Package existence checks            | 30 days |
