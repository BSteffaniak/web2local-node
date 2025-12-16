/**
 * `@web2local/types`
 *
 * Shared TypeScript types for web2local packages.
 * This module provides type definitions for source map operations,
 * dependency analysis, API capture, and project configuration.
 *
 * @packageDocumentation
 */

// ============================================================================
// SOURCE MAP ERROR CODES
// ============================================================================

/**
 * Granular error codes for source map operations.
 *
 * Use these codes for programmatic error handling to distinguish between
 * different failure modes such as network errors, parsing errors, and
 * validation errors.
 *
 * @example
 * ```typescript
 * import { SourceMapErrorCode } from '@web2local/types';
 *
 * if (error.code === SourceMapErrorCode.FETCH_TIMEOUT) {
 *     console.log('Request timed out, retrying...');
 * }
 * ```
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
 * ```typescript
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
 * ```
 */
export type Result<T, E = string> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: E };

/**
 * Creates a successful Result wrapping the given value.
 *
 * @typeParam T - The type of the success value
 * @param value - The success value to wrap
 * @returns A Result with `ok: true` containing the value
 *
 * @example
 * ```typescript
 * const result = Ok(42);
 * // result.ok === true
 * // result.value === 42
 * ```
 */
export function Ok<T>(value: T): Result<T, never> {
    return { ok: true, value };
}

/**
 * Creates a failed Result wrapping the given error.
 *
 * @typeParam E - The type of the error value
 * @param error - The error value to wrap
 * @returns A Result with `ok: false` containing the error
 *
 * @example
 * ```typescript
 * const result = Err('Something went wrong');
 * // result.ok === false
 * // result.error === 'Something went wrong'
 * ```
 */
export function Err<E>(error: E): Result<never, E> {
    return { ok: false, error };
}

// ============================================================================
// SOURCE MAP TYPES
// ============================================================================

/**
 * Source Map V3 specification (regular source map, not index map).
 *
 * Represents a standard source map as defined in the ECMA-426 specification.
 * This is the most common source map format, containing mappings from
 * generated code positions to original source positions.
 *
 * @see https://tc39.es/ecma426/
 */
export interface SourceMapV3 {
    /** Source map version (always 3 for V3 source maps). */
    readonly version: 3;
    /** Name of the generated file this source map is for. */
    readonly file?: string;
    /** Path prefix to prepend to all source paths. */
    readonly sourceRoot?: string;
    /** Array of source file paths. Entries can be null per ECMA-426. */
    readonly sources: readonly (string | null)[];
    /** Original source content for each entry in sources (same order). */
    readonly sourcesContent?: readonly (string | null)[];
    /** Symbol names referenced by the mappings. */
    readonly names?: readonly string[];
    /** VLQ-encoded mappings from generated to original positions. */
    readonly mappings: string;
    /** Indices into sources array that should be ignored (e.g., library code). */
    readonly ignoreList?: readonly number[];
}

/**
 * Offset for a section in an index map.
 *
 * Specifies where in the generated code a particular section's
 * mappings begin, using zero-based line and column numbers.
 *
 * @see https://tc39.es/ecma426/
 */
export interface IndexMapOffset {
    /** Zero-based line number in the generated code. */
    readonly line: number;
    /** Zero-based column number in the generated code. */
    readonly column: number;
}

/**
 * A section in an index map, containing an offset and a nested source map.
 *
 * Each section represents a portion of the generated code with its own
 * source map. The offset indicates where the section starts in the
 * generated file.
 *
 * @see https://tc39.es/ecma426/
 */
export interface IndexMapSection {
    /** Position in the generated code where this section starts. */
    readonly offset: IndexMapOffset;
    /** Source map for this section of the generated code. */
    readonly map: SourceMapV3;
}

/**
 * Index Map V3 specification (concatenated source maps).
 *
 * An index map contains sections, each with an offset and a nested regular
 * source map. This format is used when multiple source maps are combined
 * into a single file. Index maps cannot be nested (a section's map cannot
 * be another index map).
 *
 * @see https://tc39.es/ecma426/
 */
