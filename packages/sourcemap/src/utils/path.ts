/**
 * Path Utilities
 *
 * Functions for normalizing and manipulating source map paths.
 */

import {
    WEBPACK_PROTOCOL,
    VITE_VIRTUAL_PREFIX,
    WEBPACK_PROTOCOL_PATTERN,
    RELATIVE_PREFIX_PATTERN,
} from '../constants.js';

/**
 * Normalizes source paths from various bundler formats.
 *
 * Handles:
 * - webpack:// protocol (webpack://myapp/./src/... → src/...)
 * - Vite virtual modules (\0 prefix)
 * - sourceRoot prepending
 * - Leading ./ removal
 * - Safe .. segment resolution
 *
 * @param sourcePath - The raw source path from the source map
 * @param sourceRoot - Optional sourceRoot from the source map
 * @returns Normalized path
 */
export function normalizeSourcePath(
    sourcePath: string,
    sourceRoot: string = '',
): string {
    let path = sourcePath;

    // Handle webpack:// protocol
    // webpack://myapp/./src/components/Button.tsx → src/components/Button.tsx
    if (path.startsWith(WEBPACK_PROTOCOL)) {
        path = path.replace(WEBPACK_PROTOCOL_PATTERN, '');
    }

    // Handle vite/rollup virtual modules (prefixed with \0)
    if (path.startsWith(VITE_VIRTUAL_PREFIX)) {
        path = path.slice(1);
    }

    // Apply source root if present and path is relative
    if (sourceRoot && !path.startsWith('/') && !path.startsWith('.')) {
        // Add separator if sourceRoot doesn't end with one
        const separator = sourceRoot.endsWith('/') ? '' : '/';
        path = sourceRoot + separator + path;
    }

    // Remove leading ./
    path = path.replace(RELATIVE_PREFIX_PATTERN, '');

    // Resolve .. segments safely (prevent path traversal)
    const segments = path.split('/');
    const resolved: string[] = [];

    for (const segment of segments) {
        if (segment === '..') {
            // Only pop if we have segments and the last one isn't already ..
            if (resolved.length > 0 && resolved[resolved.length - 1] !== '..') {
                resolved.pop();
            } else {
                // Keep the .. if we can't resolve it (edge case)
                resolved.push(segment);
            }
        } else if (segment !== '.' && segment !== '') {
            resolved.push(segment);
        }
    }

    return resolved.join('/');
}

/**
 * Gets a clean filename from a source path.
 *
 * Handles:
 * - Query string removal (file.js?v=123 → file.js)
 * - Path extraction (src/components/Button.tsx → Button.tsx)
 *
 * Note: If the filename has no extension, it is returned as-is.
 * The caller should handle extension inference if needed.
 *
 * @param path - The source file path
 * @returns The filename portion of the path
 */
export function getCleanFilename(path: string): string {
    // Remove query strings
    const withoutQuery = path.split('?')[0];

    // Get the filename
    const parts = withoutQuery.split('/');
    const filename = parts[parts.length - 1];

    return filename;
}
