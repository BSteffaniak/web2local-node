# @web2local/stubs

Stub file generation for incomplete reconstructed source code.

## Purpose

When source maps don't include all original files, this package generates stubs to make the code buildable:

- **Index stubs** - Re-exports for internal packages missing index.ts
- **CSS module stubs** - Class name exports for CSS/SCSS modules
- **SCSS variable stubs** - Placeholder variables for undefined SCSS vars
- **Type declarations** - `.d.ts` files for CSS modules

## Quick Start

```typescript
import { generateStubFiles } from '@web2local/stubs';

const result = await generateStubFiles({
    projectDir: './my-project',
    sourceFiles: extractedFiles,
});

console.log(`Generated ${result.filesWritten} stub files`);
```

## API

### generateStubFiles(options)

Generates all necessary stub files for a project.

```typescript
const result = await generateStubFiles({
    projectDir: './project',
    sourceFiles: files,
    capturedCssBundles: cssBundles, // For CSS module stub generation
});
```

### CSS Module Stubs

```typescript
import { generateCssModuleStubs, recoverCssSources } from '@web2local/stubs';

// Generate stubs from captured CSS bundles
const stubs = await generateCssModuleStubs({
    projectDir: './project',
    capturedBundles: cssBundles,
});

// Recover CSS sources from source maps in bundles
const recovered = await recoverCssSources({
    projectDir: './project',
    bundles: cssBundles,
});
```

### SCSS Variable Stubs

```typescript
import { generateScssVariableStubs, analyzeScssFile } from '@web2local/stubs';

// Analyze a file for undefined variables
const analysis = await analyzeScssFile('./styles.scss');
console.log(analysis.undefined); // ['$primary-color', '$spacing']

// Generate stub file with placeholder values
const result = await generateScssVariableStubs('./project');
```

### Universal Stub

Creates a placeholder export for completely missing modules:

```typescript
import { createUniversalStub } from '@web2local/stubs';

const stub = createUniversalStub('MissingComponent');
// export const MissingComponent = __stub__('MissingComponent');
```
