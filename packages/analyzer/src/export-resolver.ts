/**
 * Export Resolver - Finds the actual source for missing exports
 *
 * This module resolves missing exports by finding their actual source:
 * - Namespace exports: finds a source file that exports all required properties
 * - Dependency re-exports: finds imports from external dependencies that should be re-exported
 * - Falls back to stubs when no resolution is found
 */

import { readdir, readFile } from 'fs/promises';
import { join, basename, relative, extname, dirname } from 'path';
import { toPosixPath } from '@web2local/utils';
import { extractExportsFromSource } from '@web2local/ast';
import { extractImportsFromSource, categorizeImport } from '@web2local/ast';
import {
    analyzeImportUsage,
    aggregateImportUsage,
    type ImportUsageInfo,
    type AggregatedUsage,
} from './import-usage-analyzer.js';

/**
 * Resolution strategy for a missing export
 */
export type ExportResolution =
    | { type: 'namespace'; sourcePath: string; exportName: string }
    | {
          type: 'reexport';
          dependencySource: string;
          exportName: string;
          isTypeOnly: boolean;
      }
    | { type: 'stub'; exportName: string; reason: string };

/**
 * Information about a missing export and how to resolve it
 */
export interface MissingExportInfo {
    /** The export name that consumers expect */
    exportName: string;
    /** How this export is used (namespace, direct, unknown) */
    usagePattern: 'namespace' | 'direct' | 'unknown';
    /** If namespace, what properties are accessed */
    accessedProperties: string[];
    /** Files that import this */
    importedBy: string[];
    /** Resolution (if found) */
    resolution: ExportResolution | null;
}

/**
 * Options for export resolution
 */
export interface ExportResolverOptions {
    /** Internal packages to scan (in node_modules) */
    internalPackages?: Set<string>;
    /** Progress callback */
    onProgress?: (message: string) => void;
    /** Warning callback */
    onWarning?: (message: string) => void;
    /** Verbose mode - emit warnings to console too */
    verbose?: boolean;
}

/**
 * Find all source files in a directory (recursive)
 */
async function findSourceFiles(
    dir: string,
    baseDir: string = dir,
): Promise<string[]> {
    const files: string[] = [];

    try {
        const entries = await readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = join(dir, entry.name);

            if (entry.isDirectory()) {
                // Skip node_modules within the package
                if (entry.name === 'node_modules') continue;
                if (entry.name.startsWith('.')) continue;
                files.push(...(await findSourceFiles(fullPath, baseDir)));
            } else if (entry.isFile()) {
                const ext = extname(entry.name).toLowerCase();
                if (
                    ['.ts', '.tsx', '.js', '.jsx'].includes(ext) &&
                    !entry.name.endsWith('.d.ts')
                ) {
                    files.push(fullPath);
                }
            }
        }
    } catch {
        // Directory doesn't exist or can't be read
    }

    return files;
}

/**
 * Emit a warning through callback and optionally to console
 */
function emitWarning(message: string, options: ExportResolverOptions): void {
    options.onWarning?.(message);
    if (options.verbose) {
        console.warn(message);
    }
}

/**
 * Searches package source files for a file that exports all the given names.
 * Used to find the source file for namespace exports.
 *
 * @returns The relative path from packagePath to the source file, or null if not found
 */
export async function findNamespaceSourceFile(
    packagePath: string,
    requiredExports: string[],
    options: ExportResolverOptions = {},
): Promise<string | null> {
    if (requiredExports.length === 0) {
        return null;
    }

    const sourceFiles = await findSourceFiles(packagePath);
    const candidates: string[] = [];

    for (const filePath of sourceFiles) {
        try {
            const content = await readFile(filePath, 'utf-8');
            const exports = extractExportsFromSource(
                content,
                basename(filePath),
            );

            // Check if this file exports ALL required names
            const allExports = new Set([...exports.named, ...exports.types]);

            const hasAll = requiredExports.every((name) =>
                allExports.has(name),
            );

            if (hasAll) {
                candidates.push(filePath);
            }
        } catch {
            // File can't be read or parsed
        }
    }

    if (candidates.length === 1) {
        // Single match - return relative path
        return toPosixPath(relative(packagePath, candidates[0]));
    }

    if (candidates.length > 1) {
        // Multiple matches - warn and return null
        const relPaths = candidates.map((c) => relative(packagePath, c));
        emitWarning(
            `Multiple files could provide namespace for [${requiredExports.slice(0, 3).join(', ')}${requiredExports.length > 3 ? '...' : ''}]: ${relPaths.join(', ')} - skipping namespace resolution`,
            options,
        );
        return null;
    }

    return null;
}

/**
 * Searches package source files for imports of a specific name from external dependencies.
 * Used to find dependency re-exports.
 *
 * @returns The dependency source and whether it's a type-only import, or null if not found
 */
