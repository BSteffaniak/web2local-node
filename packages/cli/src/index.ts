/**
 * Main entry point and orchestration logic for the web2local CLI.
 *
 * This module coordinates the entire extraction pipeline:
 * - Fetching web pages and discovering JavaScript/CSS bundles
 * - Finding and extracting source maps
 * - Analyzing dependencies and generating package.json
 * - Capturing API calls via browser automation
 * - Rebuilding the project from extracted sources
 */

import chalk from 'chalk';
import ora from 'ora';
import { parseArgs } from './cli.js';
import { SpinnerRegistry } from './spinner-registry.js';
import {
    ProgressDisplay,
    createCaptureProgressHandler,
    createVerboseHandler,
} from './progress/index.js';
import { resolveOutputDir, checkOutputDirectory } from './output-dir.js';

/**
 * CLI options for server-related commands.
 */
interface ServerCliOptions {
    /** Server port number. */
    port?: number;
    /** Server host address. */
    host?: string;
    /** Response delay in milliseconds. */
    delay?: number;
    /** Whether CORS is enabled. */
    cors?: boolean;
    /** Serve only static files, not API fixtures. */
    staticOnly?: boolean;
    /** Serve only API fixtures, not static files. */
    apiOnly?: boolean;
    /** Enable verbose logging. */
    verbose?: boolean;
    /** Serve from rebuilt source instead of captured files. */
    useRebuilt?: boolean;
}

/**
 * Generated package.json structure with custom fields.
 *
 * Extends the standard package.json structure with internal metadata
 * used during the extraction and rebuild process.
 */
interface GeneratedPackageJson {
    /** Standard npm dependencies. */
    dependencies?: Record<string, string>;
    /** Standard npm dev dependencies. */
    devDependencies?: Record<string, string>;
    /** Internal/workspace dependencies that are not published to npm. */
    _internalDependencies?: Record<string, string>;
    /** Import aliases from tsconfig paths. */
    _importAliases?: Record<string, string>;
}

/**
 * Extracts server options from parsed CLI options.
 *
 * @param cliOptions - The raw CLI options containing server configuration
 * @param outputDir - The output directory path for the captured site
 * @returns Server options object ready to pass to the server package
 */
function getServerOptions(cliOptions: ServerCliOptions, outputDir: string) {
    return {
        dir: outputDir,
        port: cliOptions.port ?? 3000,
        host: cliOptions.host || 'localhost',
        delay: cliOptions.delay,
        noCors: cliOptions.cors === false,
        staticOnly: cliOptions.staticOnly || false,
        apiOnly: cliOptions.apiOnly || false,
        verbose: cliOptions.verbose || false,
        useRebuilt: cliOptions.useRebuilt || false,
    };
}
import {
    extractBundleUrls,
    findAllSourceMaps,
    type BundleInfo,
    type BundleWithContent,
    type ScrapedRedirect,
} from '@web2local/scraper';
import { extractSourcesFromMap } from '@web2local/scraper';
import type { ExtractedSource } from '@web2local/types';
import {
    reconstructSources,
    writeManifest,
    getBundleName,
    saveBundles,
    generateBundleStubs,
    sanitizePath,
    type BundleManifest,
    type SavedBundle,
} from '@web2local/scraper';
import {
    generateDependencyManifest,
    writePackageJson,
    writeTsConfig,
    extractNodeModulesPackages,
    identifyInternalPackages,
} from '@web2local/analyzer';
import {
    generateStubFiles,
    generateScssVariableStubs,
    updateCssStubsWithCapturedBundles,
} from '@web2local/stubs';
import { type CapturedCssBundle, extractCssBaseName } from '@web2local/stubs';
import { initCache } from '@web2local/cache';
import { join, basename, relative, dirname } from 'path';
import { readFile, readdir, stat, copyFile, mkdir } from 'fs/promises';
import { captureWebsite, generateCaptureSummary } from '@web2local/capture';
import {
    rebuild as runRebuild,
    extractAliasesFromTsConfig,
} from '@web2local/rebuild';
import { FetchError } from '@web2local/http';
import { needsGlobalCssInjection } from '@web2local/rebuild';
import {
    resolveMissingDynamicImports,
    updateManifestWithResolvedFiles,
} from '@web2local/analyzer';
import { StateManager, PHASES, PHASE_STATUS } from '@web2local/state';
import { shouldTruncateCorruptedWal } from './output-dir.js';
import type { CliOptions } from './cli.js';

/**
 * Main entry point for the web2local CLI.
 *
 * Orchestrates the complete source extraction and reconstruction pipeline:
 * 1. Scrapes the target URL for JavaScript/CSS bundles
 * 2. Discovers and fetches source maps
 * 3. Extracts original source files from source maps
 * 4. Analyzes imports and generates package.json with detected dependencies
 * 5. Captures API calls via headless browser automation
 * 6. Rebuilds the project using the extracted sources
 *
 * Supports resuming interrupted operations via state management.
 *
 * @param options - CLI options parsed from command line arguments
 */
