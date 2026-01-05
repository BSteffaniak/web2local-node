# @web2local/analyzer

Dependency analysis and version detection for extracted source code.

## Purpose

Analyzes reconstructed source files to:

- Detect npm package dependencies from imports
- Infer package versions from lockfile paths and source fingerprinting
- Identify import aliases (e.g., `@/components` -> `./src/components`)
- Reconstruct missing index files for internal modules
- Resolve dynamic imports and CSS URLs from bundles

## Quick Start

```typescript
import { generateDependencyManifest } from '@web2local/analyzer';

const { packageJson, tsconfig, stats } = await generateDependencyManifest(
    './extracted-project',
    null, // manifestPath (optional)
    'my-project',
    {
        useFingerprinting: true,
        onProgress: (file) => console.log(`Analyzing: ${file}`),
    },
);

console.log(stats.totalDependencies);
// Number of detected dependencies
```

## API

### generateDependencyManifest(sourceDir, manifestPath, outputName, options)

Analyzes source files and generates a dependency manifest with detected versions.

```typescript
const { packageJson, tsconfig, stats, aliasMap } = await generateDependencyManifest('./project', null, 'output-name', {
    useFingerprinting: true, // Match against npm package contents
    fetchFromNpm: true, // Fallback to npm latest as last resort
    extractedSourceFiles: files, // Raw source files from extraction
});
```

### inferAliasesFromImports(sourceFiles, existingAliases?)

Detects import aliases by analyzing import patterns across files.

```typescript
import { inferAliasesFromImports } from '@web2local/analyzer';

const aliases = inferAliasesFromImports(sourceFiles, new Set());
// [{ alias: '@utils', targetPath: './src/utils', evidence: [...], confidence: 'high' }]
```

### reconstructAllIndexes(options)

Generates index.ts files for internal modules by analyzing what symbols are imported.

```typescript
import { reconstructAllIndexes } from '@web2local/analyzer';

const result = await reconstructAllIndexes({
    projectDir: './project',
    sourceFiles: files,
    aliases: [{ alias: '@common', path: './src/common' }],
});
```

### resolveMissingDynamicImports(options)

Resolves dynamic import paths from minified bundles to source files.

```typescript
import { resolveMissingDynamicImports } from '@web2local/analyzer';

const result = await resolveMissingDynamicImports({
    bundlesDir: './output/_bundles',
    staticDir: './output/_server/static',
    baseUrl: 'https://example.com',
});
```

## Version Detection

Versions are detected from multiple sources (in priority order):

1. **Lockfile paths** - `node_modules/react@18.2.0/...`
2. **Source fingerprinting** - Hash matching against npm package contents
3. **Peer dependencies** - Inferred from related packages
4. **npm latest** - Fallback to latest version
