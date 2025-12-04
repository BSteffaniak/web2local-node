/**
 * Vite configuration generator
 *
 * Generates a vite.config.ts file based on detected project configuration
 */

import { readFile, writeFile, stat, readdir } from 'fs/promises';
import { join, relative } from 'path';
import type {
    ViteConfigOptions,
    AliasMapping,
    Framework,
    EnvVariable,
    SourceFile,
} from './types.js';
import {
    detectImportAliases,
    buildAliasPathMappings,
    extractBareImports,
    type AliasMap,
} from '../dependency-analyzer.js';

/**
 * Represents a workspace package detected in the project
 */
interface WorkspacePackage {
    /** Package name (e.g., "shared-ui") */
    name: string;
    /** Relative path from project root (e.g., "./navigation/shared-ui") */
    path: string;
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
 * Get the Vite plugin import for a framework
 */
function getFrameworkPlugin(
    framework: Framework,
): { import: string; plugin: string } | null {
    switch (framework) {
        case 'react':
            return {
                import: "import react from '@vitejs/plugin-react'",
                plugin: 'react()',
            };
        case 'preact':
            return {
                import: "import preact from '@preact/preset-vite'",
                plugin: 'preact()',
            };
        case 'vue':
            return {
                import: "import vue from '@vitejs/plugin-vue'",
                plugin: 'vue()',
            };
        case 'svelte':
            return {
                import: "import { svelte } from '@sveltejs/vite-plugin-svelte'",
                plugin: 'svelte()',
            };
        case 'solid':
            return {
                import: "import solid from 'vite-plugin-solid'",
                plugin: 'solid()',
            };
        default:
            return null;
    }
}

/**
 * Get the Vite plugin package name for a framework
 */
export function getFrameworkPluginPackage(framework: Framework): string | null {
    switch (framework) {
        case 'react':
            return '@vitejs/plugin-react';
        case 'preact':
            return '@preact/preset-vite';
        case 'vue':
            return '@vitejs/plugin-vue';
        case 'svelte':
            return '@sveltejs/vite-plugin-svelte';
        case 'solid':
            return 'vite-plugin-solid';
        default:
            return null;
    }
}

/**
 * Convert alias mappings to Vite resolve.alias format
 *
 * IMPORTANT: Aliases must be sorted by specificity (most specific first).
 * Vite's alias resolution is prefix-based and matches in order.
 * Without proper sorting, 'sarsaparilla' would match before 'sarsaparilla/auth',
 * causing 'sarsaparilla/auth' to resolve to 'sarsaparilla-path/auth' instead
 * of the correct dedicated path.
 */
function generateAliasConfig(aliases: AliasMapping[]): string {
    if (aliases.length === 0) {
        return '{}';
    }

    // Sort aliases by specificity: more path segments first, then by length
    const sortedAliases = [...aliases].sort((a, b) => {
        const segmentsA = a.alias.split('/').length;
        const segmentsB = b.alias.split('/').length;

        // More segments = more specific, should come first
        if (segmentsB !== segmentsA) {
            return segmentsB - segmentsA;
        }

        // Same segments, longer string = more specific
        return b.alias.length - a.alias.length;
    });

    const aliasEntries = sortedAliases.map((alias) => {
        // Escape the path for JavaScript string
        const escapedPath = alias.path.replace(/\\/g, '/');
        return `      '${alias.alias}': path.resolve(__dirname, '${escapedPath}')`;
    });

    return `{\n${aliasEntries.join(',\n')}\n    }`;
}

/**
 * Generate environment variable definitions for Vite (function-based config)
 *
 * Vite's define option requires values to be valid JSON or JS expressions.
 * This version uses loadEnv() to support .env files at runtime.
 */
function generateDefineConfigWithEnv(envVariables: EnvVariable[]): string {
    const defines: string[] = [
        "      'process.env.NODE_ENV': JSON.stringify(mode)",
    ];

    for (const env of envVariables) {
        // Reference the loaded env variable with empty string fallback
        defines.push(
            `      'process.env.${env.name}': JSON.stringify(env.${env.name} || '')`,
        );
    }

    return `{\n${defines.join(',\n')}\n    }`;
}

/**
 * Generate a .env.example file content listing all detected environment variables
 */
export function generateEnvExample(envVariables: EnvVariable[]): string {
    const lines = [
        '# Environment Variables',
        '# Detected from source code analysis',
        '# Copy this file to .env and fill in values',
        '',
    ];

    for (const env of envVariables) {
        const usedInPreview = env.usedIn.slice(0, 2).join(', ');
        const more =
            env.usedIn.length > 2 ? ` (+${env.usedIn.length - 2} more)` : '';
        lines.push(`# Used in: ${usedInPreview}${more}`);
        lines.push(`${env.name}=`);
        lines.push('');
    }

    return lines.join('\n');
}

/**
 * Generate vite.config.ts content
 */
export function generateViteConfig(options: ViteConfigOptions): string {
    const {
        entryPoints,
        aliases,
        envVariables,
        framework,
        outDir,
        sourcemap = true,
    } = options;

    const imports: string[] = [
        "import { defineConfig, loadEnv } from 'vite'",
        "import path from 'path'",
    ];

    const plugins: string[] = [];

    // Add framework plugin
    const frameworkPlugin = getFrameworkPlugin(framework);
    if (frameworkPlugin) {
        imports.push(frameworkPlugin.import);
        plugins.push(frameworkPlugin.plugin);
    }

    // Generate the config
    const aliasConfig = generateAliasConfig(aliases);
    const defineConfig = generateDefineConfigWithEnv(envVariables);

    // Determine input configuration
    let inputConfig = "path.resolve(__dirname, 'index.html')";
    if (entryPoints.length > 1) {
        // Multiple entry points
        const inputs = entryPoints.map((ep) => {
            const name = ep.path
                .replace(/[^a-zA-Z0-9]/g, '_')
                .replace(/_+/g, '_');
            return `      ${name}: path.resolve(__dirname, '${ep.path}')`;
        });
        inputConfig = `{\n${inputs.join(',\n')}\n    }`;
    }

    const config = `${imports.join('\n')}

// Generated Vite configuration for rebuilt source
// This file was auto-generated by the rebuild system

export default defineConfig(({ mode }) => {
  // Load env file based on mode in the current working directory.
  // The third argument '' ensures all env vars are loaded, not just VITE_ prefixed ones.
  const env = loadEnv(mode, process.cwd(), '');
  
  return {
    plugins: [${plugins.join(', ')}],
    
    define: ${defineConfig},
    
    resolve: {
      alias: ${aliasConfig},
      extensions: ['.tsx', '.ts', '.jsx', '.js', '.json']
    },
    
    build: {
      outDir: '${outDir}',
      sourcemap: ${sourcemap},
      rollupOptions: {
        input: ${inputConfig},
        output: {
          entryFileNames: 'assets/[name]-[hash].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash].[ext]'
        }
      },
      // Increase chunk size warning limit for large apps
      chunkSizeWarningLimit: 2000
    },
    
    // Optimize dependencies - pre-bundle problematic ESM packages
    optimizeDeps: {
      include: [
        'react',
        'react-dom',
        '@reduxjs/toolkit',
        '@reduxjs/toolkit/query',
        '@reduxjs/toolkit/query/react'
      ],
      // Force esbuild to bundle these packages
      esbuildOptions: {
        target: 'esnext'
      }
    },
    
    // CSS configuration
    css: {
      modules: {
        localsConvention: 'camelCase'
      }
    },
    
    // Suppress certain warnings
    esbuild: {
      logOverride: { 'this-is-undefined-in-esm': 'silent' }
    }
  }
})
`;

    return config;
}

/**
 * Detect workspace packages by scanning directory structure.
 *
 * Looks for directories that appear to be packages (have src/, index.ts, etc.)
 * that are NOT in node_modules and are imported by other code.
 */
async function detectWorkspacePackages(
    projectDir: string,
): Promise<WorkspacePackage[]> {
    const packages: WorkspacePackage[] = [];
    const seen = new Set<string>();

    async function scanDirectory(
        dir: string,
        depth: number = 0,
    ): Promise<void> {
        if (depth > 3) return; // Don't go too deep

        try {
            const entries = await readdir(dir, { withFileTypes: true });

            for (const entry of entries) {
                if (!entry.isDirectory()) continue;

                // Skip special directories
                if (
                    entry.name === 'node_modules' ||
                    entry.name.startsWith('.') ||
                    entry.name.startsWith('_') ||
                    entry.name === 'dist' ||
                    entry.name === 'build' ||
                    entry.name === '@types'
                ) {
                    continue;
                }

                const subdir = join(dir, entry.name);
                const relativePath = './' + relative(projectDir, subdir);

                // Check if this looks like a package
                const hasIndex = await hasIndexFile(subdir);
                const hasSrc = await pathExists(join(subdir, 'src'));
                const hasPackageJson = await pathExists(
                    join(subdir, 'package.json'),
                );

                // It's a package if it has src/, index file, or package.json
                if (
                    (hasIndex || hasSrc || hasPackageJson) &&
                    !seen.has(entry.name)
                ) {
                    seen.add(entry.name);
                    packages.push({
                        name: entry.name,
                        path: relativePath,
                    });
                }

                // Recurse into subdirectories to find nested packages
                await scanDirectory(subdir, depth + 1);
            }
        } catch {
            // Directory doesn't exist or can't be read
        }
    }

    await scanDirectory(projectDir);
    return packages;
}

/**
 * Check if a directory has an index file (index.ts, index.tsx, index.js, etc.)
 */
async function hasIndexFile(dir: string): Promise<boolean> {
    const indexFiles = ['index.ts', 'index.tsx', 'index.js', 'index.jsx'];
    for (const file of indexFiles) {
        if (await pathExists(join(dir, file))) return true;
        if (await pathExists(join(dir, 'src', file))) return true;
    }
    return false;
}

/**
 * Common package names that should NEVER be aliased.
 * These are real npm packages that happen to also exist as scoped versions.
 */

/**
 * Detect subpath exports for an aliased package.
 *
 * Scans the package directory for subdirectories that could be used as subpath imports.
 * For example, if sarsaparilla has src/auth/, we should allow imports like sarsaparilla/auth.
 */
async function detectSubpathExports(packagePath: string): Promise<string[]> {
    const subpaths: string[] = [];

    // Check both root and src/ directories
    const dirsToCheck = [packagePath, join(packagePath, 'src')];

    for (const dir of dirsToCheck) {
        try {
            const entries = await readdir(dir, { withFileTypes: true });

            for (const entry of entries) {
                // Check for directories with index files (subpath exports)
                if (entry.isDirectory() && !entry.name.startsWith('.')) {
                    const subdir = join(dir, entry.name);
                    if (await hasIndexFile(subdir)) {
                        subpaths.push(entry.name);
                    }
                }

                // Check for direct .ts/.tsx files that could be subpath exports
                // e.g., legacy.tsx -> sarsaparilla/legacy
                if (entry.isFile()) {
                    const match = entry.name.match(
                        /^([a-zA-Z][\w-]*)\.(ts|tsx|js|jsx)$/,
                    );
                    if (match && match[1] !== 'index') {
                        subpaths.push(match[1]);
                    }
                }
            }
        } catch {
            // Directory doesn't exist
        }
    }

    return [...new Set(subpaths)]; // Deduplicate
}

/**
 * Parse tsconfig.json and extract path aliases.
 * Also detects workspace packages and import aliases from source files.
 *
 * @param projectDir - Project root directory
 * @param sourceFiles - Optional source files for accurate alias detection.
 *                      When provided, uses actual import analysis to detect aliases.
 *                      When not provided, falls back to tsconfig.json paths only.
 */
export async function extractAliasesFromTsConfig(
    projectDir: string,
    sourceFiles?: SourceFile[],
): Promise<AliasMapping[]> {
    const aliases: AliasMapping[] = [];
    const existingAliases = new Set<string>();

    // Step 1: Parse tsconfig.json paths
    try {
        const tsconfigPath = join(projectDir, 'tsconfig.json');
        const content = await readFile(tsconfigPath, 'utf-8');
        const tsconfig = JSON.parse(content);

        const paths = tsconfig.compilerOptions?.paths || {};
        const baseUrl = tsconfig.compilerOptions?.baseUrl || '.';

        // Collect wildcard aliases (e.g., "ui-search/*")
        const wildcardAliases = new Set<string>();
        for (const alias of Object.keys(paths)) {
            if (alias.endsWith('/*')) {
                wildcardAliases.add(alias.replace(/\/\*$/, ''));
            }
        }

        for (const [alias, targets] of Object.entries(paths)) {
            if (!Array.isArray(targets) || targets.length === 0) continue;

            // Skip problematic aliases
            if (
                alias === '..' ||
                alias === '.' ||
                alias === '../*' ||
                alias === './*' ||
                alias.startsWith('./') ||
                alias.startsWith('../')
            ) {
                continue;
            }

            const isWildcard = alias.endsWith('/*');
            const cleanAlias = alias.replace(/\/\*$/, '');

            // Skip non-wildcard if wildcard exists
            if (!isWildcard && wildcardAliases.has(cleanAlias)) {
                continue;
            }

            // Try each target path
            let resolvedPath: string | null = null;
            const targetsToTry = isWildcard
                ? [...(targets as string[])].reverse()
                : (targets as string[]);

            for (const target of targetsToTry) {
                const cleanTarget = target.replace(/\/\*$/, '');
                const candidatePath =
                    baseUrl === '.'
                        ? `./${cleanTarget}`
                        : `./${baseUrl}/${cleanTarget}`;
                const normalizedPath = candidatePath.replace(/\/+/g, '/');
                const absolutePath = join(projectDir, normalizedPath);

                if (await pathExists(absolutePath)) {
                    resolvedPath = normalizedPath;
                    break;
                }
            }

            if (!resolvedPath) {
                let targetPath = isWildcard
                    ? (targets as string[])[(targets as string[]).length - 1]
                    : (targets as string[])[0];
                targetPath = targetPath.replace(/\/\*$/, '');
                resolvedPath =
                    baseUrl === '.'
                        ? `./${targetPath}`
                        : `./${baseUrl}/${targetPath}`;
                resolvedPath = resolvedPath.replace(/\/+/g, '/');
            }

            aliases.push({ alias: cleanAlias, path: resolvedPath });
            existingAliases.add(cleanAlias);
        }
    } catch {
        // tsconfig.json doesn't exist or can't be parsed
    }

    // Step 2: Detect workspace packages from directory structure
    // Only add aliases for packages that are actually imported as bare modules
    // and don't conflict with npm packages (either installed or declared in package.json)
    const workspacePackages = await detectWorkspacePackages(projectDir);

    // Get all bare imports from source files to know which packages are actually imported
    const bareImports = sourceFiles ? extractBareImports(sourceFiles) : null;

    // Load package.json to check declared dependencies
    let declaredDeps = new Set<string>();
    try {
        const pkgJsonPath = join(projectDir, 'package.json');
        const pkgJsonContent = await readFile(pkgJsonPath, 'utf-8');
        const pkgJson = JSON.parse(pkgJsonContent);
        const deps = {
            ...(pkgJson.dependencies || {}),
            ...(pkgJson.devDependencies || {}),
            ...(pkgJson.peerDependencies || {}),
        };
        declaredDeps = new Set(Object.keys(deps));
    } catch {
        // package.json doesn't exist or can't be parsed
    }

    for (const pkg of workspacePackages) {
        if (existingAliases.has(pkg.name)) continue;

        // Check if this would conflict with an npm package
        // Either installed in node_modules OR declared in package.json
        const npmPackagePath = join(projectDir, 'node_modules', pkg.name);
        const isInstalledNpmPackage = await pathExists(npmPackagePath);
        const isDeclaredDependency = declaredDeps.has(pkg.name);

        if (isInstalledNpmPackage || isDeclaredDependency) {
            // Skip - this alias would intercept imports of the real npm package
            continue;
        }

        // If we have source files, only add alias if the package is actually imported
        if (bareImports && !bareImports.has(pkg.name)) {
            // No source file imports this as a bare module, so no alias needed
            continue;
        }

        aliases.push({ alias: pkg.name, path: pkg.path });
        existingAliases.add(pkg.name);
    }

    // Step 3: If source files provided, detect import aliases accurately
    // This handles cases like 'sarsaparilla' -> '@fp/sarsaparilla'
    if (sourceFiles && sourceFiles.length > 0) {
        const aliasMap = detectImportAliases(sourceFiles);

        if (aliasMap.aliases.size > 0) {
            const aliasPathMappings = buildAliasPathMappings(
                aliasMap,
                sourceFiles,
            );

            for (const mapping of aliasPathMappings) {
                if (existingAliases.has(mapping.alias)) continue;

                // Prefer src/ subdirectory if it exists
                const srcPath = `${mapping.relativePath}/src`;
                const absoluteSrcPath = join(projectDir, srcPath);
                const basePath = (await pathExists(absoluteSrcPath))
                    ? srcPath
                    : mapping.relativePath;

                aliases.push({ alias: mapping.alias, path: basePath });
                existingAliases.add(mapping.alias);

                // Detect and add subpath exports for this aliased package
                const absolutePackagePath = join(
                    projectDir,
                    mapping.relativePath,
                );
                const subpaths =
                    await detectSubpathExports(absolutePackagePath);

                for (const subpath of subpaths) {
                    const subpathAlias = `${mapping.alias}/${subpath}`;
                    if (existingAliases.has(subpathAlias)) continue;

                    // Find where the subpath lives
                    const subpathPath = await resolveSubpathLocation(
                        absolutePackagePath,
                        mapping.relativePath,
                        subpath,
                    );

                    if (subpathPath) {
                        aliases.push({
                            alias: subpathAlias,
                            path: subpathPath,
                        });
                        existingAliases.add(subpathAlias);
                    }
                }
            }
        }
    }

    return aliases;
}

/**
 * Resolve the actual location of a subpath export within a package.
 * Checks src/, root, and file variants.
 */
async function resolveSubpathLocation(
    absolutePackagePath: string,
    relativePackagePath: string,
    subpath: string,
): Promise<string | null> {
    // Check directory in src/
    const srcSubpath = join(absolutePackagePath, 'src', subpath);
    if (await pathExists(srcSubpath)) {
        return `${relativePackagePath}/src/${subpath}`;
    }

    // Check directory at root
    const rootSubpath = join(absolutePackagePath, subpath);
    if (await pathExists(rootSubpath)) {
        return `${relativePackagePath}/${subpath}`;
    }

    // Check file variants (.ts, .tsx, .js, .jsx)
    const extensions = ['.tsx', '.ts', '.jsx', '.js'];

    for (const ext of extensions) {
        const srcFile = join(absolutePackagePath, 'src', `${subpath}${ext}`);
        if (await pathExists(srcFile)) {
            return `${relativePackagePath}/src/${subpath}${ext}`;
        }

        const rootFile = join(absolutePackagePath, `${subpath}${ext}`);
        if (await pathExists(rootFile)) {
            return `${relativePackagePath}/${subpath}${ext}`;
        }
    }

    return null;
}

/**
 * Write vite.config.ts to the project directory
 */
export async function writeViteConfig(
    projectDir: string,
    options: ViteConfigOptions,
    overwrite: boolean = false,
): Promise<boolean> {
    const configPath = join(projectDir, 'vite.config.ts');

    // Check if config already exists
    if (!overwrite) {
        try {
            await readFile(configPath);
            return false; // File exists, don't overwrite
        } catch {
            // File doesn't exist, proceed
        }
    }

    const configContent = generateViteConfig(options);
    await writeFile(configPath, configContent, 'utf-8');

    return true;
}
