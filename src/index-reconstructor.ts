/**
 * Index File Reconstructor
 *
 * Reconstructs proper index files for internal modules by analyzing:
 * 1. What symbols consuming files expect (imports)
 * 2. Where those symbols are actually defined (exports)
 * 3. Generates proper re-exports using local relative paths
 *
 * This solves the problem where extracted source code has incomplete index files
 * because the bundler inlined/tree-shook them, losing the original module structure.
 */

import { readFile, writeFile, stat, readdir } from 'fs/promises';
import { join, dirname, basename, relative, extname, resolve } from 'path';
import { parseSync } from '@swc/core';
import {
    extractImportsFromSource,
    categorizeImport,
} from './import-extractor.js';
import type { SourceFile } from './rebuild/types.js';

/**
 * Extract ALL exported symbols from source code, including re-exports.
 *
 * Unlike extractExportsFromSource() which only extracts locally-defined exports,
 * this function also includes symbols exported via re-exports like:
 *   export { X } from './other';
 *   export * from './module';
 *
 * This is needed for index file reconstruction to know what an index already exports.
 */
function extractAllExportedSymbols(
    sourceCode: string,
    filename: string = 'file.tsx',
): Set<string> {
    const exports = new Set<string>();

    try {
        const isTypeScript =
            filename.endsWith('.ts') || filename.endsWith('.tsx');
        const hasJSX = filename.endsWith('.tsx') || filename.endsWith('.jsx');

        const ast = parseSync(sourceCode, {
            syntax: isTypeScript ? 'typescript' : 'ecmascript',
            tsx: hasJSX && isTypeScript,
            jsx: hasJSX && !isTypeScript,
        });

        for (const item of ast.body) {
            switch (item.type) {
                case 'ExportDeclaration': {
                    // export const x = ..., export function x(), etc.
                    const decl = item.declaration;
                    if (decl.type === 'VariableDeclaration') {
                        for (const d of decl.declarations) {
                            if (d.id.type === 'Identifier') {
                                exports.add(d.id.value);
                            }
                        }
                    } else if (
                        decl.type === 'FunctionDeclaration' ||
                        decl.type === 'ClassDeclaration'
                    ) {
                        if (decl.identifier) {
                            exports.add(decl.identifier.value);
                        }
                    } else if (
                        decl.type === 'TsTypeAliasDeclaration' ||
                        decl.type === 'TsInterfaceDeclaration' ||
                        decl.type === 'TsEnumDeclaration'
                    ) {
                        exports.add(decl.id.value);
                    }
                    break;
                }

                case 'ExportNamedDeclaration': {
                    // export { a, b } or export { a, b } from './mod'
                    // INCLUDE re-exports (unlike extractExportsFromSource)
                    for (const spec of item.specifiers) {
                        if (spec.type === 'ExportSpecifier') {
                            // Use exported name if aliased, otherwise use orig name
                            // export { foo } -> orig=foo, exported=null
                            // export { foo as bar } -> orig=foo, exported=bar
                            const exportedName = spec.exported ?? spec.orig;
                            if (exportedName.type === 'Identifier') {
                                exports.add(exportedName.value);
                            }
                        } else if (spec.type === 'ExportNamespaceSpecifier') {
                            // export * as X from './mod'
                            if (spec.name.type === 'Identifier') {
                                exports.add(spec.name.value);
                            }
                        }
                    }
                    break;
                }

                case 'ExportDefaultDeclaration':
                    exports.add('default');
                    break;

                case 'ExportDefaultExpression':
                    exports.add('default');
                    break;

                // Note: We skip 'ExportAllDeclaration' (export * from './mod')
                // because we can't know what symbols it exports without resolving the module
            }
        }
    } catch {
        // If parsing fails, return empty set
    }

    return exports;
}

/**
 * Options for index reconstruction
 */
