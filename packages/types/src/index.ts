/**
 * @web2local/types
 *
 * Shared TypeScript types for web2local packages
 */

// ============================================================================
// SOURCE MAP ERROR CODES
// ============================================================================

/**
 * Granular error codes for source map operations.
 * Use these for programmatic error handling.
 */
export const SourceMapErrorCode = {
    // Network Errors
    FETCH_FAILED: 'FETCH_FAILED',
    FETCH_TIMEOUT: 'FETCH_TIMEOUT',
    FETCH_DNS_ERROR: 'FETCH_DNS_ERROR',
    FETCH_CONNECTION_REFUSED: 'FETCH_CONNECTION_REFUSED',
    FETCH_CONNECTION_RESET: 'FETCH_CONNECTION_RESET',
    FETCH_SSL_ERROR: 'FETCH_SSL_ERROR',

    // HTTP Errors
    HTTP_ERROR: 'HTTP_ERROR',

    // Parse Errors
    INVALID_JSON: 'INVALID_JSON',
    INVALID_BASE64: 'INVALID_BASE64',
    INVALID_DATA_URI: 'INVALID_DATA_URI',

    // Validation Errors
    INVALID_VERSION: 'INVALID_VERSION',
    MISSING_VERSION: 'MISSING_VERSION',
    MISSING_SOURCES: 'MISSING_SOURCES',
    MISSING_MAPPINGS: 'MISSING_MAPPINGS',
    SOURCES_NOT_ARRAY: 'SOURCES_NOT_ARRAY',
    INVALID_SOURCE_ROOT: 'INVALID_SOURCE_ROOT',
    INVALID_NAMES: 'INVALID_NAMES',
    INVALID_FILE: 'INVALID_FILE',
    INVALID_SOURCES_CONTENT: 'INVALID_SOURCES_CONTENT',
    INVALID_IGNORE_LIST: 'INVALID_IGNORE_LIST',

    // Index Map Errors
    INVALID_INDEX_MAP_SECTIONS: 'INVALID_INDEX_MAP_SECTIONS',
    INVALID_INDEX_MAP_OFFSET: 'INVALID_INDEX_MAP_OFFSET',
    INVALID_INDEX_MAP_SECTION_MAP: 'INVALID_INDEX_MAP_SECTION_MAP',
    INDEX_MAP_OVERLAP: 'INDEX_MAP_OVERLAP',
    INDEX_MAP_INVALID_ORDER: 'INDEX_MAP_INVALID_ORDER',
    INDEX_MAP_NESTED: 'INDEX_MAP_NESTED',
    INDEX_MAP_WITH_MAPPINGS: 'INDEX_MAP_WITH_MAPPINGS',

    // VLQ/Mapping Errors
    INVALID_VLQ: 'INVALID_VLQ',
    INVALID_MAPPING_SEGMENT: 'INVALID_MAPPING_SEGMENT',
    MAPPING_SOURCE_INDEX_OUT_OF_BOUNDS: 'MAPPING_SOURCE_INDEX_OUT_OF_BOUNDS',
    MAPPING_NAME_INDEX_OUT_OF_BOUNDS: 'MAPPING_NAME_INDEX_OUT_OF_BOUNDS',
    MAPPING_NEGATIVE_VALUE: 'MAPPING_NEGATIVE_VALUE',
    MAPPING_VALUE_EXCEEDS_32_BITS: 'MAPPING_VALUE_EXCEEDS_32_BITS',

    // Content Errors
    NO_EXTRACTABLE_SOURCES: 'NO_EXTRACTABLE_SOURCES',

    // Discovery Errors
    NO_SOURCE_MAP_FOUND: 'NO_SOURCE_MAP_FOUND',

    // Size Errors
    SOURCE_MAP_TOO_LARGE: 'SOURCE_MAP_TOO_LARGE',
} as const;

/**
 * Union type of all source map error codes
 */
export type SourceMapErrorCode =
    (typeof SourceMapErrorCode)[keyof typeof SourceMapErrorCode];

// ============================================================================
// RESULT TYPE - Functional error handling
// ============================================================================

/**
 * A discriminated union for operations that can fail.
 * Use instead of throwing exceptions or returning Error objects as values.
 *
 * @example
 * function divide(a: number, b: number): Result<number, string> {
 *     if (b === 0) return Err('Division by zero');
 *     return Ok(a / b);
 * }
 *
 * const result = divide(10, 2);
 * if (result.ok) {
 *     console.log(result.value); // 5
 * } else {
 *     console.error(result.error);
 * }
 */
export type Result<T, E = string> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: E };

/**
 * Create a successful result
 */
export function Ok<T>(value: T): Result<T, never> {
    return { ok: true, value };
}