export async function findDependencyReexport(
    packagePath: string,
    exportName: string,
    options: ExportResolverOptions = {},
): Promise<{ source: string; isTypeOnly: boolean } | null> {
    const sourceFiles = await findSourceFiles(packagePath);
    const candidates: Array<{
        source: string;
        isTypeOnly: boolean;
        file: string;
    }> = [];

    for (const filePath of sourceFiles) {
        try {
            const content = await readFile(filePath, 'utf-8');
            const imports = extractImportsFromSource(
                content,
                basename(filePath),
            );

            for (const imp of imports) {
                const category = categorizeImport(imp.source);

                // Only look at external (non-relative) imports
                if (category.isRelative) continue;

                // Check if this import includes the name we're looking for
                const namedImport = imp.namedImportDetails.find(
                    (n: any) => n.name === exportName,
                );

                if (namedImport) {
                    candidates.push({
                        source: imp.source,
                        isTypeOnly: imp.isTypeOnly || namedImport.isTypeOnly,
                        file: filePath,
                    });
                }
            }
        } catch {
            // File can't be read or parsed
        }
    }

    if (candidates.length === 0) {
        return null;
    }

    // Check if all candidates point to the same source
    const uniqueSources = new Set(candidates.map((c) => c.source));

    if (uniqueSources.size === 1) {
        // All point to the same dependency - use it
        // Use isTypeOnly only if ALL imports are type-only
        const isTypeOnly = candidates.every((c) => c.isTypeOnly);
        return { source: candidates[0].source, isTypeOnly };
    }

    // Multiple different sources - warn and return null
    const sourceList = [...uniqueSources].join(', ');
    emitWarning(
        `"${exportName}" imported from multiple dependencies: ${sourceList} - skipping re-export`,
        options,
    );
    return null;
}

/**
 * Scans consumer files and collects import usage information for a specific package.
 */
export async function collectConsumerUsage(
    consumerFiles: string[],
    packageSource: string,
): Promise<{
    usageInfos: ImportUsageInfo[];
    aggregated: Map<string, AggregatedUsage>;
}> {
    const allUsageInfos: ImportUsageInfo[] = [];

    for (const filePath of consumerFiles) {
        try {
            const content = await readFile(filePath, 'utf-8');
            const usageInfos = analyzeImportUsage(content, filePath);

            // Filter to only imports from our target package
            for (const info of usageInfos) {
                if (info.source === packageSource) {
                    allUsageInfos.push(info);
                }
            }
        } catch {
            // File can't be read or parsed
        }
    }

    const aggregated = aggregateImportUsage(allUsageInfos, packageSource);

    return { usageInfos: allUsageInfos, aggregated };
}

/**
 * Finds the resolution for missing exports from a package.
 *
 * Algorithm:
 * 1. For each missing export, determine usage pattern (namespace vs direct)
 * 2. If namespace: search package source files for one that exports all accessed properties
 * 3. If direct: search package source files for imports of this name from external deps
 * 4. If no resolution found: mark as stub with reason
 */