export interface IndexMapV3 {
    /** Source map version (always 3 for V3 source maps). */
    readonly version: 3;
    /** Name of the generated file this source map is for. */
    readonly file?: string;
    /** Array of sections, each containing an offset and a source map. */
    readonly sections: readonly IndexMapSection[];
}

/**
 * Union type for any valid source map (regular or index map).
 *
 * Use the presence of `sections` vs `mappings` to discriminate between
 * index maps and regular source maps.
 *
 * @see https://tc39.es/ecma426/
 */
export type SourceMap = SourceMapV3 | IndexMapV3;

// ============================================================================
// SOURCE MAP EXTRACTION TYPES
// ============================================================================

/**
 * A source file extracted from a source map.
 *
 * Represents an individual source file whose content was embedded in
 * a source map's `sourcesContent` array and has been extracted for
 * reconstruction.
 */
export interface ExtractedSource {
    /** Normalized file path after processing webpack://, vite, and similar URL schemes. */
    readonly path: string;
    /** The original source code content from the source map. */
    readonly content: string;
    /** Original path before normalization, useful for debugging path resolution issues. */
    readonly originalPath?: string;
}

/**
 * Metadata about a source map extraction.
 *
 * Provides statistics and information about the extraction process,
 * including counts of sources processed, extracted, and skipped.
 */
export interface SourceMapMetadata {
    /** Source map version (typically 3). */
    readonly version: number;
    /** Source root path from the source map, if present. */
    readonly sourceRoot: string | null;
    /** Total number of sources listed in the source map. */
    readonly totalSources: number;
    /** Number of sources successfully extracted with content. */
    readonly extractedCount: number;
    /** Number of sources skipped (e.g., due to exclude patterns). */
    readonly skippedCount: number;
    /** Number of sources with null or missing content. */
    readonly nullContentCount: number;
}

/**
 * Result of source map extraction.
 *
 * Contains the extracted sources, any errors or warnings encountered,
 * and metadata about the extraction process.
 */
export interface SourceMapExtractionResult {
    /** URL of the bundle file the source map was extracted from. */
    readonly bundleUrl: string;
    /** URL of the source map file. */
    readonly sourceMapUrl: string;
    /** Array of extracted source files with their content. */
    readonly sources: readonly ExtractedSource[];
    /** Fatal errors that prevented extraction. */
    readonly errors: readonly Error[];
    /** Non-fatal warnings (e.g., sourcesContent length mismatch). */
    readonly warnings?: readonly string[];
    /** Statistics and information about the extraction. */
    readonly metadata: SourceMapMetadata;
}

/**
 * How a source map was discovered.
 *
 * - `http-header`: Found via SourceMap HTTP header
 * - `js-comment`: Found via `//# sourceMappingURL=` comment in JavaScript
 * - `css-comment`: Found via `/*# sourceMappingURL=` comment in CSS
 * - `inline-data-uri`: Source map is inline as a data URI
 * - `url-probe`: Found by probing common source map URL patterns
 */
export type SourceMapLocationType =
    | 'http-header'
    | 'js-comment'
    | 'css-comment'
    | 'inline-data-uri'
    | 'url-probe';

/**
 * Result of source map discovery.
 *
 * Contains information about whether a source map was found and
 * how it was located.
 */
export interface SourceMapDiscoveryResult {
    /** Whether a source map was found for the bundle. */
    readonly found: boolean;
    /** URL of the discovered source map, or null if not found. */
    readonly sourceMapUrl: string | null;
    /** Method used to discover the source map, or null if not found. */
    readonly locationType: SourceMapLocationType | null;
    /** Bundle content (available when discovery fetched the bundle). */
    readonly bundleContent?: string;
}

/**
 * Options for source map extraction.
 *
 * Configure how source maps are fetched and which sources are extracted.
 */