/**
 * Create a failed result
 */
export function Err<E>(error: E): Result<never, E> {
    return { ok: false, error };
}

// ============================================================================
// SOURCE MAP TYPES
// ============================================================================

/**
 * Source Map V3 specification (regular source map, not index map)
 * @see https://tc39.es/ecma426/
 */
export interface SourceMapV3 {
    readonly version: 3;
    readonly file?: string;
    readonly sourceRoot?: string;
    /** Array of source file paths. Entries can be null per ECMA-426. */
    readonly sources: readonly (string | null)[];
    readonly sourcesContent?: readonly (string | null)[];
    readonly names?: readonly string[];
    readonly mappings: string;
    /** Indices into sources array that should be ignored (e.g., library code) */
    readonly ignoreList?: readonly number[];
}

/**
 * Offset for a section in an index map
 * @see https://tc39.es/ecma426/
 */
export interface IndexMapOffset {
    readonly line: number;
    readonly column: number;
}

/**
 * A section in an index map, containing an offset and a nested source map
 * @see https://tc39.es/ecma426/
 */
export interface IndexMapSection {
    readonly offset: IndexMapOffset;
    readonly map: SourceMapV3;
}

/**
 * Index Map V3 specification (concatenated source maps)
 * An index map contains sections, each with an offset and a nested regular source map.
 * Index maps cannot be nested (a section's map cannot be another index map).
 * @see https://tc39.es/ecma426/
 */
export interface IndexMapV3 {
    readonly version: 3;
    readonly file?: string;
    readonly sections: readonly IndexMapSection[];
}

/**
 * Union type for any valid source map (regular or index map)
 * @see https://tc39.es/ecma426/
 */
export type SourceMap = SourceMapV3 | IndexMapV3;

// ============================================================================
// SOURCE MAP EXTRACTION TYPES
// ============================================================================

/**
 * A source file extracted from a source map
 */
export interface ExtractedSource {
    /** Normalized path (after webpack://, vite, etc. processing) */
    readonly path: string;
    /** Original source content */
    readonly content: string;
    /** Original path before normalization (for debugging) */
    readonly originalPath?: string;
}

/**
 * Metadata about a source map extraction
 */
export interface SourceMapMetadata {
    readonly version: number;
    readonly sourceRoot: string | null;
    readonly totalSources: number;
    readonly extractedCount: number;
    readonly skippedCount: number;
    readonly nullContentCount: number;
}

/**
 * Result of source map extraction
 */
export interface SourceMapExtractionResult {
    readonly bundleUrl: string;
    readonly sourceMapUrl: string;
    readonly sources: readonly ExtractedSource[];
    /** Fatal errors that prevented extraction */
    readonly errors: readonly Error[];
    /** Non-fatal warnings (e.g., sourcesContent length mismatch) */
    readonly warnings?: readonly string[];
    readonly metadata: SourceMapMetadata;
}

/**
 * How a source map was discovered
 */
export type SourceMapLocationType =
    | 'http-header'
    | 'js-comment'
    | 'css-comment'
    | 'inline-data-uri'
    | 'url-probe';

/**
 * Result of source map discovery
 */
export interface SourceMapDiscoveryResult {
    readonly found: boolean;
    readonly sourceMapUrl: string | null;
    readonly locationType: SourceMapLocationType | null;
    /** Bundle content (available when discovery fetched the bundle) */
    readonly bundleContent?: string;
}

/**
 * Options for source map extraction
 */
export interface ExtractSourceMapOptions {
    /** Additional path patterns to exclude */
    readonly excludePatterns?: readonly RegExp[];
    /** Callback for each extracted source (streaming) */
    readonly onSource?: (source: ExtractedSource) => void;
    /** Maximum source map size in bytes (default: 100MB) */
    readonly maxSize?: number;
    /** Fetch timeout in milliseconds (default: 30000) */
    readonly timeout?: number;
    /** Custom fetch headers */
    readonly headers?: Record<string, string>;
    /** AbortSignal for cancellation support */
    readonly signal?: AbortSignal;
}

/**
 * Options for source map discovery
 */
export interface DiscoverSourceMapOptions {
    /** Fetch timeout in milliseconds */
    readonly timeout?: number;
    /** Custom fetch headers */
    readonly headers?: Record<string, string>;
    /** AbortSignal for cancellation support */
    readonly signal?: AbortSignal;
}

/**
 * A structured validation error with code and field information.
 */
export interface SourceMapValidationError {
    /** Error code for programmatic handling */
    readonly code: SourceMapErrorCode;
    /** Human-readable error message */
    readonly message: string;
    /** The field that caused the error (if applicable) */
    readonly field?: string;
}

