/**
 * Tests for Error Module
 *
 * Tests the SourceMapError class and error factory functions.
 */

import { describe, it, expect } from 'vitest';
import {
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
    isNetworkError,
    isValidationError,
    isParseError,
    isVlqError,
} from '../src/errors.js';

// ============================================================================
// SOURCE MAP ERROR CLASS
// ============================================================================

describe('SourceMapError', () => {
    describe('constructor', () => {
        it('creates error with required fields', () => {
            const error = new SourceMapError(
                SourceMapErrorCode.INVALID_JSON,
                'Test message',
            );

            expect(error).toBeInstanceOf(Error);
            expect(error).toBeInstanceOf(SourceMapError);
            expect(error.name).toBe('SourceMapError');
            expect(error.code).toBe(SourceMapErrorCode.INVALID_JSON);
            expect(error.message).toBe('Test message');
            expect(error.url).toBeUndefined();
            expect(error.cause).toBeUndefined();
            expect(error.details).toBeUndefined();
        });

        it('creates error with all optional fields', () => {
            const cause = new Error('Original error');
            const error = new SourceMapError(
                SourceMapErrorCode.HTTP_ERROR,
                'HTTP failed',
                'https://example.com/map.js',
                cause,
                { status: 404, statusText: 'Not Found' },
            );

            expect(error.code).toBe(SourceMapErrorCode.HTTP_ERROR);
            expect(error.message).toBe('HTTP failed');
            expect(error.url).toBe('https://example.com/map.js');
            expect(error.cause).toBe(cause);
            expect(error.details).toEqual({
                status: 404,
                statusText: 'Not Found',
            });
        });

        it('sets cause on Error prototype', () => {
            const cause = new Error('Original');
            const error = new SourceMapError(
                SourceMapErrorCode.FETCH_FAILED,
                'Failed',
                undefined,
                cause,
            );

            // Error.cause is the standard property
            expect(error.cause).toBe(cause);
        });
    });

    describe('toDetailedString', () => {
        it('formats basic error', () => {
            const error = new SourceMapError(
                SourceMapErrorCode.INVALID_JSON,
                'Invalid JSON syntax',
            );

            const result = error.toDetailedString();
            expect(result).toBe('[INVALID_JSON] Invalid JSON syntax');
        });

        it('includes URL when present', () => {
            const error = new SourceMapError(
                SourceMapErrorCode.HTTP_ERROR,
                'HTTP 404',
                'https://example.com/file.map',
            );

            const result = error.toDetailedString();
            expect(result).toContain('[HTTP_ERROR] HTTP 404');
            expect(result).toContain('URL: https://example.com/file.map');
        });

        it('includes details when present', () => {
            const error = new SourceMapError(
                SourceMapErrorCode.HTTP_ERROR,
                'HTTP failed',
                undefined,
                undefined,
                { status: 500, retryAfter: 30 },
            );

            const result = error.toDetailedString();
            expect(result).toContain('status: 500');
            expect(result).toContain('retryAfter: 30');
        });

        it('includes cause message when present', () => {
            const cause = new Error('Connection refused');
            const error = new SourceMapError(
                SourceMapErrorCode.FETCH_FAILED,
                'Fetch failed',
                undefined,
                cause,
            );

            const result = error.toDetailedString();
            expect(result).toContain('Cause: Connection refused');
        });

        it('formats complete error with all fields', () => {
            const cause = new Error('Network timeout');
            const error = new SourceMapError(
                SourceMapErrorCode.FETCH_TIMEOUT,
                'Request timed out',
                'https://example.com/app.js.map',
                cause,
                { timeout: 30000, attempts: 3 },
            );

            const result = error.toDetailedString();
            const lines = result.split('\n');

            expect(lines[0]).toBe('[FETCH_TIMEOUT] Request timed out');
            expect(lines).toContainEqual(
                '  URL: https://example.com/app.js.map',
            );
            expect(lines).toContainEqual('  timeout: 30000');
            expect(lines).toContainEqual('  attempts: 3');
            expect(lines).toContainEqual('  Cause: Network timeout');
        });
    });
});

// ============================================================================
// ERROR FACTORIES
// ============================================================================