export interface IndexReconstructionOptions {
    /** Project root directory */
    projectDir: string;
    /** All source files in the project */
    sourceFiles: SourceFile[];
    /** Progress callback */
    onProgress?: (message: string) => void;
    /** Warning callback */
    onWarning?: (message: string) => void;
}

/**
 * Information about an expected import from a module
 */
export interface ExpectedImport {
    /** The symbol name being imported */
    symbolName: string;
    /** Files that import this symbol */
    importedBy: string[];
    /** Whether any import is type-only */
    isTypeOnly: boolean;
}

/**
 * A resolved export - we found where the symbol is defined
 */
export interface ResolvedExport {
    /** The symbol name */
    symbolName: string;
    /** Relative path from the index file to the source file */
    relativePath: string;
    /** Absolute path to the source file */
    absolutePath: string;
    /** Whether this should be a type-only export */
    isTypeOnly: boolean;
}

/**
 * Result of reconstructing a single index file
 */
export interface ReconstructedIndex {
    /** Directory path (e.g., "assets/packages/excalidraw/scene") */
    modulePath: string;
    /** What the current index.ts exports (if it exists) */
    existingExports: string[];
    /** What consuming files expect */
    expectedExports: string[];
    /** Exports we found sources for */
    resolvedExports: ResolvedExport[];
    /** Exports we couldn't find (will be stubbed or left as-is) */
    unresolvedExports: string[];
    /** The generated/merged index content */
    generatedContent: string;
    /** Whether the index file was modified */
    wasModified: boolean;
}

/**
 * Overall result of the reconstruction process
 */
export interface ReconstructionResult {
    /** All reconstructed index files */
    reconstructedIndexes: ReconstructedIndex[];
    /** Total exports successfully resolved */
    totalResolved: number;
    /** Total exports that couldn't be resolved */
    totalUnresolved: number;
    /** Warnings generated during reconstruction */
    warnings: string[];
}

/**
 * Check if a path exists
 */
async function pathExists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

/**
 * Check if a path is a directory
 */
async function isDirectory(path: string): Promise<boolean> {
    try {
        const s = await stat(path);
        return s.isDirectory();
    } catch {
        return false;
    }
}

/**
 * Find index file in a directory if it exists
 */
async function findIndexFile(dirPath: string): Promise<string | null> {
    const extensions = ['ts', 'tsx', 'js', 'jsx'];
    for (const ext of extensions) {
        const indexPath = join(dirPath, `index.${ext}`);
        if (await pathExists(indexPath)) {
            return indexPath;
        }
    }
    return null;
}

/**
 * Normalize a module path to an absolute directory path
 * Handles relative imports like "../scene" or "./utils"
 */
function resolveModulePath(
    importSource: string,
    importingFilePath: string,
    projectDir: string,
): string | null {
    // Only handle relative imports
    if (!importSource.startsWith('.')) {
        return null;
    }

    const importingDir = dirname(importingFilePath);
    const resolved = resolve(importingDir, importSource);
    const normalizedProjectDir = resolve(projectDir);

    // Ensure it's within the project
    if (!resolved.startsWith(normalizedProjectDir)) {
        return null;
    }

    return resolved;
}

/**
 * Collect all expected imports from internal modules
 *
 * Scans all source files, finds imports from relative paths,
 * and aggregates what symbols are expected from each module.
 *
 * @returns Map of module directory path -> Map of symbol name -> ExpectedImport
 */