export async function resolvePackageMissingExports(
    packagePath: string,
    missingExportNames: Set<string>,
    consumerFiles: string[],
    packageImportSource: string,
    options: ExportResolverOptions = {},
): Promise<MissingExportInfo[]> {
    const results: MissingExportInfo[] = [];

    if (missingExportNames.size === 0) {
        return results;
    }

    options.onProgress?.(
        `Analyzing usage patterns for ${missingExportNames.size} missing exports...`,
    );

    // Collect usage information from consumer files
    const { aggregated } = await collectConsumerUsage(
        consumerFiles,
        packageImportSource,
    );

    for (const exportName of missingExportNames) {
        const usage = aggregated.get(exportName);

        const info: MissingExportInfo = {
            exportName,
            usagePattern: 'unknown',
            accessedProperties: [],
            importedBy: usage?.usedInFiles ?? [],
            resolution: null,
        };

        // Determine usage pattern
        if (usage) {
            const allAccesses = [
                ...usage.allMemberAccesses,
                ...usage.allJsxMemberAccesses,
            ];

            if (allAccesses.length > 0) {
                info.usagePattern = 'namespace';
                info.accessedProperties = allAccesses;
            } else if (
                usage.isEverCalledDirectly ||
                usage.isEverUsedAsJsxElement ||
                usage.isEverConstructed
            ) {
                info.usagePattern = 'direct';
            }
        }

        // Try to resolve based on usage pattern
        if (
            info.usagePattern === 'namespace' &&
            info.accessedProperties.length > 0
        ) {
            // Try to find a source file that exports all accessed properties
            options.onProgress?.(
                `Looking for namespace source for ${exportName}...`,
            );

            const sourcePath = await findNamespaceSourceFile(
                packagePath,
                info.accessedProperties,
                options,
            );

            if (sourcePath) {
                info.resolution = {
                    type: 'namespace',
                    sourcePath,
                    exportName,
                };
                continue;
            }
        }

        // Try to find a dependency re-export (for both namespace and direct patterns)
        options.onProgress?.(
            `Looking for dependency re-export for ${exportName}...`,
        );

        const reexport = await findDependencyReexport(
            packagePath,
            exportName,
            options,
        );

        if (reexport) {
            info.resolution = {
                type: 'reexport',
                dependencySource: reexport.source,
                exportName,
                isTypeOnly: reexport.isTypeOnly,
            };
            continue;
        }

        // No resolution found - will be stubbed
        const reason =
            info.usagePattern === 'namespace'
                ? `No source file exports all required properties: ${info.accessedProperties.slice(0, 5).join(', ')}${info.accessedProperties.length > 5 ? '...' : ''}`
                : `Could not find source for "${exportName}" in package or dependencies`;

        info.resolution = {
            type: 'stub',
            exportName,
            reason,
        };

        // Emit warning for stub
        const importedByStr =
            info.importedBy.length > 0
                ? ` (imported by: ${info.importedBy
                      .slice(0, 2)
                      .map((f) => basename(f))
                      .join(', ')}${info.importedBy.length > 2 ? '...' : ''})`
                : '';

        emitWarning(
            `Stubbing "${exportName}"${importedByStr} - ${reason}`,
            options,
        );

        results.push(info);
    }

    // Return all results (including those with resolutions added in the loop)
    // We need to re-collect since we used continue
    const finalResults: MissingExportInfo[] = [];
    for (const exportName of missingExportNames) {
        const existing = results.find((r) => r.exportName === exportName);
        if (existing) {
            finalResults.push(existing);
        } else {
            // This export was resolved in the loop - reconstruct it
            const usage = aggregated.get(exportName);
            const allAccesses = usage
                ? [...usage.allMemberAccesses, ...usage.allJsxMemberAccesses]
                : [];

            // Re-check for resolution
            let resolution: ExportResolution | null = null;

            if (allAccesses.length > 0) {
                const sourcePath = await findNamespaceSourceFile(
                    packagePath,
                    allAccesses,
                    options,
                );
                if (sourcePath) {
                    resolution = { type: 'namespace', sourcePath, exportName };
                }
            }

            if (!resolution) {
                const reexport = await findDependencyReexport(
                    packagePath,
                    exportName,
                    options,
                );
                if (reexport) {
                    resolution = {
                        type: 'reexport',
                        dependencySource: reexport.source,
                        exportName,
                        isTypeOnly: reexport.isTypeOnly,
                    };
                }
            }

            if (!resolution) {
                resolution = {
                    type: 'stub',
                    exportName,
                    reason: 'Could not find source',
                };
            }

            finalResults.push({
                exportName,
                usagePattern: allAccesses.length > 0 ? 'namespace' : 'direct',
                accessedProperties: allAccesses,
                importedBy: usage?.usedInFiles ?? [],
                resolution,
            });
        }
    }

    return finalResults;
}

/**
 * Generates the export statement for a resolution.
 * Returns the code to add to the index file.
 *
 * @param resolution - The resolution to generate an export for
 * @param indexFilePath - The path to the index file where the export will be added
 * @param packagePath - The package root path (used to resolve sourcePath)
 */
export function generateExportStatement(
    resolution: ExportResolution,
    indexFilePath?: string,
    packagePath?: string,
): string {
    switch (resolution.type) {
        case 'namespace': {
            // Generate: import * as X from './path'; export { X };
            let importPath = resolution.sourcePath;

            // Remove extension for import
            importPath = importPath.replace(/\.(tsx?|jsx?)$/, '');

            // If we have the index file path and package path, compute the correct relative path
            if (indexFilePath && packagePath) {
                const indexDir = dirname(indexFilePath);
                // sourcePath is relative to packagePath, so get the absolute path first
                const absoluteSourcePath = join(packagePath, importPath);
                // Then compute the relative path from the index file's directory
                importPath = relative(indexDir, absoluteSourcePath);
            }

            // Ensure it starts with ./
            if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
                importPath = './' + importPath;
            }

            // Normalize path separators for imports (use forward slashes)
            importPath = importPath.replace(/\\/g, '/');

            return [
                `import * as ${resolution.exportName} from '${importPath}';`,
                `export { ${resolution.exportName} };`,
            ].join('\n');
        }

        case 'reexport': {
            // Generate: export { X } from 'dependency';
            const typePrefix = resolution.isTypeOnly ? 'type ' : '';
            return `export ${typePrefix}{ ${resolution.exportName} } from '${resolution.dependencySource}';`;
        }

        case 'stub': {
            // Stub generation is handled elsewhere (uses __stub__)
            return '';
        }
    }
}

/**
 * Groups resolutions by type for organized output
 */
export function groupResolutionsByType(resolutions: MissingExportInfo[]): {
    namespaces: MissingExportInfo[];
    reexports: MissingExportInfo[];
    stubs: MissingExportInfo[];
} {
    const namespaces: MissingExportInfo[] = [];
    const reexports: MissingExportInfo[] = [];
    const stubs: MissingExportInfo[] = [];

    for (const info of resolutions) {
        if (!info.resolution) {
            stubs.push(info);
            continue;
        }

        switch (info.resolution.type) {
            case 'namespace':
                namespaces.push(info);
                break;
            case 'reexport':
                reexports.push(info);
                break;
            case 'stub':
                stubs.push(info);
                break;
        }
    }

    return { namespaces, reexports, stubs };
}
