/**
 * Package.json enhancer
 *
 * Adds build dependencies and scripts to package.json for rebuilding
 */

import { readFile, writeFile } from 'fs/promises';
import type { Framework, PackageEnhanceOptions } from './types.js';
import { getFrameworkPluginPackage } from './vite-config-generator.js';

/**
 * Get build scripts for the project
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
 * Read and parse package.json
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
 * Enhance package.json with build dependencies
 *
 * Only adds build tools that are actually needed:
 * - Vite: Always needed for rebuild
 * - TypeScript: Only if .ts/.tsx files exist (detected via hasTypeScript option)
 * - Sass: Only if .scss/.sass files exist (detected via usesSass option)
 * - Framework plugin: Based on detected framework
 *
 * All versions use 'latest' to avoid hardcoding potentially stale versions.
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
 * Check if package.json already has build dependencies
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
 * Get missing dependencies that need to be installed
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
 * Add a dependency to package.json
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
 * Remove the '*' version placeholder for unknown packages
 * and replace with 'latest' for npm install compatibility
 */
export async function fixUnknownVersions(
    packageJsonPath: string,
): Promise<string[]> {
    const pkg = await readPackageJson(packageJsonPath);
    const fixed: string[] = [];

    for (const key of ['dependencies', 'devDependencies'] as const) {
        const deps = pkg[key] as Record<string, string> | undefined;
        if (!deps) continue;

        for (const [name, version] of Object.entries(deps)) {
            if (version === '*') {
                deps[name] = 'latest';
                fixed.push(name);
            }
        }
    }

    if (fixed.length > 0) {
        await writeFile(
            packageJsonPath,
            JSON.stringify(pkg, null, 2) + '\n',
            'utf-8',
        );
    }

    return fixed;
}
