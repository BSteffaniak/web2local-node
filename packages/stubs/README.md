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

const result = await generateStubFiles('./my-project', {
    capturedCssBundles: cssBundles,
    generateCssModuleStubs: true,
    generateScssVariableStubs: true,
});

console.log(`Generated ${result.indexFilesGenerated} stub files`);
```

## API

### generateStubFiles(sourceDir, options)

Generates all necessary stub files for a project.

```typescript
const result = await generateStubFiles('./project', {
    capturedCssBundles: cssBundles, // For CSS module stub generation
    generateCssModuleStubs: true,
});
```

### CSS Module Stubs

```typescript
import { generateCssModuleStubs, recoverCssSources } from '@web2local/stubs';

// Generate stubs for missing CSS modules
const existingCssFiles = new Set<string>();
const stubs = await generateCssModuleStubs(sourceFiles, existingCssFiles);

// Recover CSS sources from source maps in bundles
const recovered = await recoverCssSources({
    cssBundles: [{ url: 'https://example.com/styles.css', content: cssContent }],
    sourceFiles: [{ path: 'src/App.tsx', content: appCode }],
    outputDir: './project',
});
```

### SCSS Variable Stubs

```typescript
import { generateScssVariableStubs, analyzeScssFile } from '@web2local/stubs';

// Analyze a file for variable definitions and usages
const analysis = analyzeScssFile(scssContent, './styles.scss');
console.log(analysis.definitions); // Set of defined variables
console.log(analysis.usages); // Set of used variables

// Generate stub files with placeholder values for undefined variables
const result = await generateScssVariableStubs('./project');
```

### Universal Stub

Creates a placeholder export for completely missing modules:

```typescript
import { createUniversalStub } from '@web2local/stubs';

const stub = createUniversalStub('MissingComponent');
// export const MissingComponent = __stub__('MissingComponent');
```
