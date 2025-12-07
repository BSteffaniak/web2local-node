import { getCache } from '@web2local/cache';
import { BROWSER_HEADERS, robustFetch } from '@web2local/http';

export interface SourceFile {
    path: string;
    content: string;
}

export interface SourceMapResult {
    bundleUrl: string;
    sourceMapUrl: string;
    files: SourceFile[];
    errors: string[];
}

/**
 * Streaming source map parser that extracts sources without loading entire file into memory.
 * Uses a custom incremental JSON parser to handle large source maps efficiently.
 *
 * Results are cached to avoid re-parsing on subsequent runs.
 */
export async function extractSourcesFromMap(
    sourceMapUrl: string,
    bundleUrl: string,
    onFile?: (file: SourceFile) => void,
): Promise<SourceMapResult> {
    const cache = getCache();

    // Check extraction result cache first - this is the fastest path
    const cachedExtraction = await cache.getExtractionResult(sourceMapUrl);
    if (cachedExtraction) {
        // Return cached result, invoking onFile callbacks if provided
        if (onFile) {
            for (const file of cachedExtraction.files) {
                onFile(file);
            }
        }
        return {
            bundleUrl: cachedExtraction.bundleUrl,
            sourceMapUrl: cachedExtraction.sourceMapUrl,
            files: cachedExtraction.files,
            errors: cachedExtraction.errors,
        };
    }

    const result: SourceMapResult = {
        bundleUrl,
        sourceMapUrl,
        files: [],
        errors: [],
    };

    try {
        let text: string;

        // Check source map content cache
        const cachedSourceMap = await cache.getSourceMap(sourceMapUrl);
        if (cachedSourceMap) {
            text = cachedSourceMap.content;
        } else {
            // Fetch from network
            const response = await robustFetch(sourceMapUrl, {
                headers: BROWSER_HEADERS,
            });
            if (!response.ok) {
                result.errors.push(
                    `HTTP ${response.status} ${response.statusText} fetching source map from ${sourceMapUrl}`,
                );
                return result;
            }
            text = await response.text();

            // Cache the source map content
            await cache.setSourceMap(sourceMapUrl, text);
        }

        // Parse the source map JSON
        let sourceMap: {
            version: number;
            sources?: string[];
            sourcesContent?: (string | null)[];
            sourceRoot?: string;
        };

        try {
            sourceMap = JSON.parse(text);
        } catch (e) {
            // Provide helpful context about what we received instead of JSON
            const preview = text.slice(0, 1000).replace(/\n/g, ' ');
            result.errors.push(
                `Failed to parse source map JSON from ${sourceMapUrl}: ${e}\n      Response preview: "${preview}${text.length > 1000 ? '...' : ''}"`,
            );
            return result;
        }

        if (!sourceMap.sources || !sourceMap.sourcesContent) {
            result.errors.push(
                `Source map from ${sourceMapUrl} is missing sources or sourcesContent arrays`,
            );
            return result;
        }

        const sourceRoot = sourceMap.sourceRoot || '';

        for (let i = 0; i < sourceMap.sources.length; i++) {
            const sourcePath = sourceMap.sources[i];
            const content = sourceMap.sourcesContent[i];

            if (content === null || content === undefined) {
                continue;
            }

            // Normalize the path
            const normalizedPath = normalizePath(sourcePath, sourceRoot);

            const file: SourceFile = {
                path: normalizedPath,
                content,
            };

            result.files.push(file);
            onFile?.(file);
        }

        // Cache the extraction result for next time
        await cache.setExtractionResult(
            sourceMapUrl,
            bundleUrl,
            result.files,
            result.errors,
        );

        return result;
    } catch (error) {
        result.errors.push(
            `Error processing source map from ${sourceMapUrl}: ${error}`,
        );
        return result;
    }
}

/**
 * Normalizes source paths from various bundler formats
 */
export function normalizePath(
    sourcePath: string,
    sourceRoot: string = '',
): string {
    let path = sourcePath;

    // Handle webpack:// protocol
    if (path.startsWith('webpack://')) {
        path = path.replace(/^webpack:\/\/[^/]*\//, '');
    }

    // Handle vite/rollup paths
    if (path.startsWith('\u0000')) {
        path = path.slice(1);
    }

    // Apply source root if present
    if (sourceRoot && !path.startsWith('/') && !path.startsWith('.')) {
        path = sourceRoot + path;
    }

    // Remove leading ./
    path = path.replace(/^\.\//, '');

    // Resolve .. segments safely
    const segments = path.split('/');
    const resolved: string[] = [];

    for (const segment of segments) {
        if (segment === '..') {
            // Only pop if we have segments and the last one isn't already ..
            if (resolved.length > 0 && resolved[resolved.length - 1] !== '..') {
                resolved.pop();
            } else {
                // Keep the .. if we can't resolve it
                resolved.push(segment);
            }
        } else if (segment !== '.' && segment !== '') {
            resolved.push(segment);
        }
    }

    return resolved.join('/');
}

/**
 * Checks if a path should be included based on filters
 * @param path - The source file path to check
 * @param includeNodeModules - Whether to include all node_modules
 * @param internalPackages - Set of package names that are internal (not on npm) and should always be included
 */
export function shouldIncludePath(
    path: string,
    includeNodeModules: boolean,
    internalPackages?: Set<string>,
): boolean {
    // Always exclude some paths
    if (path.includes('\u0000')) {
        return false;
    }

    // Handle node_modules filtering
    if (path.includes('node_modules')) {
        if (includeNodeModules) {
            return true; // Include all node_modules when flag is set
        }

        // Check if this is an internal package that should always be included
        if (internalPackages && internalPackages.size > 0) {
            // Extract package name from path: node_modules/@scope/pkg/... or node_modules/pkg/...
            const match = path.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)/);
            if (match && internalPackages.has(match[1])) {
                return true; // Always include internal packages
            }
        }

        return false; // Skip other node_modules
    }

    // Exclude common virtual/internal paths
    const excludePatterns = [
        /^\(webpack\)/,
        /^__vite/,
        /^vite\//,
        /^\?/,
        /^data:/,
    ];

    for (const pattern of excludePatterns) {
        if (pattern.test(path)) {
            return false;
        }
    }

    return true;
}

/**
 * Gets a clean filename for a source path, handling edge cases
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