describe('createHttpError', () => {
    it('creates HTTP error with status details', () => {
        const error = createHttpError(
            404,
            'Not Found',
            'https://example.com/file.map',
        );

        expect(error).toBeInstanceOf(SourceMapError);
        expect(error.code).toBe(SourceMapErrorCode.HTTP_ERROR);
        expect(error.message).toBe('HTTP 404 Not Found');
        expect(error.url).toBe('https://example.com/file.map');
        expect(error.details).toEqual({ status: 404, statusText: 'Not Found' });
    });

    it('handles various status codes', () => {
        const error500 = createHttpError(
            500,
            'Internal Server Error',
            'https://example.com',
        );
        expect(error500.message).toBe('HTTP 500 Internal Server Error');
        expect(error500.details?.status).toBe(500);

        const error403 = createHttpError(
            403,
            'Forbidden',
            'https://example.com',
        );
        expect(error403.message).toBe('HTTP 403 Forbidden');
        expect(error403.details?.status).toBe(403);
    });
});

describe('createParseError', () => {
    it('creates parse error without preview', () => {
        const error = createParseError(
            'Unexpected token',
            'https://example.com/file.map',
        );

        expect(error.code).toBe(SourceMapErrorCode.INVALID_JSON);
        expect(error.message).toBe('Unexpected token');
        expect(error.url).toBe('https://example.com/file.map');
        expect(error.details).toBeUndefined();
    });

    it('creates parse error with preview', () => {
        const error = createParseError(
            'Unexpected token at position 5',
            'https://example.com/file.map',
            '<!DOCTYPE html>',
        );

        expect(error.code).toBe(SourceMapErrorCode.INVALID_JSON);
        expect(error.details).toEqual({ preview: '<!DOCTYPE html>' });
    });
});

describe('createValidationError', () => {
    it('creates validation error with minimal args', () => {
        const error = createValidationError(
            SourceMapErrorCode.MISSING_VERSION,
            'Missing version field',
        );

        expect(error.code).toBe(SourceMapErrorCode.MISSING_VERSION);
        expect(error.message).toBe('Missing version field');
        expect(error.url).toBeUndefined();
        expect(error.details).toBeUndefined();
    });

    it('creates validation error with all args', () => {
        const error = createValidationError(
            SourceMapErrorCode.INVALID_VERSION,
            'Invalid version: expected 3, got 2',
            'https://example.com/file.map',
            { expected: 3, actual: 2 },
        );

        expect(error.code).toBe(SourceMapErrorCode.INVALID_VERSION);
        expect(error.url).toBe('https://example.com/file.map');
        expect(error.details).toEqual({ expected: 3, actual: 2 });
    });
});

describe('createNetworkError', () => {
    it('classifies timeout errors', () => {
        const cause = new Error('Request timeout after 30000ms');
        const error = createNetworkError(cause, 'https://example.com');

        expect(error.code).toBe(SourceMapErrorCode.FETCH_TIMEOUT);
        expect(error.cause).toBe(cause);
    });

    it('classifies ETIMEDOUT errors', () => {
        const cause = new Error('connect ETIMEDOUT 192.168.1.1:443');
        const error = createNetworkError(cause, 'https://example.com');

        expect(error.code).toBe(SourceMapErrorCode.FETCH_TIMEOUT);
    });

    it('classifies DNS errors', () => {
        const cause = new Error('getaddrinfo ENOTFOUND example.com');
        const error = createNetworkError(cause, 'https://example.com');

        expect(error.code).toBe(SourceMapErrorCode.FETCH_DNS_ERROR);
    });

    it('classifies DNS errors with "dns" keyword', () => {
        const cause = new Error('DNS resolution failed');
        const error = createNetworkError(cause, 'https://example.com');

        expect(error.code).toBe(SourceMapErrorCode.FETCH_DNS_ERROR);
    });

    it('classifies connection refused errors', () => {
        const cause = new Error('connect ECONNREFUSED 127.0.0.1:3000');
        const error = createNetworkError(cause, 'https://example.com');

        expect(error.code).toBe(SourceMapErrorCode.FETCH_CONNECTION_REFUSED);
    });

    it('classifies connection reset errors', () => {
        const cause = new Error('read ECONNRESET');
        const error = createNetworkError(cause, 'https://example.com');

        expect(error.code).toBe(SourceMapErrorCode.FETCH_CONNECTION_RESET);
    });

    it('classifies SSL errors', () => {
        const sslError = new Error('SSL_ERROR_HANDSHAKE_FAILURE');
        expect(createNetworkError(sslError, 'https://example.com').code).toBe(
            SourceMapErrorCode.FETCH_SSL_ERROR,
        );

        const certError = new Error('CERT_HAS_EXPIRED');
        expect(createNetworkError(certError, 'https://example.com').code).toBe(
            SourceMapErrorCode.FETCH_SSL_ERROR,
        );

        const certificateError = new Error('certificate has expired');
        expect(
            createNetworkError(certificateError, 'https://example.com').code,
        ).toBe(SourceMapErrorCode.FETCH_SSL_ERROR);
    });

    it('defaults to FETCH_FAILED for unknown errors', () => {
        const cause = new Error('Something went wrong');
        const error = createNetworkError(cause, 'https://example.com');

        expect(error.code).toBe(SourceMapErrorCode.FETCH_FAILED);
        expect(error.message).toBe('Something went wrong');
        expect(error.cause).toBe(cause);
    });
});

