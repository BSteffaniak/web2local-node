/**
 * Rebuild system orchestrator
 *
 * Coordinates the detection, configuration, and building of reconstructed source code
 */

import { join } from 'path';
import { stat, writeFile, readFile } from 'fs/promises';
import type {
    PrepareRebuildOptions,
    PrepareResult,
    BuildOptions,
    BuildResult,
    ProjectConfig,
} from './types.js';

import type { ExtractedSource } from '@web2local/types';

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

import {
    enhancePackageJson,
    fixUnknownVersionsDetailed,
} from './package-enhancer.js';

import { runBuild, hasBuildOutput } from './build-runner.js';

import {
    injectGlobalCss,
    needsGlobalCssInjection,
    type GlobalCssInjectionResult,
} from './global-css-injector.js';

import { generateClassNameMapFile } from './css-class-mapper.js';

import type { CapturedCssBundle } from '@web2local/stubs';

import {
    reconstructAllIndexes,
    generateAliasTargetIndexFiles,
} from '@web2local/analyzer';

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
    generateEnvExample,
} from './vite-config-generator.js';
export {
    generateHtml,
    extractHtmlMetadata,
    isServerRenderedHtml,
    extractOriginalBundles,
    buildAssetMapping,
    preserveServerRenderedHtml,
    preserveHtmlIfServerRendered,
} from './html-generator.js';
export { enhancePackageJson, addDependency } from './package-enhancer.js';
export {
    runBuild,
    installDependencies,
    parseBuildErrors,
} from './build-runner.js';
export {
    injectGlobalCss,
    needsGlobalCssInjection,
    generateCapturedStylesContent,
    injectCssImport,
} from './global-css-injector.js';

/**
 * Analyzes a project directory and returns its configuration.
 *
 * Detects entry points, framework, path aliases, environment variables,
 * TypeScript usage, SASS/CSS modules, and bundle directories.
 *
 * @param projectDir - Project root directory containing package.json
 * @param sourceFiles - Optional source files for accurate alias detection.
 *                      When provided, enables detection of import aliases like
 *                      'sarsaparilla' -> '@fp/sarsaparilla' by analyzing actual imports.
 * @returns The detected project configuration including entry points, framework, and aliases
 */
