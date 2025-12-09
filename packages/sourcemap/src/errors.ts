/**
 * Source Map Error Handling
 *
 * Provides granular error codes and a custom error class for
 * detailed debugging of source map extraction issues.
 */

// ============================================================================
// ERROR CODES - Granular for debugging
// ============================================================================

export enum SourceMapErrorCode {
    // === Network Errors ===
    FETCH_FAILED = 'FETCH_FAILED',
    FETCH_TIMEOUT = 'FETCH_TIMEOUT',
    FETCH_DNS_ERROR = 'FETCH_DNS_ERROR',
    FETCH_CONNECTION_REFUSED = 'FETCH_CONNECTION_REFUSED',
    FETCH_CONNECTION_RESET = 'FETCH_CONNECTION_RESET',
    FETCH_SSL_ERROR = 'FETCH_SSL_ERROR',

    // === HTTP Errors ===
    HTTP_BAD_REQUEST = 'HTTP_BAD_REQUEST',
    HTTP_UNAUTHORIZED = 'HTTP_UNAUTHORIZED',
    HTTP_FORBIDDEN = 'HTTP_FORBIDDEN',
    HTTP_NOT_FOUND = 'HTTP_NOT_FOUND',
    HTTP_TOO_MANY_REQUESTS = 'HTTP_TOO_MANY_REQUESTS',
    HTTP_SERVER_ERROR = 'HTTP_SERVER_ERROR',
    HTTP_BAD_GATEWAY = 'HTTP_BAD_GATEWAY',
    HTTP_SERVICE_UNAVAILABLE = 'HTTP_SERVICE_UNAVAILABLE',
    HTTP_OTHER = 'HTTP_OTHER',

    // === Parse Errors ===
    INVALID_JSON = 'INVALID_JSON',
    INVALID_BASE64 = 'INVALID_BASE64',
    INVALID_DATA_URI = 'INVALID_DATA_URI',

    // === Validation Errors ===
    INVALID_VERSION = 'INVALID_VERSION',
    MISSING_VERSION = 'MISSING_VERSION',
    MISSING_SOURCES = 'MISSING_SOURCES',
    MISSING_MAPPINGS = 'MISSING_MAPPINGS',
    SOURCES_NOT_ARRAY = 'SOURCES_NOT_ARRAY',
    SOURCES_CONTENT_LENGTH_MISMATCH = 'SOURCES_CONTENT_LENGTH_MISMATCH',

    // === Content Errors ===
    EMPTY_SOURCE_MAP = 'EMPTY_SOURCE_MAP',
    NO_EXTRACTABLE_SOURCES = 'NO_EXTRACTABLE_SOURCES',
    ALL_SOURCES_NULL = 'ALL_SOURCES_NULL',

    // === Discovery Errors ===
    NO_SOURCE_MAP_FOUND = 'NO_SOURCE_MAP_FOUND',
    INVALID_CONTENT_TYPE = 'INVALID_CONTENT_TYPE',

    // === Size Errors ===
    SOURCE_MAP_TOO_LARGE = 'SOURCE_MAP_TOO_LARGE',
}

// ============================================================================
// ERROR CLASS
// ============================================================================

/**
 * Custom error class for source map operations.
 * Provides structured error information for debugging.
 */
export class SourceMapError extends Error {
    public readonly name = 'SourceMapError';

    constructor(
        public readonly code: SourceMapErrorCode,
        message: string,
        public readonly url?: string,
        public readonly cause?: Error,
        public readonly details?: Record<string, unknown>,
    ) {
        super(message);
        Error.captureStackTrace?.(this, SourceMapError);
    }

    /**
     * Create a detailed, formatted error message with all context.
     */
    toDetailedString(): string {
        const parts = [`[${this.code}] ${this.message}`];
        if (this.url) parts.push(`  URL: ${this.url}`);
        if (this.details) {
            for (const [key, value] of Object.entries(this.details)) {
                parts.push(`  ${key}: ${JSON.stringify(value)}`);
            }
        }
        if (this.cause) parts.push(`  Cause: ${this.cause.message}`);
        return parts.join('\n');
    }
}

// ============================================================================
// ERROR FACTORIES
// ============================================================================

/**
 * Map HTTP status codes to error codes
 */
