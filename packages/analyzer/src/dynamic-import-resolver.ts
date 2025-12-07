/**
 * Dynamic Import Resolver
 *
 * Resolves missing dynamic imports by:
 * 1. Parsing JS bundles with SWC to extract import("...") calls
 * 2. Parsing CSS files to extract @import URLs
 * 3. Checking if referenced files exist locally
 * 4. Fetching missing files from the original server
 * 5. Optionally fetching source maps (.map files)
 * 6. Repeating until no new files are discovered (cascade resolution)
 */

import { readFile, writeFile, mkdir, copyFile, stat } from 'fs/promises';
import { dirname, join, relative, posix } from 'path';
import { safeParse, walkAST } from '@web2local/ast';
import { robustFetch, BROWSER_HEADERS } from '@web2local/http';

/**
 * Options for dynamic import resolution
 */
export interface DynamicImportResolverOptions {
    /** Directory containing bundles (e.g., output/site.com/_bundles) */
    bundlesDir: string;
    /** Directory containing captured static assets (e.g., output/site.com/_server/static) */
    staticDir: string;
    /** Base URL of the original site (e.g., https://flatlang.org) */
    baseUrl: string;
    /** Maximum resolution iterations (default: 10) */
    maxIterations?: number;
    /** Enable verbose logging */
    verbose?: boolean;
    /** Progress callback */
    onProgress?: (message: string) => void;
}

/**
 * Information about a resolved file
 */
export interface ResolvedFile {
    /** Original URL the file was fetched from */
    url: string;
    /** Local path relative to bundlesDir */
    localPath: string;
    /** MIME type / content type */
    contentType: string;
    /** File size in bytes */
    size: number;
    /** Where the file came from */
    source: 'fetched' | 'copied';
    /** Whether a source map was also resolved */
    hasSourceMap?: boolean;
}

/**
 * Result of dynamic import resolution
 */
export interface DynamicImportResolverResult {
    /** Number of files successfully fetched from the server */
    fetchedFiles: number;
    /** Number of files copied from staticDir */
    copiedFiles: number;
    /** Number of files that 404'd or failed */
    failedFiles: number;
    /** Total iterations performed */
    iterations: number;
    /** All resolved files */
    resolvedFiles: ResolvedFile[];
    /** Warnings (non-fatal errors like 404s) */
    warnings: string[];
    /** Fatal errors */
    errors: string[];
}

/**
 * Extract dynamic import paths from JavaScript source code using SWC AST parsing.
 *
 * Only extracts paths from:
 * - `import("./relative/path.js")`
 * - `import("../parent/path.js")`
 *
 * Ignores:
 * - Static imports (`import x from "..."`)
 * - Package imports (`import("react")`)
 * - Absolute URLs (`import("https://...")`)
 * - Template literals (`import(\`./dynamic-${x}.js\`)`)
 *
 * @param sourceCode - The JavaScript source code to parse
 * @param filename - Optional filename for better error messages
 * @returns Array of relative import paths
 */
export function extractDynamicImportPaths(
    sourceCode: string,
    filename: string = 'file.js',
): string[] {
    const ast = safeParse(sourceCode, filename);
    if (!ast) return [];

    const paths: Set<string> = new Set();

    walkAST(ast, (node: any) => {
        // Look for CallExpression where callee is Import
        if (node.type === 'CallExpression') {
            const callee = node.callee as Record<string, unknown>;

            // Dynamic import: import('...')
            if (callee.type === 'Import') {
                const args = node.arguments as Array<{
                    expression?: Record<string, unknown>;
                }>;

                if (args.length > 0) {
                    // Handle ExpressionStatement wrapper
                    const arg = args[0].expression || args[0];

                    if (
                        arg &&
                        (arg as Record<string, unknown>).type ===
                            'StringLiteral'
                    ) {
                        const path = (arg as Record<string, unknown>)
                            .value as string;

                        // Only include relative paths
                        if (path.startsWith('./') || path.startsWith('../')) {
                            paths.add(path);
                        }
                    }
                }
            }
        }
    });

    return Array.from(paths);
}

/**
 * Extract static import/export paths from JavaScript source code using SWC AST parsing.
 *
 * Extracts paths from:
 * - `import ... from "./relative/path.js"`
 * - `import "./relative/path.js"` (side-effect imports)
 * - `export ... from "./relative/path.js"` (re-exports)
 *
 * Only returns relative paths (starting with ./ or ../).
 *
 * @param sourceCode - The JavaScript source code to parse
 * @param filename - Optional filename for better error messages
 * @returns Array of relative import paths
 */
