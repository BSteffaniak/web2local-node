/**
 * File Reconstruction Module for `@web2local/scraper`
 *
 * This module handles the reconstruction of original source files from extracted
 * source map content. It provides functionality for writing files to disk, generating
 * manifests, handling bundle stubs, and saving minified bundles as fallbacks.
 */

import { mkdir, writeFile, readFile, stat } from 'fs/promises';
import { dirname, join, relative } from 'path';
import { createHash } from 'crypto';
import { toPosixPath } from '@web2local/utils';
import type { ExtractedSource } from '@web2local/types';
import { shouldIncludeSource } from '@web2local/sourcemap';
import type { BundleWithContent } from './scraper.js';

/**
 * Options for reconstructing source files from extracted content.
 */
export interface ReconstructionOptions {
    /** The full output directory path (e.g., ./output/example.com). */
    outputDir: string;
    /** The name of the bundle being reconstructed, used to create a subdirectory. */
    bundleName: string;
}

/**
 * Result of a source file reconstruction operation.
 */
export interface ReconstructionResult {
    /** Number of files successfully written (includes unchanged files). */
    filesWritten: number;
    /** Number of files skipped due to filtering or invalid paths. */
    filesSkipped: number;
    /** Number of files that already existed with identical content. */
    filesUnchanged: number;
    /** Error messages for any files that failed to write. */
    errors: string[];
    /** The full path where files were written. */
    outputPath: string;
}

/**
 * Manifest file that summarizes an extraction operation.
 */
export interface Manifest {
    /** ISO timestamp of when extraction was performed. */
    extractedAt: string;
    /** The original URL that was scraped. */
    sourceUrl: string;
    /** Information about each bundle that was processed. */
    bundles: BundleManifest[];
    /** Total number of files extracted across all bundles. */
    totalFiles: number;
    /** Aggregate statistics about the extracted files. */
    stats: {
        /** Count of files by file extension. */
        byExtension: Record<string, number>;
        /** Count of files by top-level directory. */
        byDirectory: Record<string, number>;
    };
}

/**
 * Manifest entry for a single bundle's extraction results.
 */
export interface BundleManifest {
    /** The URL of the JavaScript or CSS bundle. */
    bundleUrl: string;
    /** The URL of the source map used for extraction. */
    sourceMapUrl: string;
    /** Number of source files extracted from this bundle. */
    filesExtracted: number;
    /** List of relative paths for all extracted files. */
    files: string[];
}

/**
 * Checks if a file exists and has the same content (by comparing size and hash)
 */
async function fileExistsWithSameContent(
    filePath: string,
    content: string,
): Promise<boolean> {
    try {
        const fileStats = await stat(filePath);

        // Quick check: if size doesn't match, content is different
        const contentBytes = Buffer.byteLength(content, 'utf-8');
        if (fileStats.size !== contentBytes) {
            return false;
        }

        // Size matches, check hash
        const existingContent = await readFile(filePath, 'utf-8');
        const existingHash = createHash('md5')
            .update(existingContent)
            .digest('hex');
        const newHash = createHash('md5').update(content).digest('hex');

        return existingHash === newHash;
    } catch {
        // File doesn't exist or can't be read
        return false;
    }
}

/**
 * Reconstructs the original file structure from extracted sources.
 *
 * Writes each extracted source file to disk, creating the necessary directory
 * structure. Skips files that are filtered out (e.g., node_modules) or have
 * unsafe paths. Also skips writing files that already exist with identical
 * content to avoid unnecessary disk writes.
 *
 * File write errors are captured in the result's `errors` array rather than thrown,
 * allowing the operation to continue with remaining files.
 *
 * @param files - The extracted source files to write
 * @param options - Configuration including output directory and bundle name
 * @returns Statistics about the reconstruction including counts and errors
 *
 * @example
 * ```typescript
 * const result = await reconstructSources(extractedSources, {
 *     outputDir: './output/example.com',
 *     bundleName: 'main-abc123'
 * });
 * console.log(`Written: ${result.filesWritten}, Skipped: ${result.filesSkipped}`);
 * ```
 */
export async function reconstructSources(
    files: readonly ExtractedSource[],
    options: ReconstructionOptions,
): Promise<ReconstructionResult> {
    const result: ReconstructionResult = {
        filesWritten: 0,
        filesSkipped: 0,
        filesUnchanged: 0,
        errors: [],
        outputPath: join(options.outputDir, options.bundleName),
    };

    for (const file of files) {
        try {
            // Check if we should include this file
            if (!shouldIncludeSource(file.path)) {
                result.filesSkipped++;
                continue;
            }

            // Sanitize the path to prevent directory traversal
            const safePath = sanitizePath(file.path);
            if (!safePath) {
                result.filesSkipped++;
                continue;
            }

            const fullPath = join(result.outputPath, safePath);

            // Check if file already exists with same content
            if (await fileExistsWithSameContent(fullPath, file.content)) {
                result.filesUnchanged++;
                result.filesWritten++; // Count as "written" for reporting purposes
                continue;
            }

            // Create directory structure
            await mkdir(dirname(fullPath), { recursive: true });

            // Write the file
            await writeFile(fullPath, file.content, 'utf-8');
            result.filesWritten++;
        } catch (error) {
            result.errors.push(`Failed to write ${file.path}: ${error}`);
        }
    }

    return result;
}