export interface ExtractSourceMapOptions {
    /** Additional path patterns to exclude. */
    readonly excludePatterns?: readonly RegExp[];
    /** Callback for each extracted source (streaming). */
    readonly onSource?: (source: ExtractedSource) => void;
    /**
     * Maximum source map size in bytes.
     * @defaultValue 104857600 (100MB)
     */
    readonly maxSize?: number;
    /**
     * Fetch timeout in milliseconds.
     * @defaultValue 30000
     */
    readonly timeout?: number;
    /** Custom HTTP headers to include in fetch requests. */
    readonly headers?: Record<string, string>;
    /** AbortSignal for cancellation support. */
    readonly signal?: AbortSignal;
}

/**
 * Options for source map discovery.
 *
 * Configure how source maps are discovered for a given bundle URL.
 */
export interface DiscoverSourceMapOptions {
    /** Fetch timeout in milliseconds. */
    readonly timeout?: number;
    /** Custom HTTP headers to include in fetch requests. */
    readonly headers?: Record<string, string>;
    /** AbortSignal for cancellation support. */
    readonly signal?: AbortSignal;
}

/**
 * A structured validation error with code and field information.
 *
 * Used to report specific issues found during source map validation
 * with machine-readable error codes for programmatic handling.
 */
export interface SourceMapValidationError {
    /** Error code for programmatic handling. */
    readonly code: SourceMapErrorCode;
    /** Human-readable error message. */
    readonly message: string;
    /** The field that caused the error (if applicable). */
    readonly field?: string;
}

/**
 * Result of source map validation.
 *
 * Contains the validation status along with any errors or warnings
 * discovered during validation.
 */
export interface SourceMapValidationResult {
    /** Whether the source map passed validation. */
    readonly valid: boolean;
    /** Structured validation errors with codes. */
    readonly errors: readonly SourceMapValidationError[];
    /** Non-fatal warnings about the source map. */
    readonly warnings: readonly string[];
}

// ============================================================================
// DEPENDENCY ANALYSIS TYPES
// ============================================================================

/**
 * Confidence level for detected dependency versions.
 *
 * - `exact`: Version confirmed from package.json or lockfile
 * - `high`: Version strongly indicated by banner or version constant
 * - `medium`: Version inferred from source map paths or fingerprints
 * - `low`: Version is a best guess based on limited evidence
 * - `unverified`: Version could not be determined
 */
export type VersionConfidence =
    | 'exact'
    | 'high'
    | 'medium'
    | 'low'
    | 'unverified';

/**
 * Source of version information for a detected dependency.
 *
 * - `package.json`: Found in extracted package.json
 * - `banner`: Parsed from library banner comment
 * - `lockfile-path`: Inferred from lockfile path in source map
 * - `version-constant`: Found as a version constant in source
 * - `sourcemap-path`: Inferred from node_modules path in source map
 * - `fingerprint`: Matched against known library fingerprints
 * - `fingerprint-minified`: Matched fingerprint in minified code
 * - `custom-build`: Detected as a custom/modified build
 * - `peer-dep`: Inferred from peer dependency requirements
 * - `npm-latest`: Defaulted to latest version from npm registry
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
 * Information about a detected dependency.
 *
 * Represents a package dependency discovered during source analysis,
 * including version information and confidence level.
 */
export interface DependencyInfo {
    /** Package name (e.g., "react", `@types/node`). */
    name: string;
    /** Detected version, or null if unknown. */
    version: string | null;
    /** Confidence level in the detected version. */
    confidence?: VersionConfidence;
    /** How the version was determined. */
    versionSource?: VersionSource;
    /** Source files that import this dependency. */
    importedFrom: string[];
    /** Whether this is a private/scoped package. */
    isPrivate?: boolean;
}

/**
 * Result of dependency analysis.
 *
 * Contains the detected dependencies, local imports, and any errors
 * encountered during analysis.
 */
