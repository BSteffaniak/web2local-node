/**
 * File reconstruction from source maps
 *
 * Writes extracted source files to disk, recreating the original
 * project structure from source map content.
 */

import { mkdir, writeFile, readFile, stat } from 'fs/promises';
import { dirname, join, relative } from 'path';
import { createHash } from 'crypto';
import { toPosixPath } from '@web2local/utils';
import type { ExtractedSource } from '@web2local/types';
import { shouldIncludeSource } from '@web2local/sourcemap';
import type { BundleWithContent } from './scraper.js';

/**
 * Options for reconstructing source files from a bundle.
 */
export interface ReconstructionOptions {
    /** The full output directory path (e.g., ./output/example.com) */
    outputDir: string;
    /** Name of the bundle subdirectory */
    bundleName: string;
}

/**
 * Result of a file reconstruction operation.
 */
export interface ReconstructionResult {
    /** Number of files written to disk */
    filesWritten: number;
    /** Number of files skipped (filtered or invalid) */
    filesSkipped: number;
    /** Number of files unchanged (already exist with same content) */
    filesUnchanged: number;
    /** Error messages for failed writes */
    errors: string[];
    /** Full path to the output directory */
    outputPath: string;
}

/**
 * Manifest summarizing an extraction operation.
 */
export interface Manifest {
    /** ISO timestamp when extraction occurred */
    extractedAt: string;
    /** Original URL of the extracted site */
    sourceUrl: string;
    /** Details for each extracted bundle */
    bundles: BundleManifest[];
    /** Total number of files extracted */
    totalFiles: number;
    /** File statistics */
    stats: {
        /** Count of files by extension */
        byExtension: Record<string, number>;
        /** Count of files by top-level directory */
        byDirectory: Record<string, number>;
    };
}

/**
 * Manifest entry for a single bundle.
 */
export interface BundleManifest {
    /** URL of the original bundle file */
    bundleUrl: string;
    /** URL of the source map */
    sourceMapUrl: string;
    /** Number of source files extracted */
    filesExtracted: number;
    /** List of extracted file paths */
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
 * Skips writing files that already exist with the same content to
 * support incremental updates.
 *
 * @param files - Array of extracted source files to write
 * @param options - Configuration for output location
 * @returns Result containing counts of written, skipped, and unchanged files
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
 * Resolves `..` segments, removes leading slashes/dots, and replaces
 * invalid characters with underscores.
 *
 * @param path - The path to sanitize
 * @returns The sanitized path, or null if the result would be empty
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
 * Writes a manifest.json file containing metadata about all extracted
 * bundles and file statistics.
 *
 * @param outputDir - Directory to write the manifest to
 * @param sourceUrl - Original URL that was extracted
 * @param bundles - Array of bundle manifests to include
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
 * Derives a bundle name from a URL for organizing output directories.
 *
 * Extracts the filename and parent directory to create a unique,
 * readable bundle identifier.
 *
 * @param bundleUrl - Full URL of the bundle
 * @returns A path-safe bundle name (e.g., "navigation/index-C4LR0b0Z")
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
 * Information about a saved minified bundle.
 */
export interface SavedBundle {
    /** Original URL of the bundle */
    url: string;
    /** Local file path where the bundle was saved */
    localPath: string;
    /** Type of asset */
    type: 'script' | 'stylesheet';
    /** Size of the bundle in bytes */
    size: number;
}

/**
 * Saves minified bundles to disk when no source maps are available.
 *
 * This is a fallback mode that preserves the original minified files,
 * useful when source maps are not available but the bundles themselves
 * should be retained.
 *
 * @param bundlesWithoutMaps - Bundles with their content to save
 * @param options - Configuration including output directory
 * @returns Object containing saved bundles array and any errors
 */
export async function saveBundles(
    bundlesWithoutMaps: BundleWithContent[],
    options: {
        /** The full output directory path (e.g., ./output/example.com) */
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
 * Options for generating bundle stub entry point
 */
export interface BundleStubOptions {
    /** The full output directory path (e.g., ./output/example.com) */
    outputDir: string;
    /** Bundles saved to _bundles/ (no source maps available) */
    savedBundles: SavedBundle[];
    /** Bundles that were extracted from source maps (to include re-exports) */
    extractedBundles?: Array<{ bundleName: string; entryPoint?: string }>;
}

/**
 * Result of generating bundle stubs.
 */
export interface BundleStubResult {
    /** Number of stub files generated */
    stubsGenerated: number;
    /** Path to the generated entry point file */
    entryPointPath: string;
    /** Error messages for any failures */
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
 * a project structure that can still be built/modified.
 *
 * @param options - Configuration for stub generation
 * @returns Result containing the number of stubs generated and any errors
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
