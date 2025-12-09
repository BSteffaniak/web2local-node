/**
 * Source Map Error Handling
 *
 * Provides a custom error class, error factories, and category helpers
 * for detailed debugging of source map extraction issues.
 */

import {
    SourceMapErrorCode,
    type SourceMapValidationError,
} from '@web2local/types';

// Re-export for convenience
export { SourceMapErrorCode };

// ============================================================================
// ERROR CATEGORY HELPERS
// ============================================================================

const NETWORK_ERROR_CODES: readonly SourceMapErrorCode[] = [
    SourceMapErrorCode.FETCH_FAILED,
    SourceMapErrorCode.FETCH_TIMEOUT,
    SourceMapErrorCode.FETCH_DNS_ERROR,
    SourceMapErrorCode.FETCH_CONNECTION_REFUSED,
    SourceMapErrorCode.FETCH_CONNECTION_RESET,
    SourceMapErrorCode.FETCH_SSL_ERROR,
];

const VALIDATION_ERROR_CODES: readonly SourceMapErrorCode[] = [
    SourceMapErrorCode.INVALID_VERSION,
    SourceMapErrorCode.MISSING_VERSION,
    SourceMapErrorCode.MISSING_SOURCES,
    SourceMapErrorCode.MISSING_MAPPINGS,
    SourceMapErrorCode.SOURCES_NOT_ARRAY,
    SourceMapErrorCode.INVALID_SOURCE_ROOT,
    SourceMapErrorCode.INVALID_NAMES,
    SourceMapErrorCode.INVALID_FILE,
    SourceMapErrorCode.INVALID_SOURCES_CONTENT,
    SourceMapErrorCode.INVALID_IGNORE_LIST,
    SourceMapErrorCode.INVALID_INDEX_MAP_SECTIONS,
    SourceMapErrorCode.INVALID_INDEX_MAP_OFFSET,
    SourceMapErrorCode.INVALID_INDEX_MAP_SECTION_MAP,
    SourceMapErrorCode.INDEX_MAP_OVERLAP,
    SourceMapErrorCode.INDEX_MAP_INVALID_ORDER,
    SourceMapErrorCode.INDEX_MAP_NESTED,
    SourceMapErrorCode.INDEX_MAP_WITH_MAPPINGS,
];

const PARSE_ERROR_CODES: readonly SourceMapErrorCode[] = [
    SourceMapErrorCode.INVALID_JSON,
    SourceMapErrorCode.INVALID_BASE64,
    SourceMapErrorCode.INVALID_DATA_URI,
];

const VLQ_ERROR_CODES: readonly SourceMapErrorCode[] = [
    SourceMapErrorCode.INVALID_VLQ,
    SourceMapErrorCode.INVALID_MAPPING_SEGMENT,
    SourceMapErrorCode.MAPPING_SOURCE_INDEX_OUT_OF_BOUNDS,
    SourceMapErrorCode.MAPPING_NAME_INDEX_OUT_OF_BOUNDS,
    SourceMapErrorCode.MAPPING_NEGATIVE_VALUE,
    SourceMapErrorCode.MAPPING_VALUE_EXCEEDS_32_BITS,
];

/**
 * Check if an error code is a network-related error
 */
export function isNetworkError(code: SourceMapErrorCode): boolean {
    return (NETWORK_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * Check if an error code is a validation error
 */
export function isValidationError(code: SourceMapErrorCode): boolean {
    return (VALIDATION_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * Check if an error code is a parse error
 */
export function isParseError(code: SourceMapErrorCode): boolean {
    return (PARSE_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * Check if an error code is a VLQ/mapping error
 */
export function isVlqError(code: SourceMapErrorCode): boolean {
    return (VLQ_ERROR_CODES as readonly string[]).includes(code);
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
        super(message, cause ? { cause } : undefined);
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
 * Create an error for HTTP failures.
 * Status code is available in error.details.status for programmatic handling.
 */
export function createHttpError(
    status: number,
    statusText: string,
    url: string,
): SourceMapError {
    return new SourceMapError(
        SourceMapErrorCode.HTTP_ERROR,
        `HTTP ${status} ${statusText}`,
        url,
        undefined,
        { status, statusText },
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

    let code: SourceMapErrorCode = SourceMapErrorCode.FETCH_FAILED;
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
        | typeof SourceMapErrorCode.INVALID_DATA_URI
        | typeof SourceMapErrorCode.INVALID_BASE64,
    message: string,
    url?: string,
): SourceMapError {
    return new SourceMapError(code, message, url);
}

// ============================================================================
// VALIDATION RESULT HELPERS
// ============================================================================

/**
 * Creates a structured validation error object for inclusion in validation results.
 *
 * Note: This is different from createValidationError() which creates a
 * SourceMapError for throwing. This creates a SourceMapValidationError
 * for inclusion in validation result arrays.
 */
export function createValidationErrorResult(
    code: SourceMapErrorCode,
    message: string,
    field?: string,
): SourceMapValidationError {
    return { code, message, field };
}