export function extractStaticImportPaths(
    sourceCode: string,
    filename: string = 'file.js',
): string[] {
    const ast = safeParse(sourceCode, filename);
    if (!ast) return [];

    const paths: Set<string> = new Set();

    walkAST(ast, (node: any) => {
        // Import declarations: import ... from "..."
        if (node.type === 'ImportDeclaration') {
            const source = node.source as Record<string, unknown> | undefined;
            if (source && source.type === 'StringLiteral') {
                const path = source.value as string;
                if (path.startsWith('./') || path.startsWith('../')) {
                    paths.add(path);
                }
            }
        }

        // Export declarations with source: export ... from "..."
        if (
            node.type === 'ExportNamedDeclaration' ||
            node.type === 'ExportAllDeclaration'
        ) {
            const source = node.source as Record<string, unknown> | undefined;
            if (source && source.type === 'StringLiteral') {
                const path = source.value as string;
                if (path.startsWith('./') || path.startsWith('../')) {
                    paths.add(path);
                }
            }
        }
    });

    return Array.from(paths);
}

/**
 * Extract all import paths (both static and dynamic) from JavaScript source code.
 *
 * This is a convenience function that combines extractDynamicImportPaths and
 * extractStaticImportPaths.
 *
 * @param sourceCode - The JavaScript source code to parse
 * @param filename - Optional filename for better error messages
 * @returns Array of relative import paths (deduplicated)
 */
export function extractAllImportPaths(
    sourceCode: string,
    filename: string = 'file.js',
): string[] {
    const dynamicPaths = extractDynamicImportPaths(sourceCode, filename);
    const staticPaths = extractStaticImportPaths(sourceCode, filename);

    // Combine and deduplicate
    const allPaths = new Set([...dynamicPaths, ...staticPaths]);
    return Array.from(allPaths);
}

/**
 * Extract @import URLs from CSS content.
 *
 * Matches:
 * - `@import url("./path.css")`
 * - `@import url('./path.css')`
 * - `@import url(./path.css)`
 * - `@import "./path.css"`
 * - `@import '../path.css'`
 *
 * Only returns relative paths (starting with ./ or ../).
 *
 * @param cssContent - The CSS content to parse
 * @returns Array of relative import URLs
 */
export function extractCssImportUrls(cssContent: string): string[] {
    const paths: Set<string> = new Set();

    // Match @import with url() or direct string
    // @import url("...") or @import url('...') or @import url(...)
    // @import "..." or @import '...'
    const importRegex =
        /@import\s+(?:url\s*\(\s*)?['"]?([^'");\s]+)['"]?\s*\)?/gi;

    let match;
    while ((match = importRegex.exec(cssContent)) !== null) {
        const path = match[1];

        // Only include relative paths
        if (path && (path.startsWith('./') || path.startsWith('../'))) {
            paths.add(path);
        }
    }

    return Array.from(paths);
}

/**
 * Resolve a relative path from a source file to an absolute path.
 *
 * @param fromFile - The file containing the import (relative to bundlesDir)
 * @param relativePath - The relative import path
 * @returns The resolved path (relative to bundlesDir)
 *
 * @example
 * resolveRelativePath('_app/entry/app.js', '../nodes/6.js')
 * // Returns: '_app/nodes/6.js'
 */
export function resolveRelativePath(
    fromFile: string,
    relativePath: string,
): string {
    // Use posix paths for consistency (URLs use forward slashes)
    const fromDir = posix.dirname(fromFile.replace(/\\/g, '/'));
    const resolved = posix.normalize(
        posix.join(fromDir, relativePath.replace(/\\/g, '/')),
    );

    // Remove leading ./ if present
    return resolved.replace(/^\.\//, '');
}

/**
 * Check if a file exists
 */
async function fileExists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

/**
 * Recursively find all files with given extensions in a directory
 */
async function findFilesRecursive(
    dir: string,
    extensions: string[],
): Promise<string[]> {
    const files: string[] = [];

    try {
        const { readdir } = await import('fs/promises');
        const entries = await readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = join(dir, entry.name);

            if (entry.isDirectory()) {
                const subFiles = await findFilesRecursive(fullPath, extensions);
                files.push(...subFiles);
            } else if (
                entry.isFile() &&
                extensions.some((ext) => entry.name.endsWith(ext))
            ) {
                files.push(fullPath);
            }
        }
    } catch {
        // Directory doesn't exist or can't be read
    }

    return files;
}