export async function runMain(options: CliOptions) {
    // Initialize spinner registry for synchronized logging
    const registry = new SpinnerRegistry();
    registry.setupSignalHandlers();

    // Track operation success for --serve flag
    let captureSuccess = false;
    let rebuildSuccess = false;

    // Initialize the fingerprint cache early (used by fingerprinting, peer dep inference, and source maps)
    // --force-refresh bypasses all caches, --no-cache also disables caching
    await initCache({
        cacheDir: options.cacheDir || undefined,
        disabled: options.noCache || options.forceRefresh,
    });

    // Extract hostname from URL and resolve output directory
    const hostname = new URL(options.url).hostname;
    const outputDir = resolveOutputDir(options.output, hostname);

    // Check if output directory exists and handle overwrite/resume logic
    const outputAction = await checkOutputDirectory(outputDir, {
        overwrite: options.overwrite,
        resume: options.resume,
    });

    if (outputAction === 'cancel') {
        process.exit(0);
    }

    const isResuming = outputAction === 'resume';

    // Initialize state manager for resume support
    const truncateWal = isResuming
        ? await shouldTruncateCorruptedWal(outputDir)
        : false;
    const state = await StateManager.create({
        outputDir,
        url: options.url,
        resume: isResuming,
        truncateCorruptedWal: truncateWal,
    });

    // Check if all phases were already complete at start (for skipping unnecessary work)
    const allPhasesCompleteAtStart =
        state.getPhaseStatus(PHASES.SCRAPE) === PHASE_STATUS.COMPLETED &&
        state.getPhaseStatus(PHASES.EXTRACT) === PHASE_STATUS.COMPLETED &&
        state.getPhaseStatus(PHASES.DEPENDENCIES) === PHASE_STATUS.COMPLETED &&
        state.getPhaseStatus(PHASES.CAPTURE) === PHASE_STATUS.COMPLETED &&
        state.getPhaseStatus(PHASES.REBUILD) === PHASE_STATUS.COMPLETED;

    console.log(chalk.bold.cyan('\n  web2local'));
    console.log(chalk.gray('  ' + '─'.repeat(12)));
    if (isResuming) {
        console.log(chalk.cyan(`  Resuming: ${state.getProgressString()}`));
    }
    console.log();

    // Step 1: Fetch the page and extract bundle URLs
    // Note: We need the actual bundle content for some operations (saveBundles),
    // so if scrape is complete but extract is not, we re-run scrape to get content.
    // This is a limitation of storing only metadata in state.
    const canSkipScrape =
        state.getPhaseStatus(PHASES.SCRAPE) === PHASE_STATUS.COMPLETED &&
        state.getPhaseStatus(PHASES.EXTRACT) === PHASE_STATUS.COMPLETED;

    let bundles: BundleInfo[];
    let bundlesWithMaps: BundleInfo[];
    let vendorBundles: Array<{
        url: string;
        filename: string;
        content: string;
        inferredPackage?: string;
    }>;
    let bundlesWithoutMaps: BundleWithContent[];
    let scrapedRedirect: ScrapedRedirect | undefined;
    let finalUrl: string;

    if (canSkipScrape) {
        // Resume from cached scrape results - we can skip entirely
        const scrapeResult = state.getScrapeResult()!;
        bundles = scrapeResult.bundles as BundleInfo[];
        bundlesWithMaps = scrapeResult.bundlesWithMaps as BundleInfo[];
        // For vendor bundles, we don't have content when resuming, but that's OK
        // since we're past the extract phase
        vendorBundles = scrapeResult.vendorBundles.map((v) => ({
            ...v,
            content: '', // Content not needed if extract is done
        }));
        // When resuming past extract, we don't need bundlesWithoutMaps content
        bundlesWithoutMaps = [];
        finalUrl = scrapeResult.finalUrl || options.url;
        console.log(
            chalk.gray(
                `  Resuming: Skipping scrape phase (${bundles.length} bundles cached)`,
            ),
        );
    } else {
        // Run scrape phase (or re-run if we need content)
        if (state.getPhaseStatus(PHASES.SCRAPE) !== PHASE_STATUS.COMPLETED) {
            await state.startPhase(PHASES.SCRAPE);
        }

        const spinner = ora({
            text: `Fetching ${options.url}...`,
            color: 'cyan',
        }).start();
        registry.register(spinner);

        try {
            const result = await extractBundleUrls(options.url);
            bundles = result.bundles;
            finalUrl = result.finalUrl;
            scrapedRedirect = result.redirect;

            let statusMsg = `Found ${chalk.bold(bundles.length)} bundles (JS/CSS files)`;
            if (scrapedRedirect) {
                statusMsg += chalk.gray(
                    ` (redirected: ${scrapedRedirect.from} -> ${scrapedRedirect.to})`,
                );
            }
            spinner.succeed(statusMsg);
        } catch (error) {
            await state.failPhase(PHASES.SCRAPE, String(error));
            if (error instanceof FetchError) {
                spinner.fail(error.format(options.verbose));
            } else {
                spinner.fail(`Failed to fetch page: ${error}`);
            }
            process.exit(1);
        }

        if (bundles.length === 0) {
            console.log(
                chalk.yellow(
                    '\nNo JavaScript or CSS bundles found on this page.',
                ),
            );
            await state.finalize();
            process.exit(0);
        }

        if (options.verbose) {
            if (scrapedRedirect) {
                console.log(
                    chalk.gray(
                        `\nRedirect detected: ${scrapedRedirect.from} -> ${scrapedRedirect.to} (${scrapedRedirect.status})`,
                    ),
                );
            }
            console.log(chalk.gray('\nBundles found:'));
            for (const bundle of bundles) {
                console.log(chalk.gray(`  - ${bundle.url}`));
            }
            console.log();
        }

        // Step 2: Find source maps for each bundle
        const mapSpinner = ora({
            text: 'Searching for source maps...',
            color: 'cyan',
        }).start();
        registry.register(mapSpinner);

        const sourceMapResult = await findAllSourceMaps(bundles, {
            concurrency: options.concurrency,
            onProgress: (completed, total) => {
                mapSpinner.text = `Checking bundles for source maps... (${completed}/${total})`;
            },
        });

        bundlesWithMaps = sourceMapResult.bundlesWithMaps;
        vendorBundles = sourceMapResult.vendorBundles;
        bundlesWithoutMaps = sourceMapResult.bundlesWithoutMaps;

        // Save scrape results to state (only metadata, not content)
        await state.setScrapeResult({
            bundles,
            bundlesWithMaps,
            vendorBundles: vendorBundles.map(
                ({ url, filename, inferredPackage }) => ({
                    url,
                    filename,
                    inferredPackage,
                }),
            ),
            bundlesWithoutMaps: bundlesWithoutMaps.map((bwc) => bwc.bundle),
            finalUrl,
        });

        if (bundlesWithMaps.length === 0) {
            if (bundlesWithoutMaps.length > 0) {
                mapSpinner.warn(
                    'No source maps found - will use minified bundles as fallback',
                );
            } else {
                mapSpinner.fail('No source maps found for any bundles');
                console.log(
                    chalk.yellow(
                        '\nThis site may not have publicly accessible source maps, or they may be using inline source maps.',
                    ),
                );
            }
        } else {
            let mapStatusMsg = `Found ${chalk.bold(bundlesWithMaps.length)} source maps`;
            if (vendorBundles.length > 0) {
                mapStatusMsg += chalk.gray(
                    ` + ${vendorBundles.length} vendor bundles`,
                );
            }
            mapSpinner.succeed(mapStatusMsg);
        }

        if (state.getPhaseStatus(PHASES.SCRAPE) !== PHASE_STATUS.COMPLETED) {
            await state.completePhase(PHASES.SCRAPE);
        }
    }

    let savedBundles: SavedBundle[] = [];

    // Always save bundles without source maps (best-effort fallback)
    // --save-bundles additionally saves bundles that DO have source maps
    if (bundlesWithoutMaps.length > 0) {
        const bundleSpinner = ora({
            text: 'Saving minified bundles...',
            color: 'cyan',
        }).start();
        registry.register(bundleSpinner);

        try {
            const result = await saveBundles(bundlesWithoutMaps, {
                outputDir,
            });
            savedBundles = result.saved;

            if (result.errors.length > 0) {
                bundleSpinner.warn(
                    `Saved ${result.saved.length} bundles with ${result.errors.length} errors`,
                );
                if (options.verbose) {
                    for (const error of result.errors) {
                        console.log(chalk.red(`    ${error}`));
                    }
                }
            } else {
                bundleSpinner.succeed(
                    `Saved ${chalk.bold(result.saved.length)} minified bundles to ${chalk.cyan('_bundles/')}`,
                );
            }

            if (options.verbose) {
                console.log(chalk.gray('\nBundles saved:'));
                for (const bundle of result.saved) {
                    const sizeStr = formatBytes(bundle.size);
                    console.log(
                        chalk.gray(`  - ${bundle.localPath} (${sizeStr})`),
                    );
                }
            }
        } catch (error) {
            bundleSpinner.fail(`Failed to save bundles: ${error}`);
        }
    }

    if (options.verbose && bundlesWithMaps.length > 0) {
        console.log(chalk.gray('\nSource maps found:'));
        for (const bundle of bundlesWithMaps) {
            console.log(chalk.gray(`  - ${bundle.sourceMapUrl}`));
        }
        if (vendorBundles.length > 0) {
            console.log(chalk.gray('\nVendor bundles (no source maps):'));
            for (const vb of vendorBundles) {
                const pkg = vb.inferredPackage
                    ? ` -> ${vb.inferredPackage}`
                    : '';
                console.log(chalk.gray(`  - ${vb.filename}${pkg}`));
            }
        }
        console.log();
    }

    // Step 3: Extract sources from each source map
    const manifestBundles: BundleManifest[] = [];
    let totalFilesWritten = 0;
    let totalFilesSkipped = 0;

    // Collect all source files for version extraction (includes node_modules files)
    const allExtractedFiles: ExtractedSource[] = [];

    // Store extraction results per bundle for later reconstruction
    const bundleExtractions: Array<{
        bundle: BundleInfo;
        bundleName: string;
        files: readonly ExtractedSource[];
        errors: readonly Error[];
    }> = [];

    // Phase 1: Extract all source maps (only if there are bundles with source maps)
    // Check if extract phase is already complete (for resume)
    const skipExtract =
        state.getPhaseStatus(PHASES.EXTRACT) === PHASE_STATUS.COMPLETED;

    if (skipExtract) {
        totalFilesWritten = state.getTotalFilesExtracted();
        console.log(
            chalk.gray(
                `  Resuming: Skipping extract phase (${totalFilesWritten} files already extracted)`,
            ),
        );

        // Only scan files if dependencies phase still needs to run
        // (scanning is needed for dependency classification)
        const dependenciesAlreadyComplete =
            state.getPhaseStatus(PHASES.DEPENDENCIES) ===
            PHASE_STATUS.COMPLETED;

        if (!dependenciesAlreadyComplete) {
            // When resuming, scan extracted source files from disk for dependency classification
            // This is needed so classifyDependencies can detect workspace packages
            const scanSpinner = ora({
                text: 'Scanning extracted source files...',
                color: 'cyan',
            }).start();
            registry.register(scanSpinner);

            try {
                const scannedFiles = await scanExtractedSourceFiles(outputDir);
                allExtractedFiles.push(...scannedFiles);
                scanSpinner.succeed(
                    `Scanned ${chalk.bold(scannedFiles.length)} source files for dependency analysis`,
                );
            } catch (error) {
                scanSpinner.warn(
                    `Failed to scan source files: ${error instanceof Error ? error.message : error}`,
                );
            }
        }
    } else if (bundlesWithMaps.length > 0) {
        if (state.getPhaseStatus(PHASES.EXTRACT) !== PHASE_STATUS.IN_PROGRESS) {
            await state.startPhase(PHASES.EXTRACT);
        }

        console.log(chalk.bold('\nExtracting source files:'));
        console.log();

        for (const bundle of bundlesWithMaps) {
            const bundleName = getBundleName(bundle.url);

            // Skip already extracted bundles (for partial resume)
            if (state.isBundleExtracted(bundleName)) {
                console.log(
                    chalk.gray(`  Skipping ${bundleName} (already extracted)`),
                );
                continue;
            }

            const extractSpinner = ora({
                text: `Extracting ${chalk.cyan(bundleName)}...`,
                indent: 2,
            }).start();
            registry.register(extractSpinner);

            try {
                const result = await extractSourcesFromMap(
                    bundle.sourceMapUrl!,
                    bundle.url,
                );

                if (result.errors.length > 0) {
                    extractSpinner.warn(
                        `${bundleName}: ${result.errors.length} errors during extraction`,
                    );
                    for (const error of result.errors) {
                        console.log(chalk.red(`    ${error}`));
                    }
                }

                if (result.sources.length === 0) {
                    extractSpinner.info(`${bundleName}: No source files found`);
                    await state.markBundleExtracted(bundleName, 0);
                    continue;
                }

                // Collect ALL files for version extraction (before filtering)
                // This includes node_modules/*/package.json files
                // Sanitize paths FIRST to resolve `..` segments, THEN prefix with bundle name
                // to match the actual output structure (sanitizePath in reconstructSources does the same)
                const filesWithBundlePrefix = result.sources
                    .map((f) => {
                        const sanitized = sanitizePath(f.path);
                        return sanitized
                            ? { ...f, path: `${bundleName}/${sanitized}` }
                            : null;
                    })
                    .filter((f): f is ExtractedSource => f !== null);
                allExtractedFiles.push(...filesWithBundlePrefix);

                // Store for reconstruction phase (original paths, bundleName is added during reconstruction)
                bundleExtractions.push({
                    bundle,
                    bundleName,
                    files: result.sources,
                    errors: result.errors,
                });

                // Mark bundle as extracted in state
                await state.markBundleExtracted(
                    bundleName,
                    result.sources.length,
                );

                extractSpinner.succeed(
                    `${chalk.cyan(bundleName)}: ${chalk.green(result.sources.length)} files found`,
                );
            } catch (error) {
                extractSpinner.fail(`${bundleName}: ${error}`);
            }
        }
    }

    // Phase 2: Identify internal packages (not on npm) that should always be extracted
    // This runs regardless of --include-node-modules because we need to know which
    // packages are internal so we can generate index.ts and package.json stubs for them
    let internalPackages: Set<string> = new Set();

    if (allExtractedFiles.length > 0) {
        // Extract unique package names from node_modules paths
        const nodeModulesPackages =
            extractNodeModulesPackages(allExtractedFiles);

        if (nodeModulesPackages.length > 0) {
            const internalSpinner = ora({
                text: `Checking ${nodeModulesPackages.length} packages against npm registry...`,
                indent: 2,
            }).start();
            registry.register(internalSpinner);

            internalPackages = await identifyInternalPackages(
                nodeModulesPackages,
                (checked, total, packageName, isInternal) => {
                    internalSpinner.text = `Checking packages... (${checked}/${total})${isInternal ? ` - found internal: ${packageName}` : ''}`;
                },
            );

            if (internalPackages.size > 0) {
                internalSpinner.succeed(
                    `Found ${chalk.bold(internalPackages.size)} internal packages (not on npm): ${Array.from(internalPackages).slice(0, 5).join(', ')}${internalPackages.size > 5 ? '...' : ''}`,
                );
            } else {
                internalSpinner.succeed(
                    'All node_modules packages are public npm packages',
                );
            }
        }
    }

    // Phase 3: Reconstruct files with internal packages knowledge
    if (!skipExtract && bundleExtractions.length > 0) {
        console.log();
        console.log(chalk.bold('Reconstructing files:'));
        console.log();
    }

    for (const { bundle, bundleName, files } of bundleExtractions) {
        const reconstructSpinner = ora({
            text: `Writing ${chalk.cyan(bundleName)}...`,
            indent: 2,
        }).start();
        registry.register(reconstructSpinner);

        try {
            // Reconstruct the files on disk
            const reconstructResult = await reconstructSources(files, {
                outputDir,
                bundleName,
            });

            totalFilesWritten += reconstructResult.filesWritten;
            totalFilesSkipped += reconstructResult.filesSkipped;

            // Track for manifest
            manifestBundles.push({
                bundleUrl: bundle.url,
                sourceMapUrl: bundle.sourceMapUrl!,
                filesExtracted: reconstructResult.filesWritten,
                files: files
                    .filter((_f) =>
                        reconstructResult.filesWritten > 0 ? true : false,
                    )
                    .map((f) => f.path)
                    .slice(0, 100), // Limit manifest size
            });

            reconstructSpinner.succeed(
                `${chalk.cyan(bundleName)}: ${chalk.green(reconstructResult.filesWritten)} files written` +
                    (reconstructResult.filesSkipped > 0
                        ? chalk.gray(
                              ` (${reconstructResult.filesSkipped} skipped)`,
                          )
                        : ''),
            );

            if (reconstructResult.errors.length > 0 && options.verbose) {
                for (const error of reconstructResult.errors) {
                    console.log(chalk.red(`    ${error}`));
                }
            }
        } catch (error) {
            reconstructSpinner.fail(`${bundleName}: ${error}`);
        }
    }

    // Generate stub entry point (for bundles without source maps and/or to unify entry points)
    if (savedBundles.length > 0 || bundleExtractions.length > 0) {
        const stubSpinner = ora({
            text: 'Generating stub entry point...',
            color: 'cyan',
        }).start();
        registry.register(stubSpinner);

        try {
            const stubResult = await generateBundleStubs({
                outputDir,
                savedBundles,
                extractedBundles: bundleExtractions.map((e) => ({
                    bundleName: e.bundleName,
                })),
            });

            if (stubResult.stubsGenerated > 0) {
                stubSpinner.succeed(
                    `Generated stub entry point: ${chalk.cyan(stubResult.entryPointPath.replace(options.output + '/', ''))}`,
                );
            } else {
                stubSpinner.info('No stub entry point needed');
            }

            if (stubResult.errors.length > 0 && options.verbose) {
                for (const error of stubResult.errors) {
                    console.log(chalk.red(`    ${error}`));
                }
            }
        } catch (error) {
            stubSpinner.fail(`Failed to generate stub entry point: ${error}`);
        }
    }

    // Step 4: Write manifest
    if (manifestBundles.length > 0) {
        try {
            await writeManifest(outputDir, options.url, manifestBundles);
        } catch (error) {
            console.log(chalk.yellow(`\nFailed to write manifest: ${error}`));
        }
    }

    // Complete extract phase if we ran it
    if (
        !skipExtract &&
        state.getPhaseStatus(PHASES.EXTRACT) === PHASE_STATUS.IN_PROGRESS
    ) {
        await state.completePhase(PHASES.EXTRACT);
    }

    // Step 5: Analyze dependencies and generate project files
    // Check if dependencies phase is already complete (for resume)
    const skipDependencies =
        state.getPhaseStatus(PHASES.DEPENDENCIES) === PHASE_STATUS.COMPLETED;

    let dependencyStats: {
        totalDependencies: number;
        withVersion: number;
        withoutVersion: number;
        privatePackages: number;
        bySource: Record<string, number>;
        byConfidence: Record<string, number>;
    } | null = null;

    if (skipDependencies) {
        console.log(
            chalk.gray(
                `  Resuming: Skipping dependencies phase (already completed)`,
            ),
        );
    }

    // Generate package.json (enabled by default, works with extracted sources OR saved bundles)
    if (
        !skipDependencies &&
        !options.noPackageJson &&
        (totalFilesWritten > 0 || savedBundles.length > 0)
    ) {
        // Start dependencies phase if not already in progress
        if (
            state.getPhaseStatus(PHASES.DEPENDENCIES) === PHASE_STATUS.PENDING
        ) {
            await state.startPhase(PHASES.DEPENDENCIES);
        }
        const depSpinner = ora({
            text: 'Analyzing dependencies...',
            color: 'cyan',
        }).start();
        registry.register(depSpinner);

        try {
            const sourceDir = outputDir;
            const manifestPath = join(outputDir, 'manifest.json');
            const projectName = `${hostname}-reconstructed`;

            const { packageJson, tsconfig, stats } =
                await generateDependencyManifest(
                    sourceDir,
                    manifestPath,
                    projectName,
                    {
                        onProgress: options.verbose
                            ? (file) => {
                                  depSpinner.text = `Scanning imports: ${file.split('/').slice(-2).join('/')}`;
                              }
                            : undefined,
                        onVersionProgress: (stage, packageName, result) => {
                            switch (stage) {
                                case 'detecting':
                                    depSpinner.text = `Detecting versions from source...`;
                                    break;
                                case 'detected':
                                    if (result) {
                                        depSpinner.text = `Found ${packageName}@${result.version} (${result.source})`;
                                    }
                                    break;
                                case 'fingerprinting':
                                    depSpinner.text = `Fingerprinting: ${packageName}`;
                                    break;
                                case 'fingerprint-check':
                                    depSpinner.text = `Checking ${packageName}`;
                                    break;
                                case 'fingerprinted':
                                    if (result && 'similarity' in result) {
                                        const similarity = (
                                            result as { similarity: number }
                                        ).similarity;
                                        depSpinner.text = chalk.green(
                                            `Matched ${packageName}@${result.version} (${(similarity * 100).toFixed(0)}%)`,
                                        );
                                    }
                                    break;
                                case 'vendor-bundle':
                                    depSpinner.text = `Fingerprinting vendor bundles...`;
                                    break;
                                case 'vendor-bundle-matched':
                                    depSpinner.text = chalk.magenta(
                                        `Vendor match: ${packageName}`,
                                    );
                                    break;
                                case 'peer-dep':
                                    depSpinner.text = `Inferring from peer dependencies...`;
                                    break;
                                case 'peer-dep-inferred':
                                    if (result) {
                                        depSpinner.text = chalk.cyan(
                                            `Inferred ${packageName}@${result.version} (peer-dep)`,
                                        );
                                    }
                                    break;
                                case 'npm':
                                    depSpinner.text = `Fetching ${packageName} from npm...`;
                                    break;
                                default:
                                    depSpinner.text = `[${stage}] ${packageName}`;
                            }
                        },
                        useFingerprinting: !options.noFingerprinting,
                        maxVersionsToCheck: options.maxVersions,
                        fetchFromNpm: !options.noFetchVersions,
                        includePrereleases: options.includePrereleases,
                        // Fingerprinting concurrency options
                        fingerprintConcurrency: options.fingerprintConcurrency,
                        versionConcurrency: options.versionConcurrency,
                        pathConcurrency: options.pathConcurrency,
                        onNpmProgress: (completed, total, pkg) => {
                            depSpinner.text = `Fetching from npm... (${completed}/${total}) ${pkg}`;
                        },
                        onFingerprintProgress: (completed, total, pkg) => {
                            depSpinner.text = `Fingerprinting packages... (${completed}/${total}) ${pkg}`;
                            // Force a render to ensure progress is visible
                            depSpinner.render();
                        },
                        onPeerDepProgress: (completed, total, pkg) => {
                            depSpinner.text = `Peer dep inference... (${completed}/${total}) ${pkg}`;
                            depSpinner.render();
                        },
                        onVendorBundleProgress: (
                            completed,
                            total,
                            bundleFilename,
                        ) => {
                            depSpinner.text = `Vendor bundle fingerprinting... (${completed}/${total}) ${bundleFilename}`;
                            depSpinner.render();
                        },
                        onVendorBundleDetailedProgress: (
                            bundleFilename,
                            packageName,
                            version,
                            versionIndex,
                            versionTotal,
                        ) => {
                            depSpinner.text = `Vendor bundle fingerprinting... ${bundleFilename} [checking ${packageName}@${version} (${versionIndex}/${versionTotal})]`;
                            depSpinner.render();
                        },
                        onClassificationProgress: (
                            checked,
                            total,
                            packageName,
                            classification,
                        ) => {
                            if (classification === 'workspace') {
                                depSpinner.text = chalk.cyan(
                                    `Found workspace package: ${packageName}`,
                                );
                            } else if (classification === 'internal') {
                                depSpinner.text = chalk.cyan(
                                    `Found internal package: ${packageName}`,
                                );
                            } else {
                                depSpinner.text = `Classifying packages... (${checked}/${total}) ${packageName}`;
                            }
                            depSpinner.render();
                        },
                        // Pass all extracted files for version extraction
                        extractedSourceFiles: allExtractedFiles,
                        // Pass page URL for cache keying
                        pageUrl: options.url,
                        // Pass vendor bundles for minified fingerprinting
                        vendorBundles: vendorBundles.map((vb) => ({
                            url: vb.url,
                            filename: vb.filename,
                            content: vb.content,
                            inferredPackage: vb.inferredPackage,
                        })),
                        onVerbose: options.verbose
                            ? (message) => registry.safeLog(message, true)
                            : undefined,
                    },
                );

            dependencyStats = stats;

            // Write package.json to the site's output directory
            const packageJsonPath = join(sourceDir, 'package.json');
            await writePackageJson(packageJsonPath, packageJson);

            // Write tsconfig.json with alias paths configured
            const tsconfigPath = join(sourceDir, 'tsconfig.json');
            await writeTsConfig(tsconfigPath, tsconfig);

            depSpinner.succeed(`Generated package.json and tsconfig.json`);

            // Generate stub files for internal packages (index.ts files, SCSS declarations)
            const stubSpinner = ora({
                text: 'Generating stub files for internal packages...',
                color: 'cyan',
            }).start();
            registry.register(stubSpinner);

            try {
                // Extract installed package names from the generated package.json
                // Include regular deps, dev deps, internal deps, AND import aliases
                // This ensures aliased packages like 'sarsaparilla' -> '@fp/sarsaparilla'
                // don't get stub files generated for them
                const installedPackages = new Set<string>();
                const pkgData = packageJson as GeneratedPackageJson;
                const pkgDeps = pkgData.dependencies || {};
                const pkgDevDeps = pkgData.devDependencies || {};
                const pkgInternal = pkgData._internalDependencies || {};
                const pkgAliases = pkgData._importAliases || {};
                for (const pkg of [
                    ...Object.keys(pkgDeps),
                    ...Object.keys(pkgDevDeps),
                    ...Object.keys(pkgInternal),
                    ...Object.keys(pkgAliases),
                ]) {
                    installedPackages.add(pkg);
                }

                // Extract aliases from tsconfig for missing source file detection
                const aliases = await extractAliasesFromTsConfig(sourceDir);

                const stubResult = await generateStubFiles(sourceDir, {
                    internalPackages,
                    installedPackages,
                    aliases,
                    generateScssDeclarations: true,
                    generateDirectoryIndexes: true,
                    generateCssModuleStubs: true,
                    generateExternalStubs: true,
                    generateMissingSourceStubs: true,
                    onProgress: (msg) => {
                        stubSpinner.text = msg;
                    },
                });

                const totalGenerated =
                    stubResult.indexFilesGenerated +
                    stubResult.directoryIndexesGenerated +
                    stubResult.scssDeclarationsGenerated +
                    stubResult.scssVariableStubsGenerated +
                    stubResult.cssModuleStubsGenerated +
                    stubResult.externalPackageStubsGenerated +
                    stubResult.missingSourceStubsGenerated;

                if (totalGenerated > 0) {
                    const parts = [];
                    if (stubResult.indexFilesGenerated > 0)
                        parts.push(
                            `${stubResult.indexFilesGenerated} package indexes`,
                        );
                    if (stubResult.directoryIndexesGenerated > 0)
                        parts.push(
                            `${stubResult.directoryIndexesGenerated} directory indexes`,
                        );
                    if (stubResult.scssDeclarationsGenerated > 0)
                        parts.push(
                            `${stubResult.scssDeclarationsGenerated} SCSS declarations`,
                        );
                    if (stubResult.scssVariableStubsGenerated > 0)
                        parts.push(
                            `${stubResult.scssVariableStubsGenerated} SCSS variable stubs`,
                        );
                    if (stubResult.cssModuleStubsGenerated > 0)
                        parts.push(
                            `${stubResult.cssModuleStubsGenerated} CSS module stubs`,
                        );
                    if (stubResult.externalPackageStubsGenerated > 0)
                        parts.push(
                            `${stubResult.externalPackageStubsGenerated} external package stubs`,
                        );
                    if (stubResult.missingSourceStubsGenerated > 0)
                        parts.push(
                            `${stubResult.missingSourceStubsGenerated} missing source stubs`,
                        );
                    stubSpinner.succeed(`Generated ${parts.join(', ')}`);
                } else {
                    stubSpinner.info('No stub files needed');
                }
            } catch (error) {
                stubSpinner.warn(`Stub generation had issues: ${error}`);
            }

            // Build detailed status message
            let statusMsg = `Generated package.json with ${chalk.bold(stats.totalDependencies)} dependencies`;

            // Show version breakdown by source
            const sourceCounts: string[] = [];
            if (stats.bySource.lockfilePath > 0)
                sourceCounts.push(`${stats.bySource.lockfilePath} lockfile`);
            if (stats.bySource.banner > 0)
                sourceCounts.push(`${stats.bySource.banner} banner`);
            if (stats.bySource.versionConstant > 0)
                sourceCounts.push(`${stats.bySource.versionConstant} constant`);
            if (stats.bySource.packageJson > 0)
                sourceCounts.push(`${stats.bySource.packageJson} pkg.json`);
            if (stats.bySource.fingerprint > 0)
                sourceCounts.push(`${stats.bySource.fingerprint} fingerprint`);
            if (stats.bySource.fingerprintMinified > 0)
                sourceCounts.push(
                    `${chalk.magenta(stats.bySource.fingerprintMinified)} vendor-bundle`,
                );
            if (stats.bySource.peerDep > 0)
                sourceCounts.push(`${stats.bySource.peerDep} peer-dep`);
            if (stats.bySource.npmLatest > 0)
                sourceCounts.push(
                    `${chalk.yellow(stats.bySource.npmLatest)} npm-latest`,
                );

            if (sourceCounts.length > 0) {
                statusMsg += `\n    Version sources: ${sourceCounts.join(', ')}`;
            }

            // Show confidence breakdown
            const confCounts: string[] = [];
            if (stats.byConfidence.exact > 0)
                confCounts.push(
                    `${chalk.green(stats.byConfidence.exact)} exact`,
                );
            if (stats.byConfidence.high > 0)
                confCounts.push(`${chalk.cyan(stats.byConfidence.high)} high`);
            if (stats.byConfidence.medium > 0)
                confCounts.push(
                    `${chalk.blue(stats.byConfidence.medium)} medium`,
                );
            if (stats.byConfidence.low > 0)
                confCounts.push(`${chalk.yellow(stats.byConfidence.low)} low`);
            if (stats.byConfidence.unverified > 0)
                confCounts.push(
                    `${chalk.gray(stats.byConfidence.unverified)} unverified`,
                );

            if (confCounts.length > 0) {
                statusMsg += `\n    Confidence: ${confCounts.join(', ')}`;
            }

            if (stats.privatePackages > 0) {
                statusMsg += `\n    ${chalk.magenta(stats.privatePackages)} internal/private packages`;
            }
            if (stats.withoutVersion > 0) {
                statusMsg += `\n    ${chalk.red(stats.withoutVersion)} packages with unknown versions`;
            }

            depSpinner.succeed(statusMsg);
        } catch (error) {
            depSpinner.fail(`Failed to generate package.json: ${error}`);
        }

        // Complete dependencies phase
        if (
            state.getPhaseStatus(PHASES.DEPENDENCIES) ===
            PHASE_STATUS.IN_PROGRESS
        ) {
            await state.completePhase(PHASES.DEPENDENCIES);
        }
    }

    // Only show summary if we did work this run (not all phases were already complete)
    if (!allPhasesCompleteAtStart) {
        // Summary
        console.log(chalk.gray('\n  ' + '─'.repeat(20)));
        console.log(chalk.bold('\n  Summary:'));
        if (totalFilesWritten > 0) {
            console.log(
                `    ${chalk.green('✓')} Files extracted: ${chalk.bold(totalFilesWritten)}`,
            );
        }
        if (savedBundles.length > 0) {
            const totalBundleSize = savedBundles.reduce(
                (sum, b) => sum + b.size,
                0,
            );
            console.log(
                `    ${chalk.yellow('○')} Minified bundles saved: ${chalk.bold(savedBundles.length)} (${formatBytes(totalBundleSize)})`,
            );
        }
        if (totalFilesSkipped > 0) {
            console.log(
                `    ${chalk.gray('○')} Files skipped: ${chalk.gray(totalFilesSkipped)}`,
            );
        }
        if (dependencyStats) {
            console.log(
                `    ${chalk.green('✓')} Dependencies found: ${chalk.bold(dependencyStats.totalDependencies)}`,
            );
        }
        console.log(
            `    ${chalk.blue('→')} Output directory: ${chalk.cyan(outputDir)}`,
        );

        if (
            options.noPackageJson &&
            (totalFilesWritten > 0 || savedBundles.length > 0)
        ) {
            console.log(
                chalk.gray(
                    '  Note: Package.json generation was skipped (--no-package-json)',
                ),
            );
        }

        if (options.noCapture) {
            console.log(
                chalk.gray('  Note: API capture was skipped (--no-capture)'),
            );
        }

        console.log();
    }

    // Mark capture as successful if we extracted files, saved bundles, or will capture API
    captureSuccess =
        totalFilesWritten > 0 || savedBundles.length > 0 || !options.noCapture;

    // Step 6: Capture API calls (enabled by default)
    // Check if capture phase is already complete (for resume)
    const skipCapture =
        options.noCapture ||
        state.getPhaseStatus(PHASES.CAPTURE) === PHASE_STATUS.COMPLETED;

    if (!skipCapture) {
        // Check if we're resuming or starting fresh
        const captureStatus = state.getPhaseStatus(PHASES.CAPTURE);
        const isResumingCapture = captureStatus === PHASE_STATUS.IN_PROGRESS;

        if (isResumingCapture) {
            const completedPages = state.getCompletedUrls().length;
            console.log(
                chalk.gray(
                    `  Resuming capture phase (${completedPages} pages already completed)`,
                ),
            );
        }

        if (captureStatus === PHASE_STATUS.PENDING) {
            await state.startPhase(PHASES.CAPTURE);
        }

        console.log(chalk.bold('\nCapturing API calls:'));
        console.log();

        // Create multi-line progress display
        const progress = new ProgressDisplay({
            workerCount: options.captureConcurrency ?? 5,
            maxPages: options.crawlMaxPages ?? 100,
            maxDepth: options.crawlMaxDepth ?? 5,
            baseOrigin: options.url,
        });

        progress.start();

        try {
            const captureResult = await captureWebsite({
                url: options.url,
                outputDir,
                apiFilter: options.apiFilter,
                captureStatic: options.captureStatic,
                captureRenderedHtml: options.captureRenderedHtml,
                headless: options.headless,
                browseTimeout: options.browseTimeout,
                autoScroll: options.autoScroll,
                verbose: options.verbose,
                // Crawl options
                crawl: options.crawl,
                crawlMaxDepth: options.crawlMaxDepth,
                crawlMaxPages: options.crawlMaxPages,
                // Parallelization options
                concurrency: options.captureConcurrency,
                pageRetries: options.pageRetries,
                assetRetries: options.assetRetries,
                retryDelayBase: options.retryDelay,
                retryDelayMax: options.retryDelayMax,
                rateLimitDelay: options.rateLimitDelay,
                pageTimeout: options.pageTimeout,
                // Wait time options
                networkIdleTimeout: options.networkIdleTimeout,
                networkIdleTime: options.networkIdleTime,
                scrollDelay: options.scrollDelay,
                pageSettleTime: options.pageSettleTime,
                // Pass scraped redirect to include in manifest
                scrapedRedirects: scrapedRedirect
                    ? [scrapedRedirect]
                    : undefined,
                // Pass state manager for resume support
                stateManager: state,
                // Use shared event handlers
                onProgress: createCaptureProgressHandler({
                    progress,
                    baseUrl: options.url,
                    logApiCaptures: true,
                    trackApiCaptures: true,
                }),
                // Always create verbose handler - it filters based on verboseMode
                // This ensures warnings/errors always appear in the TUI logs
                onVerbose: createVerboseHandler(progress, options.verbose),
            });

            progress.stop();

            // Show truncation warning if any files were truncated
            if (
                captureResult.stats.truncatedFiles &&
                captureResult.stats.truncatedFiles > 0
            ) {
                console.log(
                    chalk.yellow(
                        `⚠ ${captureResult.stats.truncatedFiles} file(s) were truncated during download`,
                    ),
                );
            }

            // Generate summary
            const summary = generateCaptureSummary(
                captureResult.fixtures,
                captureResult.assets,
            );

            if (captureResult.errors.length > 0) {
                console.log(
                    chalk.yellow(
                        `⚠ Capture completed with ${captureResult.errors.length} errors`,
                    ),
                );
                if (options.verbose) {
                    for (const error of captureResult.errors) {
                        console.log(chalk.red(`    ${error}`));
                    }
                }
            } else {
                console.log(chalk.green('✓ API capture completed'));
            }

            // Show capture summary
            console.log(chalk.gray('\n  ' + '─'.repeat(20)));
            console.log(chalk.bold('\n  API Capture Summary:'));
            console.log(
                `    ${chalk.green('✓')} API endpoints captured: ${chalk.bold(summary.apiEndpoints)}`,
            );
            console.log(
                `    ${chalk.green('✓')} Unique patterns: ${chalk.bold(summary.uniquePatterns)}`,
            );

            if (summary.staticAssets > 0) {
                console.log(
                    `    ${chalk.green('✓')} Static assets: ${chalk.bold(summary.staticAssets)} (${formatBytes(summary.totalBytes)})`,
                );
            }

            // Show crawl stats
            if (captureResult.stats.crawlStats) {
                const cs = captureResult.stats.crawlStats;
                let crawlMsg = `Pages crawled: ${chalk.bold(cs.pagesVisited)}`;
                if (cs.maxPagesReached) {
                    crawlMsg += chalk.yellow(' (max pages reached)');
                }
                if (cs.maxDepthReached) {
                    crawlMsg += chalk.yellow(' (max depth reached)');
                }
                console.log(`    ${chalk.green('✓')} ${crawlMsg}`);

                if (options.verbose) {
                    console.log(
                        `    ${chalk.blue('→')} Links discovered: ${cs.linksDiscovered}`,
                    );
                }
            }

            // Show method breakdown
            const methodCounts = Object.entries(summary.byMethod)
                .map(([method, count]) => `${method}: ${count}`)
                .join(', ');
            if (methodCounts) {
                console.log(`    ${chalk.blue('→')} Methods: ${methodCounts}`);
            }

            // Show status breakdown
            const statusCounts = Object.entries(summary.byStatus)
                .map(([status, count]) => {
                    const color = status.startsWith('2')
                        ? chalk.green
                        : status.startsWith('4')
                          ? chalk.yellow
                          : status.startsWith('5')
                            ? chalk.red
                            : chalk.gray;
                    return color(`${status}: ${count}`);
                })
                .join(', ');
            if (statusCounts) {
                console.log(
                    `    ${chalk.blue('→')} Status codes: ${statusCounts}`,
                );
            }

            console.log(
                `    ${chalk.blue('→')} Capture time: ${(captureResult.stats.captureTimeMs / 1000).toFixed(1)}s`,
            );
            console.log(
                `    ${chalk.blue('→')} Server manifest: ${chalk.cyan(join(outputDir, '_server', 'manifest.json'))}`,
            );

            // Update CSS stubs with captured bundle content
            if (options.captureStatic && captureResult.assets.length > 0) {
                const cssAssets = captureResult.assets.filter(
                    (a) =>
                        a.contentType === 'text/css' ||
                        a.localPath.endsWith('.css'),
                );

                if (cssAssets.length > 0) {
                    const capturedCssBundles: CapturedCssBundle[] = [];
                    const staticDir = join(outputDir, '_server', 'static');

                    for (const asset of cssAssets) {
                        try {
                            const fullPath = join(staticDir, asset.localPath);
                            const content = await readFile(fullPath, 'utf-8');
                            const filename = basename(asset.localPath);
                            capturedCssBundles.push({
                                url: asset.url,
                                localPath: asset.localPath,
                                content,
                                filename,
                                baseName: extractCssBaseName(filename),
                            });
                        } catch {
                            // Skip assets that can't be read
                        }
                    }

                    if (capturedCssBundles.length > 0) {
                        const sourceDir = outputDir;
                        const cssStubResult =
                            await updateCssStubsWithCapturedBundles(
                                sourceDir,
                                capturedCssBundles,
                                {
                                    onProgress: options.verbose
                                        ? (msg) =>
                                              console.log(
                                                  chalk.gray(`    ${msg}`),
                                              )
                                        : undefined,
                                },
                            );

                        if (cssStubResult.updatedCount > 0) {
                            console.log(
                                `    ${chalk.green('✓')} Updated ${chalk.bold(cssStubResult.updatedCount)} CSS stubs with captured bundle content`,
                            );
                        }

                        // Check if we need global CSS injection (source maps weren't available)
                        if (
                            needsGlobalCssInjection(
                                cssStubResult.unmatchedStubs,
                                cssStubResult.unusedBundles,
                            )
                        ) {
                            console.log(
                                `    ${chalk.yellow('!')} ${chalk.bold(cssStubResult.unmatchedStubs.length)} CSS stubs couldn't be matched to captured bundles`,
                            );
                            console.log(
                                chalk.gray(
                                    `      Global CSS injection will be applied during rebuild`,
                                ),
                            );

                            // Store the unused bundles info in the server manifest for rebuild to use
                            const manifestPath = join(
                                sourceDir,
                                '_server',
                                'manifest.json',
                            );
                            try {
                                const manifestContent = await readFile(
                                    manifestPath,
                                    'utf-8',
                                );
                                const manifest = JSON.parse(manifestContent);
                                manifest.unusedCssBundles =
                                    cssStubResult.unusedBundles.map((b) => ({
                                        url: b.url,
                                        localPath: b.localPath,
                                        filename: b.filename,
                                        baseName: b.baseName,
                                    }));
                                manifest.unmatchedCssStubs =
                                    cssStubResult.unmatchedStubs;
                                await import('fs/promises').then((fs) =>
                                    fs.writeFile(
                                        manifestPath,
                                        JSON.stringify(manifest, null, 2),
                                        'utf-8',
                                    ),
                                );
                            } catch {
                                // Manifest may not exist yet, that's fine
                            }
                        }
                    }
                }
            }

            console.log();
            console.log(
                chalk.gray(
                    '  Tip: Use `web2local serve` to serve the captured API fixtures',
                ),
            );
            console.log(chalk.gray(`  Example: web2local serve ${outputDir}`));
        } catch (error) {
            progress.stop();
            console.log(chalk.red(`✗ API capture failed: ${error}`));
        }

        console.log();

        // Generate SCSS variable stubs for captured static assets
        // This handles SCSS files that reference undefined variables
        const captureSourceDir = outputDir;
        const serverStaticDir = join(captureSourceDir, '_server', 'static');
        const scssVarResult = await generateScssVariableStubs(serverStaticDir, {
            onProgress: options.verbose
                ? (msg) => registry.safeLog(msg, true)
                : undefined,
        });
        if (scssVarResult.stubFilesGenerated > 0) {
            console.log(
                `    ${chalk.green('✓')} Generated ${chalk.bold(scssVarResult.stubFilesGenerated)} SCSS variable stubs for captured assets`,
            );
        }

        // Mark capture phase as completed
        if (state.getPhaseStatus(PHASES.CAPTURE) === PHASE_STATUS.IN_PROGRESS) {
            await state.completePhase(PHASES.CAPTURE);
        }
    } else if (
        state.getPhaseStatus(PHASES.CAPTURE) === PHASE_STATUS.COMPLETED
    ) {
        // Skip capture - show resume message
        console.log(
            chalk.gray(
                `  Resuming: Skipping capture phase (already completed)`,
            ),
        );
    }

    // Step 6.5: Sync dynamically loaded bundles from _server/static to _bundles
    // This ensures bundles loaded via dynamic imports during API capture are available for rebuild
    // Skip if capture was already completed (resuming) - sync was done in previous run
    if (!options.noCapture && !options.noRebuild && !skipCapture) {
        const sourceDir = outputDir;
        const syncSpinner = ora({
            text: 'Syncing dynamically loaded bundles...',
            color: 'cyan',
        }).start();
        registry.register(syncSpinner);

        try {
            const syncResult = await syncDynamicBundles(
                sourceDir,
                options.verbose,
                options.verbose
                    ? (message) => registry.safeLog(message, true)
                    : undefined,
            );

            if (syncResult.jsFiles > 0 || syncResult.cssFiles > 0) {
                const parts: string[] = [];
                if (syncResult.jsFiles > 0)
                    parts.push(`${syncResult.jsFiles} JS`);
                if (syncResult.cssFiles > 0)
                    parts.push(`${syncResult.cssFiles} CSS`);
                syncSpinner.succeed(
                    `Synced ${parts.join(' + ')} dynamic bundles to ${chalk.cyan('_bundles/')}`,
                );
            } else {
                syncSpinner.info('No additional dynamic bundles to sync');
            }

            if (syncResult.errors.length > 0 && options.verbose) {
                for (const error of syncResult.errors) {
                    console.log(chalk.red(`    ${error}`));
                }
            }
        } catch (error) {
            syncSpinner.warn(`Failed to sync dynamic bundles: ${error}`);
        }

        // Step 6.6: Resolve missing dynamic imports from bundles
        // This parses JS/CSS bundles to find import() calls and @import rules,
        // then fetches any missing files from the original server
        const resolveSpinner = ora({
            text: 'Resolving dynamic imports...',
            color: 'cyan',
        }).start();
        registry.register(resolveSpinner);

        try {
            const resolveResult = await resolveMissingDynamicImports({
                bundlesDir: join(sourceDir, '_bundles'),
                staticDir: join(sourceDir, '_server', 'static'),
                baseUrl: finalUrl,
                maxIterations: options.resolveMaxIterations,
                verbose: options.verbose,
                onProgress: (msg) => {
                    resolveSpinner.text = msg;
                },
            });

            if (
                resolveResult.fetchedFiles > 0 ||
                resolveResult.copiedFiles > 0
            ) {
                const parts: string[] = [];
                if (resolveResult.fetchedFiles > 0) {
                    parts.push(`${resolveResult.fetchedFiles} fetched`);
                }
                if (resolveResult.copiedFiles > 0) {
                    parts.push(`${resolveResult.copiedFiles} copied`);
                }
                resolveSpinner.succeed(
                    `Resolved ${parts.join(', ')} dynamic imports (${resolveResult.iterations} iteration${resolveResult.iterations !== 1 ? 's' : ''})`,
                );

                // Update manifest with resolved files
                const manifestPath = join(
                    sourceDir,
                    '_server',
                    'manifest.json',
                );
                await updateManifestWithResolvedFiles(
                    manifestPath,
                    resolveResult.resolvedFiles,
                );
            } else {
                resolveSpinner.info('No missing dynamic imports to resolve');
            }

            // Show warnings (404s, etc.)
            if (resolveResult.warnings.length > 0) {
                if (options.verbose) {
                    for (const warning of resolveResult.warnings) {
                        console.log(chalk.yellow(`    ${warning}`));
                    }
                } else if (resolveResult.warnings.length <= 5) {
                    for (const warning of resolveResult.warnings) {
                        console.log(chalk.yellow(`    ${warning}`));
                    }
                } else {
                    console.log(
                        chalk.yellow(
                            `    ${resolveResult.warnings.length} files could not be resolved (use --verbose for details)`,
                        ),
                    );
                }
            }
        } catch (error) {
            resolveSpinner.warn(
                `Dynamic import resolution had issues: ${error}`,
            );
        }

        // Generate SCSS variable stubs for any newly fetched SCSS files
        const staticDir = join(sourceDir, '_server', 'static');
        const scssVarResult2 = await generateScssVariableStubs(staticDir, {
            onProgress: options.verbose
                ? (msg) => registry.safeLog(msg, true)
                : undefined,
        });
        if (scssVarResult2.stubFilesGenerated > 0) {
            console.log(
                `    ${chalk.green('✓')} Generated ${chalk.bold(scssVarResult2.stubFilesGenerated)} SCSS variable stubs for resolved imports`,
            );
        }
    }

    // Step 7: Rebuild (enabled by default, skip with --no-rebuild)
    // Check if rebuild phase is already complete (for resume)
    const skipRebuild =
        options.noRebuild ||
        state.getPhaseStatus(PHASES.REBUILD) === PHASE_STATUS.COMPLETED;

    /**
     * Checks if a line from package manager or build output is a warning or error.
     *
     * Uses patterns specific to npm, pnpm, yarn, and common build tools
     * to identify important messages that should be shown to the user.
     *
     * @param line - A single line of output from a package manager or build tool
     * @returns True if the line appears to be a warning or error message
     */
    function isWarningOrError(line: string): boolean {
        // Package manager specific prefixes
        if (line.startsWith('npm WARN') || line.startsWith('npm ERR')) {
            return true;
        }
        // pnpm/yarn WARN or ERR at start (with word boundary)
        if (/^\s*WARN\b/i.test(line) || /^\s*ERR\b/i.test(line)) {
            return true;
        }
        // Generic patterns with word boundaries
        if (/\bwarning[:\s]/i.test(line)) return true;
        if (/\berror[:\s]/i.test(line)) return true;
        if (/\bdeprecated\b/i.test(line)) return true;
        return false;
    }

    if (!skipRebuild) {
        // Start rebuild phase if not already in progress
        if (state.getPhaseStatus(PHASES.REBUILD) === PHASE_STATUS.PENDING) {
            await state.startPhase(PHASES.REBUILD);
        }

        const sourceDir = outputDir;

        console.log(chalk.bold('\nRebuilding from source:'));
        console.log();

        const rebuildSpinner = ora({
            text: 'Analyzing project...',
            color: 'cyan',
        }).start();
        registry.register(rebuildSpinner);

        // Track current phase for output prefixing
        let currentPhase: 'install' | 'build' = 'install';

        try {
            // Full rebuild (install + build)
            const result = await runRebuild({
                projectDir: sourceDir,
                verbose: options.verbose,
                recovery: true,
                maxRecoveryAttempts: 3,
                packageManager:
                    options.packageManager === 'auto'
                        ? undefined
                        : options.packageManager,
                sourceFiles: allExtractedFiles,
                onProgress: (message) => {
                    // Track phase transitions
                    if (message.includes('Installing dependencies')) {
                        currentPhase = 'install';
                    } else if (
                        message.includes('Running') ||
                        message.includes('Building')
                    ) {
                        currentPhase = 'build';
                    }
                    rebuildSpinner.text = message;
                },
                onOutput: (line, stream) => {
                    const prefix =
                        currentPhase === 'install' ? '[install]' : '[build]';

                    if (options.verbose) {
                        // Verbose: log everything
                        registry.safeLog(`${prefix} ${line}`, true);
                    } else if (stream === 'stderr' || isWarningOrError(line)) {
                        // Default: stderr + stdout warnings/errors
                        registry.safeLog(`${prefix} ${line}`, false);
                    }
                },
            });

            if (result.success) {
                rebuildSuccess = true;
                rebuildSpinner.succeed('Rebuild completed successfully');
                console.log(
                    `    ${chalk.green('✓')} Built ${chalk.bold(result.bundles.length)} files`,
                );
                console.log(
                    `    ${chalk.blue('→')} Output: ${chalk.cyan(result.outputDir)}`,
                );
                console.log(
                    `    ${chalk.blue('→')} Build time: ${(result.durationMs / 1000).toFixed(1)}s`,
                );

                // Store rebuild result and complete phase
                await state.setRebuildResult({
                    success: true,
                    outputDir: result.outputDir,
                    bundles: result.bundles,
                    durationMs: result.durationMs,
                });
                await state.completePhase(PHASES.REBUILD);
            } else {
                rebuildSpinner.fail('Rebuild failed');
                for (const error of result.errors) {
                    console.log(chalk.red(`    ${error}`));
                }

                // Store rebuild failure
                await state.setRebuildResult({
                    success: false,
                    errors: result.errors,
                });
                await state.failPhase(PHASES.REBUILD, result.errors.join('; '));
            }

            if (result.warnings.length > 0 && options.verbose) {
                for (const warning of result.warnings) {
                    console.log(chalk.yellow(`    Warning: ${warning}`));
                }
            }
        } catch (error) {
            rebuildSpinner.fail(`Rebuild failed: ${error}`);
            await state.failPhase(PHASES.REBUILD, String(error));
        }

        console.log();
    } else if (
        state.getPhaseStatus(PHASES.REBUILD) === PHASE_STATUS.COMPLETED
    ) {
        // Skip rebuild - show resume message
        console.log(
            chalk.gray(
                `  Resuming: Skipping rebuild phase (already completed)`,
            ),
        );
    }

    // Finalize state BEFORE starting server (which may block indefinitely)
    // This ensures state is persisted even if server is Ctrl+C'd
    await state.finalize();

    // Clean up spinner registry before server (removes signal handlers that could interfere)
    registry.cleanup();

    // Start mock server if requested and operations were successful
    if (options.serve) {
        // When using --use-rebuilt, both capture and rebuild must succeed
        // (because we're serving rebuilt assets, not just captured ones).
        // Otherwise, just capture success is enough to serve the mock server.
        const canServe = options.useRebuilt
            ? captureSuccess && rebuildSuccess
            : captureSuccess || rebuildSuccess;

        if (canServe) {
            console.log('\nStarting mock server...');

            const { runServer } = await import('@web2local/server');

            const serverOptions = getServerOptions(options, outputDir);

            await runServer(serverOptions);
        } else {
            const reason = options.useRebuilt
                ? 'both capture and rebuild must succeed when using --use-rebuilt'
                : 'operations were not successful';
            console.log(`Skipping server start - ${reason}`);
        }
    }
}

