# @web2local/manifest

Manifest and configuration file generation.

## Purpose

Generates configuration files for captured sites and reconstructed projects:

- Server manifest for the mock server
- Fixture index for API call lookup
- package.json from detected dependencies
- tsconfig.json with path aliases

## Main Exports

```typescript
import {
    generateServerManifest, // Create manifest.json for mock server
    buildFixtureIndex, // Create fixture index
    generatePackageJson, // Create package.json
    generateTsConfig, // Create tsconfig.json
} from '@web2local/manifest';
```

## Example

```typescript
import { generateServerManifest } from '@web2local/manifest';

await generateServerManifest(fixtures, assets, {
    name: 'example.com',
    sourceUrl: 'https://example.com',
    outputDir: './output/example.com',
    defaultPort: 3000,
    cors: true,
    delay: { enabled: false, minMs: 0, maxMs: 0 },
});
```
