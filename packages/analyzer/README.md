# @web2local/analyzer

Dependency analysis and version detection for extracted source code.

## Purpose

Analyzes reconstructed source files to:

- Detect npm package dependencies from imports
- Infer package versions from banners, lockfile paths, and source fingerprinting
- Identify import aliases (e.g., `@/components` -> `./src/components`)
- Reconstruct missing index files for internal modules
- Resolve dynamic imports and CSS URLs from bundles

## Quick Start

```typescript
import { generateDependencyManifest } from '@web2local/analyzer';

const result = await generateDependencyManifest({
    projectDir: './extracted-project',
    sourceFiles: extractedFiles,
    useFingerprinting: true,
    onProgress: (msg) => console.log(msg),
});

console.log(result.dependencies);
// Map { 'react' => { version: '18.2.0', confidence: 'exact' }, ... }
```

## API

### generateDependencyManifest(options)

Analyzes source files and generates a dependency manifest with detected versions.

```typescript
const result = await generateDependencyManifest({
    projectDir: './project',
    sourceFiles: files,
    useFingerprinting: true, // Match against npm package contents
    fetchVersions: true, // Fetch latest versions for undetected packages
    vendorBundles: bundles, // Vendor bundles for fingerprinting
});
```

### inferAliasesFromImports(sourceFiles)

Detects import aliases by analyzing import patterns across files.

```typescript
import { inferAliasesFromImports } from '@web2local/analyzer';

const aliases = await inferAliasesFromImports(sourceFiles);
// [{ alias: '@utils', targetPath: './src/utils', confidence: 'high' }]
```

### reconstructAllIndexes(options)

Generates index.ts files for internal modules by analyzing what symbols are imported.

```typescript
import { reconstructAllIndexes } from '@web2local/analyzer';

const result = await reconstructAllIndexes({
    projectDir: './project',
    sourceFiles: files,
    aliases: detectedAliases,
});
```

### resolveMissingDynamicImports(options)

Resolves dynamic import paths from minified bundles to source files.

```typescript
import { resolveMissingDynamicImports } from '@web2local/analyzer';

const resolved = await resolveMissingDynamicImports({
    projectDir: './project',
    bundles: vendorBundles,
});
```

## Version Detection

Versions are detected from multiple sources (in priority order):

1. **Lockfile paths** - `node_modules/react@18.2.0/...`
2. **Banner comments** - `/*! React v18.2.0 */`
3. **Source fingerprinting** - Hash matching against npm package contents
4. **Peer dependencies** - Inferred from related packages
5. **npm latest** - Fallback to latest version