/**
 * Result of source map validation
 */
export interface SourceMapValidationResult {
    readonly valid: boolean;
    /** Structured validation errors with codes */
    readonly errors: readonly SourceMapValidationError[];
    readonly warnings: readonly string[];
}

// ============================================================================
// DEPENDENCY ANALYSIS TYPES
// ============================================================================

/**
 * Version confidence level for detected dependencies
 */
export type VersionConfidence =
    | 'exact'
    | 'high'
    | 'medium'
    | 'low'
    | 'unverified';

/**
 * Source of version information
 */
export type VersionSource =
    | 'package.json'
    | 'banner'
    | 'lockfile-path'
    | 'version-constant'
    | 'sourcemap-path'
    | 'fingerprint'
    | 'fingerprint-minified'
    | 'custom-build'
    | 'peer-dep'
    | 'npm-latest';

/**
 * Information about a detected dependency
 */
export interface DependencyInfo {
    name: string;
    version: string | null;
    confidence?: VersionConfidence;
    versionSource?: VersionSource;
    importedFrom: string[];
    isPrivate?: boolean;
}

/**
 * Result of dependency analysis
 */
export interface AnalysisResult {
    dependencies: Map<string, DependencyInfo>;
    localImports: Set<string>;
    errors: string[];
}

/**
 * Detected project configuration
 */
export interface DetectedProjectConfig {
    hasTypeScript: boolean;
    hasJavaScript: boolean;
    hasJsx: boolean;
    jsxFramework: 'react' | 'preact' | 'solid' | 'vue' | 'none';
    moduleSystem: 'esm' | 'commonjs' | 'mixed';
    environment: 'browser' | 'node' | 'both';
    targetFeatures: {
        asyncAwait: boolean;
        optionalChaining: boolean;
        nullishCoalescing: boolean;
    };
}

/**
 * Alias map for path resolution
 */
export interface AliasMap {
    aliases: Map<string, string>;
    evidence: Map<string, { importingFile: string; resolvedPath: string }[]>;
}

/**
 * Inferred alias with confidence level
 */
export interface InferredAlias {
    alias: string;
    targetPath: string;
    evidence: string[];
    confidence: 'high' | 'medium' | 'low';
}

// ============================================================================
// API CAPTURE TYPES
// ============================================================================

/**
 * HTTP methods supported for API capture
 */
export type HttpMethod =
    | 'GET'
    | 'POST'
    | 'PUT'
    | 'DELETE'
    | 'PATCH'
    | 'HEAD'
    | 'OPTIONS';

/**
 * Captured API request details
 */
export interface CapturedRequest {
    method: HttpMethod;
    url: string;
    path: string;
    query: Record<string, string>;
    headers: Record<string, string>;
    body?: unknown;
    bodyRaw?: string;
}

/**
 * Captured API response details
 */
export interface CapturedResponse {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: unknown;
    bodyRaw?: string;
    bodyType: 'json' | 'text' | 'binary';
}

/**
 * A captured API call (request + response pair)
 */
export interface ApiFixture {
    id: string;
    request: CapturedRequest & {
        /** URL pattern with path parameters, e.g., "/api/users/:id" */
        pattern: string;
        /** Names of path parameters, e.g., ["id"] */
        pathParams: string[];
    };
    response: CapturedResponse;
    /** Timestamp when the call was captured */
    timestamp: number;
    /** Priority for sorting (higher = more important) */
    priority: number;
}

/**
 * Captured static asset
 */
export interface CapturedAsset {
    url: string;
    localPath: string;
    contentType: string;
    size: number;
    isEntrypoint: boolean;
}

/**
 * Captured redirect
 */
export interface CapturedRedirect {
    from: string;
    to: string;
    status: number;
}

/**
 * Fixture index entry
 */
export interface FixtureIndexEntry {
    id: string;
    file: string;
    method: HttpMethod;
    pattern: string;
    params: string[];
    status: number;
    priority: number;
}

/**
 * Fixture index for quick lookup
 */
export interface FixtureIndex {
    generatedAt: number;
    fixtures: FixtureIndexEntry[];
}

/**
 * Server manifest configuration
 */
export interface ServerManifest {
    name: string;
    sourceUrl: string;
    capturedAt: string;
    server: {
        defaultPort: number;
        cors: boolean;
        delay: {
            enabled: boolean;
            minMs: number;
            maxMs: number;
        };
    };
    routes: {
        api: string;
        static: string;
    };
    fixtures: {
        count: number;
        indexFile: string;
    };
    static: {
        enabled: boolean;
        entrypoint: string | undefined;
        assetCount: number;
        pathPrefix: string;
    };
    redirects?: CapturedRedirect[];
}