export async function collectExpectedImports(
    options: IndexReconstructionOptions,
): Promise<Map<string, Map<string, ExpectedImport>>> {
    const { projectDir, sourceFiles, onProgress } = options;

    // Map: module path -> symbol name -> import info
    const moduleImports = new Map<string, Map<string, ExpectedImport>>();

    onProgress?.(
        `Scanning ${sourceFiles.length} files for internal imports...`,
    );

    for (const file of sourceFiles) {
        const filePath = join(projectDir, file.path);

        try {
            const content = await readFile(filePath, 'utf-8');
            const imports = extractImportsFromSource(
                content,
                basename(filePath),
            );

            for (const imp of imports) {
                const category = categorizeImport(imp.source);

                // Only process relative imports (internal modules)
                if (!category.isRelative) continue;

                // Resolve to absolute module path
                const modulePath = resolveModulePath(
                    imp.source,
                    filePath,
                    projectDir,
                );
                if (!modulePath) continue;

                // Get or create the map for this module
                if (!moduleImports.has(modulePath)) {
                    moduleImports.set(modulePath, new Map());
                }
                const symbolMap = moduleImports.get(modulePath)!;

                // Record each named import
                for (const namedImport of imp.namedImportDetails) {
                    const symbolName = namedImport.name;

                    if (!symbolMap.has(symbolName)) {
                        symbolMap.set(symbolName, {
                            symbolName,
                            importedBy: [],
                            isTypeOnly: true, // Start as true, will be set to false if any non-type import
                        });
                    }

                    const info = symbolMap.get(symbolName)!;
                    info.importedBy.push(filePath);

                    // If any import is not type-only, the export shouldn't be type-only
                    if (!imp.isTypeOnly && !namedImport.isTypeOnly) {
                        info.isTypeOnly = false;
                    }
                }

                // Handle default imports
                if (imp.hasDefaultImport) {
                    const symbolName = 'default';
                    if (!symbolMap.has(symbolName)) {
                        symbolMap.set(symbolName, {
                            symbolName,
                            importedBy: [],
                            isTypeOnly: imp.isTypeOnly,
                        });
                    }
                    const info = symbolMap.get(symbolName)!;
                    info.importedBy.push(filePath);
                    if (!imp.isTypeOnly) {
                        info.isTypeOnly = false;
                    }
                }

                // Handle namespace imports (import * as X)
                // We track these but don't try to resolve them (complex case)
                if (imp.hasNamespaceImport) {
                    const symbolName = '__namespace__';
                    if (!symbolMap.has(symbolName)) {
                        symbolMap.set(symbolName, {
                            symbolName,
                            importedBy: [],
                            isTypeOnly: imp.isTypeOnly,
                        });
                    }
                    const info = symbolMap.get(symbolName)!;
                    info.importedBy.push(filePath);
                    if (!imp.isTypeOnly) {
                        info.isTypeOnly = false;
                    }
                }
            }
        } catch {
            // File couldn't be read or parsed, skip
        }
    }

    onProgress?.(`Found imports from ${moduleImports.size} internal modules`);

    return moduleImports;
}

/**
 * Get current exports from an existing index file
 */
async function getExistingExports(indexPath: string): Promise<{
    exports: Set<string>;
    content: string;
}> {
    try {
        const content = await readFile(indexPath, 'utf-8');
        const exports = extractAllExportedSymbols(content, basename(indexPath));
        return { exports, content };
    } catch {
        return { exports: new Set(), content: '' };
    }
}

/**
 * Find all TypeScript/JavaScript files in a directory (non-recursive for now)
 */
async function getModuleFiles(dirPath: string): Promise<string[]> {
    const files: string[] = [];

    try {
        const entries = await readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
            if (!entry.isFile()) continue;

            const ext = extname(entry.name).toLowerCase();
            if (
                ['.ts', '.tsx', '.js', '.jsx'].includes(ext) &&
                !entry.name.endsWith('.d.ts')
            ) {
                // Skip index files - we're looking for source files to re-export FROM
                if (entry.name.match(/^index\.(ts|tsx|js|jsx)$/)) continue;
                files.push(join(dirPath, entry.name));
            }
        }
    } catch {
        // Directory doesn't exist or can't be read
    }

    return files;
}

/**
 * Search for a symbol's export source within a directory and related paths
 *
 * Search order:
 * 1. Files in the module's own directory
 * 2. Files in subdirectories (e.g., src/)
 * 3. Sibling directories at the same level
 * 4. Parent package directories
 */
