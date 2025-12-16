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

## Type Categories

| Category     | Types                                                                              |
| ------------ | ---------------------------------------------------------------------------------- |
| Source Maps  | `SourceMapV3`, `ExtractedSource`, `SourceMapMetadata`, `SourceMapExtractionResult` |
| Discovery    | `SourceMapDiscoveryResult`, `SourceMapLocationType`                                |
| Options      | `ExtractSourceMapOptions`, `DiscoverSourceMapOptions`                              |
| Validation   | `SourceMapValidationResult`, `SourceMapValidationError`                            |
| Dependencies | `DependencyInfo`, `AnalysisResult`, `AliasMap`, `InferredAlias`                    |
| Capture      | `ApiFixture`, `CapturedRequest`, `CapturedResponse`, `CapturedAsset`               |
| Server       | `ServerManifest`, `FixtureIndex`, `FixtureIndexEntry`                              |