/**
 * Formats a byte count to a human-readable string.
 *
 * @param bytes - The number of bytes to format
 * @returns A formatted string like "1.5 KB" or "2.3 MB"
 */
function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

/**
 * Scan extracted source files from disk.
 *
 * When resuming, we need to reload the source files so that dependency
 * classification can detect workspace packages (packages outside node_modules).
 *
 * This function scans the output directory for source files, skipping:
 * - _server/ (API fixtures)
 * - _bundles/ (minified bundles)
 * - _rebuilt/ (build output)
 * - node_modules/ (installed dependencies)
 *
 * @param outputDir - The site output directory (e.g., output/example.com)
 * @returns Array of ExtractedSource objects with path and content
 */
async function scanExtractedSourceFiles(
    outputDir: string,
): Promise<ExtractedSource[]> {
    const sources: ExtractedSource[] = [];
    const sourceExtensions = [
        '.ts',
        '.tsx',
        '.js',
        '.jsx',
        '.mjs',
        '.cjs',
        '.json',
        '.css',
        '.scss',
        '.sass',
        '.less',
    ];

    // Directories to skip (internal/generated)
    const skipDirs = new Set([
        '_server',
        '_bundles',
        '_rebuilt',
        'node_modules',
    ]);

    async function scanDir(dir: string, relativePath: string): Promise<void> {
        try {
            const entries = await readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = join(dir, entry.name);
                const entryRelativePath = relativePath
                    ? `${relativePath}/${entry.name}`
                    : entry.name;

                if (entry.isDirectory()) {
                    // Skip internal directories at the root level
                    if (relativePath === '' && skipDirs.has(entry.name)) {
                        continue;
                    }
                    await scanDir(fullPath, entryRelativePath);
                } else if (
                    entry.isFile() &&
                    sourceExtensions.some((ext) => entry.name.endsWith(ext))
                ) {
                    try {
                        const content = await readFile(fullPath, 'utf-8');
                        sources.push({
                            path: entryRelativePath,
                            content,
                            originalPath: entryRelativePath,
                        });
                    } catch {
                        // Skip files that can't be read
                    }
                }
            }
        } catch {
            // Directory doesn't exist or can't be read
        }
    }

    await scanDir(outputDir, '');
    return sources;
}