/**
 * Sanitizes a path to prevent directory traversal attacks and normalize it.
 *
 * Resolves `..` segments, removes leading slashes/dots, strips null bytes,
 * and replaces invalid filename characters with underscores. Prevents paths
 * from escaping the base directory.
 *
 * @param path - The potentially unsafe path to sanitize
 * @returns The sanitized path, or null if the result would be empty
 *
 * @example
 * ```typescript
 * sanitizePath('../etc/passwd');      // Returns: 'etc/passwd'
 * sanitizePath('/absolute/path.ts');  // Returns: 'absolute/path.ts'
 * sanitizePath('src/index.ts');       // Returns: 'src/index.ts'
 * sanitizePath('');                   // Returns: null
 * ```
 */
export function sanitizePath(path: string): string | null {
    // Remove any null bytes
    let sanitized = path.replace(/\0/g, '');

    // Remove leading slashes and dots
    sanitized = sanitized.replace(/^[./\\]+/, '');

    // Resolve the path and check it doesn't escape
    const segments = sanitized.split(/[/\\]/);
    const resolved: string[] = [];

    for (const segment of segments) {
        if (segment === '..') {
            if (resolved.length > 0) {
                resolved.pop();
            }
            // Don't allow escaping the base directory
        } else if (segment && segment !== '.') {
            // Sanitize each segment
            const cleanSegment = segment.replace(/[<>:"|?*]/g, '_');
            resolved.push(cleanSegment);
        }
    }

    if (resolved.length === 0) {
        return null;
    }

    return resolved.join('/');
}

/**
 * Generates a manifest file summarizing what was extracted.
 *
 * Creates a `manifest.json` file in the output directory containing metadata
 * about the extraction, including timestamps, bundle information, file counts,
 * and aggregate statistics by file extension and directory.
 *
 * @param outputDir - The directory where the manifest will be written
 * @param sourceUrl - The original URL that was scraped
 * @param bundles - Information about each processed bundle
 * @returns Resolves when the manifest file has been written
 *
 * @example
 * ```typescript
 * await writeManifest('./output/example.com', 'https://example.com', [
 *     { bundleUrl: 'https://example.com/main.js', sourceMapUrl: '...', filesExtracted: 10, files: [...] }
 * ]);
 * ```
 */
export async function writeManifest(
    outputDir: string,
    sourceUrl: string,
    bundles: BundleManifest[],
): Promise<void> {
    const stats = {
        byExtension: {} as Record<string, number>,
        byDirectory: {} as Record<string, number>,
    };

    let totalFiles = 0;

    for (const bundle of bundles) {
        totalFiles += bundle.filesExtracted;

        for (const file of bundle.files) {
            // Count by extension
            const ext = file.split('.').pop() || 'no-ext';
            stats.byExtension[ext] = (stats.byExtension[ext] || 0) + 1;

            // Count by top-level directory
            const topDir = file.split('/')[0] || 'root';
            stats.byDirectory[topDir] = (stats.byDirectory[topDir] || 0) + 1;
        }
    }

    const manifest: Manifest = {
        extractedAt: new Date().toISOString(),
        sourceUrl,
        bundles,
        totalFiles,
        stats,
    };

    const manifestPath = join(outputDir, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
}

/**
 * Gets the bundle name from a URL for organizing output.
 *
 * Extracts a meaningful name from a bundle URL by combining the parent
 * directory with the filename (without extension). This helps maintain
 * uniqueness when multiple bundles have the same filename.
 *
 * @param bundleUrl - The full URL of the bundle
 * @returns A filesystem-safe bundle name derived from the URL path
 *
 * @example
 * ```typescript
 * getBundleName('https://example.com/assets/main-abc123.js');
 * // Returns: 'assets/main-abc123'
 * ```
 */
export function getBundleName(bundleUrl: string): string {
    const url = new URL(bundleUrl);
    const pathParts = url.pathname.split('/').filter(Boolean);

    // Get filename without extension
    const filename = pathParts[pathParts.length - 1] || 'bundle';
    const filenameWithoutExt = filename
        .replace(/\.js\.map$/, '')
        .replace(/\.css\.map$/, '')
        .replace(/\.js$/, '')
        .replace(/\.css$/, '');

    // Combine parent directory with filename for uniqueness
    // e.g., /navigation/index-C4LR0b0Z.js -> navigation/index-C4LR0b0Z
    if (pathParts.length > 1) {
        const parentDir = pathParts[pathParts.length - 2];
        return `${parentDir}/${filenameWithoutExt}`;
    }

    // Fallback to just filename
    return filenameWithoutExt;
}

/**
 * Result of saving a minified bundle to disk.
 */
export interface SavedBundle {
    /** The original URL of the bundle. */
    url: string;
    /** The local filesystem path where the bundle was saved. */
    localPath: string;
    /** The type of bundle (script for JS, stylesheet for CSS). */
    type: 'script' | 'stylesheet';
    /** The size of the bundle content in bytes. */
    size: number;
}

/**
 * Saves minified bundles to disk when no source maps are available.
 *
 * This is a fallback mode that preserves the original minified files in a
 * `_bundles` subdirectory. The original URL path structure is maintained
 * within the bundles directory. Files that already exist with identical
 * content are not rewritten.
 *
 * File write errors are captured in the returned `errors` array rather than thrown,
 * allowing the operation to continue with remaining bundles.
 *
 * @param bundlesWithoutMaps - The bundles to save along with their content
 * @param options - Configuration containing the output directory path
 * @returns The list of saved bundles with their local paths and any errors
 *
 * @example
 * ```typescript
 * const { saved, errors } = await saveBundles(bundlesWithoutMaps, {
 *     outputDir: './output/example.com'
 * });
 * console.log(`Saved ${saved.length} bundles to _bundles/`);
 * ```
 */
export async function saveBundles(
    bundlesWithoutMaps: BundleWithContent[],
    options: {
        /** The full output directory path (e.g., ./output/example.com). */
        outputDir: string;
    },
): Promise<{ saved: SavedBundle[]; errors: string[] }> {
    const saved: SavedBundle[] = [];
    const errors: string[] = [];
    const bundlesDir = join(options.outputDir, '_bundles');

    for (const { bundle, content } of bundlesWithoutMaps) {
        try {
            const url = new URL(bundle.url);
            // Preserve path structure under bundles dir
            const pathParts = url.pathname.split('/').filter(Boolean);
            const filename = pathParts.pop() || 'bundle';
            const subDir = pathParts.join('/');
            const localPath = subDir
                ? join(bundlesDir, subDir, filename)
                : join(bundlesDir, filename);

            // Check if file already exists with same content
            if (await fileExistsWithSameContent(localPath, content)) {
                saved.push({
                    url: bundle.url,
                    localPath,
                    type: bundle.type,
                    size: content.length,
                });
                continue;
            }

            await mkdir(dirname(localPath), { recursive: true });
            await writeFile(localPath, content, 'utf-8');

            saved.push({
                url: bundle.url,
                localPath,
                type: bundle.type,
                size: content.length,
            });
        } catch (error) {
            errors.push(`Failed to save ${bundle.url}: ${error}`);
        }
    }

    return { saved, errors };
}

/**
 * Options for generating bundle stub entry points.
 */
export interface BundleStubOptions {
    /** The full output directory path (e.g., ./output/example.com). */
    outputDir: string;
    /** Bundles saved to _bundles/ (no source maps available). */
    savedBundles: SavedBundle[];
    /** Bundles that were extracted from source maps (to include re-exports). */
    extractedBundles?: Array<{ bundleName: string; entryPoint?: string }>;
}

/**
 * Result of generating bundle stub entry points.
 */
export interface BundleStubResult {
    /** Number of stub files generated. */
    stubsGenerated: number;
    /** Path to the main entry point file. */
    entryPointPath: string;
    /** Error messages for any failures during generation. */
    errors: string[];
}

/**
 * Detects the entry point file in a bundle directory.
 * Looks for common entry point patterns.
 */
async function detectBundleEntryPoint(
    bundleDir: string,
): Promise<string | undefined> {
    const entryPatterns = [
        'src/index.tsx',
        'src/index.ts',
        'src/index.jsx',
        'src/index.js',
        'src/main.tsx',
        'src/main.ts',
        'index.tsx',
        'index.ts',
        'index.jsx',
        'index.js',
        'main.tsx',
        'main.ts',
    ];

    for (const pattern of entryPatterns) {
        try {
            const filePath = join(bundleDir, pattern);
            await stat(filePath);
            return pattern;
        } catch {
            // File doesn't exist, try next
        }
    }

    return undefined;
}

/**
 * Generates a stub entry point that imports minified bundles and re-exports
 * extracted source entry points.
 *
 * This is used as a fallback when source maps are not available, creating
 * a project structure that can still be built/modified. The generated stub
 * creates a `src/index.ts` file that re-exports from extracted bundles and
 * imports minified bundles without source maps.
 *
 * Errors during file write are captured in the returned `errors` array rather than thrown.
 *
 * @param options - Configuration including output directory, saved bundles, and extracted bundles
 * @returns Information about the generated stubs including the entry point path
 *
 * @example
 * ```typescript
 * const result = await generateBundleStubs({
 *     outputDir: './output/example.com',
 *     savedBundles: savedBundles,
 *     extractedBundles: [{ bundleName: 'main-abc123' }]
 * });
 * if (result.stubsGenerated > 0) {
 *     console.log(`Entry point: ${result.entryPointPath}`);
 * }
 * ```
 */
export async function generateBundleStubs(
    options: BundleStubOptions,
): Promise<BundleStubResult> {
    const result: BundleStubResult = {
        stubsGenerated: 0,
        entryPointPath: '',
        errors: [],
    };

    const siteDir = options.outputDir;
    const srcDir = join(siteDir, 'src');
    const entryPointPath = join(srcDir, 'index.ts');

    // Check if there's anything to generate
    const hasSavedBundles = options.savedBundles.length > 0;
    const hasExtractedBundles =
        options.extractedBundles && options.extractedBundles.length > 0;

    if (!hasSavedBundles && !hasExtractedBundles) {
        return result;
    }

    // Detect entry points for extracted bundles
    const extractedEntries: Array<{ bundleName: string; entryPoint: string }> =
        [];

    if (options.extractedBundles) {
        for (const bundle of options.extractedBundles) {
            const bundleDir = join(siteDir, bundle.bundleName);
            const entryPoint =
                bundle.entryPoint || (await detectBundleEntryPoint(bundleDir));
            if (entryPoint) {
                extractedEntries.push({
                    bundleName: bundle.bundleName,
                    entryPoint,
                });
            }
        }
    }

    // Check if there's actually anything to put in the stub
    // (extracted bundles might not have entry points)
    if (!hasSavedBundles && extractedEntries.length === 0) {
        return result;
    }

    // Build the stub content
    const lines: string[] = [
        '/**',
        ' * Auto-generated entry point',
        ' *',
        ' * This file was generated because source maps were not available for some bundles.',
        ' * It imports the original minified bundles and re-exports extracted sources.',
        ' */',
        '',
    ];

    // Add re-exports for extracted sources
    if (extractedEntries.length > 0) {
        lines.push('// === Extracted source entry points ===');
        lines.push('// (These were reconstructed from source maps)');

        for (const entry of extractedEntries) {
            // Calculate relative path from src/ to the bundle entry point
            const entryPath = join(siteDir, entry.bundleName, entry.entryPoint);
            let relativePath = toPosixPath(relative(srcDir, entryPath));

            // Remove .ts/.tsx/.js/.jsx extension for import
            relativePath = relativePath.replace(/\.(tsx?|jsx?)$/, '');

            // Ensure it starts with ./
            if (!relativePath.startsWith('.')) {
                relativePath = './' + relativePath;
            }

            lines.push(`export * from '${relativePath}';`);
        }
        lines.push('');
    }

    // Add imports for minified bundles
    if (hasSavedBundles) {
        lines.push('// === Minified bundles (no source maps available) ===');

        // Separate JS and CSS bundles
        const jsBundles = options.savedBundles.filter(
            (b) => b.type === 'script',
        );
        const cssBundles = options.savedBundles.filter(
            (b) => b.type === 'stylesheet',
        );

        if (jsBundles.length > 0) {
            lines.push('// JavaScript bundles');
            for (const bundle of jsBundles) {
                // Calculate relative path from src/ to _bundles/
                let relativePath = toPosixPath(
                    relative(srcDir, bundle.localPath),
                );

                // Ensure it starts with ./
                if (!relativePath.startsWith('.')) {
                    relativePath = './' + relativePath;
                }

                lines.push(`import '${relativePath}';`);
            }
        }

        if (cssBundles.length > 0) {
            if (jsBundles.length > 0) {
                lines.push('');
            }
            lines.push('// CSS bundles');
            for (const bundle of cssBundles) {
                let relativePath = toPosixPath(
                    relative(srcDir, bundle.localPath),
                );

                if (!relativePath.startsWith('.')) {
                    relativePath = './' + relativePath;
                }

                lines.push(`import '${relativePath}';`);
            }
        }

        lines.push('');
    }

    // Write the stub file
    try {
        await mkdir(srcDir, { recursive: true });
        await writeFile(entryPointPath, lines.join('\n'), 'utf-8');
        result.stubsGenerated = 1;
        result.entryPointPath = entryPointPath;
    } catch (error) {
        result.errors.push(`Failed to write stub entry point: ${error}`);
    }

    return result;
}