/**
 * Fetch a file from a URL and return its content as a Buffer
 */
async function fetchFile(
    url: string,
): Promise<{ buffer: Buffer; contentType: string } | null> {
    try {
        const response = await robustFetch(url, {
            headers: BROWSER_HEADERS,
        });

        if (!response.ok) {
            return null;
        }

        const contentType =
            response.headers.get('content-type') || 'application/octet-stream';
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        return { buffer, contentType };
    } catch {
        return null;
    }
}

/**
 * Resolve missing dynamic imports from JavaScript and CSS bundles.
 *
 * This function:
 * 1. Scans all JS/CSS files in bundlesDir
 * 2. Extracts dynamic import paths using AST parsing
 * 3. Checks if files exist in bundlesDir or staticDir
 * 4. Copies from staticDir or fetches from original server
 * 5. Also attempts to fetch .map source map files
 * 6. Loops until no new files are discovered
 *
 * @param options - Configuration options
 * @returns Result containing counts and any warnings/errors
 */
export async function resolveMissingDynamicImports(
    options: DynamicImportResolverOptions,
): Promise<DynamicImportResolverResult> {
    const {
        bundlesDir,
        staticDir,
        baseUrl,
        maxIterations = 10,
        verbose = false,
        onProgress,
    } = options;

    const processedPaths = new Set<string>();
    const resolvedFiles: ResolvedFile[] = [];
    const warnings: string[] = [];
    const errors: string[] = [];

    let fetchedFiles = 0;
    let copiedFiles = 0;
    let failedFiles = 0;
    let iterations = 0;

    // Normalize base URL (remove trailing slash)
    const normalizedBaseUrl = baseUrl.replace(/\/$/, '');

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
        iterations = iteration;
        let newFilesThisIteration = 0;

        onProgress?.(
            `Resolving dynamic imports (iteration ${iteration}/${maxIterations})...`,
        );

        // Find all JS and CSS files in bundlesDir
        const bundleFiles = await findFilesRecursive(bundlesDir, [
            '.js',
            '.css',
        ]);

        if (bundleFiles.length === 0) {
            if (verbose) {
                onProgress?.('No bundle files found to scan');
            }
            break;
        }

        // Collect all import paths from all files
        const importPathsToResolve: Array<{
            fromFile: string;
            relativePath: string;
            resolvedPath: string;
        }> = [];

        for (const bundleFile of bundleFiles) {
            try {
                const content = await readFile(bundleFile, 'utf-8');
                const relativeFromFile = relative(bundlesDir, bundleFile);

                // Extract imports based on file type
                // For JS files, extract both static and dynamic imports
                const isJs = bundleFile.endsWith('.js');
                const importPaths = isJs
                    ? extractAllImportPaths(content, bundleFile)
                    : extractCssImportUrls(content);

                for (const relativePath of importPaths) {
                    const resolvedPath = resolveRelativePath(
                        relativeFromFile,
                        relativePath,
                    );

                    // Skip if already processed
                    if (processedPaths.has(resolvedPath)) {
                        continue;
                    }

                    importPathsToResolve.push({
                        fromFile: relativeFromFile,
                        relativePath,
                        resolvedPath,
                    });
                }
            } catch (error) {
                // Skip files that can't be read
                if (verbose) {
                    warnings.push(`Could not read ${bundleFile}: ${error}`);
                }
            }
        }

        if (importPathsToResolve.length === 0) {
            if (verbose) {
                onProgress?.('No new import paths to resolve');
            }
            break;
        }

        onProgress?.(
            `Found ${importPathsToResolve.length} import paths to check...`,
        );

        // Process each import path
        for (const { resolvedPath } of importPathsToResolve) {
            // Mark as processed
            processedPaths.add(resolvedPath);

            const bundlePath = join(bundlesDir, resolvedPath);
            const staticPath = join(staticDir, resolvedPath);

            // Check if already exists in bundlesDir
            if (await fileExists(bundlePath)) {
                continue;
            }

            // Check if exists in staticDir (copy instead of fetch)
            if (await fileExists(staticPath)) {
                try {
                    // Ensure directory exists
                    await mkdir(dirname(bundlePath), { recursive: true });

                    // Copy the file
                    await copyFile(staticPath, bundlePath);

                    const stats = await stat(bundlePath);
                    const contentType = resolvedPath.endsWith('.css')
                        ? 'text/css'
                        : 'application/javascript';

                    let hasSourceMap = false;

                    // Also copy .map file if it exists
                    const staticMapPath = staticPath + '.map';
                    if (await fileExists(staticMapPath)) {
                        await copyFile(staticMapPath, bundlePath + '.map');
                        hasSourceMap = true;
                    }

                    resolvedFiles.push({
                        url: `${normalizedBaseUrl}/${resolvedPath}`,
                        localPath: resolvedPath,
                        contentType,
                        size: stats.size,
                        source: 'copied',
                        hasSourceMap,
                    });

                    copiedFiles++;
                    newFilesThisIteration++;

                    if (verbose) {
                        onProgress?.(`Copied: ${resolvedPath}`);
                    }
                } catch (error) {
                    warnings.push(`Failed to copy ${resolvedPath}: ${error}`);
                    failedFiles++;
                }
                continue;
            }

            // Fetch from original server
            const url = `${normalizedBaseUrl}/${resolvedPath}`;
            onProgress?.(`Fetching: ${resolvedPath}`);

            const result = await fetchFile(url);

            if (result) {
                try {
                    // Ensure directory exists
                    await mkdir(dirname(bundlePath), { recursive: true });

                    // Write the file
                    await writeFile(bundlePath, result.buffer);

                    let hasSourceMap = false;

                    // Try to fetch .map file too (for JS files)
                    if (resolvedPath.endsWith('.js')) {
                        const mapUrl = url + '.map';
                        const mapResult = await fetchFile(mapUrl);

                        if (mapResult) {
                            await writeFile(
                                bundlePath + '.map',
                                mapResult.buffer,
                            );
                            hasSourceMap = true;

                            if (verbose) {
                                onProgress?.(
                                    `Fetched source map: ${resolvedPath}.map`,
                                );
                            }
                        }
                    }

                    resolvedFiles.push({
                        url,
                        localPath: resolvedPath,
                        contentType: result.contentType,
                        size: result.buffer.length,
                        source: 'fetched',
                        hasSourceMap,
                    });

                    fetchedFiles++;
                    newFilesThisIteration++;

                    if (verbose) {
                        onProgress?.(`Fetched: ${resolvedPath}`);
                    }
                } catch (error) {
                    warnings.push(`Failed to save ${resolvedPath}: ${error}`);
                    failedFiles++;
                }
            } else {
                warnings.push(`404 or error: ${url}`);
                failedFiles++;
            }
        }

        // If no new files this iteration, we're done
        if (newFilesThisIteration === 0) {
            if (verbose) {
                onProgress?.(
                    `No new files resolved in iteration ${iteration}, stopping`,
                );
            }
            break;
        }

        onProgress?.(
            `Iteration ${iteration}: resolved ${newFilesThisIteration} files`,
        );
    }

    return {
        fetchedFiles,
        copiedFiles,
        failedFiles,
        iterations,
        resolvedFiles,
        warnings,
        errors,
    };
}

