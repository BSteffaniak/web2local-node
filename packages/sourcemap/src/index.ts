/**
 * @web2local/sourcemap
 *
 * Professional source map parsing, discovery, and extraction.
 * Implements the ECMA-426 Source Map specification.
 *
 * ## Quick Start
 *
 * ```typescript
 * import { extractSourceMap } from '@web2local/sourcemap';
 *
 * const result = await extractSourceMap('https://example.com/bundle.js');
 * for (const source of result.sources) {
 *     console.log(source.path, source.content.length);
 * }
 * ```
 *
 * ## Advanced Usage
 *
 * ```typescript
 * import { discoverSourceMap, parseSourceMap, extractSources } from '@web2local/sourcemap';
 *
 * const discovery = await discoverSourceMap(bundleUrl);
 * if (discovery.found) {
 *     const content = await fetch(discovery.sourceMapUrl).then(r => r.text());
 *     const parsed = parseSourceMap(content);
 *     const result = extractSources(parsed, bundleUrl, discovery.sourceMapUrl);
 * }
 * ```
 *
 * @see https://tc39.es/ecma426/ - ECMA-426 Source Map Specification
 */

// ============================================================================
// PRIMARY API
// ============================================================================

/**
 * High-level extraction function - all-in-one discovery, fetch, parse, extract.
 * This is the recommended entry point for most use cases.
 */
export { extractSourceMap } from './extract.js';

// ============================================================================
// TYPES
// ============================================================================

export type {
    // Source Map Types
    SourceMapV3,
    IndexMapV3,
    IndexMapSection,
    IndexMapOffset,
    SourceMap,
    // Extraction Types
    ExtractedSource,
    SourceMapMetadata,
    SourceMapExtractionResult,
    // Discovery Types
    SourceMapLocationType,
    SourceMapDiscoveryResult,
    // Options Types
    ExtractSourceMapOptions,
    DiscoverSourceMapOptions,
    // Validation Types
    SourceMapValidationResult,
    SourceMapValidationError,
    // Result Type
    Result,
} from '@web2local/types';

export { SourceMapErrorCode, Ok, Err } from '@web2local/types';

// ============================================================================
// DISCOVERY API
// ============================================================================

/**
 * Discovers source maps from bundle URLs using multiple strategies:
 * HTTP headers, inline/external comments, and URL probing.
 */
export { discoverSourceMap, findSourceMapInComment } from './discovery.js';

// ============================================================================
// PARSING & VALIDATION API
// ============================================================================

/**
 * Parse and validate source map JSON content.
 * Supports both regular and index maps per ECMA-426.
 */
export {
    parseSourceMap,
    parseSourceMapAuto,
    parseInlineSourceMap,
    validateSourceMap,
    isSourceMapV3,
} from './parser.js';

// ============================================================================
// SOURCE EXTRACTION API
// ============================================================================

/**
 * Extract source files from parsed source maps.
 * Handles path normalization and filtering.
 */
export {
    extractSources,
    hasExtractableContent,
    getSourceMapSummary,
} from './sources.js';

// ============================================================================
// MAPPINGS VALIDATION API
// ============================================================================

/**
 * Validate VLQ-encoded mappings strings.
 * Low-level API for custom validation needs.
 */
export { validateMappings, type MappingsValidationResult } from './mappings.js';

// ============================================================================
// ERROR HANDLING
// ============================================================================

/**
 * Custom error class with structured error codes.
 * Use isNetworkError(), isValidationError(), etc. for error classification.
 */
export {
    SourceMapError,
    isNetworkError,
    isValidationError,
    isParseError,
    isVlqError,
} from './errors.js';

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Path normalization for webpack://, vite, and other bundler formats.
 */
export { normalizeSourcePath, getCleanFilename } from './utils/path.js';

/**
 * Source filtering for node_modules, internal packages, etc.
 */
export { shouldIncludeSource, type FilterOptions } from './utils/filter.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Default configuration values. Use these for reference when customizing options.
 */
export { DEFAULT_MAX_SOURCE_MAP_SIZE, DEFAULT_TIMEOUT } from './constants.js';
