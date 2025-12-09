/**
 * Path Utilities
 *
 * Functions for normalizing and manipulating source map paths.
 */

import { WEBPACK_PROTOCOL, VITE_VIRTUAL_PREFIX } from '../constants.js';

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
        path = path.replace(/^webpack:\/\/[^/]*\//, '');
    }

    // Handle vite/rollup virtual modules (prefixed with \0)
    if (path.startsWith(VITE_VIRTUAL_PREFIX)) {
        path = path.slice(1);
    }

    // Apply source root if present and path is relative
    if (sourceRoot && !path.startsWith('/') && !path.startsWith('.')) {
        path = sourceRoot + path;
    }

    // Remove leading ./
    path = path.replace(/^\.\//, '');

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
 * Gets a clean filename for a source path, handling edge cases.
 *
 * @param path - The source file path
 * @returns Clean filename with extension
 */
export function getCleanFilename(path: string): string {
    // Remove query strings
    const withoutQuery = path.split('?')[0];

    // Get the filename
    const parts = withoutQuery.split('/');
    const filename = parts[parts.length - 1];

    // If no extension, try to infer one
    if (!filename.includes('.')) {
        return filename + '.js';
    }

    return filename;
}