export interface AnalysisResult {
    /** Map of package names to their dependency information. */
    dependencies: Map<string, DependencyInfo>;
    /** Set of local/relative import paths found in the sources. */
    localImports: Set<string>;
    /** Error messages encountered during analysis. */
    errors: string[];
}

/**
 * Detected project configuration.
 *
 * Information about the project structure and features inferred
 * from the extracted source files.
 */
export interface DetectedProjectConfig {
    /** Whether TypeScript files were found. */
    hasTypeScript: boolean;
    /** Whether JavaScript files were found. */
    hasJavaScript: boolean;
    /** Whether JSX/TSX syntax was detected. */
    hasJsx: boolean;
    /** Detected JSX framework, or 'none' if no JSX. */
    jsxFramework: 'react' | 'preact' | 'solid' | 'vue' | 'none';
    /** Detected module system used in the project. */
    moduleSystem: 'esm' | 'commonjs' | 'mixed';
    /** Target runtime environment. */
    environment: 'browser' | 'node' | 'both';
    /** Modern JavaScript features detected in use. */
    targetFeatures: {
        /** Whether async/await syntax is used. */
        asyncAwait: boolean;
        /** Whether optional chaining (?.) is used. */
        optionalChaining: boolean;
        /** Whether nullish coalescing (??) is used. */
        nullishCoalescing: boolean;
    };
}

/**
 * Alias map for path resolution.
 *
 * Contains detected path aliases (like webpack aliases or TypeScript
 * path mappings) and evidence supporting each alias detection.
 */
export interface AliasMap {
    /** Map of alias prefixes to their resolved base paths. */
    aliases: Map<string, string>;
    /** Evidence for each alias, showing imports that support the detection. */
    evidence: Map<string, { importingFile: string; resolvedPath: string }[]>;
}

/**
 * Inferred alias with confidence level.
 *
 * Represents a single detected path alias with supporting evidence
 * and a confidence score for the detection.
 */
export interface InferredAlias {
    /** The alias prefix (e.g., `@/`, "~components/"). */
    alias: string;
    /** The resolved target path for this alias. */
    targetPath: string;
    /** Import statements that support this alias detection. */
    evidence: string[];
    /** Confidence level in the alias detection. */
    confidence: 'high' | 'medium' | 'low';
}

// ============================================================================
// API CAPTURE TYPES
// ============================================================================

/**
 * HTTP methods supported for API capture.
 *
 * Standard HTTP methods that can be captured and replayed
 * by the fixture server.
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
 * Captured API request details.
 *
 * Contains all information about an HTTP request that was
 * intercepted during capture.
 */
export interface CapturedRequest {
    /** HTTP method of the request. */
    method: HttpMethod;
    /** Full URL of the request. */
    url: string;
    /** URL path without query string. */
    path: string;
    /** Query string parameters as key-value pairs. */
    query: Record<string, string>;
    /** HTTP headers sent with the request. */
    headers: Record<string, string>;
    /** Parsed request body (for JSON requests). */
    body?: unknown;
    /** Raw request body as a string. */
    bodyRaw?: string;
}

/**
 * Captured API response details.
 *
 * Contains all information about an HTTP response that was
 * intercepted during capture.
 */
export interface CapturedResponse {
    /** HTTP status code. */
    status: number;
    /** HTTP status text (e.g., "OK", "Not Found"). */
    statusText: string;
    /** HTTP headers from the response. */
    headers: Record<string, string>;
    /** Parsed response body (for JSON) or raw content. */
    body: unknown;
    /** Raw response body as a string. */
    bodyRaw?: string;
    /** Type of the response body content. */
    bodyType: 'json' | 'text' | 'binary';
}

/**
 * A captured API call (request + response pair).
 *
 * Represents a complete API interaction that was captured and
 * can be replayed by the fixture server.
 */
