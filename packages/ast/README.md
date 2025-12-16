# @web2local/ast

AST parsing and analysis utilities using SWC.

## Purpose

Provides fast AST parsing for analyzing JavaScript/TypeScript source code:

- Extract imports and exports
- Detect frameworks (React, Vue, etc.)
- Identify module system (ESM/CommonJS)
- Find environment variable usage

## Main Exports

```typescript
import {
    safeParse, // Parse source to AST
    extractImportsFromSource,
    extractExportsFromSource,
    detectFrameworkImports,
    detectModuleSystem,
    hasJSXElements,
    extractProcessEnvAccesses,
} from '@web2local/ast';
```

## Example

```typescript
import { extractImportsFromSource, categorizeImport } from '@web2local/ast';

const imports = extractImportsFromSource(sourceCode, 'file.tsx');

for (const imp of imports) {
    const info = categorizeImport(imp.source);
    // info: { isRelative, isExternal, packageName, isCssModule, isTypeFile }
    console.log(`${imp.source} -> ${info.isRelative ? 'relative' : info.packageName}`);
    // 'react' -> 'react'
    // './utils' -> 'relative'
}
```