/**
 * Recursively finds all files matching given extensions in a directory.
 *
 * @param dir - The directory to search
 * @param extensions - Array of file extensions to match (e.g., ['.js', '.css'])
 * @returns Array of absolute file paths matching the extensions
 */
async function findFilesRecursive(
    dir: string,
    extensions: string[],
): Promise<string[]> {
    const files: string[] = [];

    try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) {
                const subFiles = await findFilesRecursive(fullPath, extensions);
                files.push(...subFiles);
            } else if (
                entry.isFile() &&
                extensions.some((ext) => entry.name.endsWith(ext))
            ) {
                files.push(fullPath);
            }
        }
    } catch {
        // Directory doesn't exist or can't be read
    }

    return files;
}

/**
 * Checks if a file exists at the given path.
 *
 * @param path - The file path to check
 * @returns True if the file exists, false otherwise
 */
async function fileExists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

/**
 * Sync dynamically loaded bundles from _server/static to _bundles.
 *
 * During API capture, additional JS/CSS files may be loaded via dynamic imports
 * that weren't detected during the initial bundle scan. These files are captured
 * in _server/static/ but need to also be in _bundles/ for the rebuild to work.
 *
 * This function finds all JS/CSS files in _server/static/ that don't exist in
 * _bundles/ and copies them over.
 *
 * @param sourceDir - The site output directory (e.g., output/example.com)
 * @param verbose - Whether to log progress messages
 * @param onVerbose - Optional callback for verbose log messages
 * @returns Object with counts of synced JS files, CSS files, and any errors
 */
