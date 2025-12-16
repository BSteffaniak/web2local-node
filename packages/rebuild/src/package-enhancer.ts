/**
 * Package.json enhancer
 *
 * Adds build dependencies and scripts to package.json for rebuilding
 */

import { readFile, writeFile } from 'fs/promises';
import type { Framework, PackageEnhanceOptions } from './types.js';
import { getFrameworkPluginPackage } from './vite-config-generator.js';
import { isPublicNpmPackage } from '@web2local/analyzer';

/**
 * Gets build scripts for the project.
 *
 * Returns standard Vite build scripts for dev, build, preview, and typecheck.
 *
 * @returns Record of script names to their commands
 */
function getBuildScripts(): Record<string, string> {
    return {
        dev: 'vite',
        build: 'vite build',
        preview: 'vite preview',
        typecheck: 'tsc --noEmit',
    };
}

/**
 * Reads and parses package.json.
 *
 * Returns a minimal package.json structure if the file doesn't exist
 * or cannot be parsed.
 *
 * @param packageJsonPath - Path to the package.json file
 * @returns Parsed package.json contents
 */
async function readPackageJson(
    packageJsonPath: string,
): Promise<Record<string, unknown>> {
    try {
        const content = await readFile(packageJsonPath, 'utf-8');
        return JSON.parse(content);
    } catch {
        // Return minimal package.json if it doesn't exist
        return {
            name: 'rebuilt-app',
            version: '0.0.0',
            private: true,
        };
    }
}

/**
 * Enhances package.json with build dependencies.
 *
 * Only adds build tools that are actually needed:
 * - Vite: Always needed for rebuild
 * - TypeScript: Only if .ts/.tsx files exist (detected via hasTypeScript option)
 * - Sass: Only if .scss/.sass files exist (detected via usesSass option)
 * - Framework plugin: Based on detected framework
 *
 * All versions use 'latest' to avoid hardcoding potentially stale versions.
 *
 * @param options - Enhancement options including path, framework, and feature flags
 * @returns Object with list of added dependencies and whether file was updated
 */
export async function enhancePackageJson(
    options: PackageEnhanceOptions,
): Promise<{ added: string[]; updated: boolean }> {
    const {
        packageJsonPath,
        framework,
        usesSass,
        additionalDevDeps,
        hasTypeScript = true,
    } = options;

    const pkg = await readPackageJson(packageJsonPath);
    const added: string[] = [];

    // Ensure devDependencies exists
    if (!pkg.devDependencies) {
        pkg.devDependencies = {};
    }
    const devDeps = pkg.devDependencies as Record<string, string>;

    // Add Vite - always needed for rebuild
    if (!devDeps['vite']) {
        devDeps['vite'] = 'latest';
        added.push('vite');
    }

    // Add TypeScript only if TypeScript files were detected
    const deps = (pkg.dependencies || {}) as Record<string, string>;
    if (hasTypeScript && !devDeps['typescript'] && !deps['typescript']) {
        devDeps['typescript'] = 'latest';
        added.push('typescript');
    }

    // Add framework-specific Vite plugin
    const pluginPkg = getFrameworkPluginPackage(framework);
    if (pluginPkg && !devDeps[pluginPkg]) {
        devDeps[pluginPkg] = 'latest';
        added.push(pluginPkg);
    }

    // Add SASS only if SASS/SCSS files were detected
    if (usesSass && !devDeps['sass']) {
        devDeps['sass'] = 'latest';
        added.push('sass');
    }

    // Add additional dev dependencies
    if (additionalDevDeps) {
        for (const [name, version] of Object.entries(additionalDevDeps)) {
            if (!devDeps[name]) {
                devDeps[name] = version;
                added.push(name);
            }
        }
    }

    // Add/update scripts
    if (!pkg.scripts) {
        pkg.scripts = {};
    }
    const scripts = pkg.scripts as Record<string, string>;
    const buildScripts = getBuildScripts();

    for (const [name, command] of Object.entries(buildScripts)) {
        // Don't overwrite existing scripts except 'build' if it's just 'tsc'
        if (!scripts[name] || (name === 'build' && scripts[name] === 'tsc')) {
            scripts[name] = command;
        }
    }

    // Ensure type: module for ESM
    if (!pkg.type) {
        pkg.type = 'module';
    }

    // Sort dependencies alphabetically
    if (
        pkg.dependencies &&
        Object.keys(pkg.dependencies as object).length > 0
    ) {
        pkg.dependencies = Object.fromEntries(
            Object.entries(pkg.dependencies as Record<string, string>).sort(
                ([a], [b]) => a.localeCompare(b),
            ),
        );
    }

    // Sort devDependencies alphabetically
    pkg.devDependencies = Object.fromEntries(
        Object.entries(devDeps).sort(([a], [b]) => a.localeCompare(b)),
    );

    // Write back
    await writeFile(
        packageJsonPath,
        JSON.stringify(pkg, null, 2) + '\n',
        'utf-8',
    );

    return { added, updated: added.length > 0 };
}

/**
 * Checks if package.json already has build dependencies.
 *
 * @param packageJsonPath - Path to the package.json file
 * @returns True if Vite is already in devDependencies
 */
export async function hasBuildDependencies(
    packageJsonPath: string,
): Promise<boolean> {
    try {
        const pkg = await readPackageJson(packageJsonPath);
        const devDeps = (pkg.devDependencies || {}) as Record<string, string>;
        return 'vite' in devDeps;
    } catch {
        return false;
    }
}

/**
 * Gets missing dependencies that need to be installed.
 *
 * Checks for required build tools (Vite, TypeScript, framework plugin, Sass)
 * and returns any that are not yet in the package.json.
 *
 * @param packageJsonPath - Path to the package.json file
 * @param framework - The detected framework
 * @param usesSass - Whether the project uses SASS/SCSS
 * @returns Array of missing dependency package names
 */
