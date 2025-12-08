/**
 * @web2local/types
 *
 * Shared TypeScript types for web2local packages
 */

// ============================================================================
// SOURCE MAP TYPES
// ============================================================================

/**
 * Source Map V3 specification
 * @see https://sourcemaps.info/spec.html
 */
export interface SourceMapV3 {
    readonly version: 3;
    readonly file?: string;
    readonly sourceRoot?: string;
    readonly sources: readonly string[];
    readonly sourcesContent?: readonly (string | null)[];
    readonly names?: readonly string[];
    readonly mappings: string;
}

/**
 * A source file extracted from a source map
 */
export interface ExtractedSource {
    /** Normalized path (after webpack://, vite, etc. processing) */
    readonly path: string;
    /** Original source content */
    readonly content: string;
    /** Original path before normalization (for debugging) */
    readonly originalPath: string;
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
    readonly errors: readonly Error[];
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
    /** Include node_modules sources (default: false) */
    readonly includeNodeModules?: boolean;
    /** Package names that are "internal" and should always be included */
    readonly internalPackages?: ReadonlySet<string>;
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
}

/**
 * Options for source map discovery
 */
export interface DiscoverSourceMapOptions {
    /** Skip HTTP header check */
    readonly skipHeaderCheck?: boolean;
    /** Skip comment parsing */
    readonly skipCommentCheck?: boolean;
    /** Skip .map URL probing */
    readonly skipProbe?: boolean;
    /** Fetch timeout in milliseconds */
    readonly timeout?: number;
    /** Custom fetch headers */
    readonly headers?: Record<string, string>;
}

/**
 * Result of source map validation
 */
export interface SourceMapValidationResult {
    readonly valid: boolean;
    readonly errors: readonly string[];
    readonly warnings: readonly string[];
}

// ============================================================================
// LEGACY TYPES (for backwards compatibility)
// ============================================================================

/**
 * A source file extracted from a source map
 * @deprecated Use ExtractedSource instead
 */
export interface SourceFile {
    /** The file path (relative to source root) */
    path: string;
    /** The file content */
    content: string;
}

/**
 * Information about a JavaScript/CSS bundle
 */
export interface BundleInfo {
    /** The URL of the bundle */
    url: string;
    /** The type of bundle */
    type: 'script' | 'stylesheet';
    /** The URL of the source map, if available */
    sourceMapUrl?: string;
}

/**
 * Result of extracting sources from a source map
 */
export interface SourceMapResult {
    /** The URL of the bundle this source map belongs to */
    bundleUrl: string;
    /** The URL of the source map */
    sourceMapUrl: string;
    /** The extracted source files */
    files: SourceFile[];
    /** Any errors encountered during extraction */
    errors: string[];
}

/**
 * Options for reconstruction
 */
export interface ReconstructionOptions {
    /** The output directory */
    outputDir: string;
    /** Whether to include node_modules */
    includeNodeModules: boolean;
    /** Internal packages that should always be extracted */
    internalPackages?: Set<string>;
    /** The hostname of the site being extracted */
    siteHostname: string;
    /** The name of the bundle being extracted */
    bundleName: string;
}

/**
 * Result of reconstructing sources
 */
export interface ReconstructionResult {
    /** Number of files written */
    filesWritten: number;
    /** Number of files skipped */
    filesSkipped: number;
    /** Number of files unchanged */
    filesUnchanged: number;
    /** Any errors encountered */
    errors: string[];
    /** The output path */
    outputPath: string;
}

/**
 * Information about a detected alias
 */
export interface AliasInfo {
    /** The alias pattern (e.g., '@components') */
    pattern: string;
    /** The target path (e.g., './src/components') */
    target: string;
}

/**
 * Progress callback type
 */
export type ProgressCallback = (message: string) => void;

/**
 * Verbose logging callback type
 */
export type VerboseCallback = (message: string) => void;

/**
 * Information about a dependency
 */
export interface DependencyInfo {
    name: string;
    version: string | null;
    confidence?: 'exact' | 'high' | 'medium' | 'low' | 'unverified';
    versionSource?:
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
 * Mapping of alias to the actual path
 */
export interface AliasPathMapping {
    alias: string;
    actualPackage: string;
    relativePath: string;
}

/**
 * Workspace package mapping
 */
export interface WorkspacePackageMapping {
    name: string;
    relativePath: string;
}

/**
 * Subpath mapping
 */
export interface SubpathMapping {
    specifier: string;
    relativePath: string;
}

/**
 * Alias map
 */
export interface AliasMap {
    aliases: Map<string, string>;
    evidence: Map<string, { importingFile: string; resolvedPath: string }[]>;
}

/**
 * Inferred alias
 */
export interface InferredAlias {
    alias: string;
    targetPath: string;
    evidence: string[];
    confidence: 'high' | 'medium' | 'low';
}

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