describe('createSizeError', () => {
    it('creates size error with details', () => {
        const error = createSizeError(
            200 * 1024 * 1024, // 200MB
            100 * 1024 * 1024, // 100MB max
            'https://example.com/large.map',
        );

        expect(error.code).toBe(SourceMapErrorCode.SOURCE_MAP_TOO_LARGE);
        expect(error.message).toContain('exceeds maximum size');
        expect(error.message).toContain('209715200 > 104857600');
        expect(error.url).toBe('https://example.com/large.map');
        expect(error.details).toEqual({
            actualSize: 200 * 1024 * 1024,
            maxSize: 100 * 1024 * 1024,
        });
    });

    it('works without URL', () => {
        const error = createSizeError(1000, 500);

        expect(error.code).toBe(SourceMapErrorCode.SOURCE_MAP_TOO_LARGE);
        expect(error.url).toBeUndefined();
    });
});

describe('createDiscoveryError', () => {
    it('creates discovery error', () => {
        const error = createDiscoveryError(
            'No source map found for bundle',
            'https://example.com/app.js',
        );

        expect(error.code).toBe(SourceMapErrorCode.NO_SOURCE_MAP_FOUND);
        expect(error.message).toBe('No source map found for bundle');
        expect(error.url).toBe('https://example.com/app.js');
    });
});

describe('createContentError', () => {
    it('creates content error with code', () => {
        const error = createContentError(
            SourceMapErrorCode.NO_EXTRACTABLE_SOURCES,
            'Source map has no sourcesContent',
            'https://example.com/file.map',
        );

        expect(error.code).toBe(SourceMapErrorCode.NO_EXTRACTABLE_SOURCES);
        expect(error.message).toBe('Source map has no sourcesContent');
        expect(error.url).toBe('https://example.com/file.map');
    });

    it('works without URL', () => {
        const error = createContentError(
            SourceMapErrorCode.NO_EXTRACTABLE_SOURCES,
            'No content',
        );

        expect(error.url).toBeUndefined();
    });
});

describe('createDataUriError', () => {
    it('creates INVALID_DATA_URI error', () => {
        const error = createDataUriError(
            SourceMapErrorCode.INVALID_DATA_URI,
            'Not a valid data URI',
            'https://example.com/app.js',
        );

        expect(error.code).toBe(SourceMapErrorCode.INVALID_DATA_URI);
        expect(error.message).toBe('Not a valid data URI');
    });

    it('creates INVALID_BASE64 error', () => {
        const error = createDataUriError(
            SourceMapErrorCode.INVALID_BASE64,
            'Failed to decode base64',
            'https://example.com/app.js',
        );

        expect(error.code).toBe(SourceMapErrorCode.INVALID_BASE64);
        expect(error.message).toBe('Failed to decode base64');
    });
});

// ============================================================================
// ERROR CODES
// ============================================================================