/**
 * Update the server manifest with information about resolved dynamic imports.
 *
 * Adds a `resolvedDynamicImports` section to the manifest and updates
 * the static asset count.
 *
 * @param manifestPath - Path to the manifest.json file
 * @param resolvedFiles - Array of resolved files to add
 */
export async function updateManifestWithResolvedFiles(
    manifestPath: string,
    resolvedFiles: ResolvedFile[],
): Promise<void> {
    if (resolvedFiles.length === 0) {
        return;
    }

    try {
        const content = await readFile(manifestPath, 'utf-8');
        const manifest = JSON.parse(content);

        // Add resolved dynamic imports section
        manifest.resolvedDynamicImports = {
            count: resolvedFiles.length,
            resolvedAt: new Date().toISOString(),
            files: resolvedFiles.map((f) => ({
                url: f.url,
                localPath: f.localPath,
                contentType: f.contentType,
                size: f.size,
                source: f.source,
                hasSourceMap: f.hasSourceMap || false,
            })),
        };

        // Update static asset count
        if (manifest.static) {
            manifest.static.assetCount =
                (manifest.static.assetCount || 0) + resolvedFiles.length;
        }

        await writeFile(
            manifestPath,
            JSON.stringify(manifest, null, 2),
            'utf-8',
        );
    } catch (error) {
        // Manifest may not exist or be invalid - that's okay
        console.warn(`Could not update manifest: ${error}`);
    }
}
