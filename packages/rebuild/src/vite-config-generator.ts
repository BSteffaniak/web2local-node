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
} from './types.js';
import type { ExtractedSource } from '@web2local/types';
import {
    detectImportAliases,
    buildAliasPathMappings,
    extractBareImports,
    inferAliasesFromImports,
} from '@web2local/analyzer';

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
 * Checks if a path exists on the filesystem.
 *
 * @param path - File or directory path to check
 * @returns True if the path exists
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
 * Gets the Vite plugin import statement and usage for a framework.
 *
 * @param framework - The detected framework
 * @returns Object with import statement and plugin call, or null for unknown frameworks
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
 * Gets the Vite plugin package name for a framework.
 *
 * @param framework - The detected framework
 * @returns The npm package name for the Vite plugin, or null for unknown frameworks
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
 * Converts alias mappings to Vite resolve.alias format.
 *
 * IMPORTANT: Aliases must be sorted by specificity (most specific first).
 * Vite's alias resolution is prefix-based and matches in order.
 * Without proper sorting, 'sarsaparilla' would match before 'sarsaparilla/auth',
 * causing 'sarsaparilla/auth' to resolve to 'sarsaparilla-path/auth' instead
 * of the correct dedicated path.
 *
 * @param aliases - Array of alias mappings
 * @returns JavaScript object literal string for Vite's resolve.alias config
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
 * Generates environment variable definitions for Vite (function-based config).
 *
 * Vite's define option requires values to be valid JSON or JS expressions.
 * This version uses loadEnv() to support .env files at runtime.
 *
 * @param envVariables - Array of detected environment variables
 * @returns JavaScript object literal string for Vite's define config
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
 * Generates a .env.example file content listing all detected environment variables.
 *
 * Creates a template file with comments showing where each variable is used.
 *
 * @param envVariables - Array of detected environment variables
 * @returns Content for the .env.example file
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
 * Generates vite.config.ts content.
 *
 * Creates a complete Vite configuration file with:
 * - Framework-specific plugins
 * - Path alias resolution
 * - Environment variable definitions
 * - Virtual module stub plugins
 * - CSS module stub plugins
 * - Build optimization settings
 *
 * @param options - Vite configuration options
 * @returns Complete vite.config.ts file content
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
        "import { defineConfig, loadEnv, type Plugin } from 'vite'",
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

/**
 * Plugin to stub virtual modules from Vite plugins that aren't configured.
 * 
 * Virtual modules (e.g., virtual:pwa-register from vite-plugin-pwa) are
 * build-time constructs that don't exist as real files. When rebuilding
 * from source maps, these plugins aren't configured, so we need to stub them.
 * 
 * This plugin:
 * 1. Intercepts imports starting with 'virtual:'
 * 2. Returns a universal Proxy-based stub as the default export
 * 3. Transforms named imports to destructure from the default export
 *    (since ES modules require static exports, we can't dynamically export names)
 * 
 * Example transformation:
 *   import { registerSW } from 'virtual:pwa-register';
 * becomes:
 *   import __virtual_stub__ from '\0virtual-stub:pwa-register';
 *   const { registerSW } = __virtual_stub__;
 */
