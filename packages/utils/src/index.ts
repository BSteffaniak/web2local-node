/**
 * @web2local/utils
 *
 * Shared utility functions for web2local packages
 */

/**
 * Converts a file path to use POSIX-style forward slashes.
 * This is necessary for cross-platform compatibility, especially for:
 * - Import/export statements in generated source code
 * - CSS @import paths
 * - Consistent path comparisons
 *
 * @param filePath - The file path to normalize
 * @returns The path with all backslashes replaced with forward slashes
 */
export function toPosixPath(filePath: string): string {
    return filePath.replaceAll('\\', '/');
}