export async function getMissingDependencies(
    packageJsonPath: string,
    framework: Framework,
    usesSass: boolean,
): Promise<string[]> {
    const missing: string[] = [];
    const pkg = await readPackageJson(packageJsonPath);
    const devDeps = (pkg.devDependencies || {}) as Record<string, string>;
    const deps = (pkg.dependencies || {}) as Record<string, string>;

    // Check for Vite
    if (!devDeps['vite']) {
        missing.push('vite');
    }

    // Check for TypeScript
    if (!devDeps['typescript'] && !deps['typescript']) {
        missing.push('typescript');
    }

    // Check for framework plugin
    const pluginPkg = getFrameworkPluginPackage(framework);
    if (pluginPkg && !devDeps[pluginPkg]) {
        missing.push(pluginPkg);
    }

    // Check for SASS
    if (usesSass && !devDeps['sass']) {
        missing.push('sass');
    }

    return missing;
}

/**
 * Adds a dependency to package.json.
 *
 * Adds the specified package to either dependencies or devDependencies
 * and sorts the section alphabetically.
 *
 * @param packageJsonPath - Path to the package.json file
 * @param name - Package name to add
 * @param version - Version specifier (e.g., "latest", "^1.0.0")
 * @param isDev - Whether to add as devDependency (default: true)
 */
export async function addDependency(
    packageJsonPath: string,
    name: string,
    version: string,
    isDev: boolean = true,
): Promise<void> {
    const pkg = await readPackageJson(packageJsonPath);

    const targetKey = isDev ? 'devDependencies' : 'dependencies';
    if (!pkg[targetKey]) {
        pkg[targetKey] = {};
    }

    (pkg[targetKey] as Record<string, string>)[name] = version;

    // Sort dependencies
    pkg[targetKey] = Object.fromEntries(
        Object.entries(pkg[targetKey] as Record<string, string>).sort(
            ([a], [b]) => a.localeCompare(b),
        ),
    );

    await writeFile(
        packageJsonPath,
        JSON.stringify(pkg, null, 2) + '\n',
        'utf-8',
    );
}

/**
 * Result of fixing unknown versions
 */
export interface FixUnknownVersionsResult {
    /** Packages that were converted to 'latest' (exist on npm) */
    fixed: string[];
    /** Packages that were moved to _internalDependencies (don't exist on npm) */
    movedToInternal: string[];
}

/**
 * Removes the '*' version placeholder for unknown packages.
 *
 * For each package with '*' version:
 * - If it exists on npm: replace with 'latest'
 * - If it doesn't exist on npm: move to _internalDependencies with 'workspace:*'
 *
 * This prevents pnpm install from failing on internal packages that don't exist on npm.
 *
 * @param packageJsonPath - Path to the package.json file
 * @returns Array of package names that were converted to 'latest'
 */
export async function fixUnknownVersions(
    packageJsonPath: string,
): Promise<string[]> {
    const result = await fixUnknownVersionsDetailed(packageJsonPath);
    return result.fixed;
}

/**
 * Detailed version of fixUnknownVersions that returns both fixed and moved-to-internal packages.
 *
 * Checks npm registry for each package with '*' version and either
 * converts to 'latest' or moves to _internalDependencies.
 *
 * @param packageJsonPath - Path to the package.json file
 * @returns Object with arrays of fixed packages and packages moved to internal
 */
export async function fixUnknownVersionsDetailed(
    packageJsonPath: string,
): Promise<FixUnknownVersionsResult> {
    const pkg = await readPackageJson(packageJsonPath);
    const fixed: string[] = [];
    const movedToInternal: string[] = [];

    // Collect all packages with '*' version
    const packagesToCheck: Array<{
        key: 'dependencies' | 'devDependencies';
        name: string;
    }> = [];

    for (const key of ['dependencies', 'devDependencies'] as const) {
        const deps = pkg[key] as Record<string, string> | undefined;
        if (!deps) continue;

        for (const [name, version] of Object.entries(deps)) {
            if (version === '*') {
                packagesToCheck.push({ key, name });
            }
        }
    }

    if (packagesToCheck.length === 0) {
        return { fixed: [], movedToInternal: [] };
    }

    // Check npm existence in parallel
    const npmChecks = await Promise.all(
        packagesToCheck.map(async ({ key, name }) => ({
            key,
            name,
            existsOnNpm: await isPublicNpmPackage(name),
        })),
    );

    // Process results
    for (const { key, name, existsOnNpm } of npmChecks) {
        const deps = pkg[key] as Record<string, string>;

        if (existsOnNpm) {
            // Package exists on npm - use 'latest'
            deps[name] = 'latest';
            fixed.push(name);
        } else {
            // Package doesn't exist on npm - move to _internalDependencies
            delete deps[name];

            // Initialize _internalDependencies if needed
            if (!pkg._internalDependencies) {
                pkg._internalDependencies = {};
            }
            (pkg._internalDependencies as Record<string, string>)[name] =
                'workspace:*';
            movedToInternal.push(name);
        }
    }

    // Clean up empty dependency objects
    for (const key of ['dependencies', 'devDependencies'] as const) {
        const deps = pkg[key] as Record<string, string> | undefined;
        if (deps && Object.keys(deps).length === 0) {
            delete pkg[key];
        }
    }

    if (fixed.length > 0 || movedToInternal.length > 0) {
        await writeFile(
            packageJsonPath,
            JSON.stringify(pkg, null, 2) + '\n',
            'utf-8',
        );
    }

    return { fixed, movedToInternal };
}