describe('SourceMapErrorCode', () => {
    it('has all expected network error codes', () => {
        expect(SourceMapErrorCode.FETCH_FAILED).toBe('FETCH_FAILED');
        expect(SourceMapErrorCode.FETCH_TIMEOUT).toBe('FETCH_TIMEOUT');
        expect(SourceMapErrorCode.FETCH_DNS_ERROR).toBe('FETCH_DNS_ERROR');
        expect(SourceMapErrorCode.FETCH_CONNECTION_REFUSED).toBe(
            'FETCH_CONNECTION_REFUSED',
        );
        expect(SourceMapErrorCode.FETCH_CONNECTION_RESET).toBe(
            'FETCH_CONNECTION_RESET',
        );
        expect(SourceMapErrorCode.FETCH_SSL_ERROR).toBe('FETCH_SSL_ERROR');
    });

    it('has all expected validation error codes', () => {
        expect(SourceMapErrorCode.INVALID_VERSION).toBe('INVALID_VERSION');
        expect(SourceMapErrorCode.MISSING_VERSION).toBe('MISSING_VERSION');
        expect(SourceMapErrorCode.MISSING_SOURCES).toBe('MISSING_SOURCES');
        expect(SourceMapErrorCode.MISSING_MAPPINGS).toBe('MISSING_MAPPINGS');
        expect(SourceMapErrorCode.SOURCES_NOT_ARRAY).toBe('SOURCES_NOT_ARRAY');
    });

    it('has all expected index map error codes', () => {
        expect(SourceMapErrorCode.INVALID_INDEX_MAP_SECTIONS).toBe(
            'INVALID_INDEX_MAP_SECTIONS',
        );
        expect(SourceMapErrorCode.INVALID_INDEX_MAP_OFFSET).toBe(
            'INVALID_INDEX_MAP_OFFSET',
        );
        expect(SourceMapErrorCode.INDEX_MAP_OVERLAP).toBe('INDEX_MAP_OVERLAP');
        expect(SourceMapErrorCode.INDEX_MAP_NESTED).toBe('INDEX_MAP_NESTED');
    });

    it('has all expected mapping error codes', () => {
        expect(SourceMapErrorCode.INVALID_VLQ).toBe('INVALID_VLQ');
        expect(SourceMapErrorCode.INVALID_MAPPING_SEGMENT).toBe(
            'INVALID_MAPPING_SEGMENT',
        );
        expect(SourceMapErrorCode.MAPPING_SOURCE_INDEX_OUT_OF_BOUNDS).toBe(
            'MAPPING_SOURCE_INDEX_OUT_OF_BOUNDS',
        );
        expect(SourceMapErrorCode.MAPPING_NEGATIVE_VALUE).toBe(
            'MAPPING_NEGATIVE_VALUE',
        );
        expect(SourceMapErrorCode.MAPPING_VALUE_EXCEEDS_32_BITS).toBe(
            'MAPPING_VALUE_EXCEEDS_32_BITS',
        );
    });
});

// ============================================================================
// ERROR CATEGORY HELPERS
// ============================================================================