async function syncDynamicBundles(
    sourceDir: string,
    verbose: boolean = false,
    onVerbose?: (message: string) => void,
): Promise<{ jsFiles: number; cssFiles: number; errors: string[] }> {
    const staticDir = join(sourceDir, '_server', 'static');
    const bundlesDir = join(sourceDir, '_bundles');
    const errors: string[] = [];

    let jsFiles = 0;
    let cssFiles = 0;

    // Find all JS and CSS files in _server/static
    const staticFiles = await findFilesRecursive(staticDir, ['.js', '.css']);

    for (const staticFile of staticFiles) {
        // Get the relative path from staticDir
        const relativePath = relative(staticDir, staticFile);

        // Check if this file exists in _bundles
        const bundlePath = join(bundlesDir, relativePath);

        if (!(await fileExists(bundlePath))) {
            try {
                // Create the directory if needed
                await mkdir(dirname(bundlePath), { recursive: true });

                // Copy the file
                await copyFile(staticFile, bundlePath);

                if (staticFile.endsWith('.js')) {
                    jsFiles++;
                } else if (staticFile.endsWith('.css')) {
                    cssFiles++;
                }

                if (verbose) {
                    onVerbose?.(`Synced dynamic bundle: ${relativePath}`);
                }
            } catch (error) {
                errors.push(`Failed to sync ${relativePath}: ${error}`);
            }
        }
    }

    return { jsFiles, cssFiles, errors };
}

/**
 * CLI entry point that parses command line arguments and executes the appropriate command.
 *
 * This is the main entry point called by the `run.ts` script. It parses
 * command line arguments using commander.js and dispatches to the appropriate
 * command handler.
 */
export async function main(): Promise<void> {
    parseArgs();
}
