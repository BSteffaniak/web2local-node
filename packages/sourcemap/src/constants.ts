/**
 * Source Map Constants
 *
 * Central location for all magic strings, patterns, and configuration values.
 */

// ============================================================================
// PROTOCOL & PATH PREFIXES
// ============================================================================

/** Webpack source map protocol prefix */
export const WEBPACK_PROTOCOL = 'webpack://';

/** Vite/Rollup virtual module prefix */
export const VITE_VIRTUAL_PREFIX = '\0';

// ============================================================================
// HTTP HEADERS
// ============================================================================

/** HTTP headers that may contain source map URLs */
export const SOURCE_MAP_HEADERS = ['SourceMap', 'X-SourceMap'] as const;

// ============================================================================
// CONTENT TYPE VALIDATION
// ============================================================================

/** Content types that indicate a valid source map response */
export const VALID_SOURCE_MAP_CONTENT_TYPES = [
    'application/json',
    'application/octet-stream',
    'text/plain',
    '', // Some servers don't set content-type
] as const;

/** Content types that indicate an invalid response (e.g., SPA fallback) */
export const INVALID_SOURCE_MAP_CONTENT_TYPES = ['text/html'] as const;

// ============================================================================
// COMMENT PATTERNS
// ============================================================================

// Note: We construct these patterns dynamically to prevent build tools
// from mistakenly parsing them as actual source map references
const SOURCE_MAPPING_URL = 'source' + 'MappingURL';

/** Pattern to find source mapping URL in JavaScript files */
export const JS_SOURCE_MAP_COMMENT_PATTERN = new RegExp(
    `\\/\\/[#@]\\s*${SOURCE_MAPPING_URL}=(\\S+)\\s*$`,
);

/** Pattern to find source mapping URL in CSS files */
export const CSS_SOURCE_MAP_COMMENT_PATTERN = new RegExp(
    `\\/\\*[#@]\\s*${SOURCE_MAPPING_URL}=(\\S+)\\s*\\*\\/\\s*$`,
);

/** Pattern to match inline base64 data URIs */
export const DATA_URI_PATTERN = /^data:application\/json;base64,(.+)$/;

// ============================================================================
// PATH EXCLUSION PATTERNS
// ============================================================================

/** Patterns for paths that should be excluded from extraction */
export const EXCLUDE_PATH_PATTERNS = [
    /^\(webpack\)/, // Webpack internal modules
    /^__vite/, // Vite internal modules
    /^vite\//, // Vite runtime
    /^\?/, // Query string paths
    /^data:/, // Data URIs
] as const;

// ============================================================================
// SIZE LIMITS
// ============================================================================

/** Maximum source map size in bytes (100MB) */
export const DEFAULT_MAX_SOURCE_MAP_SIZE = 100 * 1024 * 1024;

/** Size threshold for switching to streaming parser (50MB) */
export const STREAMING_THRESHOLD = 50 * 1024 * 1024;

/** Default fetch timeout in milliseconds (30s) */
export const DEFAULT_TIMEOUT = 30000;

// ============================================================================
// SOURCE MAP VERSION
// ============================================================================

/** The only supported source map version */
export const SUPPORTED_SOURCE_MAP_VERSION = 3;