function virtualModuleStubPlugin(): import('vite').Plugin {
  const virtualPrefix = '\\0virtual-stub:';
  
  return {
    name: 'virtual-module-stub',
    enforce: 'pre',
    
    resolveId(id) {
      // Handle original virtual: imports
      if (id.startsWith('virtual:')) {
        const moduleName = id.slice('virtual:'.length);
        return virtualPrefix + moduleName;
      }
      // Handle transformed virtual-stub: imports (from our transform hook)
      if (id.startsWith('virtual-stub:')) {
        const moduleName = id.slice('virtual-stub:'.length);
        return virtualPrefix + moduleName;
      }
      return null;
    },
    
    load(id) {
      if (!id.startsWith(virtualPrefix)) {
        return null;
      }
      
      const moduleName = 'virtual:' + id.slice(virtualPrefix.length);
      
      // Return a universal Proxy-based stub
      // The Proxy handles any property access, function calls, or construction
      return \`
        const __moduleName__ = \${JSON.stringify(moduleName)};
        
        // Only warn once per module
        if (typeof window !== 'undefined' && !window.__virtualStubWarned__) {
          window.__virtualStubWarned__ = new Set();
        }
        if (typeof window !== 'undefined' && !window.__virtualStubWarned__.has(__moduleName__)) {
          console.warn('[rebuild] Virtual module "' + __moduleName__ + '" is stubbed - original functionality unavailable');
          window.__virtualStubWarned__.add(__moduleName__);
        }
        
        const handler = {
          get(target, prop) {
            if (prop === '__esModule') return true;
            if (prop === 'default') return target;
            if (prop === Symbol.toStringTag) return 'VirtualModuleStub';
            if (typeof prop === 'symbol') return undefined;
            // Return a new proxy for any property access (allows chaining)
            return new Proxy(function() {}, handler);
          },
          apply(target, thisArg, args) {
            // When called as a function, return another proxy (allows chaining)
            return new Proxy(function() {}, handler);
          },
          construct(target, args) {
            // When used with 'new', return a proxy object
            return new Proxy({}, handler);
          }
        };
        
        const stub = new Proxy(function() {}, handler);
        export default stub;
      \`;
    },
    
    transform(code, id) {
      // Skip virtual stubs themselves and node_modules
      if (id.startsWith(virtualPrefix) || id.includes('node_modules')) {
        return null;
      }
      
      // Match imports from virtual: modules
      // Handles: import { foo, bar } from 'virtual:xyz'
      //          import foo from 'virtual:xyz'
      //          import * as foo from 'virtual:xyz'
      //          import { foo as bar } from 'virtual:xyz'
      const virtualImportRegex = /import\\s+({[^}]+}|\\*\\s+as\\s+\\w+|\\w+)\\s+from\\s+['"]virtual:([^'"]+)['"]/g;
      
      let hasVirtualImports = false;
      let newCode = code;
      let importCounter = 0;
      
      newCode = newCode.replace(virtualImportRegex, (match, imports, moduleName) => {
        hasVirtualImports = true;
        const stubVarName = \`__virtual_stub_\${importCounter++}__\`;
        const stubImport = \`import \${stubVarName} from 'virtual-stub:\${moduleName}'\`;
        
        const trimmedImports = imports.trim();
        
        // Handle: import * as foo from 'virtual:xyz'
        if (trimmedImports.startsWith('* as ')) {
          const alias = trimmedImports.slice('* as '.length).trim();
          return \`\${stubImport};\\nconst \${alias} = \${stubVarName}\`;
        }
        
        // Handle: import foo from 'virtual:xyz' (default import)
        if (!trimmedImports.startsWith('{')) {
          return \`\${stubImport};\\nconst \${trimmedImports} = \${stubVarName}\`;
        }
        
        // Handle: import { foo, bar, baz as qux } from 'virtual:xyz'
        return \`\${stubImport};\\nconst \${trimmedImports} = \${stubVarName}\`;
      });
      
      if (hasVirtualImports) {
        return {
          code: newCode,
          map: null
        };
      }
      
      return null;
    }
  };
}

/**
 * Plugin to handle CSS module stubs that have no actual class definitions.
 * When CSS source maps aren't available, the CSS module stubs are empty.
 * This plugin intercepts CSS module imports and returns a Proxy that maps
 * base class names to their hashed equivalents from the captured CSS.
 * 
 * For example: styles.skipLink -> '_skipLink_pl5cr_7'
 * 
 * This allows the app to work with the globally-injected captured CSS bundle
 * which contains the production-hashed class names.
 */
function cssModuleStubPlugin(): import('vite').Plugin {
  const stubMarker = 'Auto-generated CSS module stub';
  const stubCache = new Map<string, boolean>();
  // Use .js extension to ensure Vite treats this as JavaScript, not CSS
  const virtualPrefix = '\\0virtual:css-stub/';
  const virtualSuffix = '.js';
  
  // Class name mappings loaded from _class-name-map.json
  let classNameMappings: Record<string, string[]> | null = null;
  let mappingsLoaded = false;
  
  async function loadMappings() {
    if (mappingsLoaded) return;
    mappingsLoaded = true;
    
    try {
      const fs = await import('fs/promises');
      const mapPath = path.resolve(process.cwd(), '_class-name-map.json');
      const content = await fs.readFile(mapPath, 'utf-8');
      const parsed = JSON.parse(content);
      classNameMappings = parsed.mappings || {};
      console.log('[css-module-stub] Loaded', Object.keys(classNameMappings).length, 'class name mappings');
    } catch (e) {
      // No mappings file - will fall back to returning base names
      console.log('[css-module-stub] No class name mappings found, using base names');
    }
  }
  
  return {
    name: 'css-module-stub',
    enforce: 'pre',
    
    async buildStart() {
      await loadMappings();
    },
    
    async resolveId(source, importer, options) {
      // Only handle CSS module imports
      if (!source.match(/\\.module\\.(css|scss|sass|less)$/)) {
        return null;
      }
      
      // Let Vite resolve the path first
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved) return null;
      
      // Check if we've already determined this is a stub
      if (stubCache.has(resolved.id)) {
        if (stubCache.get(resolved.id)) {
          // Return a virtual module ID with .js extension so Vite treats it as JS
          return virtualPrefix + encodeURIComponent(resolved.id) + virtualSuffix;
        }
        return null;
      }
      
      // Read the file to check if it's a stub
      try {
        const fs = await import('fs/promises');
        const content = await fs.readFile(resolved.id, 'utf-8');
        const isStub = content.includes(stubMarker);
        stubCache.set(resolved.id, isStub);
        
        if (isStub) {
          return virtualPrefix + encodeURIComponent(resolved.id) + virtualSuffix;
        }
      } catch {
        stubCache.set(resolved.id, false);
      }
      
      return null;
    },
    
    load(id) {
      // Handle our virtual stub modules
      if (!id.startsWith(virtualPrefix) || !id.endsWith(virtualSuffix)) {
        return null;
      }
      
      // Generate a module that exports a Proxy
      // The Proxy maps base class names to their hashed equivalents
      const mappingsJson = JSON.stringify(classNameMappings || {});
      
      return \`
        const __mappings = \${mappingsJson};
        
        const handler = {
          get(target, prop) {
            if (prop === '__esModule') return true;
            if (prop === 'default') return target;
            if (typeof prop === 'string') {
              // Look up the hashed class name from mappings
              const hashedNames = __mappings[prop];
              if (hashedNames && hashedNames.length > 0) {
                return hashedNames[0];
              }
              // Fallback to base name if no mapping found
              return prop;
            }
            return undefined;
          }
        };
        const styles = new Proxy({}, handler);
        export default styles;
      \`;
    }
  };
}

export default defineConfig(({ mode }) => {
  // Load env file based on mode in the current working directory.
  // The third argument '' ensures all env vars are loaded, not just VITE_ prefixed ones.
  const env = loadEnv(mode, process.cwd(), '');
  
  return {
    plugins: [virtualModuleStubPlugin(), cssModuleStubPlugin(), ${plugins.join(', ')}],
    
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
        localsConvention: 'camelCase',
        // Return the original class name without any hashing
        // This ensures styles.className returns 'className' consistently
        // The actual styling comes from the captured CSS bundle (injected globally)
        // which uses data-component attributes and global class names
        generateScopedName: '[local]'
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
 * Detects workspace packages by scanning directory structure.
 *
 * Looks for directories that appear to be packages (have src/, index.ts, etc.)
 * that are NOT in node_modules and are imported by other code.
 *
 * @param projectDir - Project root directory to scan
 * @returns Array of detected workspace packages with names and paths
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
 * Checks if a directory has an index file (index.ts, index.tsx, index.js, etc.).
 *
 * Also checks for index files in the src/ subdirectory.
 *
 * @param dir - Directory to check
 * @returns True if an index file exists
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
 * Detects subpath exports for an aliased package.
 *
 * Scans the package directory for subdirectories that could be used as subpath imports.
 * For example, if sarsaparilla has src/auth/, we should allow imports like sarsaparilla/auth.
 *
 * @param packagePath - Absolute path to the package directory
 * @returns Array of subpath names (e.g., ["auth", "legacy"])
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
    sourceFiles?: ExtractedSource[],
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

    // Step 2b: Detect scoped package imports that should resolve to local workspace packages
    // This handles monorepo patterns where:
    // - Source code imports from '@excalidraw/excalidraw/analytics'
    // - The actual source exists at 'assets/packages/excalidraw/analytics.ts'
    // - The npm package '@excalidraw/excalidraw' doesn't export these internal subpaths
    // In this case, we need to alias '@excalidraw/excalidraw' -> local workspace path
    if (sourceFiles && bareImports) {
        // Find all scoped package imports
        const scopedImports = Array.from(bareImports).filter((imp) =>
            imp.startsWith('@'),
        );

        for (const scopedPkg of scopedImports) {
            if (existingAliases.has(scopedPkg)) continue;

            // Extract the unscoped name: @excalidraw/excalidraw -> excalidraw
            const parts = scopedPkg.split('/');
            if (parts.length !== 2) continue;
            const unscopedName = parts[1];

            // Check if we have a workspace package with the same unscoped name
            const matchingWorkspace = workspacePackages.find(
                (wp) => wp.name === unscopedName,
            );
            if (!matchingWorkspace) continue;

            // Check if the scoped package is declared as a dependency
            // (it may not be installed yet when prepareRebuild runs)
            const isDeclaredDep = declaredDeps.has(scopedPkg);

            // If the scoped package is a declared dependency AND we have a matching
            // local workspace package, alias the scoped name to the local path.
            // This handles monorepo scenarios where the source was extracted from
            // the same codebase that publishes the npm package, and the npm package
            // doesn't export internal subpaths that the source code uses.
            if (isDeclaredDep) {
                const localPath = matchingWorkspace.path;
                const absoluteLocalPath = join(projectDir, localPath);

                if (await pathExists(absoluteLocalPath)) {
                    // Prefer src/ subdirectory if it exists (common monorepo pattern)
                    // This handles both packages with index files and packages with
                    // individual module files like utils/src/export.ts
                    const srcPath = `${localPath}/src`;
                    const absoluteSrcPath = join(projectDir, srcPath);
                    const srcExists = await pathExists(absoluteSrcPath);

                    const finalPath = srcExists ? srcPath : localPath;
                    aliases.push({ alias: scopedPkg, path: finalPath });
                    existingAliases.add(scopedPkg);
                }
            }
        }
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

    // Step 4: Infer aliases from import/file path matching
    // This handles cases where imports like 'excalidraw-app/app-jotai' exist
    // but the file is actually at 'assets/app-jotai.ts', meaning
    // 'excalidraw-app' should alias to 'assets'.
    if (sourceFiles && sourceFiles.length > 0) {
        const inferredAliases = inferAliasesFromImports(
            sourceFiles,
            existingAliases,
        );

        for (const inferred of inferredAliases) {
            if (existingAliases.has(inferred.alias)) continue;

            // Only add high/medium confidence aliases
            if (inferred.confidence === 'low') continue;

            aliases.push({
                alias: inferred.alias,
                path: inferred.targetPath,
            });
            existingAliases.add(inferred.alias);
        }
    }

    return aliases;
}

/**
 * Resolves the actual location of a subpath export within a package.
 *
 * Checks src/, root, and file variants (.ts, .tsx, .js, .jsx).
 *
 * @param absolutePackagePath - Absolute path to the package directory
 * @param relativePackagePath - Relative path from project root
 * @param subpath - Subpath name to resolve
 * @returns Relative path to the subpath, or null if not found
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
 * Writes vite.config.ts to the project directory.
 *
 * Generates the configuration file and writes it to disk. Skips writing
 * if the file already exists (unless overwrite=true).
 *
 * @param projectDir - Project root directory
 * @param options - Vite configuration options
 * @param overwrite - Whether to overwrite existing file (default: false)
 * @returns True if file was written, false if skipped
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