async function findExportSource(
    symbolName: string,
    modulePath: string,
    projectDir: string,
    options: IndexReconstructionOptions,
): Promise<{ absolutePath: string; relativePath: string } | null> {
    const searchPaths: string[] = [];

    // 1. The module directory itself
    searchPaths.push(modulePath);

    // 2. Common subdirectories
    searchPaths.push(join(modulePath, 'src'));

    // 3. Sibling directories (for monorepo patterns)
    const parentDir = dirname(modulePath);
    try {
        const siblings = await readdir(parentDir, { withFileTypes: true });
        for (const sibling of siblings) {
            if (
                sibling.isDirectory() &&
                sibling.name !== basename(modulePath)
            ) {
                const siblingPath = join(parentDir, sibling.name);
                searchPaths.push(siblingPath);
                searchPaths.push(join(siblingPath, 'src'));
            }
        }
    } catch {
        // Can't read parent directory
    }

    // 4. Go up one more level for package patterns (e.g., packages/element/src)
    const grandparentDir = dirname(parentDir);
    if (grandparentDir !== parentDir && grandparentDir.startsWith(projectDir)) {
        try {
            const packages = await readdir(grandparentDir, {
                withFileTypes: true,
            });
            for (const pkg of packages) {
                if (pkg.isDirectory()) {
                    const pkgPath = join(grandparentDir, pkg.name);
                    searchPaths.push(pkgPath);
                    searchPaths.push(join(pkgPath, 'src'));
                }
            }
        } catch {
            // Can't read grandparent directory
        }
    }

    // Search each path for files exporting the symbol
    const candidates: Array<{ absolutePath: string; relativePath: string }> =
        [];

    for (const searchPath of searchPaths) {
        if (!(await isDirectory(searchPath))) continue;

        const files = await getModuleFiles(searchPath);

        for (const filePath of files) {
            try {
                const content = await readFile(filePath, 'utf-8');
                const allExports = extractAllExportedSymbols(
                    content,
                    basename(filePath),
                );

                if (allExports.has(symbolName)) {
                    const relativePath = relative(modulePath, filePath).replace(
                        /\\/g,
                        '/',
                    );
                    candidates.push({ absolutePath: filePath, relativePath });
                }
            } catch {
                // File can't be read or parsed
            }
        }
    }

    if (candidates.length === 0) {
        return null;
    }

    if (candidates.length > 1) {
        // Warn about multiple sources
        const paths = candidates.map((c) => c.relativePath).join(', ');
        options.onWarning?.(
            `"${symbolName}" found in multiple locations: ${paths} - using first match`,
        );
    }

    return candidates[0];
}

/**
 * Generate the content for a reconstructed index file
 */
function generateIndexContent(
    existingContent: string,
    resolvedExports: ResolvedExport[],
    unresolvedExports: string[],
): string {
    const lines: string[] = [];

    // If there's existing content, preserve it and add a separator
    if (existingContent.trim()) {
        lines.push(existingContent.trimEnd());
        lines.push('');
        lines.push('// --- Re-exports added by index reconstruction ---');
        lines.push('');
    } else {
        lines.push('// Auto-generated index file');
        lines.push(
            '// Generated by index reconstruction based on consumer imports',
        );
        lines.push('');
    }

    // Group exports by source file for cleaner output
    const exportsBySource = new Map<string, ResolvedExport[]>();

    for (const exp of resolvedExports) {
        const source = exp.relativePath;
        if (!exportsBySource.has(source)) {
            exportsBySource.set(source, []);
        }
        exportsBySource.get(source)!.push(exp);
    }

    // Generate export statements grouped by source
    for (const [source, exports] of exportsBySource) {
        // Remove extension for import path
        const importPath = source.replace(/\.(tsx?|jsx?)$/, '');

        // Ensure path starts with ./
        const normalizedPath = importPath.startsWith('.')
            ? importPath
            : './' + importPath;

        // Separate type-only and regular exports
        const typeExports = exports.filter((e) => e.isTypeOnly);
        const valueExports = exports.filter((e) => !e.isTypeOnly);

        if (valueExports.length > 0) {
            const symbols = valueExports
                .map((e) => e.symbolName)
                .sort()
                .join(', ');
            lines.push(`export { ${symbols} } from '${normalizedPath}';`);
        }

        if (typeExports.length > 0) {
            const symbols = typeExports
                .map((e) => e.symbolName)
                .sort()
                .join(', ');
            lines.push(`export type { ${symbols} } from '${normalizedPath}';`);
        }
    }

    // Add comments for unresolved exports (don't stub them - let the build fail clearly)
    if (unresolvedExports.length > 0) {
        lines.push('');
        lines.push(
            '// WARNING: The following exports are expected by consumers but could not be found:',
        );
        for (const exp of unresolvedExports.sort()) {
            lines.push(`// - ${exp}`);
        }
    }

    lines.push('');

    return lines.join('\n');
}