describe('error category helpers', () => {
    describe('isNetworkError', () => {
        it('returns true for FETCH_FAILED', () => {
            expect(isNetworkError(SourceMapErrorCode.FETCH_FAILED)).toBe(true);
        });

        it('returns true for all network error codes', () => {
            const networkCodes = [
                SourceMapErrorCode.FETCH_FAILED,
                SourceMapErrorCode.FETCH_TIMEOUT,
                SourceMapErrorCode.FETCH_DNS_ERROR,
                SourceMapErrorCode.FETCH_CONNECTION_REFUSED,
                SourceMapErrorCode.FETCH_CONNECTION_RESET,
                SourceMapErrorCode.FETCH_SSL_ERROR,
            ];
            networkCodes.forEach((code) => {
                expect(isNetworkError(code)).toBe(true);
            });
        });

        it('returns false for non-network errors', () => {
            expect(isNetworkError(SourceMapErrorCode.INVALID_JSON)).toBe(false);
            expect(isNetworkError(SourceMapErrorCode.INVALID_VERSION)).toBe(
                false,
            );
            expect(isNetworkError(SourceMapErrorCode.INVALID_VLQ)).toBe(false);
        });
    });

    describe('isValidationError', () => {
        it('returns true for INVALID_VERSION', () => {
            expect(isValidationError(SourceMapErrorCode.INVALID_VERSION)).toBe(
                true,
            );
        });

        it('returns true for all validation error codes', () => {
            const validationCodes = [
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
            validationCodes.forEach((code) => {
                expect(isValidationError(code)).toBe(true);
            });
        });

        it('returns false for non-validation errors', () => {
            expect(isValidationError(SourceMapErrorCode.FETCH_FAILED)).toBe(
                false,
            );
            expect(isValidationError(SourceMapErrorCode.INVALID_JSON)).toBe(
                false,
            );
            expect(isValidationError(SourceMapErrorCode.INVALID_VLQ)).toBe(
                false,
            );
        });
    });

    describe('isParseError', () => {
        it('returns true for INVALID_JSON', () => {
            expect(isParseError(SourceMapErrorCode.INVALID_JSON)).toBe(true);
        });

        it('returns true for all parse error codes', () => {
            const parseCodes = [
                SourceMapErrorCode.INVALID_JSON,
                SourceMapErrorCode.INVALID_BASE64,
                SourceMapErrorCode.INVALID_DATA_URI,
            ];
            parseCodes.forEach((code) => {
                expect(isParseError(code)).toBe(true);
            });
        });

        it('returns false for non-parse errors', () => {
            expect(isParseError(SourceMapErrorCode.FETCH_FAILED)).toBe(false);
            expect(isParseError(SourceMapErrorCode.INVALID_VERSION)).toBe(
                false,
            );
            expect(isParseError(SourceMapErrorCode.INVALID_VLQ)).toBe(false);
        });
    });

    describe('isVlqError', () => {
        it('returns true for INVALID_VLQ', () => {
            expect(isVlqError(SourceMapErrorCode.INVALID_VLQ)).toBe(true);
        });

        it('returns true for all VLQ/mapping error codes', () => {
            const vlqCodes = [
                SourceMapErrorCode.INVALID_VLQ,
                SourceMapErrorCode.INVALID_MAPPING_SEGMENT,
                SourceMapErrorCode.MAPPING_SOURCE_INDEX_OUT_OF_BOUNDS,
                SourceMapErrorCode.MAPPING_NAME_INDEX_OUT_OF_BOUNDS,
                SourceMapErrorCode.MAPPING_NEGATIVE_VALUE,
                SourceMapErrorCode.MAPPING_VALUE_EXCEEDS_32_BITS,
            ];
            vlqCodes.forEach((code) => {
                expect(isVlqError(code)).toBe(true);
            });
        });

        it('returns false for non-VLQ errors', () => {
            expect(isVlqError(SourceMapErrorCode.FETCH_FAILED)).toBe(false);
            expect(isVlqError(SourceMapErrorCode.INVALID_JSON)).toBe(false);
            expect(isVlqError(SourceMapErrorCode.INVALID_VERSION)).toBe(false);
        });
    });

    describe('error category exclusivity', () => {
        it('categories are mutually exclusive', () => {
            // A network error should not be a validation, parse, or VLQ error
            expect(isNetworkError(SourceMapErrorCode.FETCH_FAILED)).toBe(true);
            expect(isValidationError(SourceMapErrorCode.FETCH_FAILED)).toBe(
                false,
            );
            expect(isParseError(SourceMapErrorCode.FETCH_FAILED)).toBe(false);
            expect(isVlqError(SourceMapErrorCode.FETCH_FAILED)).toBe(false);

            // A validation error should not be in other categories
            expect(isNetworkError(SourceMapErrorCode.INVALID_VERSION)).toBe(
                false,
            );
            expect(isValidationError(SourceMapErrorCode.INVALID_VERSION)).toBe(
                true,
            );
            expect(isParseError(SourceMapErrorCode.INVALID_VERSION)).toBe(
                false,
            );
            expect(isVlqError(SourceMapErrorCode.INVALID_VERSION)).toBe(false);

            // A parse error should not be in other categories
            expect(isNetworkError(SourceMapErrorCode.INVALID_JSON)).toBe(false);
            expect(isValidationError(SourceMapErrorCode.INVALID_JSON)).toBe(
                false,
            );
            expect(isParseError(SourceMapErrorCode.INVALID_JSON)).toBe(true);
            expect(isVlqError(SourceMapErrorCode.INVALID_JSON)).toBe(false);

            // A VLQ error should not be in other categories
            expect(isNetworkError(SourceMapErrorCode.INVALID_VLQ)).toBe(false);
            expect(isValidationError(SourceMapErrorCode.INVALID_VLQ)).toBe(
                false,
            );
            expect(isParseError(SourceMapErrorCode.INVALID_VLQ)).toBe(false);
            expect(isVlqError(SourceMapErrorCode.INVALID_VLQ)).toBe(true);
        });
    });
});
