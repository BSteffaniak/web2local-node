/**
 * @web2local/sourcemap
 *
 * Professional source map parsing, discovery, and extraction.
 *
 * This package provides a clean, well-structured API for working with source maps:
 *
 * - **Discovery**: Find source maps from bundle URLs (headers, comments, probing)
 * - **Parsing**: Parse and validate source map JSON (including inline base64)
 * - **Extraction**: Extract source files with path normalization and filtering
 *
 * @example
 * ```typescript
 * import { extractSourceMap } from '@web2local/sourcemap';
 *
 * // Simple: extract sources from a bundle URL
 * const result = await extractSourceMap('https://example.com/bundle.js');
 * for (const source of result.sources) {
 *   console.log(source.path, source.content.length);
 * }
 *
 * // Advanced: use individual functions for more control
 * import { discoverSourceMap, parseSourceMap, extractSources } from '@web2local/sourcemap';
 *
 * const discovery = await discoverSourceMap(bundleUrl);
 * if (discovery.found) {
 *   const content = await fetch(discovery.sourceMapUrl).then(r => r.text());
 *   const parsed = parseSourceMap(content);
 *   const result = extractSources(parsed, bundleUrl, discovery.sourceMapUrl);
 * }
 * ```
 */

// ============================================================================
// TYPE RE-EXPORTS
// ============================================================================

export type {
    SourceMapV3,
    ExtractedSource,
    SourceMapMetadata,
    SourceMapExtractionResult,
    SourceMapLocationType,
    SourceMapDiscoveryResult,
    ExtractSourceMapOptions,
    DiscoverSourceMapOptions,
    SourceMapValidationResult,
    SourceMapValidationError,
} from '@web2local/types';

// ============================================================================
// ERROR EXPORTS
// ============================================================================

export {
    SourceMapError,
    SourceMapErrorCode,
    createHttpError,
    createParseError,
    createValidationError,
    createNetworkError,
    createSizeError,
    createDiscoveryError,
    createContentError,
    createDataUriError,
} from './errors.js';

// ============================================================================
// CONSTANT EXPORTS
// ============================================================================

export {
    WEBPACK_PROTOCOL,
    VITE_VIRTUAL_PREFIX,
    SOURCE_MAP_HEADERS,
    VALID_SOURCE_MAP_CONTENT_TYPES,
    INVALID_SOURCE_MAP_CONTENT_TYPES,
    ALLOW_MISSING_CONTENT_TYPE,
    JS_SOURCE_MAP_COMMENT_PATTERN,
    CSS_SOURCE_MAP_COMMENT_PATTERN,
    DATA_URI_PATTERN,
    EXCLUDE_PATH_PATTERNS,
    DEFAULT_MAX_SOURCE_MAP_SIZE,
    DEFAULT_TIMEOUT,
    SUPPORTED_SOURCE_MAP_VERSION,
    ERROR_PREVIEW_LENGTH,
} from './constants.js';

// ============================================================================
// UTILITY EXPORTS
// ============================================================================

export { normalizeSourcePath, getCleanFilename } from './utils/path.js';
export { isDataUri, resolveSourceMapUrl, decodeDataUri } from './utils/url.js';
export { shouldIncludeSource, type FilterOptions } from './utils/filter.js';

// ============================================================================
// PARSER EXPORTS
// ============================================================================

export {
    parseSourceMap,
    parseInlineSourceMap,
    parseSourceMapAuto,
    validateSourceMap,
    isSourceMapV3,
} from './parser.js';

// ============================================================================
// DISCOVERY EXPORTS
// ============================================================================

export {
    discoverSourceMap,
    findSourceMapInHeaders,
    findSourceMapInComment,
    findSourceMapInJsComment,
    findSourceMapInCssComment,
    probeSourceMapUrl,
    isValidSourceMapContentType,
} from './discovery.js';

// ============================================================================
// SOURCE EXTRACTION EXPORTS
// ============================================================================

export {
    extractSources,
    hasExtractableContent,
    getSourceMapSummary,
} from './sources.js';

// ============================================================================
// HIGH-LEVEL CONVENIENCE FUNCTION
// ============================================================================

export { extractSourceMap } from './extract.js';
