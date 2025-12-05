import { mkdir, writeFile, readFile, stat } from 'fs/promises';
import { dirname, join, relative } from 'path';
import { createHash } from 'crypto';
import { SourceFile, shouldIncludePath } from './sourcemap.js';
import type { BundleWithContent } from './scraper.js';

export interface ReconstructionOptions {
    outputDir: string;
    includeNodeModules: boolean;
    /** Internal packages (not on npm) that should always be extracted from node_modules */
    internalPackages?: Set<string>;
    siteHostname: string;
    bundleName: string;
}

export interface ReconstructionResult {
    filesWritten: number;
    filesSkipped: number;
    filesUnchanged: number;
    errors: string[];
    outputPath: string;
}

export interface Manifest {
    extractedAt: string;
    sourceUrl: string;
    bundles: BundleManifest[];
    totalFiles: number;
    stats: {
        byExtension: Record<string, number>;
        byDirectory: Record<string, number>;
    };
}

export interface BundleManifest {
    bundleUrl: string;
    sourceMapUrl: string;
    filesExtracted: number;
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
 * Skips writing files that already exist with the same content.
 */
export async function reconstructSources(
    files: SourceFile[],
    options: ReconstructionOptions,
): Promise<ReconstructionResult> {
    const result: ReconstructionResult = {
        filesWritten: 0,
        filesSkipped: 0,
        filesUnchanged: 0,
        errors: [],
        outputPath: join(
            options.outputDir,
            options.siteHostname,
            options.bundleName,
        ),
    };

    for (const file of files) {
        try {
            // Check if we should include this file
            if (
                !shouldIncludePath(
                    file.path,
                    options.includeNodeModules,
                    options.internalPackages,
                )
            ) {
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
 * Resolves `..` segments and removes leading slashes/dots.
 * Returns null if the result would be empty.
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
 * Generates a manifest file summarizing what was extracted
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
 * Gets the bundle name from a URL for organizing output
 */
export function getBundleName(bundleUrl: string): string {
    const url = new URL(bundleUrl);
    const pathParts = url.pathname.split('/').filter(Boolean);

    // Try to get a meaningful name from the path
    // e.g., /navigation/index-C4LR0b0Z.js -> navigation
    if (pathParts.length > 1) {
        return pathParts[pathParts.length - 2];
    }

    // Fallback to filename without hash
    const filename = pathParts[pathParts.length - 1] || 'bundle';
    return filename
        .replace(/[-_.][a-zA-Z0-9]{6,}\.js$/, '')
        .replace(/\.js$/, '');
}

/**
 * Result of saving minified bundles
 */
export interface SavedBundle {
    url: string;
    localPath: string;
    type: 'script' | 'stylesheet';
    size: number;
}

/**
 * Saves minified bundles to disk when no source maps are available.
 * This is a fallback mode that preserves the original minified files.
 */
export async function saveBundles(
    bundlesWithoutMaps: BundleWithContent[],
    options: {
        outputDir: string;
        siteHostname: string;
    },
): Promise<{ saved: SavedBundle[]; errors: string[] }> {
    const saved: SavedBundle[] = [];
    const errors: string[] = [];
    const bundlesDir = join(
        options.outputDir,
        options.siteHostname,
        '_bundles',
    );

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
    outputDir: string;
    siteHostname: string;
    /** Bundles saved to _bundles/ (no source maps available) */
    savedBundles: SavedBundle[];
    /** Bundles that were extracted from source maps (to include re-exports) */
    extractedBundles?: Array<{ bundleName: string; entryPoint?: string }>;
}

/**
 * Result of generating bundle stubs
 */
export interface BundleStubResult {
    stubsGenerated: number;
    entryPointPath: string;
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
 */
export async function generateBundleStubs(
    options: BundleStubOptions,
): Promise<BundleStubResult> {
    const result: BundleStubResult = {
        stubsGenerated: 0,
        entryPointPath: '',
        errors: [],
    };

    const siteDir = join(options.outputDir, options.siteHostname);
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
            let relativePath = relative(srcDir, entryPath);

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
                let relativePath = relative(srcDir, bundle.localPath);

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
                let relativePath = relative(srcDir, bundle.localPath);

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
