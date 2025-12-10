/**
 * URL Utilities
 *
 * Functions for URL resolution and data URI handling.
 */

import { DATA_URI_PATTERN } from '../constants.js';

/**
 * Checks if a URL is a data URI (inline source map).
 *
 * Uses startsWith check rather than DATA_URI_PATTERN because this needs to
 * match ANY data URI format, not just base64 JSON source maps.
 *
 * @param url - The URL to check
 * @returns true if the URL starts with "data:"
 */
export function isDataUri(url: string): boolean {
    return url.startsWith('data:');
}

/**
 * Resolves a source map URL against a base bundle URL.
 *
 * Handles:
 * - Absolute URLs (returned as-is)
 * - Data URIs (returned as-is)
 * - Protocol-relative URLs (//example.com/...)
 * - Absolute paths (/path/to/map)
 * - Relative paths (./map, ../map, map)
 *
 * @param baseUrl - The URL of the bundle file
 * @param sourceMapUrl - The source map URL (from header or comment)
 * @returns Resolved absolute URL
 */
export function resolveSourceMapUrl(
    baseUrl: string,
    sourceMapUrl: string,
): string {
    // Absolute URLs - return as-is
    if (
        sourceMapUrl.startsWith('http://') ||
        sourceMapUrl.startsWith('https://')
    ) {
        return sourceMapUrl;
    }

    // Data URIs - return as-is
    if (isDataUri(sourceMapUrl)) {
        return sourceMapUrl;
    }

    // Use URL API for proper resolution
    try {
        const base = new URL(baseUrl);

        // Protocol-relative URLs
        if (sourceMapUrl.startsWith('//')) {
            return `${base.protocol}${sourceMapUrl}`;
        }

        // Absolute paths
        if (sourceMapUrl.startsWith('/')) {
            return `${base.origin}${sourceMapUrl}`;
        }

        // Relative URLs - let URL API handle resolution
        return new URL(sourceMapUrl, base).href;
    } catch {
        // Invalid base URL - return sourceMapUrl as-is (best effort)
        return sourceMapUrl;
    }
}

/** Regex pattern for validating base64 content */
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Extracts and decodes the JSON content from a base64 data URI.
 *
 * Expects format: data:application/json;base64,<content>
 *
 * @param dataUri - The full data URI string
 * @returns The decoded JSON string, or null if invalid format or decoding fails
 */
export function decodeDataUri(dataUri: string): string | null {
    const match = dataUri.match(DATA_URI_PATTERN);
    if (!match) {
        return null;
    }

    const base64Content = match[1];

    // Validate base64 format before attempting decode
    if (!BASE64_PATTERN.test(base64Content)) {
        return null;
    }

    try {
        return Buffer.from(base64Content, 'base64').toString('utf-8');
    } catch {
        return null;
    }
}