function getHttpErrorCode(status: number): SourceMapErrorCode {
    switch (status) {
        case 400:
            return SourceMapErrorCode.HTTP_BAD_REQUEST;
        case 401:
            return SourceMapErrorCode.HTTP_UNAUTHORIZED;
        case 403:
            return SourceMapErrorCode.HTTP_FORBIDDEN;
        case 404:
            return SourceMapErrorCode.HTTP_NOT_FOUND;
        case 429:
            return SourceMapErrorCode.HTTP_TOO_MANY_REQUESTS;
        case 500:
            return SourceMapErrorCode.HTTP_SERVER_ERROR;
        case 502:
            return SourceMapErrorCode.HTTP_BAD_GATEWAY;
        case 503:
            return SourceMapErrorCode.HTTP_SERVICE_UNAVAILABLE;
        default:
            return SourceMapErrorCode.HTTP_OTHER;
    }
}

/**
 * Create an error for HTTP failures
 */
export function createHttpError(
    status: number,
    statusText: string,
    url: string,
): SourceMapError {
    const code = getHttpErrorCode(status);
    return new SourceMapError(
        code,
        `HTTP ${status} ${statusText}`,
        url,
        undefined,
        {
            status,
            statusText,
        },
    );
}

/**
 * Create an error for JSON parse failures
 *
 * @param message - The error message
 * @param url - The URL of the source map
 * @param preview - Optional preview of the content (will be truncated to PREVIEW_LENGTH)
 * @returns A SourceMapError for JSON parse failures
 */
export function createParseError(
    message: string,
    url: string,
    preview?: string,
): SourceMapError {
    // Preview is already truncated by caller using PREVIEW_LENGTH constant
    return new SourceMapError(
        SourceMapErrorCode.INVALID_JSON,
        message,
        url,
        undefined,
        preview ? { preview } : undefined,
    );
}

/**
 * Create an error for validation failures
 */
export function createValidationError(
    code: SourceMapErrorCode,
    message: string,
    url?: string,
    details?: Record<string, unknown>,
): SourceMapError {
    return new SourceMapError(code, message, url, undefined, details);
}

/**
 * Create an error for network failures based on error type
 */
export function createNetworkError(error: Error, url: string): SourceMapError {
    const message = error.message.toLowerCase();

    let code = SourceMapErrorCode.FETCH_FAILED;
    if (message.includes('timeout') || message.includes('etimedout')) {
        code = SourceMapErrorCode.FETCH_TIMEOUT;
    } else if (message.includes('enotfound') || message.includes('dns')) {
        code = SourceMapErrorCode.FETCH_DNS_ERROR;
    } else if (message.includes('econnrefused')) {
        code = SourceMapErrorCode.FETCH_CONNECTION_REFUSED;
    } else if (message.includes('econnreset')) {
        code = SourceMapErrorCode.FETCH_CONNECTION_RESET;
    } else if (
        message.includes('ssl') ||
        message.includes('certificate') ||
        message.includes('cert')
    ) {
        code = SourceMapErrorCode.FETCH_SSL_ERROR;
    }

    return new SourceMapError(code, error.message, url, error);
}

/**
 * Create an error for source map size limit exceeded
 */
export function createSizeError(
    actualSize: number,
    maxSize: number,
    url?: string,
): SourceMapError {
    return new SourceMapError(
        SourceMapErrorCode.SOURCE_MAP_TOO_LARGE,
        `Source map exceeds maximum size (${actualSize} > ${maxSize})`,
        url,
        undefined,
        { actualSize, maxSize },
    );
}

/**
 * Create an error for when no source map is found
 */
export function createDiscoveryError(
    message: string,
    url: string,
): SourceMapError {
    return new SourceMapError(
        SourceMapErrorCode.NO_SOURCE_MAP_FOUND,
        message,
        url,
    );
}

/**
 * Create an error for no extractable sources
 */
export function createContentError(
    code: SourceMapErrorCode,
    message: string,
    url?: string,
): SourceMapError {
    return new SourceMapError(code, message, url);
}

/**
 * Create an error for data URI issues
 */
export function createDataUriError(
    code:
        | SourceMapErrorCode.INVALID_DATA_URI
        | SourceMapErrorCode.INVALID_BASE64,
    message: string,
    url?: string,
): SourceMapError {
    return new SourceMapError(code, message, url);
}
