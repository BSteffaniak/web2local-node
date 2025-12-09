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
     * Whether to include sources from node_modules.
     * @default false
     */
    includeNodeModules?: boolean;

    /**
     * Package names that are considered "internal" and should always be included,
     * even when includeNodeModules is false.
     *
     * @example
     * ```typescript
     * internalPackages: new Set(['@mycompany/shared', '@mycompany/utils'])
     * ```
     */
    internalPackages?: ReadonlySet<string>;

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
 * - Paths containing virtual module markers (\0)
 * - node_modules (unless includeNodeModules is true or package is internal)
 * - Webpack/Vite internal paths
 * - Query strings and data URIs
 *
 * @param path - The normalized source path
 * @param options - Filtering options
 * @returns true if the path should be included
 */
export function shouldIncludeSource(
    path: string,
    options: FilterOptions = {},
): boolean {
    const {
        includeNodeModules = false,
        internalPackages,
        excludePatterns,
    } = options;

    // Always exclude paths with virtual module marker
    if (path.includes(VITE_VIRTUAL_PREFIX)) {
        return false;
    }

    // Handle node_modules filtering
    if (path.includes('node_modules')) {
        if (includeNodeModules) {
            return true;
        }

        // Check if this is an internal package that should always be included
        if (internalPackages && internalPackages.size > 0) {
            // Extract package name: node_modules/@scope/pkg/... or node_modules/pkg/...
            const match = path.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)/);
            if (match && internalPackages.has(match[1])) {
                return true;
            }
        }

        return false;
    }

    // Check built-in exclusion patterns
    for (const pattern of EXCLUDE_PATH_PATTERNS) {
        if (pattern.test(path)) {
            return false;
        }
    }

    // Check custom exclusion patterns
    if (excludePatterns) {
        for (const pattern of excludePatterns) {
            if (pattern.test(path)) {
                return false;
            }
        }
    }

    return true;
}