/**
 * Reconstruct the index file for a single module
 */
async function reconstructModuleIndex(
    modulePath: string,
    expectedImports: Map<string, ExpectedImport>,
    options: IndexReconstructionOptions,
): Promise<ReconstructedIndex | null> {
    const { projectDir, onProgress } = options;

    // Check if this is a valid directory
    if (!(await isDirectory(modulePath))) {
        return null;
    }

    const relativeModulePath = relative(projectDir, modulePath);
    onProgress?.(`Reconstructing index for ${relativeModulePath}...`);

    // Get existing index file and its exports
    const indexPath = await findIndexFile(modulePath);
    const { exports: existingExports, content: existingContent } = indexPath
        ? await getExistingExports(indexPath)
        : { exports: new Set<string>(), content: '' };

    // Determine which exports are missing
    const expectedSymbols = Array.from(expectedImports.keys())
        // Filter out namespace imports for now (complex to handle)
        .filter((s) => s !== '__namespace__');

    const missingSymbols = expectedSymbols.filter(
        (s) => !existingExports.has(s),
    );

    if (missingSymbols.length === 0) {
        // No missing exports, nothing to do
        return null;
    }

    onProgress?.(`  Found ${missingSymbols.length} missing exports`);

    // Try to resolve each missing symbol
    const resolvedExports: ResolvedExport[] = [];
    const unresolvedExports: string[] = [];

    for (const symbolName of missingSymbols) {
        const source = await findExportSource(
            symbolName,
            modulePath,
            projectDir,
            options,
        );

        if (source) {
            const importInfo = expectedImports.get(symbolName)!;
            resolvedExports.push({
                symbolName,
                relativePath: source.relativePath,
                absolutePath: source.absolutePath,
                isTypeOnly: importInfo.isTypeOnly,
            });
        } else {
            unresolvedExports.push(symbolName);
        }
    }

    onProgress?.(
        `  Resolved ${resolvedExports.length}/${missingSymbols.length} exports`,
    );

    // Generate the new index content
    const generatedContent = generateIndexContent(
        existingContent,
        resolvedExports,
        unresolvedExports,
    );

    return {
        modulePath: relativeModulePath,
        existingExports: Array.from(existingExports),
        expectedExports: expectedSymbols,
        resolvedExports,
        unresolvedExports,
        generatedContent,
        wasModified: resolvedExports.length > 0 || unresolvedExports.length > 0,
    };
}

/**
 * Main entry point: Reconstruct all index files in the project
 *
 * 1. Collects all expected imports from internal modules
 * 2. For each module, determines missing exports
 * 3. Searches for export sources
 * 4. Generates/merges index files
 */
