import { readdir, writeFile, stat, readFile, mkdir } from 'fs/promises';
import { join, dirname, basename, relative, extname, resolve } from 'path';
import { parseSync } from '@swc/core';
import type {
    ExportSpecifier,
    ExportNamedDeclaration,
    ExportDeclaration,
} from '@swc/types';
import { extractExportsFromSource } from './export-extractor.js';
import type { FileExports } from './export-extractor.js';
import {
    extractImportsFromSource,
    categorizeImport,
    isNodeBuiltin,
    type ImportDeclarationInfo,
} from './import-extractor.js';
import {
    extractNamedImportsForSource,
    extractProcessEnvAccesses,
} from './ast-utils.js';
import { findAndResolveAssetStubs } from './asset-stub-resolver.js';

/**
 * Information about a package that needs stub files
 */
export interface PackageInfo {
    name: string;
    path: string;
    hasIndex: boolean;
    exportedModules: string[];
}

/**
 * Recursively finds all TypeScript/JavaScript files in a directory
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
                files.push(...(await findSourceFiles(fullPath, baseDir)));
            } else if (entry.isFile()) {
                const ext = extname(entry.name).toLowerCase();
                if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
                    files.push(relative(baseDir, fullPath));
                }
            }
        }
    } catch {
        // Directory doesn't exist or can't be read
    }

    return files;
}

/**
 * Checks if a file exists
 */
async function fileExists(filePath: string): Promise<boolean> {
    try {
        await stat(filePath);
        return true;
    } catch {
        return false;
    }
}

/**
 * Extracts exported identifiers from a TypeScript/JavaScript file.
 * Uses SWC for robust AST-based parsing that handles all export patterns correctly,
 * including destructured exports like RTK Query hooks.
 */
export async function extractExports(filePath: string): Promise<FileExports> {
    try {
        const content = await readFile(filePath, 'utf-8');
        const filename = basename(filePath);
        return extractExportsFromSource(content, filename);
    } catch {
        return { named: [], types: [], hasDefault: false };
    }
}

/**
 * Analyzes a package directory and determines what exports it provides
 */
export async function analyzePackage(
    packagePath: string,
): Promise<PackageInfo> {
    const name = basename(packagePath);
    const info: PackageInfo = {
        name,
        path: packagePath,
        hasIndex: false,
        exportedModules: [],
    };

    // Check for existing index file
    const indexFiles = ['index.ts', 'index.tsx', 'index.js', 'index.jsx'];
    for (const indexFile of indexFiles) {
        if (await fileExists(join(packagePath, indexFile))) {
            info.hasIndex = true;
            break;
        }
        // Also check src/index
        if (await fileExists(join(packagePath, 'src', indexFile))) {
            info.hasIndex = true;
            break;
        }
    }

    // Find all source files
    const sourceFiles = await findSourceFiles(packagePath);

    // Extract exports from each file
    for (const file of sourceFiles) {
        const exports = await extractExports(join(packagePath, file));
        info.exportedModules.push(...exports.named, ...exports.types);
        if (exports.defaultName) {
            info.exportedModules.push(exports.defaultName);
        }
    }

    info.exportedModules = [...new Set(info.exportedModules)].sort();

    return info;
}

/**
 * Detects if a file should be exported as a namespace object.
 *
 * Common patterns:
 * - securityHelper.ts → SecurityHelper (helper file with many exports)
 * - loginActions.js → LoginActions (Redux action creator file)
 * - cartActions.js → CartActions
 * - mapHelper.jsx → MapHelper
 *
 * Returns the namespace name if it should be exported as a namespace, null otherwise.
 */
function detectNamespaceExport(
    filePath: string,
    exports: { named: string[]; types: string[]; hasDefault: boolean },
): string | null {
    const fileName = basename(filePath).replace(/\.(tsx?|jsx?)$/, '');

    // Check if filename follows helper/actions pattern (camelCase ending with Helper or Actions)
    const helperMatch = fileName.match(
        /^([a-z][a-zA-Z0-9]*)([Hh]elper|[Aa]ctions|[Uu]tils?)$/,
    );
    if (!helperMatch) return null;

    // Only treat as namespace if it has multiple exports and no default export
    // (default export suggests it's a component, not a utility namespace)
    if (exports.hasDefault) return null;
    if (exports.named.length < 3) return null;

    // Convert camelCase to PascalCase for the namespace name
    const namespaceName = fileName.charAt(0).toUpperCase() + fileName.slice(1);
    return namespaceName;
}

/**
 * Generates an index.ts file that re-exports all found modules
 */
