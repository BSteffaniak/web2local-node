/**
 * @web2local/utils
 *
 * Shared utility functions for web2local packages
 */

/**
 * The current version of web2local
 *
 * Used for displaying version information in CLI and error messages.
 */
export const VERSION = '0.0.1-alpha.1';

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

/**
 * Executes async functions concurrently with a limit, reporting progress
 * as each individual item completes (not waiting for the whole batch).
 *
 * Unlike Promise.all with batching, this uses a worker pool pattern that
 * immediately starts the next item when one completes, maximizing throughput.
 *
 * @param items - Array of items to process
 * @param concurrency - Maximum number of concurrent executions
 * @param fn - Async function to execute for each item
 * @param onItemComplete - Optional callback fired when each item completes
 * @returns Array of results in the same order as input items
 *
 * @example
 * ```ts
 * const results = await runConcurrent(
 *   urls,
 *   5,
 *   async (url) => fetch(url),
 *   (result, index, completed, total) => {
 *     console.log(`Completed ${completed}/${total}`);
 *   }
 * );
 * ```
 */
export async function runConcurrent<T, R>(
    items: T[],
    concurrency: number,
    fn: (item: T, index: number) => Promise<R>,
    onItemComplete?: (
        result: R,
        index: number,
        completed: number,
        total: number,
    ) => void,
): Promise<R[]> {
    if (items.length === 0) {
        return [];
    }

    const results: R[] = new Array(items.length);
    const total = items.length;
    let nextIndex = 0;
    let completedCount = 0;

    async function worker(): Promise<void> {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            const item = items[index];
            const result = await fn(item, index);
            results[index] = result;
            completedCount++;
            onItemComplete?.(result, index, completedCount, total);
        }
    }

    // Start workers up to the concurrency limit (or item count if smaller)
    const workerCount = Math.min(concurrency, items.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return results;
}