export interface ApiFixture {
    /** Unique identifier for this fixture. */
    id: string;
    /** Request details with pattern matching information. */
    request: CapturedRequest & {
        /** URL pattern with path parameters, e.g., "/api/users/:id". */
        pattern: string;
        /** Names of path parameters, e.g., ["id"]. */
        pathParams: string[];
    };
    /** Response that was captured for this request. */
    response: CapturedResponse;
    /** Timestamp when the call was captured (Unix milliseconds). */
    timestamp: number;
    /** Priority for sorting (higher = more important). */
    priority: number;
}

/**
 * Captured static asset.
 *
 * Represents a static file (JS, CSS, image, etc.) that was
 * downloaded during capture.
 */
export interface CapturedAsset {
    /** Original URL the asset was fetched from. */
    url: string;
    /** Local file path where the asset is stored. */
    localPath: string;
    /** MIME content type of the asset. */
    contentType: string;
    /** File size in bytes. */
    size: number;
    /** Whether this is an entry point (HTML page). */
    isEntrypoint: boolean;
}

/**
 * Captured redirect.
 *
 * Represents an HTTP redirect that was encountered during capture.
 */
export interface CapturedRedirect {
    /** Original URL that triggered the redirect. */
    from: string;
    /** Target URL the redirect points to. */
    to: string;
    /** HTTP status code of the redirect (301, 302, etc.). */
    status: number;
}

/**
 * Fixture index entry.
 *
 * A compact representation of a fixture for the index file,
 * enabling quick lookup without loading full fixture data.
 */
export interface FixtureIndexEntry {
    /** Unique identifier for the fixture. */
    id: string;
    /** File path where the full fixture is stored. */
    file: string;
    /** HTTP method this fixture matches. */
    method: HttpMethod;
    /** URL pattern for matching requests. */
    pattern: string;
    /** Path parameter names in the pattern. */
    params: string[];
    /** HTTP status code returned by this fixture. */
    status: number;
    /** Priority for sorting when multiple fixtures match. */
    priority: number;
}

/**
 * Fixture index for quick lookup.
 *
 * Contains a list of all fixtures with metadata for efficient
 * route matching without loading individual fixture files.
 */
export interface FixtureIndex {
    /** Timestamp when the index was generated (Unix milliseconds). */
    generatedAt: number;
    /** Array of fixture entries for route matching. */
    fixtures: FixtureIndexEntry[];
}

/**
 * Server manifest configuration.
 *
 * Configuration and metadata for a captured fixture server,
 * stored in the manifest.json file.
 */
export interface ServerManifest {
    /** Name of the captured site/application. */
    name: string;
    /** Original URL that was captured. */
    sourceUrl: string;
    /** ISO timestamp when capture was performed. */
    capturedAt: string;
    /** Server configuration options. */
    server: {
        /** Default port for the fixture server. */
        defaultPort: number;
        /** Whether CORS headers are enabled. */
        cors: boolean;
        /** Response delay configuration for simulating latency. */
        delay: {
            /** Whether delay is enabled. */
            enabled: boolean;
            /** Minimum delay in milliseconds. */
            minMs: number;
            /** Maximum delay in milliseconds. */
            maxMs: number;
        };
    };
    /** Route path configuration. */
    routes: {
        /** Base path for API fixture routes. */
        api: string;
        /** Base path for static asset routes. */
        static: string;
    };
    /** Fixture collection information. */
    fixtures: {
        /** Total number of captured fixtures. */
        count: number;
        /** Path to the fixture index file. */
        indexFile: string;
    };
    /** Static asset configuration. */
    static: {
        /** Whether static file serving is enabled. */
        enabled: boolean;
        /** Path to the main HTML entry point. */
        entrypoint: string | undefined;
        /** Total number of captured static assets. */
        assetCount: number;
        /** URL path prefix for static assets. */
        pathPrefix: string;
    };
    /** Captured redirects to replay. */
    redirects?: CapturedRedirect[];
}