export async function analyzeProject(
    projectDir: string,
    sourceFiles?: ExtractedSource[],
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
 * Gets bundle directories in the project.
 *
 * Scans the project root for directories that may contain source bundles,
 * excluding node_modules, hidden directories, and build output directories.
 *
 * @param projectDir - Project root directory to scan
 * @returns Array of bundle directory names relative to project root
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
 * Checks if the project uses TypeScript.
 *
 * @param projectDir - Project root directory
 * @returns True if tsconfig.json exists in the project root
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
 * Reads server manifest and performs global CSS injection if needed.
 *
 * The server manifest is populated during capture with info about
 * unmatched CSS stubs and unused bundles. This function checks if
 * injection is needed and performs it.
 *
 * @param projectDir - Project root directory
 * @param entryPoints - Detected entry points in the project
 * @param onProgress - Optional callback for progress updates
 * @returns Result of the CSS injection operation
 */
async function checkAndInjectGlobalCss(
    projectDir: string,
    entryPoints: import('./types.js').EntryPoint[],
    onProgress?: (message: string) => void,
): Promise<GlobalCssInjectionResult> {
    const manifestPath = join(projectDir, '_server', 'manifest.json');

    try {
        const manifestContent = await readFile(manifestPath, 'utf-8');
        const manifest = JSON.parse(manifestContent);

        // Check if manifest has the CSS info we need
        const unmatchedStubs: string[] = manifest.unmatchedCssStubs || [];
        const unusedBundleInfo: Array<{
            url: string;
            localPath: string;
            filename: string;
            baseName: string;
        }> = manifest.unusedCssBundles || [];

        // Convert bundle info back to CapturedCssBundle format (need to read content)
        const unusedBundles: CapturedCssBundle[] = [];
        for (const info of unusedBundleInfo) {
            try {
                const bundlePath = join(
                    projectDir,
                    '_server',
                    'static',
                    info.localPath,
                );
                const content = await readFile(bundlePath, 'utf-8');
                unusedBundles.push({
                    ...info,
                    content,
                });
            } catch {
                // Bundle file not found, skip
            }
        }

        // Check if injection is needed
        if (!needsGlobalCssInjection(unmatchedStubs, unusedBundles)) {
            return {
                injected: false,
                includedBundles: [],
                errors: [],
            };
        }

        onProgress?.(
            `Found ${unmatchedStubs.length} unmatched CSS stubs, ${unusedBundles.length} unused bundles`,
        );

        // Perform the injection
        return await injectGlobalCss({
            projectDir,
            unusedBundles,
            entryPoints,
            onProgress,
        });
    } catch {
        // No manifest or no CSS info - no injection needed
        return {
            injected: false,
            includedBundles: [],
            errors: [],
        };
    }
}

/**
 * Prepares a project for rebuilding.
 *
 * Generates all necessary configuration files:
 * - vite.config.ts - Vite build configuration
 * - index.html - Entry HTML for Vite
 * - .env.example - Environment variable template (if env vars detected)
 * - Updates package.json with build dependencies
 * - Reconstructs module index files
 * - Generates CSS class name mappings
 * - Injects global CSS if needed
 *
 * @param options - Configuration options for the rebuild preparation
 * @returns Result object containing success status, generated files, and any warnings/errors
 */
export async function prepareRebuild(
    options: PrepareRebuildOptions,
): Promise<PrepareResult> {
    const {
        projectDir,
        overwrite = false,
        verbose = false,
        onProgress,
        onVerbose,
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

    // Reconstruct index files for internal modules using SWC-based analysis
    // This analyzes what symbols consuming files expect from each module,
    // finds where those symbols are defined, and generates proper re-exports.
    // NOTE: We also pass aliases so that aliased imports (like @excalidraw/common)
    // are tracked and their target index files get reconstructed.
    onProgress?.('Reconstructing module index files...');
    try {
        const reconstructionResult = await reconstructAllIndexes({
            projectDir,
            sourceFiles: sourceFiles ?? [],
            aliases: config.aliases,
            onProgress: verbose ? onProgress : undefined,
            onWarning: (msg: string) => warnings.push(msg),
        });

        // Track generated files
        for (const idx of reconstructionResult.reconstructedIndexes) {
            generatedFiles.push(idx.modulePath + '/index.ts');
        }

        if (verbose && reconstructionResult.totalUnresolved > 0) {
            onProgress?.(
                `Warning: ${reconstructionResult.totalUnresolved} exports could not be resolved`,
            );
        }
    } catch (error) {
        warnings.push(`Failed to reconstruct index files: ${error}`);
    }

    // Generate index files for alias target directories that don't have one
    // This handles cases like @excalidraw/utils -> ./assets/packages/utils/src
    // where the directory has module files but no index.ts for bare imports
    onProgress?.('Generating alias target index files...');
    try {
        const aliasIndexFiles = await generateAliasTargetIndexFiles(
            projectDir,
            config.aliases,
            verbose ? onProgress : undefined,
        );
        generatedFiles.push(...aliasIndexFiles);
    } catch (error) {
        warnings.push(`Failed to generate alias target index files: ${error}`);
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

        // Fix unknown versions - check npm existence before converting '*' to 'latest'
        const { fixed, movedToInternal } =
            await fixUnknownVersionsDetailed(packageJsonPath);
        if (fixed.length > 0 && verbose) {
            onProgress?.(`Fixed unknown versions for: ${fixed.join(', ')}`);
        }
        if (movedToInternal.length > 0) {
            onProgress?.(
                `Detected internal packages (not on npm): ${movedToInternal.join(', ')}`,
            );
        }
    } catch (error) {
        errors.push(`Failed to update package.json: ${error}`);
    }

    // Check for global CSS injection (when CSS source maps weren't available)
    onProgress?.('Checking for global CSS injection...');
    try {
        const cssInjectionResult = await checkAndInjectGlobalCss(
            projectDir,
            config.entryPoints,
            verbose ? onProgress : undefined,
        );

        if (cssInjectionResult.injected) {
            generatedFiles.push('_captured-styles.css');
            if (verbose) {
                onProgress?.(
                    `Injected global CSS with ${cssInjectionResult.includedBundles.length} bundle(s)`,
                );
            }
        }

        if (cssInjectionResult.errors.length > 0) {
            warnings.push(...cssInjectionResult.errors);
        }
    } catch (error) {
        warnings.push(`Failed to check global CSS injection: ${error}`);
    }

    // Generate CSS class name mapping (for CSS module hash resolution)
    onProgress?.('Generating CSS class name mappings...');
    try {
        const classNameMap = await generateClassNameMapFile(
            projectDir,
            onVerbose,
        );
        if (classNameMap) {
            generatedFiles.push('_class-name-map.json');
            const totalMappings = Object.keys(classNameMap.mappings).length;
            if (verbose) {
                onProgress?.(
                    `Generated class name map with ${totalMappings} mappings`,
                );
            }
        }
    } catch (error) {
        warnings.push(`Failed to generate class name map: ${error}`);
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
 * Prepares and builds a project.
 *
 * This is the main entry point for the rebuild system. It first prepares
 * the project (generating config files, updating package.json), then
 * runs the actual build process.
 *
 * @param options - Configuration options for the build
 * @returns Result object containing success status, output directory, bundle list, and any warnings/errors
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
        sourceFiles: options.sourceFiles,
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
 * Checks if a project is ready for rebuilding.
 *
 * Verifies that all required configuration files exist (package.json,
 * vite.config.ts, index.html).
 *
 * @param projectDir - Project root directory to check
 * @returns Object containing ready status and list of missing files
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
 * Gets the rebuild status for a project.
 *
 * Returns information about whether the project is prepared for building,
 * whether a build output exists, and how many entry points were detected.
 *
 * @param projectDir - Project root directory to check
 * @returns Status object with prepared state, built state, and entry point count
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