export async function generateIndexFile(
    packagePath: string,
    options: {
        dryRun?: boolean;
        onProgress?: (message: string) => void;
    } = {},
): Promise<{ generated: boolean; content: string; exports: string[] }> {
    const { dryRun = false, onProgress } = options;

    // Find all source files
    const sourceFiles = await findSourceFiles(packagePath);

    if (sourceFiles.length === 0) {
        return { generated: false, content: '', exports: [] };
    }

    const exportLines: string[] = [];
    const importLines: string[] = []; // For namespace imports
    const namespaceExportLines: string[] = []; // For namespace re-exports
    const allExports: string[] = [];

    // Track ALL used export names to prevent duplicates.
    // We use a single set for named exports, type exports, AND default-as-named exports
    // because TypeScript doesn't allow duplicate identifiers in the same scope,
    // even if one is a type and one is a value.
    //
    // This handles cases like:
    //   export function LogInPage() {}  // named export
    //   export default LogInPage;       // default export of same name
    // And also:
    //   export type { LocationSuggestion } from './types';  // type export
    //   export { LocationSuggestion } from './component';   // value export with same name
    //
    // Without this unified tracking, we'd generate duplicates that cause TS2300 errors.
    const usedExportNames = new Set<string>();

    // Group files by directory for cleaner exports
    const filesByDir = new Map<string, string[]>();

    for (const file of sourceFiles) {
        // Skip test files and stories
        if (
            file.includes('.test.') ||
            file.includes('.spec.') ||
            file.includes('.stories.')
        ) {
            continue;
        }

        const dir = dirname(file);
        if (!filesByDir.has(dir)) {
            filesByDir.set(dir, []);
        }
        filesByDir.get(dir)!.push(file);
    }

    // Track the first file with a default export for fallback default re-export
    // This enables `import X from './Dir'` to work even when no file matches the directory name
    let firstDefaultExportFile: string | null = null;
    let firstDefaultExportImportPath: string | null = null;

    // Get the root package directory name for matching
    const packageDirName = basename(packagePath);

    // Process each file
    for (const file of sourceFiles) {
        // Skip test files, stories, and type definition files
        if (
            file.includes('.test.') ||
            file.includes('.spec.') ||
            file.includes('.stories.') ||
            file.endsWith('.d.ts')
        ) {
            continue;
        }

        const fullPath = join(packagePath, file);
        const exports = await extractExports(fullPath);

        const hasExports =
            exports.named.length > 0 ||
            exports.types.length > 0 ||
            exports.hasDefault;

        if (hasExports) {
            // Create relative import path (without extension)
            let importPath = './' + file.replace(/\.(tsx?|jsx?)$/, '');

            // Handle index files in subdirectories
            if (importPath.endsWith('/index')) {
                importPath = importPath.slice(0, -6);
            }

            // Generate export lines for this file
            const fileExportParts: string[] = [];

            // Check if this file should also be exported as a namespace
            // (e.g., securityHelper.ts → export { SecurityHelper })
            const namespaceName = detectNamespaceExport(file, exports);
            if (namespaceName && !usedExportNames.has(namespaceName)) {
                importLines.push(
                    `import * as ${namespaceName} from '${importPath}';`,
                );
                namespaceExportLines.push(`export { ${namespaceName} };`);
                usedExportNames.add(namespaceName);
                allExports.push(namespaceName);
                fileExportParts.push(`namespace ${namespaceName}`);
            }

            // Named exports - filter out already-exported names
            const newNamedExports = exports.named.filter(
                (name) => !usedExportNames.has(name),
            );
            if (newNamedExports.length > 0) {
                exportLines.push(
                    `export { ${newNamedExports.join(', ')} } from '${importPath}';`,
                );
                newNamedExports.forEach((name) => usedExportNames.add(name));
                allExports.push(...newNamedExports);
                fileExportParts.push(`${newNamedExports.length} named`);
            }

            // Type exports - filter out names already exported (either as types or values).
            // In TypeScript, a value export can also be used as a type (type/value merging),
            // so if we already have `export { LocationSuggestion }` we don't need
            // `export type { LocationSuggestion }` which would cause a duplicate identifier error.
            const newTypeExports = exports.types.filter(
                (name) => !usedExportNames.has(name),
            );
            if (newTypeExports.length > 0) {
                exportLines.push(
                    `export type { ${newTypeExports.join(', ')} } from '${importPath}';`,
                );
                newTypeExports.forEach((name) => usedExportNames.add(name));
                allExports.push(...newTypeExports);
                fileExportParts.push(`${newTypeExports.length} types`);
            }

            // Default export - re-export as named using the identified name or filename
            // Skip if this name was already exported (either as named or default-as-named)
            if (exports.hasDefault) {
                const defaultName =
                    exports.defaultName ||
                    basename(file).replace(/\.(tsx?|jsx?)$/, '');
                // Use a valid identifier (capitalize first letter if needed, remove invalid chars)
                const safeName = defaultName.replace(/[^a-zA-Z0-9_$]/g, '');
                const fileBaseName = basename(file).replace(
                    /\.(tsx?|jsx?)$/,
                    '',
                );
                // dirName is the immediate parent directory of the file
                const dirName = basename(dirname(join(packagePath, file)));

                if (
                    safeName &&
                    /^[A-Za-z_$]/.test(safeName) &&
                    !usedExportNames.has(safeName)
                ) {
                    exportLines.push(
                        `export { default as ${safeName} } from '${importPath}';`,
                    );
                    usedExportNames.add(safeName);
                    allExports.push(safeName);
                    fileExportParts.push('default');

                    // Track the first file with a default export as a fallback
                    // Prefer files in the root directory (dirname(file) === '.')
                    if (
                        firstDefaultExportFile === null ||
                        dirname(file) === '.'
                    ) {
                        firstDefaultExportFile = file;
                        firstDefaultExportImportPath = importPath;
                    }

                    // If this file's default export matches the directory name (e.g., Label/Label.tsx exports Label),
                    // also add a direct default re-export so `import X from './Dir'` works.
                    // This handles the common pattern where directories have a main component file.
                    // We check both the immediate parent directory AND the root package directory.
                    const matchesDirName =
                        safeName.toLowerCase() === dirName.toLowerCase() ||
                        fileBaseName.toLowerCase() === dirName.toLowerCase();
                    const matchesPackageName =
                        safeName.toLowerCase() ===
                            packageDirName.toLowerCase() ||
                        fileBaseName.toLowerCase() ===
                            packageDirName.toLowerCase();

                    if (
                        (matchesDirName || matchesPackageName) &&
                        !usedExportNames.has('default')
                    ) {
                        exportLines.push(
                            `export { default } from '${importPath}';`,
                        );
                        usedExportNames.add('default');
                        fileExportParts.push('default-reexport');
                    }
                }
            }

            if (fileExportParts.length > 0) {
                onProgress?.(
                    `  Found ${fileExportParts.join(', ')} in ${file}`,
                );
            }
        }
    }

    // If no file matched the directory name but we have files with default exports,
    // use the first one as the module's default export.
    // This ensures `import X from './Dir'` works for directories with a single main component.
    if (
        !usedExportNames.has('default') &&
        firstDefaultExportFile !== null &&
        firstDefaultExportImportPath !== null
    ) {
        exportLines.push(
            `export { default } from '${firstDefaultExportImportPath}';`,
        );
        usedExportNames.add('default');
        onProgress?.(
            `  Using ${firstDefaultExportFile} as default export for directory`,
        );
    }

    if (exportLines.length === 0 && importLines.length === 0) {
        return { generated: false, content: '', exports: [] };
    }

    // Determine where to write - prefer src/index.ts if src exists
    const srcDir = join(packagePath, 'src');
    const hasSrc = await fileExists(srcDir);

    // If we're writing to src/, we need to adjust paths since findSourceFiles
    // returns paths relative to packagePath, not src/
    let adjustedExportLines = exportLines;
    let adjustedImportLines = importLines;
    let adjustedNamespaceExportLines = namespaceExportLines;
    if (hasSrc) {
        adjustedExportLines = exportLines.map((line) => {
            // Change './src/...' to './' since index will be in src/
            return line.replace(/from '\.\/(src\/)?/g, "from './");
        });
        adjustedImportLines = importLines.map((line) => {
            return line.replace(/from '\.\/(src\/)?/g, "from './");
        });
    }

    // Build content with namespace imports at the top, then regular exports, then namespace exports
    const contentParts: string[] = [
        '// Auto-generated index file for reconstructed package',
        '// This file was created because the original index.ts was not in the source map',
        '',
    ];

    // Add namespace imports first (if any)
    if (adjustedImportLines.length > 0) {
        contentParts.push('// Namespace imports for helper/action modules');
        contentParts.push(...adjustedImportLines.sort());
        contentParts.push('');
    }

    // Add regular exports
    contentParts.push(...adjustedExportLines.sort());

    // Add namespace exports (if any)
    if (adjustedNamespaceExportLines.length > 0) {
        contentParts.push('');
        contentParts.push('// Namespace exports');
        contentParts.push(...adjustedNamespaceExportLines.sort());
    }

    contentParts.push('');

    const content = contentParts.join('\n');

    if (!dryRun) {
        const indexPath = hasSrc
            ? join(srcDir, 'index.ts')
            : join(packagePath, 'index.ts');

        await writeFile(indexPath, content, 'utf-8');
        onProgress?.(
            `Generated ${indexPath} with ${allExports.length} exports`,
        );

        // Also generate a package.json if one doesn't exist
        const pkgJsonPath = join(packagePath, 'package.json');
        if (!(await fileExists(pkgJsonPath))) {
            const packageName = basename(packagePath);
            // Check if this is a scoped package (parent dir starts with @)
            const parentDir = basename(dirname(packagePath));
            const fullPackageName = parentDir.startsWith('@')
                ? `${parentDir}/${packageName}`
                : packageName;

            const pkgJson = {
                name: fullPackageName,
                version: '0.0.0-reconstructed',
                private: true,
                main: hasSrc ? './src/index.ts' : './index.ts',
                types: hasSrc ? './src/index.ts' : './index.ts',
            };
            await writeFile(
                pkgJsonPath,
                JSON.stringify(pkgJson, null, 2) + '\n',
                'utf-8',
            );
            onProgress?.(`Generated ${pkgJsonPath}`);
        }
    }

    return {
        generated: true,
        content,
        exports: [...new Set(allExports)].sort(),
    };
}

/**
 * Generates type declaration stubs for SCSS/CSS modules.
 *
 * @param sourceDir - Root directory to scan
 * @param options.dryRun - If true, don't write files
 * @param options.onProgress - Progress callback
 * @param options.internalPackages - Set of internal package names that should be processed
 *                                   even if they're in node_modules (e.g., '@fp/sarsaparilla')
 */
export async function generateScssModuleDeclarations(
    sourceDir: string,
    options: {
        dryRun?: boolean;
        onProgress?: (message: string) => void;
        internalPackages?: Set<string>;
    } = {},
): Promise<number> {
    const {
        dryRun = false,
        onProgress,
        internalPackages = new Set(),
    } = options;
    let count = 0;

    async function processDir(
        dir: string,
        inNodeModules: boolean = false,
    ): Promise<void> {
        try {
            const entries = await readdir(dir, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = join(dir, entry.name);

                if (entry.isDirectory()) {
                    if (entry.name === 'node_modules') {
                        // Enter node_modules but only process internal packages
                        await processNodeModules(fullPath);
                    } else if (!inNodeModules) {
                        // Normal directory traversal outside node_modules
                        await processDir(fullPath, false);
                    }
                } else if (entry.isFile()) {
                    // Check for .module.scss or .module.css files
                    if (entry.name.match(/\.module\.(scss|css|sass|less)$/)) {
                        const dtsPath = fullPath + '.d.ts';

                        // Skip if declaration already exists
                        if (await fileExists(dtsPath)) {
                            continue;
                        }

                        const dtsContent = [
                            '// Auto-generated type declaration for CSS module',
                            'declare const styles: { readonly [key: string]: string };',
                            'export default styles;',
                            '',
                        ].join('\n');

                        if (!dryRun) {
                            await writeFile(dtsPath, dtsContent, 'utf-8');
                            onProgress?.(
                                `Generated ${relative(sourceDir, dtsPath)}`,
                            );
                        }
                        count++;
                    }
                }
            }
        } catch {
            // Directory doesn't exist or can't be read
        }
    }

    async function processNodeModules(nodeModulesDir: string): Promise<void> {
        try {
            const entries = await readdir(nodeModulesDir, {
                withFileTypes: true,
            });

            for (const entry of entries) {
                if (!entry.isDirectory()) continue;

                const fullPath = join(nodeModulesDir, entry.name);

                if (entry.name.startsWith('@')) {
                    // Scoped package - look inside for the actual package
                    const scopedEntries = await readdir(fullPath, {
                        withFileTypes: true,
                    });
                    for (const scopedEntry of scopedEntries) {
                        if (!scopedEntry.isDirectory()) continue;

                        const scopedPackageName = `${entry.name}/${scopedEntry.name}`;
                        if (internalPackages.has(scopedPackageName)) {
                            // This is an internal package - process it recursively
                            await processInternalPackage(
                                join(fullPath, scopedEntry.name),
                            );
                        }
                    }
                } else if (internalPackages.has(entry.name)) {
                    // This is an internal package - process it recursively
                    await processInternalPackage(fullPath);
                }
            }
        } catch {
            // Directory doesn't exist or can't be read
        }
    }

    async function processInternalPackage(packageDir: string): Promise<void> {
        // Recursively process all directories in this internal package
        async function processPackageDir(dir: string): Promise<void> {
            try {
                const entries = await readdir(dir, { withFileTypes: true });

                for (const entry of entries) {
                    const fullPath = join(dir, entry.name);

                    if (entry.isDirectory()) {
                        // Skip nested node_modules even in internal packages
                        if (entry.name !== 'node_modules') {
                            await processPackageDir(fullPath);
                        }
                    } else if (entry.isFile()) {
                        if (
                            entry.name.match(/\.module\.(scss|css|sass|less)$/)
                        ) {
                            const dtsPath = fullPath + '.d.ts';

                            if (await fileExists(dtsPath)) {
                                continue;
                            }

                            const dtsContent = [
                                '// Auto-generated type declaration for CSS module',
                                'declare const styles: { readonly [key: string]: string };',
                                'export default styles;',
                                '',
                            ].join('\n');

                            if (!dryRun) {
                                await writeFile(dtsPath, dtsContent, 'utf-8');
                                onProgress?.(
                                    `Generated ${relative(sourceDir, dtsPath)}`,
                                );
                            }
                            count++;
                        }
                    }
                }
            } catch {
                // Directory doesn't exist or can't be read
            }
        }

        await processPackageDir(packageDir);
    }

    await processDir(sourceDir);
    return count;
}

/**
 * Checks if a directory looks like a package (has source files, looks like a package name)
 */
async function looksLikePackage(
    dirPath: string,
    dirName: string,
): Promise<boolean> {
    // Skip common non-package directories
    const skipNames = [
        'src',
        'lib',
        'dist',
        'build',
        'assets',
        'images',
        'styles',
        'types',
        'utils',
        'helpers',
        'components',
        'hooks',
        'api',
        'redux',
        'store',
        'services',
        'constants',
    ];
    if (skipNames.includes(dirName.toLowerCase())) {
        return false;
    }

    // Package names typically use kebab-case or are scoped (@scope/name)
    if (!/^(@[a-z0-9-]+\/)?[a-z][a-z0-9-]*$/i.test(dirName)) {
        return false;
    }

    // Check if it has source files directly or in src/
    try {
        const entries = await readdir(dirPath, { withFileTypes: true });

        // Has a src directory with files?
        const hasSrc = entries.some((e) => e.isDirectory() && e.name === 'src');
        if (hasSrc) {
            const srcEntries = await readdir(join(dirPath, 'src'), {
                withFileTypes: true,
            });
            const hasSrcFiles = srcEntries.some(
                (e) => e.isFile() && /\.(tsx?|jsx?)$/.test(e.name),
            );
            if (hasSrcFiles) return true;
        }

        // Has TypeScript/JavaScript files at root?
        const hasRootFiles = entries.some(
            (e) =>
                e.isFile() &&
                /\.(tsx?|jsx?)$/.test(e.name) &&
                !e.name.startsWith('.'),
        );
        if (hasRootFiles) return true;

        // Has subdirectories that look like they contain code?
        const hasCodeDirs = entries.some(
            (e) =>
                e.isDirectory() &&
                !e.name.startsWith('.') &&
                !['node_modules', 'dist', 'build'].includes(e.name),
        );
        return hasCodeDirs;
    } catch {
        return false;
    }
}

/**
 * Finds all internal packages that need index files generated
 */
export async function findPackagesNeedingIndex(
    sourceDir: string,
    internalPackages: Set<string>,
): Promise<string[]> {
    const packagesNeedingIndex: string[] = [];
    const checkedPaths = new Set<string>();

    async function checkAndAddPackage(fullPath: string): Promise<void> {
        if (checkedPaths.has(fullPath)) return;
        checkedPaths.add(fullPath);

        const info = await analyzePackage(fullPath);
        if (!info.hasIndex && info.exportedModules.length > 0) {
            packagesNeedingIndex.push(fullPath);
        }
    }

    async function searchDir(dir: string, depth: number = 0): Promise<void> {
        // Don't go too deep
        if (depth > 5) return;

        try {
            const entries = await readdir(dir, { withFileTypes: true });

            for (const entry of entries) {
                if (!entry.isDirectory()) continue;

                const fullPath = join(dir, entry.name);

                if (entry.name === 'node_modules') {
                    // Check packages inside node_modules
                    await searchNodeModules(fullPath);
                } else if (entry.name.startsWith('.')) {
                    // Skip hidden directories
                    continue;
                } else {
                    // Check if this directory is explicitly an internal package
                    if (internalPackages.has(entry.name)) {
                        await checkAndAddPackage(fullPath);
                    }
                    // Also check if it looks like a workspace package (not in node_modules)
                    // depth > 0 means we're not at sourceDir level (skip bundle dirs like navigation/, mapbox-gl-2.15.0/)
                    else if (
                        depth > 0 &&
                        (await looksLikePackage(fullPath, entry.name))
                    ) {
                        await checkAndAddPackage(fullPath);
                    }

                    // Recurse into subdirectories
                    await searchDir(fullPath, depth + 1);
                }
            }
        } catch {
            // Directory doesn't exist or can't be read
        }
    }

    async function searchNodeModules(nodeModulesDir: string): Promise<void> {
        try {
            const entries = await readdir(nodeModulesDir, {
                withFileTypes: true,
            });

            for (const entry of entries) {
                if (!entry.isDirectory()) continue;

                const fullPath = join(nodeModulesDir, entry.name);

                if (entry.name.startsWith('@')) {
                    // Scoped package - check subdirectories
                    const scopedEntries = await readdir(fullPath, {
                        withFileTypes: true,
                    });
                    for (const scopedEntry of scopedEntries) {
                        if (!scopedEntry.isDirectory()) continue;

                        const scopedFullPath = join(fullPath, scopedEntry.name);
                        const packageName = `${entry.name}/${scopedEntry.name}`;

                        if (internalPackages.has(packageName)) {
                            const info = await analyzePackage(scopedFullPath);
                            if (
                                !info.hasIndex &&
                                info.exportedModules.length > 0
                            ) {
                                packagesNeedingIndex.push(scopedFullPath);
                            }
                        }
                    }
                } else {
                    // Regular package
                    if (internalPackages.has(entry.name)) {
                        const info = await analyzePackage(fullPath);
                        if (!info.hasIndex && info.exportedModules.length > 0) {
                            packagesNeedingIndex.push(fullPath);
                        }
                    }
                }
            }
        } catch {
            // Directory doesn't exist
        }
    }

    await searchDir(sourceDir, 0);
    return packagesNeedingIndex;
}

/**
 * Information about an import found in source files
 */
export interface ImportInfo {
    /** The import path as written in the source */
    importPath: string;
    /** The file that contains this import */
    sourceFile: string;
    /** Whether this is a relative import */
    isRelative: boolean;
    /** Whether this imports from a directory (no file extension) */
    isDirectoryImport: boolean;
    /** The resolved absolute path (for relative imports) */
    resolvedPath?: string;
}

/**
 * Scans source files for imports and categorizes them.
 *
 * @param sourceDir - Root directory to scan
 * @param options.internalPackages - Set of package names that should be scanned
 *                                   even if they're in node_modules (e.g., '@fp/sarsaparilla')
 */
export async function scanImports(
    sourceDir: string,
    options: {
        internalPackages?: Set<string>;
    } = {},
): Promise<{
    directoryImports: ImportInfo[];
    cssModuleImports: ImportInfo[];
    externalPackageImports: ImportInfo[];
    missingTypeFileImports: ImportInfo[];
}> {
    const { internalPackages = new Set() } = options;

    const result = {
        directoryImports: [] as ImportInfo[],
        cssModuleImports: [] as ImportInfo[],
        externalPackageImports: [] as ImportInfo[],
        missingTypeFileImports: [] as ImportInfo[],
    };

    const seenDirectoryImports = new Set<string>();
    const seenCssModuleImports = new Set<string>();
    const seenExternalPackages = new Set<string>();

    /**
     * Check if a package name is an internal package that should be processed
     */
    function isInternalPackage(packageName: string): boolean {
        return internalPackages.has(packageName);
    }

    /**
     * Process a node_modules directory, only scanning internal packages
     */
    async function processNodeModules(nodeModulesDir: string): Promise<void> {
        try {
            const entries = await readdir(nodeModulesDir, {
                withFileTypes: true,
            });

            for (const entry of entries) {
                if (!entry.isDirectory()) continue;

                const fullPath = join(nodeModulesDir, entry.name);

                if (entry.name.startsWith('@')) {
                    // Scoped package - check each package inside
                    const scopedEntries = await readdir(fullPath, {
                        withFileTypes: true,
                    });
                    for (const scopedEntry of scopedEntries) {
                        if (!scopedEntry.isDirectory()) continue;

                        const scopedPackageName = `${entry.name}/${scopedEntry.name}`;
                        if (isInternalPackage(scopedPackageName)) {
                            // Recursively process this internal package
                            await processDir(join(fullPath, scopedEntry.name));
                        }
                    }
                } else if (isInternalPackage(entry.name)) {
                    // Non-scoped internal package
                    await processDir(fullPath);
                }
            }
        } catch {
            // Directory doesn't exist
        }
    }

    async function processDir(dir: string): Promise<void> {
        try {
            const entries = await readdir(dir, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = join(dir, entry.name);

                if (entry.isDirectory()) {
                    if (entry.name === 'node_modules') {
                        // Process node_modules but only scan internal packages
                        await processNodeModules(fullPath);
                    } else if (!entry.name.startsWith('.')) {
                        await processDir(fullPath);
                    }
                } else if (entry.isFile()) {
                    const ext = extname(entry.name).toLowerCase();
                    if (
                        ['.ts', '.tsx', '.js', '.jsx'].includes(ext) &&
                        !entry.name.endsWith('.d.ts')
                    ) {
                        await processFile(fullPath);
                    }
                }
            }
        } catch {
            // Directory doesn't exist
        }
    }

    async function processFile(filePath: string): Promise<void> {
        try {
            const content = await readFile(filePath, 'utf-8');
            const fileDir = dirname(filePath);

            // Use SWC-based import extraction for robust parsing
            const imports = extractImportsFromSource(
                content,
                basename(filePath),
            );

            for (const imp of imports) {
                const importPath = imp.source;
                const category = categorizeImport(importPath);

                // Handle CSS module imports
                if (category.isCssModule) {
                    if (category.isRelative) {
                        const resolvedPath = resolve(fileDir, importPath);

                        if (!seenCssModuleImports.has(resolvedPath)) {
                            seenCssModuleImports.add(resolvedPath);
                            result.cssModuleImports.push({
                                importPath,
                                sourceFile: filePath,
                                isRelative: true,
                                isDirectoryImport: false,
                                resolvedPath,
                            });
                        }
                    }
                    continue;
                }

                // Handle relative imports
                if (category.isRelative) {
                    // Check if this is a directory import (no extension)
                    const hasExtension =
                        /\.(tsx?|jsx?|json|css|scss|sass|less)$/.test(
                            importPath,
                        );

                    if (!hasExtension) {
                        const resolvedPath = resolve(fileDir, importPath);

                        // Check if resolved path is a directory OR a missing file
                        try {
                            const stats = await stat(resolvedPath);
                            if (stats.isDirectory()) {
                                // Check if it has an index file
                                const indexFiles = [
                                    'index.ts',
                                    'index.tsx',
                                    'index.js',
                                    'index.jsx',
                                ];
                                let hasIndex = false;
                                for (const idx of indexFiles) {
                                    if (
                                        await fileExists(
                                            join(resolvedPath, idx),
                                        )
                                    ) {
                                        hasIndex = true;
                                        break;
                                    }
                                }

                                if (
                                    !hasIndex &&
                                    !seenDirectoryImports.has(resolvedPath)
                                ) {
                                    seenDirectoryImports.add(resolvedPath);
                                    result.directoryImports.push({
                                        importPath,
                                        sourceFile: filePath,
                                        isRelative: true,
                                        isDirectoryImport: true,
                                        resolvedPath,
                                    });
                                }
                            }
                        } catch {
                            // Path doesn't exist - check if it's a missing type file or other file
                            // Try common extensions
                            const extensions = ['.ts', '.tsx', '.js', '.jsx'];
                            let fileFound = false;

                            for (const ext of extensions) {
                                if (await fileExists(resolvedPath + ext)) {
                                    fileFound = true;
                                    break;
                                }
                            }

                            if (!fileFound) {
                                // This is a missing file import
                                // Check if it looks like a type file (.types, .type, -types, etc.)
                                if (category.isTypeFile) {
                                    // Always add to the list - we'll collect all importers
                                    // in generateMissingTypeFileStubs to extract all needed types
                                    result.missingTypeFileImports.push({
                                        importPath,
                                        sourceFile: filePath,
                                        isRelative: true,
                                        isDirectoryImport: false,
                                        resolvedPath: resolvedPath + '.ts', // Assume .ts extension
                                    });
                                }
                            }
                        }
                    }
                    continue;
                }

                // Handle external package imports
                if (
                    category.packageName &&
                    !isNodeBuiltin(category.packageName)
                ) {
                    if (!seenExternalPackages.has(category.packageName)) {
                        seenExternalPackages.add(category.packageName);
                        result.externalPackageImports.push({
                            importPath,
                            sourceFile: filePath,
                            isRelative: false,
                            isDirectoryImport: false,
                        });
                    }
                }
            }
        } catch {
            // File doesn't exist or can't be read
        }
    }

    await processDir(sourceDir);
    return result;
}

/**
 * Generates index.ts files for directories that are imported as modules but lack an index
 */
export async function generateDirectoryIndexFiles(
    sourceDir: string,
    directoryImports: ImportInfo[],
    options: {
        dryRun?: boolean;
        onProgress?: (message: string) => void;
    } = {},
): Promise<number> {
    const { dryRun = false, onProgress } = options;
    let count = 0;

    for (const importInfo of directoryImports) {
        if (!importInfo.resolvedPath) continue;

        const dirPath = importInfo.resolvedPath;

        // Generate index file for this directory
        onProgress?.(
            `Generating index for directory: ${relative(sourceDir, dirPath)}`,
        );
        const { generated } = await generateIndexFile(dirPath, {
            dryRun,
            onProgress,
        });

        if (generated) {
            count++;
        }
    }

    return count;
}

/**
 * Generates stub CSS module files for imports that don't exist
 */
export async function generateMissingCssModuleStubs(
    sourceDir: string,
    cssModuleImports: ImportInfo[],
    options: {
        dryRun?: boolean;
        onProgress?: (message: string) => void;
    } = {},
): Promise<number> {
    const { dryRun = false, onProgress } = options;
    let count = 0;

    for (const importInfo of cssModuleImports) {
        if (!importInfo.resolvedPath) continue;

        const cssPath = importInfo.resolvedPath;

        // Check if the file already exists
        if (await fileExists(cssPath)) {
            continue;
        }

        // Create the stub CSS module file
        const stubContent = [
            '/* Auto-generated CSS module stub */',
            '/* Original file was not available in source maps */',
            `/* Imported by: ${relative(sourceDir, importInfo.sourceFile)} */`,
            '',
            '/* Add your styles here */',
            '',
        ].join('\n');

        // Also create the .d.ts declaration
        const dtsContent = [
            '// Auto-generated type declaration for CSS module stub',
            'declare const styles: { readonly [key: string]: string };',
            'export default styles;',
            '',
        ].join('\n');

        if (!dryRun) {
            // Ensure directory exists
            await mkdir(dirname(cssPath), { recursive: true });

            await writeFile(cssPath, stubContent, 'utf-8');
            await writeFile(cssPath + '.d.ts', dtsContent, 'utf-8');
            onProgress?.(
                `Generated CSS module stub: ${relative(sourceDir, cssPath)}`,
            );
        }

        count++;
    }

    return count;
}

/**
 * Generates stub type files for missing .types.ts imports.
 * These are typically type definition files that were erased during TypeScript compilation
 * and thus not included in the source maps.
 */
export async function generateMissingTypeFileStubs(
    sourceDir: string,
    missingTypeFileImports: ImportInfo[],
    options: {
        dryRun?: boolean;
        onProgress?: (message: string) => void;
    } = {},
): Promise<number> {
    const { dryRun = false, onProgress } = options;
    let count = 0;

    // Group by file path to avoid duplicates and collect all importing files
    const fileImporters = new Map<string, string[]>();

    for (const importInfo of missingTypeFileImports) {
        if (!importInfo.resolvedPath) continue;

        const typePath = importInfo.resolvedPath;

        // Check if the file already exists
        if (await fileExists(typePath)) {
            continue;
        }

        if (!fileImporters.has(typePath)) {
            fileImporters.set(typePath, []);
        }
        fileImporters.get(typePath)!.push(importInfo.sourceFile);
    }

    for (const [typePath, importers] of fileImporters) {
        // Extract type names that are imported from this file
        // We'll analyze the importing files to see what they're trying to import using AST
        const importedNames = new Set<string>();

        for (const importerPath of importers) {
            try {
                const content = await readFile(importerPath, 'utf-8');

                // Get the relative path to the type file (without extension)
                const relativeTypePath = relative(
                    dirname(importerPath),
                    typePath.replace(/\.ts$/, ''),
                );

                // Use AST-based extraction to find named imports from this path
                // This properly handles multi-line imports, comments, and edge cases
                const names = extractNamedImportsForSource(
                    content,
                    relativeTypePath,
                    basename(importerPath),
                );

                names.forEach((n) => importedNames.add(n));
            } catch {
                // File can't be read
            }
        }

        // Generate stub with the imported types
        const stubLines = [
            '// Auto-generated type stub',
            '// Original type definition file was not available in source maps',
            `// Imported by: ${importers
                .slice(0, 3)
                .map((p) => relative(sourceDir, p))
                .join(
                    ', ',
                )}${importers.length > 3 ? ` and ${importers.length - 3} more` : ''}`,
            '',
            '/* eslint-disable @typescript-eslint/no-explicit-any */',
            '',
        ];

        if (importedNames.size > 0) {
            // Generate specific type stubs for each imported name
            // Use 'any' instead of 'unknown' to allow destructuring and property access
            for (const name of importedNames) {
                stubLines.push(`export type ${name} = any;`);
            }
        } else {
            // No specific names found - create a generic stub
            stubLines.push('// Add your type definitions here');
            stubLines.push('export type TODO = any;');
        }

        stubLines.push('');

        if (!dryRun) {
            // Ensure directory exists
            await mkdir(dirname(typePath), { recursive: true });
            await writeFile(typePath, stubLines.join('\n'), 'utf-8');
            onProgress?.(
                `Generated type stub: ${relative(sourceDir, typePath)} (${importedNames.size} types)`,
            );
        }

        count++;
    }

    return count;
}

/**
 * Information about a process.env property access
 */
interface EnvPropertyAccess {
    /** The full path like 'HOMEPAGE_OPTIONS.searchAcrossUS' */
    path: string;
    /** The source file where this was found */
    sourceFile: string;
}

/**
 * Scans source files for process.env property accesses and generates env.d.ts
 * to declare the types for these custom environment variables.
 */
export async function generateEnvDeclarations(
    sourceDir: string,
    options: {
        dryRun?: boolean;
        onProgress?: (message: string) => void;
    } = {},
): Promise<{ generated: boolean; envVars: string[] }> {
    const { dryRun = false, onProgress } = options;

    const envAccesses: EnvPropertyAccess[] = [];

    async function processDir(dir: string): Promise<void> {
        try {
            const entries = await readdir(dir, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = join(dir, entry.name);

                if (entry.isDirectory()) {
                    if (
                        entry.name !== 'node_modules' &&
                        !entry.name.startsWith('.')
                    ) {
                        await processDir(fullPath);
                    }
                } else if (entry.isFile()) {
                    const ext = extname(entry.name).toLowerCase();
                    if (
                        ['.ts', '.tsx', '.js', '.jsx'].includes(ext) &&
                        !entry.name.endsWith('.d.ts')
                    ) {
                        await processFile(fullPath);
                    }
                }
            }
        } catch {
            // Directory doesn't exist
        }
    }

    async function processFile(filePath: string): Promise<void> {
        try {
            const content = await readFile(filePath, 'utf-8');

            // Use AST-based extraction to find process.env accesses
            // This properly ignores code inside strings/comments
            const envVars = extractProcessEnvAccesses(
                content,
                basename(filePath),
            );

            for (const envPath of envVars) {
                // Skip common env vars that are already typed
                if (['NODE_ENV', 'DEBUG', 'CI'].includes(envPath)) {
                    continue;
                }

                envAccesses.push({
                    path: envPath,
                    sourceFile: filePath,
                });
            }
        } catch {
            // File can't be read
        }
    }

    await processDir(sourceDir);

    if (envAccesses.length === 0) {
        return { generated: false, envVars: [] };
    }

    // Build a tree structure of env vars for proper typing
    // e.g., HOMEPAGE_OPTIONS.searchAcrossUS -> { HOMEPAGE_OPTIONS: { searchAcrossUS: string } }
    interface EnvTree {
        [key: string]: EnvTree | 'leaf';
    }

    const envTree: EnvTree = {};
    const rootEnvVars = new Set<string>();

    for (const access of envAccesses) {
        const parts = access.path.split('.');
        rootEnvVars.add(parts[0]);

        let current = envTree;
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (i === parts.length - 1) {
                // Leaf node - but only if not already an object
                if (!(part in current) || current[part] === 'leaf') {
                    current[part] = 'leaf';
                }
            } else {
                // Intermediate node
                if (!(part in current) || current[part] === 'leaf') {
                    current[part] = {};
                }
                current = current[part] as EnvTree;
            }
        }
    }

    // Generate the type definitions
    function generateType(tree: EnvTree, indent: string = '    '): string {
        const lines: string[] = [];

        for (const [key, value] of Object.entries(tree)) {
            if (value === 'leaf') {
                lines.push(`${indent}${key}: string;`);
            } else {
                lines.push(`${indent}${key}: {`);
                lines.push(generateType(value, indent + '  '));
                lines.push(`${indent}};`);
            }
        }

        return lines.join('\n');
    }

    // Asset module declarations go in a separate file WITHOUT `export {}`
    // This makes it a "script" file where ambient module declarations are globally visible.
    // If we put them in env.d.ts with `export {}`, they become scoped to that module.
    const assetsContent = [
        '// Auto-generated asset module declarations',
        '// These allow TypeScript to understand static asset imports (images, fonts, etc.)',
        '// This file intentionally has no exports to make it a "script" file,',
        '// which allows the ambient module declarations to be globally visible.',
        '',
        "declare module '*.svg' {",
        '  const content: string;',
        '  export default content;',
        '}',
        '',
        "declare module '*.png' {",
        '  const content: string;',
        '  export default content;',
        '}',
        '',
        "declare module '*.jpg' {",
        '  const content: string;',
        '  export default content;',
        '}',
        '',
        "declare module '*.jpeg' {",
        '  const content: string;',
        '  export default content;',
        '}',
        '',
        "declare module '*.webp' {",
        '  const content: string;',
        '  export default content;',
        '}',
        '',
        "declare module '*.avif' {",
        '  const content: string;',
        '  export default content;',
        '}',
        '',
        "declare module '*.gif' {",
        '  const content: string;',
        '  export default content;',
        '}',
        '',
        "declare module '*.ico' {",
        '  const content: string;',
        '  export default content;',
        '}',
        '',
        "declare module '*.woff' {",
        '  const content: string;',
        '  export default content;',
        '}',
        '',
        "declare module '*.woff2' {",
        '  const content: string;',
        '  export default content;',
        '}',
        '',
        "declare module '*.eot' {",
        '  const content: string;',
        '  export default content;',
        '}',
        '',
        "declare module '*.ttf' {",
        '  const content: string;',
        '  export default content;',
        '}',
        '',
        "declare module '*.otf' {",
        '  const content: string;',
        '  export default content;',
        '}',
        '',
        "declare module '*.mp4' {",
        '  const content: string;',
        '  export default content;',
        '}',
        '',
        "declare module '*.webm' {",
        '  const content: string;',
        '  export default content;',
        '}',
        '',
        "declare module '*.ogg' {",
        '  const content: string;',
        '  export default content;',
        '}',
        '',
        "declare module '*.mp3' {",
        '  const content: string;',
        '  export default content;',
        '}',
        '',
        "declare module '*.wav' {",
        '  const content: string;',
        '  export default content;',
        '}',
        '',
        "declare module '*.pdf' {",
        '  const content: string;',
        '  export default content;',
        '}',
        '',
    ].join('\n');

    // Environment variable declarations go in env.d.ts with `export {}`
    // The `export {}` is needed for the `declare global` augmentation to work.
    const envContent = [
        '// Auto-generated environment variable type declarations',
        '// These types were inferred from process.env usage in source files',
        '',
        'declare global {',
        '  namespace NodeJS {',
        '    interface ProcessEnv {',
        generateType(envTree),
        '    }',
        '  }',
        '}',
        '',
        'export {};',
        '',
    ].join('\n');

    if (!dryRun) {
        // Write assets.d.ts (script file - no exports, ambient declarations are global)
        const assetsDtsPath = join(sourceDir, 'assets.d.ts');
        await writeFile(assetsDtsPath, assetsContent, 'utf-8');
        onProgress?.(`Generated assets.d.ts with asset module declarations`);

        // Write env.d.ts (module file - has export {}, for global augmentation)
        const envDtsPath = join(sourceDir, 'env.d.ts');
        await writeFile(envDtsPath, envContent, 'utf-8');
        onProgress?.(
            `Generated env.d.ts with ${rootEnvVars.size} environment variables`,
        );
    }

    return {
        generated: true,
        envVars: [...rootEnvVars].sort(),
    };
}

/**
 * Generates stub type declarations for external packages that aren't installed
 */
export async function generateExternalPackageStubs(
    sourceDir: string,
    externalPackageImports: ImportInfo[],
    installedPackages: Set<string>,
    options: {
        dryRun?: boolean;
        onProgress?: (message: string) => void;
    } = {},
): Promise<number> {
    const { dryRun = false, onProgress } = options;
    let count = 0;

    // Group imports by package name
    const packageImports = new Map<string, ImportInfo[]>();

    for (const importInfo of externalPackageImports) {
        let packageName: string;
        if (importInfo.importPath.startsWith('@')) {
            const parts = importInfo.importPath.split('/');
            packageName =
                parts.length >= 2
                    ? `${parts[0]}/${parts[1]}`
                    : importInfo.importPath;
        } else {
            packageName = importInfo.importPath.split('/')[0];
        }

        if (!packageImports.has(packageName)) {
            packageImports.set(packageName, []);
        }
        packageImports.get(packageName)!.push(importInfo);
    }

    // Create @types directory if needed
    const typesDir = join(sourceDir, '@types');

    for (const [packageName, imports] of packageImports) {
        // Skip if package is already installed
        if (installedPackages.has(packageName)) {
            continue;
        }

        // Skip if package exists in node_modules
        const nodeModulesPath = join(sourceDir, 'node_modules', packageName);
        if (await fileExists(nodeModulesPath)) {
            continue;
        }

        // Create stub declaration file
        // Handle scoped packages by creating nested directories
        const packagePath = packageName.startsWith('@')
            ? join(typesDir, packageName.replace('/', '__'))
            : join(typesDir, packageName);

        const dtsPath = join(packagePath, 'index.d.ts');

        // Collect all unique import paths for this package to generate more specific stubs
        const subPaths = new Set<string>();
        for (const imp of imports) {
            const subPath = imp.importPath.slice(packageName.length);
            if (subPath && subPath !== '/') {
                subPaths.add(subPath);
            }
        }

        // Collect all named imports used with this package to generate specific stubs
        const namedImports = new Set<string>();
        for (const imp of imports) {
            // Try to extract named imports from the source file
            // This is a simplified approach - we'll just generate catch-all exports
        }

        // Generate the stub content using a wildcard module pattern
        // We create both an index.d.ts and a _types.d.ts for flexibility
        const indexContent = [
            `// Auto-generated type stub for "${packageName}"`,
            '// This package was not available - install it or replace with actual types',
            '',
            '// Default export',
            'declare const _default: any;',
            'export default _default;',
            '',
            '// Allow any named export - these will resolve to "any"',
            '// Add specific types here as needed',
            'export declare const __esModule: boolean;',
            '',
        ];

        // Add specific subpath declarations as comments
        if (subPaths.size > 0) {
            indexContent.push('// Subpath imports detected:');
            for (const subPath of subPaths) {
                indexContent.push(`// - "${packageName}${subPath}"`);
            }
            indexContent.push('');
        }

        const dtsContent = indexContent.join('\n');

        // Also create a wildcard module declaration file for better compatibility
        const wildcardContent = [
            `// Wildcard module declaration for "${packageName}"`,
            `declare module '${packageName}' {`,
            '  const value: any;',
            '  export default value;',
            '  export = value;',
            '}',
            '',
            `declare module '${packageName}/*' {`,
            '  const value: any;',
            '  export default value;',
            '  export = value;',
            '}',
            '',
        ].join('\n');

        if (!dryRun) {
            await mkdir(packagePath, { recursive: true });
            await writeFile(dtsPath, dtsContent, 'utf-8');
            // Also write a module declaration file
            await writeFile(
                join(packagePath, 'module.d.ts'),
                wildcardContent,
                'utf-8',
            );
            onProgress?.(`Generated stub for external package: ${packageName}`);
        }

        count++;
    }

    return count;
}

/**
 * Get the exported name from an ExportSpecifier
 */
function getExportedNameFromSpec(spec: ExportSpecifier): string | null {
    switch (spec.type) {
        case 'ExportSpecifier':
            // export { orig as exported } - use exported name if present
            if (spec.exported) {
                return spec.exported.type === 'Identifier'
                    ? spec.exported.value
                    : spec.exported.value;
            }
            return spec.orig.type === 'Identifier'
                ? spec.orig.value
                : spec.orig.value;

        case 'ExportDefaultSpecifier':
            return spec.exported.value;

        case 'ExportNamespaceSpecifier':
            return spec.name.type === 'Identifier'
                ? spec.name.value
                : spec.name.value;

        default:
            return null;
    }
}

/**
 * Represents an export statement with its position in the source
 */
interface ExportStatementInfo {
    /** Start character index in source (0-based, for use with string.slice) */
    charStart: number;
    /** End character index in source (exclusive, for use with string.slice) */
    charEnd: number;
    /** Whether this is a type-only export */
    isTypeOnly: boolean;
    /** The source module path (for re-exports) */
    source: string | null;
    /** Original quote character used for source (' or ") */
    quoteChar: string;
    /** Export specifiers with their names */
    specifiers: Array<{
        name: string;
        isTypeOnly: boolean;
    }>;
}

/**
 * Converts a SWC span offset to a JavaScript string character index.
 *
 * SWC spans have two quirks we must handle:
 * 1. Spans are cumulative across all parseSync calls in a process (global offset)
 * 2. The module span starts at the first statement, not at byte 0 of the source
 *    (leading comments/whitespace are excluded from the module span)
 *
 * For UTF-8 text with multi-byte characters, we also need to convert byte
 * positions to character positions.
 *
 * @param source The source string being parsed
 * @param swcOffset The raw span offset from SWC
 * @param moduleStart The ast.span.start value
 */
function swcOffsetToCharIndex(
    source: string,
    swcOffset: number,
    moduleStart: number,
    _moduleEnd: number,
): number {
    // SWC span positions are BYTE-BASED and cumulative across parseSync calls.
    // Spans are 1-indexed: position 1 = byte 0.
    //
    // Key insight from testing:
    // - swcOffset - moduleStart gives the byte offset within the module
    // - For files with no leading content, this is the absolute byte offset in source
    // - For files with leading comments, we need to add leading bytes
    //
    // IMPORTANT: ast.span excludes trailing comments, so we CANNOT use
    // (sourceBytes.length - moduleLen) to calculate leading bytes, because
    // that would include both leading AND trailing excluded content.
    //
    // Instead, we detect leading content by finding where code actually starts.

    const sourceBytes = Buffer.from(source, 'utf-8');

    // Byte offset within the module
    const offsetInModule = swcOffset - moduleStart;

    // Find where actual code starts (after any leading whitespace/comments)
    // Export/import statements start with these keywords
    const codeStartMatch = source.match(
        /^(\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*)/,
    );
    const leadingChars = codeStartMatch ? codeStartMatch[1].length : 0;

    // Convert leading characters to bytes
    const leadingBytes = Buffer.byteLength(
        source.slice(0, leadingChars),
        'utf-8',
    );

    // Absolute byte offset in source
    // Note: SWC spans are 1-indexed, but offsetInModule is already 0-indexed
    // (because moduleStart is the position of byte 0 of the module)
    const absoluteByteOffset = leadingBytes + offsetInModule;

    // For pure ASCII, byte offset equals character index
    if (sourceBytes.length === source.length) {
        return absoluteByteOffset;
    }

    // Multi-byte characters present - convert byte offset to character index
    const clampedOffset = Math.max(
        0,
        Math.min(absoluteByteOffset, sourceBytes.length),
    );
    const prefix = sourceBytes.subarray(0, clampedOffset).toString('utf-8');
    return prefix.length;
}

/**
 * Parse a source file with SWC and return export statements with span information.
 * This allows for surgical edits that preserve all non-export content.
 */
function parseExportsWithSpans(
    sourceCode: string,
    filename: string = 'file.tsx',
): ExportStatementInfo[] {
    const exports: ExportStatementInfo[] = [];

    try {
        const isTypeScript =
            filename.endsWith('.ts') || filename.endsWith('.tsx');
        const hasJSX = filename.endsWith('.tsx') || filename.endsWith('.jsx');

        const ast = parseSync(sourceCode, {
            syntax: isTypeScript ? 'typescript' : 'ecmascript',
            tsx: hasJSX && isTypeScript,
            jsx: hasJSX && !isTypeScript,
        });

        // SWC spans are byte-based. We use ast.span to calculate local offsets.
        const moduleStart = ast.span.start;
        const moduleEnd = ast.span.end;

        for (const item of ast.body) {
            if (
                item.type === 'ExportNamedDeclaration' &&
                item.specifiers.length > 0
            ) {
                const namedExport = item as ExportNamedDeclaration;
                const specifiers: ExportStatementInfo['specifiers'] = [];

                for (const spec of namedExport.specifiers) {
                    const name = getExportedNameFromSpec(spec);
                    if (name) {
                        // Check if this specific specifier is type-only (inline type modifier)
                        const isSpecTypeOnly =
                            spec.type === 'ExportSpecifier' && spec.isTypeOnly;
                        specifiers.push({ name, isTypeOnly: isSpecTypeOnly });
                    }
                }

                if (specifiers.length > 0) {
                    // Detect quote character used in source path
                    let quoteChar = "'";
                    if (namedExport.source) {
                        const sourceStart = swcOffsetToCharIndex(
                            sourceCode,
                            namedExport.source.span.start,
                            moduleStart,
                            moduleEnd,
                        );
                        const charAtStart = sourceCode[sourceStart];
                        if (charAtStart === '"' || charAtStart === "'") {
                            quoteChar = charAtStart;
                        }
                    }

                    // Convert SWC spans to character indices
                    const charStart = swcOffsetToCharIndex(
                        sourceCode,
                        namedExport.span.start,
                        moduleStart,
                        moduleEnd,
                    );
                    const charEnd = swcOffsetToCharIndex(
                        sourceCode,
                        namedExport.span.end,
                        moduleStart,
                        moduleEnd,
                    );

                    exports.push({
                        charStart,
                        charEnd,
                        isTypeOnly: namedExport.typeOnly ?? false,
                        source: namedExport.source?.value ?? null,
                        quoteChar,
                        specifiers,
                    });
                }
            }
        }
    } catch {
        // If parsing fails, return empty
    }

    return exports;
}

/**
 * Builds an export statement string from the given parameters.
 */
function buildExportStatement(
    isTypeOnly: boolean,
    specifiers: Array<{ name: string; isTypeOnly: boolean }>,
    source: string | null,
    quoteChar: string,
): string {
    const typePrefix = isTypeOnly ? 'type ' : '';

    // Build specifier list, preserving inline type modifiers
    const specifierList = specifiers
        .map((s) => (s.isTypeOnly && !isTypeOnly ? `type ${s.name}` : s.name))
        .join(', ');

    const sourcePart = source ? ` from ${quoteChar}${source}${quoteChar}` : '';
    return `export ${typePrefix}{ ${specifierList} }${sourcePart};`;
}

/**
 * Fixes duplicate exports in source code using SWC AST parsing with span-based
 * surgical edits. This preserves all content outside of export statements
 * (comments, blank lines, formatting) while only modifying exports that have
 * duplicate identifiers.
 *
 * Strategy:
 * 1. Parse with SWC to get export statements with their exact byte positions
 * 2. Identify which exports have duplicates
 * 3. Build replacement strings only for affected exports
 * 4. Apply edits in reverse order to preserve positions
 */
function fixDuplicateExportsInSource(
    sourceCode: string,
    filename: string = 'file.tsx',
): { newContent: string; duplicatesRemoved: string[] } {
    const duplicatesRemoved: string[] = [];
    const seenExportNames = new Set<string>();

    // Parse to get export info with spans
    const exportStatements = parseExportsWithSpans(sourceCode, filename);

    if (exportStatements.length === 0) {
        return { newContent: sourceCode, duplicatesRemoved: [] };
    }

    // Collect edits: { charStart, charEnd, replacement }
    const edits: Array<{
        charStart: number;
        charEnd: number;
        replacement: string;
    }> = [];

    for (const stmt of exportStatements) {
        const keptSpecifiers: typeof stmt.specifiers = [];
        const removedFromThis: string[] = [];

        for (const spec of stmt.specifiers) {
            if (seenExportNames.has(spec.name)) {
                removedFromThis.push(spec.name);
                duplicatesRemoved.push(spec.name);
            } else {
                seenExportNames.add(spec.name);
                keptSpecifiers.push(spec);
            }
        }

        // Only create an edit if we removed something
        if (removedFromThis.length > 0) {
            let replacement: string;
            if (keptSpecifiers.length === 0) {
                // All specifiers were duplicates - remove entire export statement
                // Also remove trailing newline if present to avoid blank lines
                replacement = '';
            } else {
                // Rebuild export with only kept specifiers
                replacement = buildExportStatement(
                    stmt.isTypeOnly,
                    keptSpecifiers,
                    stmt.source,
                    stmt.quoteChar,
                );
            }

            edits.push({
                charStart: stmt.charStart,
                charEnd: stmt.charEnd,
                replacement,
            });
        }
    }

    if (edits.length === 0) {
        return { newContent: sourceCode, duplicatesRemoved: [] };
    }

    // Apply edits in reverse order to preserve character positions
    let result = sourceCode;
    for (const edit of edits.reverse()) {
        result =
            result.slice(0, edit.charStart) +
            edit.replacement +
            result.slice(edit.charEnd);
    }

    // Clean up any resulting empty lines from removed exports
    // Replace multiple consecutive newlines with at most two (preserving paragraph breaks)
    result = result.replace(/\n{3,}/g, '\n\n');

    return { newContent: result, duplicatesRemoved };
}

/**
 * Fixes duplicate export identifiers in an index file using SWC for robust parsing.
 *
 * This handles cases where both a type and value export have the same name:
 * - export type { LocationSuggestion } from './types';
 * - export { LocationSuggestion } from './component';
 *
 * TypeScript doesn't allow duplicate identifiers, so we keep only the first occurrence.
 *
 * Uses SWC to parse the AST and identify export spans, then rebuilds the file
 * with duplicates removed while preserving comments and formatting.
 */
export async function fixDuplicateExports(
    filePath: string,
    options: {
        dryRun?: boolean;
        onProgress?: (message: string) => void;
    } = {},
): Promise<{ fixed: boolean; duplicatesRemoved: string[] }> {
    const { dryRun = false, onProgress } = options;

    try {
        const content = await readFile(filePath, 'utf-8');
        const result = fixDuplicateExportsInSource(content, basename(filePath));

        if (result.duplicatesRemoved.length > 0) {
            if (!dryRun) {
                await writeFile(filePath, result.newContent, 'utf-8');
                onProgress?.(
                    `Fixed ${result.duplicatesRemoved.length} duplicate exports in ${filePath}`,
                );
            }
            return { fixed: true, duplicatesRemoved: result.duplicatesRemoved };
        }

        return { fixed: false, duplicatesRemoved: [] };
    } catch {
        return { fixed: false, duplicatesRemoved: [] };
    }
}

/**
 * Finds and fixes duplicate exports in all generated index files
 */
export async function fixAllDuplicateExports(
    sourceDir: string,
    options: {
        internalPackages?: Set<string>;
        dryRun?: boolean;
        onProgress?: (message: string) => void;
    } = {},
): Promise<number> {
    const {
        internalPackages = new Set(),
        dryRun = false,
        onProgress,
    } = options;
    let fixedCount = 0;

    async function processDir(dir: string): Promise<void> {
        try {
            const entries = await readdir(dir, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = join(dir, entry.name);

                if (entry.isDirectory()) {
                    if (entry.name === 'node_modules') {
                        // Process internal packages in node_modules
                        await processNodeModules(fullPath);
                    } else if (!entry.name.startsWith('.')) {
                        await processDir(fullPath);
                    }
                } else if (entry.isFile() && entry.name === 'index.ts') {
                    // Check if this is a generated index file
                    const content = await readFile(fullPath, 'utf-8');
                    if (content.includes('Auto-generated index file')) {
                        const { fixed } = await fixDuplicateExports(fullPath, {
                            dryRun,
                            onProgress,
                        });
                        if (fixed) fixedCount++;
                    }
                }
            }
        } catch {
            // Directory doesn't exist
        }
    }

    async function processNodeModules(nodeModulesDir: string): Promise<void> {
        try {
            const entries = await readdir(nodeModulesDir, {
                withFileTypes: true,
            });

            for (const entry of entries) {
                if (!entry.isDirectory()) continue;

                const fullPath = join(nodeModulesDir, entry.name);

                if (entry.name.startsWith('@')) {
                    // Scoped package - check each package inside
                    const scopedEntries = await readdir(fullPath, {
                        withFileTypes: true,
                    });
                    for (const scopedEntry of scopedEntries) {
                        if (!scopedEntry.isDirectory()) continue;

                        const scopedPackageName = `${entry.name}/${scopedEntry.name}`;
                        if (internalPackages.has(scopedPackageName)) {
                            await processDir(join(fullPath, scopedEntry.name));
                        }
                    }
                } else if (internalPackages.has(entry.name)) {
                    await processDir(fullPath);
                }
            }
        } catch {
            // Directory doesn't exist
        }
    }

    await processDir(sourceDir);
    return fixedCount;
}

/**
 * Information about what a missing file needs to export
 */
export interface MissingFileRequirements {
    /** Absolute path where the stub file should be created */
    filePath: string;
    /** Whether any importer uses a default import */
    needsDefaultExport: boolean;
    /** Named value exports needed (non-type) */
    namedExports: Set<string>;
    /** Type exports needed */
    typeExports: Set<string>;
    /** Files that import this missing file */
    importedBy: string[];
}

/**
 * Alias mapping for import resolution
 */
export interface AliasMapping {
    /** Import alias (e.g., "sarsaparilla") */
    alias: string;
    /** Resolved path relative to source dir (e.g., "./navigation/node_modules/@fp/sarsaparilla") */
    path: string;
}

/**
 * Scans all source files and finds imports that point to missing files.
 * Handles both relative imports and aliased imports.
 * Collects all the export requirements from every importer.
 */
export async function findMissingSourceFiles(
    sourceDir: string,
    options: {
        internalPackages?: Set<string>;
        aliases?: AliasMapping[];
        onProgress?: (message: string) => void;
    } = {},
): Promise<Map<string, MissingFileRequirements>> {
    const { internalPackages = new Set(), aliases = [], onProgress } = options;
    const missingFiles = new Map<string, MissingFileRequirements>();

    // Extensions to try when resolving imports
    const extensions = ['.ts', '.tsx', '.js', '.jsx'];
    const indexFiles = ['index.ts', 'index.tsx', 'index.js', 'index.jsx'];

    // Sort aliases by specificity for matching (longer/more specific first)
    const sortedAliases = [...aliases].sort((a, b) => {
        const segmentsA = a.alias.split('/').length;
        const segmentsB = b.alias.split('/').length;
        if (segmentsB !== segmentsA) {
            return segmentsB - segmentsA;
        }
        return b.alias.length - a.alias.length;
    });

    /**
     * Try to resolve an import path using aliases
     * Returns the absolute resolved path if alias matches, null otherwise
     */
    function resolveWithAlias(importPath: string): string | null {
        for (const { alias, path: aliasPath } of sortedAliases) {
            if (importPath === alias || importPath.startsWith(alias + '/')) {
                // Replace the alias with the actual path
                const subPath = importPath.slice(alias.length); // '' or '/subpath'
                const cleanAliasPath = aliasPath.replace(/^\.\//, '');
                const resolvedPath = join(sourceDir, cleanAliasPath + subPath);
                return resolvedPath;
            }
        }
        return null;
    }

    /**
     * Check if a file exists with any of the common extensions
     */
    async function resolveImportPath(basePath: string): Promise<string | null> {
        // Try exact path first
        if (await fileExists(basePath)) {
            const stats = await stat(basePath);
            if (stats.isFile()) {
                return basePath;
            }
            // It's a directory - check for index file
            for (const idx of indexFiles) {
                const indexPath = join(basePath, idx);
                if (await fileExists(indexPath)) {
                    return indexPath;
                }
            }
            return null; // Directory without index
        }

        // Try adding extensions
        for (const ext of extensions) {
            const pathWithExt = basePath + ext;
            if (await fileExists(pathWithExt)) {
                return pathWithExt;
            }
        }

        return null;
    }

    /**
     * Process a node_modules directory, only scanning internal packages
     */
    async function processNodeModules(nodeModulesDir: string): Promise<void> {
        try {
            const entries = await readdir(nodeModulesDir, {
                withFileTypes: true,
            });

            for (const entry of entries) {
                if (!entry.isDirectory()) continue;

                const fullPath = join(nodeModulesDir, entry.name);

                if (entry.name.startsWith('@')) {
                    const scopedEntries = await readdir(fullPath, {
                        withFileTypes: true,
                    });
                    for (const scopedEntry of scopedEntries) {
                        if (!scopedEntry.isDirectory()) continue;
                        const scopedPackageName = `${entry.name}/${scopedEntry.name}`;
                        if (internalPackages.has(scopedPackageName)) {
                            await processDir(join(fullPath, scopedEntry.name));
                        }
                    }
                } else if (internalPackages.has(entry.name)) {
                    await processDir(fullPath);
                }
            }
        } catch {
            // Directory doesn't exist
        }
    }

    async function processDir(dir: string): Promise<void> {
        try {
            const entries = await readdir(dir, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = join(dir, entry.name);

                if (entry.isDirectory()) {
                    if (entry.name === 'node_modules') {
                        await processNodeModules(fullPath);
                    } else if (
                        !entry.name.startsWith('.') &&
                        !entry.name.startsWith('_')
                    ) {
                        await processDir(fullPath);
                    }
                } else if (entry.isFile()) {
                    const ext = extname(entry.name).toLowerCase();
                    if (
                        ['.ts', '.tsx', '.js', '.jsx'].includes(ext) &&
                        !entry.name.endsWith('.d.ts')
                    ) {
                        await processFile(fullPath);
                    }
                }
            }
        } catch {
            // Directory doesn't exist
        }
    }

    async function processFile(filePath: string): Promise<void> {
        try {
            const content = await readFile(filePath, 'utf-8');
            const fileDir = dirname(filePath);

            const imports = extractImportsFromSource(
                content,
                basename(filePath),
            );

            for (const imp of imports) {
                const importPath = imp.source;
                const category = categorizeImport(importPath);

                // Skip CSS/SCSS modules - handled separately
                if (category.isCssModule) continue;

                let resolvedBasePath: string | null = null;

                if (category.isRelative) {
                    // Relative import - resolve from file directory
                    resolvedBasePath = resolve(fileDir, importPath);
                } else {
                    // Non-relative import - try to resolve via aliases
                    resolvedBasePath = resolveWithAlias(importPath);
                    if (!resolvedBasePath) {
                        // Not an aliased import we know about - skip
                        continue;
                    }
                }

                const resolvedFile = await resolveImportPath(resolvedBasePath);

                // If file exists, skip
                if (resolvedFile !== null) continue;

                // File is missing - determine what extension to use for stub
                // Default to .tsx for maximum compatibility (supports JSX and types)
                const stubPath = resolvedBasePath + '.tsx';

                // Get or create requirements for this missing file
                let requirements = missingFiles.get(stubPath);
                if (!requirements) {
                    requirements = {
                        filePath: stubPath,
                        needsDefaultExport: false,
                        namedExports: new Set(),
                        typeExports: new Set(),
                        importedBy: [],
                    };
                    missingFiles.set(stubPath, requirements);
                }

                // Track who imports this file
                requirements.importedBy.push(filePath);

                // Collect export requirements from this import
                if (imp.hasDefaultImport) {
                    requirements.needsDefaultExport = true;
                }

                // Process named imports
                if (imp.isTypeOnly) {
                    // Entire import is type-only: import type { A, B } from './missing'
                    for (const name of imp.namedImports) {
                        requirements.typeExports.add(name);
                    }
                } else {
                    // Check each specifier
                    for (const detail of imp.namedImportDetails) {
                        if (detail.isTypeOnly) {
                            requirements.typeExports.add(detail.name);
                        } else {
                            requirements.namedExports.add(detail.name);
                        }
                    }
                }

                // Namespace imports don't require specific exports - file just needs to exist
                // Side-effect imports also just need the file to exist
            }
        } catch {
            // File can't be read or parsed
        }
    }

    onProgress?.('Scanning for missing source files...');
    await processDir(sourceDir);

    return missingFiles;
}

/**
 * Generates stub files for missing source imports.
 * Each stub exports the required default, named, and type exports as `any`.
 */
export async function generateMissingSourceStubs(
    sourceDir: string,
    missingFiles: Map<string, MissingFileRequirements>,
    options: {
        dryRun?: boolean;
        onProgress?: (message: string) => void;
    } = {},
): Promise<number> {
    const { dryRun = false, onProgress } = options;
    let count = 0;

    for (const [stubPath, requirements] of missingFiles) {
        // Skip if file somehow now exists
        if (await fileExists(stubPath)) {
            continue;
        }

        const lines: string[] = [
            '// Auto-generated stub for missing source file',
            '// Original file was not available in source maps',
            `// Imported by: ${requirements.importedBy
                .slice(0, 3)
                .map((p) => relative(sourceDir, p))
                .join(
                    ', ',
                )}${requirements.importedBy.length > 3 ? ` and ${requirements.importedBy.length - 3} more` : ''}`,
            '',
            '/* eslint-disable @typescript-eslint/no-explicit-any */',
            '',
        ];

        // Add default export if needed
        if (requirements.needsDefaultExport) {
            lines.push('const _default: any = {};');
            lines.push('export default _default;');
            lines.push('');
        }

        // Add named exports
        if (requirements.namedExports.size > 0) {
            for (const name of requirements.namedExports) {
                lines.push(`export const ${name}: any = {};`);
            }
            lines.push('');
        }

        // Add type exports
        if (requirements.typeExports.size > 0) {
            for (const name of requirements.typeExports) {
                lines.push(`export type ${name} = any;`);
            }
            lines.push('');
        }

        // If no exports were needed (side-effect or namespace only), add a comment
        if (
            !requirements.needsDefaultExport &&
            requirements.namedExports.size === 0 &&
            requirements.typeExports.size === 0
        ) {
            lines.push(
                '// This file exists for side-effect or namespace imports',
            );
            lines.push('export {};');
            lines.push('');
        }

        if (!dryRun) {
            // Ensure directory exists
            await mkdir(dirname(stubPath), { recursive: true });
            await writeFile(stubPath, lines.join('\n'), 'utf-8');
            onProgress?.(
                `Generated stub: ${relative(sourceDir, stubPath)} (${requirements.needsDefaultExport ? 'default' : ''}${requirements.namedExports.size > 0 ? ` ${requirements.namedExports.size} named` : ''}${requirements.typeExports.size > 0 ? ` ${requirements.typeExports.size} types` : ''})`,
            );
        }

        count++;
    }

    return count;
}

/**
 * Information about missing exports from a generated barrel/index file
 */
export interface MissingBarrelExport {
    /** The directory path containing the index.ts */
    directoryPath: string;
    /** The index.ts file path */
    indexPath: string;
    /** Named exports that are imported but not provided */
    missingNamedExports: Set<string>;
    /** Type exports that are imported but not provided */
    missingTypeExports: Set<string>;
    /** Files that import from this directory */
    importedBy: string[];
}

/**
 * Extracts what named exports a generated index file actually provides.
 * Uses SWC AST parsing for accuracy.
 */
async function extractProvidedExports(
    indexPath: string,
): Promise<{ named: Set<string>; types: Set<string> }> {
    const result = { named: new Set<string>(), types: new Set<string>() };

    try {
        const content = await readFile(indexPath, 'utf-8');
        const ast = parseSync(content, {
            syntax: 'typescript',
            tsx: false,
        });

        for (const item of ast.body) {
            if (item.type === 'ExportNamedDeclaration') {
                const namedExport = item as ExportNamedDeclaration;
                const isTypeOnly = namedExport.typeOnly ?? false;

                for (const spec of namedExport.specifiers) {
                    let exportedName: string | null = null;

                    if (spec.type === 'ExportSpecifier') {
                        // export { foo } or export { foo as bar }
                        if (spec.exported) {
                            exportedName =
                                spec.exported.type === 'Identifier'
                                    ? spec.exported.value
                                    : spec.exported.value;
                        } else {
                            exportedName =
                                spec.orig.type === 'Identifier'
                                    ? spec.orig.value
                                    : spec.orig.value;
                        }

                        // Check for inline type modifier
                        const isSpecTypeOnly = spec.isTypeOnly ?? false;
                        if (exportedName) {
                            if (isTypeOnly || isSpecTypeOnly) {
                                result.types.add(exportedName);
                            } else {
                                result.named.add(exportedName);
                            }
                        }
                    } else if (spec.type === 'ExportDefaultSpecifier') {
                        result.named.add('default');
                    } else if (spec.type === 'ExportNamespaceSpecifier') {
                        const name =
                            spec.name.type === 'Identifier'
                                ? spec.name.value
                                : spec.name.value;
                        result.named.add(name);
                    }
                }
            } else if (item.type === 'ExportDeclaration') {
                // Handle export declarations (export const X = ...)
                const exportDecl = item as ExportDeclaration;
                const decl = exportDecl.declaration;
                if (decl.type === 'VariableDeclaration' && decl.declarations) {
                    for (const d of decl.declarations) {
                        if (d.id.type === 'Identifier') {
                            result.named.add(d.id.value);
                        }
                    }
                } else if (
                    decl.type === 'FunctionDeclaration' &&
                    decl.identifier
                ) {
                    result.named.add(decl.identifier.value);
                } else if (
                    decl.type === 'ClassDeclaration' &&
                    decl.identifier
                ) {
                    result.named.add(decl.identifier.value);
                } else if (decl.type === 'TsTypeAliasDeclaration' && decl.id) {
                    result.types.add(decl.id.value);
                } else if (decl.type === 'TsInterfaceDeclaration' && decl.id) {
                    result.types.add(decl.id.value);
                }
            } else if (item.type === 'ExportDefaultDeclaration') {
                result.named.add('default');
            }
        }
    } catch {
        // If parsing fails, return empty sets
    }

    return result;
}

/**
 * Finds missing exports from generated barrel/index files.
 * Scans source files for imports from directories with generated index files,
 * extracts what named exports they expect, and compares against what the
 * generated index actually exports.
 */
export async function findMissingBarrelExports(
    sourceDir: string,
    generatedIndexPaths: string[],
    options: {
        internalPackages?: Set<string>;
        onProgress?: (message: string) => void;
    } = {},
): Promise<Map<string, MissingBarrelExport>> {
    const { internalPackages = new Set(), onProgress } = options;
    const missingExports = new Map<string, MissingBarrelExport>();

    // Build a map of directory paths to their generated index files
    const indexByDir = new Map<string, string>();
    for (const indexPath of generatedIndexPaths) {
        const dirPath = dirname(indexPath);
        indexByDir.set(dirPath, indexPath);
    }

    // Extract what each index file actually exports
    const providedExportsByDir = new Map<
        string,
        { named: Set<string>; types: Set<string> }
    >();
    for (const [dirPath, indexPath] of indexByDir) {
        const provided = await extractProvidedExports(indexPath);
        providedExportsByDir.set(dirPath, provided);
    }

    // Extensions to try when resolving directory imports
    const indexFiles = ['index.ts', 'index.tsx', 'index.js', 'index.jsx'];

    /**
     * Resolve an import path to a directory if it points to one of our generated index files
     */
    function resolveToGeneratedIndex(
        importPath: string,
        fromDir: string,
    ): string | null {
        if (!importPath.startsWith('.')) {
            return null; // Not a relative import
        }

        const resolvedPath = resolve(fromDir, importPath);

        // Check if this resolves to a directory with a generated index
        if (indexByDir.has(resolvedPath)) {
            return resolvedPath;
        }

        return null;
    }

    /**
     * Process a node_modules directory, only scanning internal packages
     */
    async function processNodeModules(nodeModulesDir: string): Promise<void> {
        try {
            const entries = await readdir(nodeModulesDir, {
                withFileTypes: true,
            });

            for (const entry of entries) {
                if (!entry.isDirectory()) continue;

                const fullPath = join(nodeModulesDir, entry.name);

                if (entry.name.startsWith('@')) {
                    const scopedEntries = await readdir(fullPath, {
                        withFileTypes: true,
                    });
                    for (const scopedEntry of scopedEntries) {
                        if (!scopedEntry.isDirectory()) continue;
                        const scopedPackageName = `${entry.name}/${scopedEntry.name}`;
                        if (internalPackages.has(scopedPackageName)) {
                            await processDir(join(fullPath, scopedEntry.name));
                        }
                    }
                } else if (internalPackages.has(entry.name)) {
                    await processDir(fullPath);
                }
            }
        } catch {
            // Directory doesn't exist
        }
    }

    async function processDir(dir: string): Promise<void> {
        try {
            const entries = await readdir(dir, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = join(dir, entry.name);

                if (entry.isDirectory()) {
                    if (entry.name === 'node_modules') {
                        await processNodeModules(fullPath);
                    } else if (
                        !entry.name.startsWith('.') &&
                        !entry.name.startsWith('_')
                    ) {
                        await processDir(fullPath);
                    }
                } else if (entry.isFile()) {
                    const ext = extname(entry.name).toLowerCase();
                    if (
                        ['.ts', '.tsx', '.js', '.jsx'].includes(ext) &&
                        !entry.name.endsWith('.d.ts')
                    ) {
                        await processFile(fullPath);
                    }
                }
            }
        } catch {
            // Directory doesn't exist
        }
    }

    async function processFile(filePath: string): Promise<void> {
        try {
            const content = await readFile(filePath, 'utf-8');
            const fileDir = dirname(filePath);

            const imports = extractImportsFromSource(
                content,
                basename(filePath),
            );

            for (const imp of imports) {
                const importPath = imp.source;

                // Check if this import resolves to a directory with a generated index
                const targetDir = resolveToGeneratedIndex(importPath, fileDir);
                if (!targetDir) continue;

                // Get what exports this directory provides
                const provided = providedExportsByDir.get(targetDir);
                if (!provided) continue;

                // Get or create missing exports entry
                let missing = missingExports.get(targetDir);
                if (!missing) {
                    missing = {
                        directoryPath: targetDir,
                        indexPath: indexByDir.get(targetDir)!,
                        missingNamedExports: new Set(),
                        missingTypeExports: new Set(),
                        importedBy: [],
                    };
                    missingExports.set(targetDir, missing);
                }

                // Track who imports this
                if (!missing.importedBy.includes(filePath)) {
                    missing.importedBy.push(filePath);
                }

                // Check each named import against what's provided
                if (imp.isTypeOnly) {
                    // Entire import is type-only
                    for (const name of imp.namedImports) {
                        if (
                            !provided.named.has(name) &&
                            !provided.types.has(name)
                        ) {
                            missing.missingTypeExports.add(name);
                        }
                    }
                } else {
                    // Check each specifier individually
                    for (const detail of imp.namedImportDetails) {
                        if (
                            !provided.named.has(detail.name) &&
                            !provided.types.has(detail.name)
                        ) {
                            if (detail.isTypeOnly) {
                                missing.missingTypeExports.add(detail.name);
                            } else {
                                missing.missingNamedExports.add(detail.name);
                            }
                        }
                    }
                }
            }
        } catch {
            // File can't be read or parsed
        }
    }

    onProgress?.('Scanning for missing barrel exports...');
    await processDir(sourceDir);

    // Filter out entries with no missing exports
    for (const [dirPath, missing] of missingExports) {
        if (
            missing.missingNamedExports.size === 0 &&
            missing.missingTypeExports.size === 0
        ) {
            missingExports.delete(dirPath);
        }
    }

    return missingExports;
}

/**
 * Appends stub exports to generated index files for missing named/type exports.
 * These are exports that are imported from the directory but not provided by any file.
 */
export async function appendMissingBarrelExports(
    sourceDir: string,
    missingExports: Map<string, MissingBarrelExport>,
    options: {
        dryRun?: boolean;
        onProgress?: (message: string) => void;
    } = {},
): Promise<number> {
    const { dryRun = false, onProgress } = options;
    let count = 0;

    for (const [_dirPath, missing] of missingExports) {
        if (
            missing.missingNamedExports.size === 0 &&
            missing.missingTypeExports.size === 0
        ) {
            continue;
        }

        try {
            const currentContent = await readFile(missing.indexPath, 'utf-8');

            const stubLines: string[] = [
                '',
                '// Stub exports for values imported but not found in source maps',
                '/* eslint-disable @typescript-eslint/no-explicit-any */',
            ];

            // Add named export stubs
            for (const name of missing.missingNamedExports) {
                stubLines.push(`export const ${name}: any = undefined;`);
            }

            // Add type export stubs
            for (const name of missing.missingTypeExports) {
                stubLines.push(`export type ${name} = any;`);
            }

            stubLines.push('');

            const newContent =
                currentContent.trimEnd() + '\n' + stubLines.join('\n');

            if (!dryRun) {
                await writeFile(missing.indexPath, newContent, 'utf-8');
                onProgress?.(
                    `Added ${missing.missingNamedExports.size + missing.missingTypeExports.size} stub exports to ${relative(sourceDir, missing.indexPath)}`,
                );
            }

            count++;
        } catch {
            // File can't be read or written
        }
    }

    return count;
}

/**
 * Generates all necessary stub files for a reconstructed project
 */
export async function generateStubFiles(
    sourceDir: string,
    options: {
        internalPackages?: Set<string>;
        installedPackages?: Set<string>;
        aliases?: AliasMapping[];
        generateScssDeclarations?: boolean;
        generateDirectoryIndexes?: boolean;
        generateCssModuleStubs?: boolean;
        generateExternalStubs?: boolean;
        generateTypeFileStubs?: boolean;
        generateEnvDeclarations?: boolean;
        generateMissingSourceStubs?: boolean;
        dryRun?: boolean;
        onProgress?: (message: string) => void;
    } = {},
): Promise<{
    indexFilesGenerated: number;
    directoryIndexesGenerated: number;
    scssDeclarationsGenerated: number;
    cssModuleStubsGenerated: number;
    externalPackageStubsGenerated: number;
    typeFileStubsGenerated: number;
    missingSourceStubsGenerated: number;
    missingBarrelExportsFixed: number;
    assetStubsResolved: number;
    duplicateExportsFixed: number;
    envDeclarationsGenerated: boolean;
    envVars: string[];
    packages: string[];
}> {
    const {
        internalPackages = new Set(),
        installedPackages = new Set(),
        aliases = [],
        generateScssDeclarations = true,
        generateDirectoryIndexes = true,
        generateCssModuleStubs = true,
        generateExternalStubs = true,
        generateTypeFileStubs = true,
        generateEnvDeclarations: generateEnvDeclarationsOpt = true,
        generateMissingSourceStubs: generateMissingSourceStubsOpt = true,
        dryRun = false,
        onProgress,
    } = options;

    const result = {
        indexFilesGenerated: 0,
        directoryIndexesGenerated: 0,
        scssDeclarationsGenerated: 0,
        cssModuleStubsGenerated: 0,
        externalPackageStubsGenerated: 0,
        typeFileStubsGenerated: 0,
        missingSourceStubsGenerated: 0,
        missingBarrelExportsFixed: 0,
        assetStubsResolved: 0,
        duplicateExportsFixed: 0,
        envDeclarationsGenerated: false,
        envVars: [] as string[],
        packages: [] as string[],
    };

    // Track all generated index file paths for later missing export detection
    const generatedIndexPaths: string[] = [];

    // Find packages needing index files
    onProgress?.('Scanning for packages needing index files...');
    const packagesNeedingIndex = await findPackagesNeedingIndex(
        sourceDir,
        internalPackages,
    );

    // Generate index files for each package
    for (const packagePath of packagesNeedingIndex) {
        onProgress?.(`Generating index for ${basename(packagePath)}...`);
        const { generated } = await generateIndexFile(packagePath, {
            dryRun,
            onProgress,
        });
        if (generated) {
            result.indexFilesGenerated++;
            result.packages.push(packagePath);
            // Track the generated index path
            const hasSrc = await fileExists(join(packagePath, 'src'));
            const indexPath = hasSrc
                ? join(packagePath, 'src', 'index.ts')
                : join(packagePath, 'index.ts');
            generatedIndexPaths.push(indexPath);
        }
    }

    // Scan for imports to find missing modules (including internal packages in node_modules)
    onProgress?.('Scanning source files for imports...');
    const imports = await scanImports(sourceDir, { internalPackages });

    // Generate index files for directories imported as modules
    if (generateDirectoryIndexes && imports.directoryImports.length > 0) {
        onProgress?.(
            `Found ${imports.directoryImports.length} directory imports without index files...`,
        );
        result.directoryIndexesGenerated = await generateDirectoryIndexFiles(
            sourceDir,
            imports.directoryImports,
            { dryRun, onProgress },
        );
        // Track directory index paths
        for (const imp of imports.directoryImports) {
            if (imp.resolvedPath) {
                generatedIndexPaths.push(join(imp.resolvedPath, 'index.ts'));
            }
        }
    }

    // Generate CSS module stubs for missing files
    if (generateCssModuleStubs && imports.cssModuleImports.length > 0) {
        onProgress?.(
            `Found ${imports.cssModuleImports.length} CSS module imports...`,
        );
        result.cssModuleStubsGenerated = await generateMissingCssModuleStubs(
            sourceDir,
            imports.cssModuleImports,
            { dryRun, onProgress },
        );
    }

    // Generate SCSS module declarations for existing files (including internal packages)
    if (generateScssDeclarations) {
        onProgress?.('Generating SCSS module declarations...');
        result.scssDeclarationsGenerated = await generateScssModuleDeclarations(
            sourceDir,
            {
                dryRun,
                onProgress,
                internalPackages,
            },
        );
    }

    // Generate stubs for external packages
    if (generateExternalStubs && imports.externalPackageImports.length > 0) {
        onProgress?.(
            `Found ${imports.externalPackageImports.length} external package imports...`,
        );
        result.externalPackageStubsGenerated =
            await generateExternalPackageStubs(
                sourceDir,
                imports.externalPackageImports,
                installedPackages,
                { dryRun, onProgress },
            );
    }

    // Generate stubs for missing type files (.types.ts, etc.)
    if (generateTypeFileStubs && imports.missingTypeFileImports.length > 0) {
        onProgress?.(
            `Found ${imports.missingTypeFileImports.length} missing type file imports...`,
        );
        result.typeFileStubsGenerated = await generateMissingTypeFileStubs(
            sourceDir,
            imports.missingTypeFileImports,
            { dryRun, onProgress },
        );
    }

    // Generate stubs for missing source files (relative imports and aliased imports)
    if (generateMissingSourceStubsOpt) {
        onProgress?.('Scanning for missing source files...');
        const missingSourceFiles = await findMissingSourceFiles(sourceDir, {
            internalPackages,
            aliases,
            onProgress,
        });
        if (missingSourceFiles.size > 0) {
            onProgress?.(
                `Found ${missingSourceFiles.size} missing source files...`,
            );
            result.missingSourceStubsGenerated =
                await generateMissingSourceStubs(
                    sourceDir,
                    missingSourceFiles,
                    { dryRun, onProgress },
                );
        }
    }

    // Generate env.d.ts for custom process.env types
    if (generateEnvDeclarationsOpt) {
        onProgress?.('Scanning for process.env usage...');
        const envResult = await generateEnvDeclarations(sourceDir, {
            dryRun,
            onProgress,
        });
        result.envDeclarationsGenerated = envResult.generated;
        result.envVars = envResult.envVars;
    }

    // Find and fix missing barrel exports (exports that are imported but not provided)
    if (generatedIndexPaths.length > 0) {
        onProgress?.('Scanning for missing barrel exports...');
        const missingBarrelExports = await findMissingBarrelExports(
            sourceDir,
            generatedIndexPaths,
            { internalPackages, onProgress },
        );
        if (missingBarrelExports.size > 0) {
            onProgress?.(
                `Found ${missingBarrelExports.size} directories with missing exports...`,
            );
            result.missingBarrelExportsFixed = await appendMissingBarrelExports(
                sourceDir,
                missingBarrelExports,
                { dryRun, onProgress },
            );
        }
    }

    // Resolve asset stubs (bundler-generated placeholders like __VITE_ASSET__)
    onProgress?.('Resolving asset stubs...');
    const assetStubResult = await findAndResolveAssetStubs(sourceDir, {
        internalPackages,
        dryRun,
        onProgress,
    });
    result.assetStubsResolved = assetStubResult.resolved;

    // Fix duplicate exports in generated index files
    onProgress?.('Fixing duplicate exports in generated index files...');
    result.duplicateExportsFixed = await fixAllDuplicateExports(sourceDir, {
        internalPackages,
        dryRun,
        onProgress,
    });

    return result;
}