export async function reconstructAllIndexes(
    options: IndexReconstructionOptions,
): Promise<ReconstructionResult> {
    const { onProgress, onWarning } = options;
    // Ensure projectDir is absolute for path comparisons
    const projectDir = resolve(options.projectDir);
    const warnings: string[] = [];

    // Wrap options with resolved projectDir and warning callback
    const wrappedOptions: IndexReconstructionOptions = {
        ...options,
        projectDir, // Use resolved absolute path
        onWarning: (msg) => {
            warnings.push(msg);
            onWarning?.(msg);
        },
    };

    // Step 1: Collect all expected imports
    const moduleImports = await collectExpectedImports(wrappedOptions);

    // Step 2: Reconstruct each module's index
    const reconstructedIndexes: ReconstructedIndex[] = [];
    let totalResolved = 0;
    let totalUnresolved = 0;

    for (const [modulePath, expectedImports] of moduleImports) {
        const result = await reconstructModuleIndex(
            modulePath,
            expectedImports,
            wrappedOptions,
        );

        if (result && result.wasModified) {
            reconstructedIndexes.push(result);
            totalResolved += result.resolvedExports.length;
            totalUnresolved += result.unresolvedExports.length;

            // Write the reconstructed index file
            const indexPath = join(projectDir, result.modulePath, 'index.ts');
            await writeFile(indexPath, result.generatedContent, 'utf-8');
            onProgress?.(`  Wrote ${result.modulePath}/index.ts`);
        }
    }

    onProgress?.(
        `Reconstruction complete: ${reconstructedIndexes.length} index files updated, ` +
            `${totalResolved} exports resolved, ${totalUnresolved} unresolved`,
    );

    return {
        reconstructedIndexes,
        totalResolved,
        totalUnresolved,
        warnings,
    };
}

/**
 * Generate simple index files for alias target directories that don't have one.
 *
 * This handles the case where an alias like `@excalidraw/utils` points to a
 * directory that has individual module files but no index.ts to serve as
 * the entry point for bare imports.
 *
 * Unlike the SWC-based reconstruction (which analyzes consumer imports),
 * this just creates a simple `export * from './module'` for each file.
 */
export async function generateAliasTargetIndexFiles(
    projectDir: string,
    aliases: Array<{ alias: string; path: string }>,
    onProgress?: (message: string) => void,
): Promise<string[]> {
    const generatedFiles: string[] = [];
    const processedDirs = new Set<string>();

    for (const { alias, path: aliasPath } of aliases) {
        // Normalize the path
        const normalizedPath = aliasPath.replace(/^\.\//, '');
        const absolutePath = resolve(projectDir, normalizedPath);

        // Skip if we've already processed this directory
        if (processedDirs.has(absolutePath)) continue;
        processedDirs.add(absolutePath);

        try {
            // Check if path exists and is a directory
            if (!(await isDirectory(absolutePath))) continue;

            // Check if index file already exists
            if (await findIndexFile(absolutePath)) continue;

            // Read directory contents to find exportable modules
            const entries = await readdir(absolutePath, {
                withFileTypes: true,
            });
            const moduleFiles: string[] = [];

            for (const entry of entries) {
                if (!entry.isFile()) continue;

                // Check for TypeScript/JavaScript files (not index files)
                const match = entry.name.match(
                    /^([a-zA-Z][\w-]*)\.(?:ts|tsx|js|jsx)$/,
                );
                if (match && match[1] !== 'index') {
                    moduleFiles.push(match[1]);
                }
            }

            if (moduleFiles.length === 0) continue;

            // Generate the index file
            const lines: string[] = [
                '// Auto-generated index file for package alias resolution',
                `// This file was created because the directory is used as an alias target (${alias})`,
                '// and did not have an index file for bare imports.',
                '',
            ];

            // Sort module files alphabetically for consistent output
            for (const moduleName of moduleFiles.sort()) {
                lines.push(`export * from './${moduleName}';`);
            }

            lines.push('');

            const indexPath = join(absolutePath, 'index.ts');
            await writeFile(indexPath, lines.join('\n'), 'utf-8');
            generatedFiles.push(normalizedPath + '/index.ts');

            onProgress?.(
                `Generated index.ts for ${alias} with ${moduleFiles.length} module(s)`,
            );
        } catch {
            // Directory doesn't exist or can't be read, skip
        }
    }

    return generatedFiles;
}
