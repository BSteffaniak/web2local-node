/**
 * Filtering Utilities
 *
 * Functions for filtering source paths based on various criteria.
 */

import { VITE_VIRTUAL_PREFIX, EXCLUDE_PATH_PATTERNS } from '../constants.js';

/**
 * Options for filtering source paths during extraction.
 */
export interface FilterOptions {
    /**
     * Additional regex patterns to exclude from extraction.
     * Paths matching any pattern will be skipped.
     */
    excludePatterns?: readonly RegExp[];
}

/**
 * Determines if a source path should be included in extraction results.
 *
 * Excludes:
 * - Paths containing virtual module markers (`\0`)
 * - Webpack/Vite internal paths
 * - Query strings and data URIs
 *
 * Note: node_modules paths are now always included to ensure internal/workspace
 * packages bundled from node_modules paths are properly extracted. The dependency
 * analyzer handles classification of internal vs external packages separately.
 *
 * @param path - The normalized source path
 * @param options - Filtering options
 * @returns true if the path should be included
 */
export function shouldIncludeSource(
    path: string,
    options: FilterOptions = {},
): boolean {
    const { excludePatterns } = options;

    // Always exclude paths with virtual module marker
    if (path.includes(VITE_VIRTUAL_PREFIX)) {
        return false;
    }

    // Check all exclusion patterns (built-in + custom)
    const allPatterns = excludePatterns
        ? [...EXCLUDE_PATH_PATTERNS, ...excludePatterns]
        : EXCLUDE_PATH_PATTERNS;

    for (const pattern of allPatterns) {
        if (pattern.test(path)) {
            return false;
        }
    }

    return true;
}
