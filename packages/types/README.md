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

## Error Handling

The package exports a `Result<T, E>` type for functional error handling, along with `Ok` and `Err` helper functions:

```typescript
import { Result, Ok, Err, SourceMapErrorCode } from '@web2local/types';

// Creating results
const success: Result<number, string> = Ok(42);
const failure: Result<number, string> = Err('Something went wrong');

// Checking results
if (success.ok) {
    console.log(success.value); // 42
}

// Using error codes for programmatic handling
if (!result.ok && result.error.code === SourceMapErrorCode.FETCH_TIMEOUT) {
    console.log('Request timed out, retrying...');
}
```

## Type Categories

| Category     | Types                                                                              |
| ------------ | ---------------------------------------------------------------------------------- |
| Results      | `Result`, `Ok`, `Err`, `SourceMapErrorCode`                                        |
| Source Maps  | `SourceMapV3`, `ExtractedSource`, `SourceMapMetadata`, `SourceMapExtractionResult` |
| Discovery    | `SourceMapDiscoveryResult`, `SourceMapLocationType`                                |
| Options      | `ExtractSourceMapOptions`, `DiscoverSourceMapOptions`                              |
| Validation   | `SourceMapValidationResult`, `SourceMapValidationError`                            |
| Dependencies | `DependencyInfo`, `AnalysisResult`, `AliasMap`, `InferredAlias`                    |
| Capture      | `ApiFixture`, `CapturedRequest`, `CapturedResponse`, `CapturedAsset`               |
| Server       | `ServerManifest`, `FixtureIndex`, `FixtureIndexEntry`                              |
