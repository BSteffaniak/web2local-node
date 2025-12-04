/**
 * Rebuild system orchestrator
 *
 * Coordinates the detection, configuration, and building of reconstructed source code
 */

import { join } from 'path';
import { stat, writeFile } from 'fs/promises';
import type {
    PrepareRebuildOptions,
    PrepareResult,
    BuildOptions,
    BuildResult,
    ProjectConfig,
    SourceFile,
} from './types.js';

import {
    detectEntryPoints,
    detectEnvVariables,
    detectPrimaryFramework,
    usesSass,
    usesCssModules,
} from './entry-point-detector.js';

import {
    extractAliasesFromTsConfig,
    writeViteConfig,
    generateEnvExample,
} from './vite-config-generator.js';

import { writeHtml } from './html-generator.js';

import { enhancePackageJson, fixUnknownVersions } from './package-enhancer.js';

import { runBuild, hasBuildOutput } from './build-runner.js';

// Re-export types
export * from './types.js';

// Re-export utilities
export {
    detectEntryPoints,
    detectEnvVariables,
} from './entry-point-detector.js';
export {
    extractAliasesFromTsConfig,
    generateViteConfig,
} from './vite-config-generator.js';
export { generateHtml, extractHtmlMetadata } from './html-generator.js';
export { enhancePackageJson, addDependency } from './package-enhancer.js';
export {
    runBuild,
    installDependencies,
    parseBuildErrors,
} from './build-runner.js';

/**
 * Analyze a project and return its configuration
 *
 * @param projectDir - Project root directory
 * @param sourceFiles - Optional source files for accurate alias detection.
 *                      When provided, enables detection of import aliases like
 *                      'sarsaparilla' -> '@fp/sarsaparilla' by analyzing actual imports.
 */
export async function analyzeProject(
    projectDir: string,
    sourceFiles?: SourceFile[],
): Promise<ProjectConfig> {
    // Detect entry points
    const entryPoints = await detectEntryPoints(projectDir);

    // Detect framework
    const framework = await detectPrimaryFramework(projectDir);

    // Extract aliases from tsconfig and source files
    const aliases = await extractAliasesFromTsConfig(projectDir, sourceFiles);

    // Detect environment variables
    const envVariables = await detectEnvVariables(projectDir);

    // Detect SASS/CSS modules usage
    const hasSass = await usesSass(projectDir);
    const hasCssModules = await usesCssModules(projectDir);

    // Get bundle directories
    const bundleDirs = await getBundleDirectories(projectDir);

    // Check for TypeScript
    const usesTypeScript = await hasTypeScript(projectDir);

    return {
        rootDir: projectDir,
        entryPoints,
        framework,
        aliases,
        envVariables,
        usesTypeScript,
        usesSass: hasSass,
        usesCssModules: hasCssModules,
        bundleDirs,
    };
}

/**
 * Get bundle directories in the project
 */
async function getBundleDirectories(projectDir: string): Promise<string[]> {
    const bundleDirs: string[] = [];

    try {
        const { readdir } = await import('fs/promises');
        const entries = await readdir(projectDir, { withFileTypes: true });

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;

            // Skip special directories
            if (
                entry.name === 'node_modules' ||
                entry.name.startsWith('.') ||
                entry.name.startsWith('_') ||
                entry.name === 'dist' ||
                entry.name === 'build'
            ) {
                continue;
            }

            bundleDirs.push(entry.name);
        }
    } catch {
        // Ignore errors
    }

    return bundleDirs;
}

/**
 * Check if project uses TypeScript
 */
async function hasTypeScript(projectDir: string): Promise<boolean> {
    try {
        await stat(join(projectDir, 'tsconfig.json'));
        return true;
    } catch {
        return false;
    }
}

/**
 * Prepare a project for rebuilding
 *
 * This generates all necessary configuration files:
 * - vite.config.ts
 * - index.html
 * - Updates package.json with build dependencies
 */
