# @web2local/types

Shared TypeScript types for web2local packages.

## Purpose

Provides centralized type definitions used across all web2local packages:

- Source map types (`SourceMapV3`, `ExtractedSource`, etc.)
- Extraction options and results
- Dependency analysis types
- API capture types
- Server manifest types

## Usage

```typescript
import type { SourceMapV3, ExtractedSource, SourceMapExtractionResult, DependencyInfo, ApiFixture, ServerManifest } from '@web2local/types';
```

### Result Type

The package exports a `Result<T, E>` type for functional error handling, along with `Ok` and `Err` helper functions:

```typescript
import { Result, Ok, Err, SourceMapErrorCode } from '@web2local/types';

function divide(a: number, b: number): Result<number, string> {
    if (b === 0) return Err('Division by zero');
    return Ok(a / b);
}

const result = divide(10, 2);
if (result.ok) {
    console.log(result.value); // 5
} else {
    console.error(result.error);
}
```

`SourceMapErrorCode` provides machine-readable error codes for programmatic handling of source map operations.

## Type Categories

| Category     | Types                                                                              |
| ------------ | ---------------------------------------------------------------------------------- |
| Utilities    | `Result`, `Ok`, `Err`, `SourceMapErrorCode`                                        |
| Source Maps  | `SourceMapV3`, `ExtractedSource`, `SourceMapMetadata`, `SourceMapExtractionResult` |
| Discovery    | `SourceMapDiscoveryResult`, `SourceMapLocationType`                                |
| Options      | `ExtractSourceMapOptions`, `DiscoverSourceMapOptions`                              |
| Validation   | `SourceMapValidationResult`, `SourceMapValidationError`                            |
| Dependencies | `DependencyInfo`, `AnalysisResult`, `AliasMap`, `InferredAlias`                    |
| Capture      | `ApiFixture`, `CapturedRequest`, `CapturedResponse`, `CapturedAsset`               |
| Server       | `ServerManifest`, `FixtureIndex`, `FixtureIndexEntry`                              |
