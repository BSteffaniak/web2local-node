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
] as const;

/** Content types that indicate an invalid response (e.g., SPA fallback) */
export const INVALID_SOURCE_MAP_CONTENT_TYPES = ['text/html'] as const;

/**
 * Whether to accept responses with missing or unknown Content-Type headers.
 * Some servers don't set Content-Type for .map files, so we accept them by default.
 */
export const ALLOW_MISSING_CONTENT_TYPE = true;

// ============================================================================
// DATA URI PATTERN
// ============================================================================

/** Pattern to match inline base64 data URIs */
export const DATA_URI_PATTERN = /^data:application\/json;base64,(.+)$/;

// ============================================================================
// PATH PATTERNS
// ============================================================================

/** Extracts package name from node_modules path (e.g., "lodash" or "@types/node") */
export const NODE_MODULES_PACKAGE_PATTERN =
    /node_modules\/(@[^/]+\/[^/]+|[^/]+)/;

/** Matches webpack:// protocol with optional package name */
export const WEBPACK_PROTOCOL_PATTERN = /^webpack:\/\/[^/]*\//;

/** Matches relative path prefix (./) */
export const RELATIVE_PREFIX_PATTERN = /^\.\//;

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

/** Default fetch timeout in milliseconds (30s) */
export const DEFAULT_TIMEOUT = 30000;

// ============================================================================
// SOURCE MAP VERSION
// ============================================================================

/** The only supported source map version */
export const SUPPORTED_SOURCE_MAP_VERSION = 3;

// ============================================================================
// ERROR DISPLAY
// ============================================================================

/** Maximum length for content preview in error messages */
export const ERROR_PREVIEW_LENGTH = 500;