export async function prepareRebuild(
    options: PrepareRebuildOptions,
): Promise<PrepareResult> {
    const {
        projectDir,
        overwrite = false,
        verbose = false,
        onProgress,
        sourceFiles,
    } = options;

    const generatedFiles: string[] = [];
    const warnings: string[] = [];
    const errors: string[] = [];

    onProgress?.('Analyzing project...');

    // Analyze the project (pass source files for accurate alias detection)
    let config: ProjectConfig;
    try {
        config = await analyzeProject(projectDir, sourceFiles);
    } catch (error) {
        return {
            success: false,
            entryPoints: [],
            generatedFiles: [],
            envVariables: [],
            warnings: [],
            errors: [`Failed to analyze project: ${error}`],
        };
    }

    if (verbose) {
        onProgress?.(`Detected framework: ${config.framework}`);
        onProgress?.(`Found ${config.entryPoints.length} entry point(s)`);
        onProgress?.(`Found ${config.aliases.length} alias(es)`);
        onProgress?.(
            `Found ${config.envVariables.length} environment variable(s)`,
        );
    }

    // Check for entry points
    if (config.entryPoints.length === 0) {
        errors.push('No entry points detected. Cannot prepare for rebuild.');
        return {
            success: false,
            entryPoints: [],
            generatedFiles: [],
            envVariables: config.envVariables,
            warnings,
            errors,
        };
    }

    // Generate vite.config.ts
    onProgress?.('Generating vite.config.ts...');
    try {
        const written = await writeViteConfig(
            projectDir,
            {
                entryPoints: config.entryPoints,
                aliases: config.aliases,
                envVariables: config.envVariables,
                framework: config.framework,
                outDir: '_rebuilt',
                sourcemap: true,
            },
            overwrite,
        );

        if (written) {
            generatedFiles.push('vite.config.ts');
        } else if (!overwrite) {
            warnings.push('vite.config.ts already exists, skipping');
        }
    } catch (error) {
        errors.push(`Failed to generate vite.config.ts: ${error}`);
    }

    // Generate index.html
    onProgress?.('Generating index.html...');
    try {
        const written = await writeHtml(
            projectDir,
            config.entryPoints,
            undefined,
            overwrite,
        );

        if (written) {
            generatedFiles.push('index.html');
        } else if (!overwrite) {
            warnings.push('index.html already exists, skipping');
        }
    } catch (error) {
        errors.push(`Failed to generate index.html: ${error}`);
    }

    // Generate .env.example if there are environment variables
    if (config.envVariables.length > 0) {
        onProgress?.('Generating .env.example...');
        try {
            const envExampleContent = generateEnvExample(config.envVariables);
            const envExamplePath = join(projectDir, '.env.example');
            await writeFile(envExamplePath, envExampleContent, 'utf-8');
            generatedFiles.push('.env.example');
        } catch (error) {
            warnings.push(`Failed to generate .env.example: ${error}`);
        }
    }

    // Update package.json
    onProgress?.('Updating package.json...');
    try {
        const packageJsonPath = join(projectDir, 'package.json');
        const { added } = await enhancePackageJson({
            packageJsonPath,
            framework: config.framework,
            usesSass: config.usesSass,
        });

        if (added.length > 0) {
            if (verbose) {
                onProgress?.(`Added dev dependencies: ${added.join(', ')}`);
            }
        }

        // Fix unknown versions
        const fixed = await fixUnknownVersions(packageJsonPath);
        if (fixed.length > 0 && verbose) {
            onProgress?.(`Fixed unknown versions for: ${fixed.join(', ')}`);
        }
    } catch (error) {
        errors.push(`Failed to update package.json: ${error}`);
    }

    const success = errors.length === 0;

    if (success) {
        onProgress?.('Rebuild preparation complete!');
    } else {
        onProgress?.(`Preparation completed with ${errors.length} error(s)`);
    }

    return {
        success,
        entryPoints: config.entryPoints,
        generatedFiles,
        envVariables: config.envVariables,
        warnings,
        errors,
    };
}

/**
 * Prepare and build a project
 *
 * This is the main entry point for the rebuild system
 */
export async function rebuild(options: BuildOptions): Promise<BuildResult> {
    const { projectDir, onProgress, verbose } = options;

    // First, prepare the project
    onProgress?.('Preparing project for rebuild...');
    const prepareResult = await prepareRebuild({
        projectDir,
        overwrite: true, // Always overwrite when rebuilding
        verbose,
        onProgress,
    });

    if (!prepareResult.success) {
        return {
            success: false,
            outputDir: join(projectDir, '_rebuilt'),
            durationMs: 0,
            bundles: [],
            recoveryAttempts: 0,
            warnings: prepareResult.warnings,
            errors: prepareResult.errors,
        };
    }

    // Run the build
    return runBuild(options);
}

/**
 * Check if a project is ready for rebuilding
 */
export async function isReadyForRebuild(projectDir: string): Promise<{
    ready: boolean;
    missing: string[];
}> {
    const missing: string[] = [];

    // Check for required files
    const requiredFiles = ['package.json', 'vite.config.ts', 'index.html'];

    for (const file of requiredFiles) {
        try {
            await stat(join(projectDir, file));
        } catch {
            missing.push(file);
        }
    }

    return {
        ready: missing.length === 0,
        missing,
    };
}

/**
 * Get rebuild status for a project
 */
export async function getRebuildStatus(projectDir: string): Promise<{
    prepared: boolean;
    built: boolean;
    entryPoints: number;
}> {
    const { ready } = await isReadyForRebuild(projectDir);
    const built = await hasBuildOutput(projectDir);
    const entryPoints = (await detectEntryPoints(projectDir)).length;

    return {
        prepared: ready,
        built,
        entryPoints,
    };
}
