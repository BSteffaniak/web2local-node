#!/usr/bin/env node

import chalk from 'chalk';
import ora from 'ora';
import { parseArgs } from './cli.js';
import {
    extractBundleUrls,
    findAllSourceMaps,
    type BundleInfo,
    type ScrapedRedirect,
} from './scraper.js';
import { extractSourcesFromMap, type SourceFile } from './sourcemap.js';
import {
    reconstructSources,
    writeManifest,
    getBundleName,
    saveBundles,
    generateBundleStubs,
    type BundleManifest,
    type SavedBundle,
} from './reconstructor.js';
import {
    generateDependencyManifest,
    writePackageJson,
    writeTsConfig,
    extractNodeModulesPackages,
    identifyInternalPackages,
} from './dependency-analyzer.js';
import {
    generateStubFiles,
    updateCssStubsWithCapturedBundles,
    type CssStubUpdateResult,
} from './stub-generator.js';
import { type CapturedCssBundle, extractCssBaseName } from './css-recovery.js';
import { initCache } from './fingerprint-cache.js';
import { join, basename } from 'path';
import { readFile } from 'fs/promises';
import { captureWebsite, generateCaptureSummary } from './capture/index.js';
import {
    prepareRebuild,
    rebuild as runRebuild,
    extractAliasesFromTsConfig,
} from './rebuild/index.js';
import { FetchError } from './http.js';
import { needsGlobalCssInjection } from './rebuild/global-css-injector.js';

async function main() {
    const options = parseArgs();

    // Initialize the fingerprint cache early (used by fingerprinting, peer dep inference, and source maps)
    // --force-refresh bypasses all caches, --no-cache also disables caching
    await initCache({
        cacheDir: options.cacheDir || undefined,
        disabled: options.noCache || options.forceRefresh,
    });

    console.log(chalk.bold.cyan('\n  Source Map Extractor 9001'));
    console.log(chalk.gray('  ' + '─'.repeat(20)));
    console.log();

    // Step 1: Fetch the page and extract bundle URLs
    const spinner = ora({
        text: `Fetching ${options.url}...`,
        color: 'cyan',
    }).start();

    let bundles: BundleInfo[];
    let scrapedRedirect: ScrapedRedirect | undefined;
    let finalUrl: string;
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
        if (error instanceof FetchError) {
            spinner.fail(error.format(options.verbose));
        } else {
            spinner.fail(`Failed to fetch page: ${error}`);
        }
        process.exit(1);
    }

    if (bundles.length === 0) {
        console.log(
            chalk.yellow('\nNo JavaScript or CSS bundles found on this page.'),
        );
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

    const { bundlesWithMaps, vendorBundles, bundlesWithoutMaps } =
        await findAllSourceMaps(
            bundles,
            options.concurrency,
            (completed, total) => {
                mapSpinner.text = `Checking bundles for source maps... (${completed}/${total})`;
            },
        );

    const hostname = new URL(options.url).hostname;
    let savedBundles: SavedBundle[] = [];

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

    // Always save bundles without source maps (best-effort fallback)
    // --save-bundles additionally saves bundles that DO have source maps
    if (bundlesWithoutMaps.length > 0) {
        const bundleSpinner = ora({
            text: 'Saving minified bundles...',
            color: 'cyan',
        }).start();

        try {
            const result = await saveBundles(bundlesWithoutMaps, {
                outputDir: options.output,
                siteHostname: hostname,
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
    const allExtractedFiles: SourceFile[] = [];

    // Store extraction results per bundle for later reconstruction
    const bundleExtractions: Array<{
        bundle: BundleInfo;
        bundleName: string;
        files: SourceFile[];
        errors: string[];
    }> = [];

    // Phase 1: Extract all source maps (only if there are bundles with source maps)
    if (bundlesWithMaps.length > 0) {
        console.log(chalk.bold('\nExtracting source files:'));
        console.log();
    }

    for (const bundle of bundlesWithMaps) {
        const bundleName = getBundleName(bundle.url);
        const extractSpinner = ora({
            text: `Extracting ${chalk.cyan(bundleName)}...`,
            indent: 2,
        }).start();

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

            if (result.files.length === 0) {
                extractSpinner.info(`${bundleName}: No source files found`);
                continue;
            }

            // Collect ALL files for version extraction (before filtering)
            // This includes node_modules/*/package.json files
            // Prefix paths with bundle name to match the actual output structure
            const filesWithBundlePrefix = result.files.map((f) => ({
                ...f,
                path: `${bundleName}/${f.path}`,
            }));
            allExtractedFiles.push(...filesWithBundlePrefix);

            // Store for reconstruction phase (original paths, bundleName is added during reconstruction)
            bundleExtractions.push({
                bundle,
                bundleName,
                files: result.files,
                errors: result.errors,
            });

            extractSpinner.succeed(
                `${chalk.cyan(bundleName)}: ${chalk.green(result.files.length)} files found`,
            );
        } catch (error) {
            extractSpinner.fail(`${bundleName}: ${error}`);
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
    console.log();
    console.log(chalk.bold('Reconstructing files:'));
    console.log();

    for (const { bundle, bundleName, files, errors } of bundleExtractions) {
        const reconstructSpinner = ora({
            text: `Writing ${chalk.cyan(bundleName)}...`,
            indent: 2,
        }).start();

        try {
            // Reconstruct the files on disk
            const reconstructResult = await reconstructSources(files, {
                outputDir: options.output,
                includeNodeModules: options.includeNodeModules,
                internalPackages,
                siteHostname: hostname,
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
                    .filter((f) =>
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

        try {
            const stubResult = await generateBundleStubs({
                outputDir: options.output,
                siteHostname: hostname,
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
            await writeManifest(options.output, options.url, manifestBundles);
        } catch (error) {
            console.log(chalk.yellow(`\nFailed to write manifest: ${error}`));
        }
    }

    // Step 5: Generate package.json if requested
    let dependencyStats: {
        totalDependencies: number;
        withVersion: number;
        withoutVersion: number;
        privatePackages: number;
        bySource: Record<string, number>;
        byConfidence: Record<string, number>;
    } | null = null;

    // Generate package.json if requested (works with extracted sources OR saved bundles)
    if (
        options.generatePackageJson &&
        (totalFilesWritten > 0 || savedBundles.length > 0)
    ) {
        const depSpinner = ora({
            text: 'Analyzing dependencies...',
            color: 'cyan',
        }).start();

        try {
            const sourceDir = join(options.output, hostname);
            const manifestPath = join(options.output, 'manifest.json');
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
                                    if (result) {
                                        depSpinner.text = chalk.green(
                                            `Matched ${packageName}@${result.version} (${((result as any).similarity * 100).toFixed(0)}%)`,
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
                        useFingerprinting: options.useFingerprinting,
                        maxVersionsToCheck: options.maxVersions,
                        fetchFromNpm: options.fetchNpmVersions,
                        includePrereleases: options.includePrereleases,
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

            try {
                // Extract installed package names from the generated package.json
                // Include regular deps, dev deps, internal deps, AND import aliases
                // This ensures aliased packages like 'sarsaparilla' -> '@fp/sarsaparilla'
                // don't get stub files generated for them
                const installedPackages = new Set<string>();
                const pkgDeps = (packageJson as any).dependencies || {};
                const pkgDevDeps = (packageJson as any).devDependencies || {};
                const pkgInternal =
                    (packageJson as any)._internalDependencies || {};
                const pkgAliases = (packageJson as any)._importAliases || {};
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
    }

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
        `    ${chalk.blue('→')} Output directory: ${chalk.cyan(options.output)}`,
    );

    if (!options.includeNodeModules && totalFilesSkipped > 0) {
        console.log(
            chalk.gray(
                '\n  Tip: Use --include-node-modules to include dependency source files',
            ),
        );
    }

    if (
        !options.generatePackageJson &&
        (totalFilesWritten > 0 || savedBundles.length > 0)
    ) {
        console.log(
            chalk.gray(
                '  Tip: Use --generate-package-json to create a package.json with dependencies',
            ),
        );
    }

    if (!options.captureApi) {
        console.log(
            chalk.gray(
                '  Tip: Use --capture-api to capture API calls for mock server generation',
            ),
        );
    }

    console.log();

    // Step 6: Capture API calls if requested
    if (options.captureApi) {
        console.log(chalk.bold('\nCapturing API calls:'));
        console.log();

        const captureSpinner = ora({
            text: 'Starting browser for API capture...',
            color: 'cyan',
        }).start();

        try {
            const captureResult = await captureWebsite({
                url: options.url,
                outputDir: options.output,
                apiFilter: options.apiFilter,
                captureStatic: options.captureStatic,
                captureRenderedHtml: options.captureRenderedHtml,
                headless: options.headless,
                browseTimeout: options.browseTimeout,
                autoScroll: options.autoScroll,
                verbose: options.verbose,
                // Pass scraped redirect to include in manifest
                scrapedRedirects: scrapedRedirect
                    ? [scrapedRedirect]
                    : undefined,
                onProgress: (message) => {
                    captureSpinner.text = message;
                },
                // Verbose logging that works with the spinner
                onVerbose: options.verbose
                    ? (message) => {
                          // Clear spinner, log message, re-render spinner
                          captureSpinner.clear();
                          console.log(chalk.gray(`  ${message}`));
                          captureSpinner.render();
                      }
                    : undefined,
            });

            // Generate summary
            const summary = generateCaptureSummary(
                captureResult.fixtures,
                captureResult.assets,
            );

            if (captureResult.errors.length > 0) {
                captureSpinner.warn(
                    `Capture completed with ${captureResult.errors.length} errors`,
                );
                if (options.verbose) {
                    for (const error of captureResult.errors) {
                        console.log(chalk.red(`    ${error}`));
                    }
                }
            } else {
                captureSpinner.succeed('API capture completed');
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
                `    ${chalk.blue('→')} Server manifest: ${chalk.cyan(join(options.output, hostname, '_server', 'manifest.json'))}`,
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
                    const staticDir = join(
                        options.output,
                        hostname,
                        '_server',
                        'static',
                    );

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
                        const sourceDir = join(options.output, hostname);
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
                    '  Tip: Use mock-site-server to serve the captured API fixtures',
                ),
            );
            console.log(
                chalk.gray(
                    `  Example: npx mock-site-server serve ${join(options.output, hostname)}`,
                ),
            );
        } catch (error) {
            captureSpinner.fail(`API capture failed: ${error}`);
        }

        console.log();
    }

    // Step 7: Prepare for rebuild if requested
    if (options.prepareRebuild || options.rebuild) {
        const sourceDir = join(options.output, hostname);

        console.log(chalk.bold('\nPreparing for rebuild:'));
        console.log();

        const rebuildSpinner = ora({
            text: 'Analyzing project...',
            color: 'cyan',
        }).start();

        try {
            if (options.rebuild) {
                // Full rebuild
                const result = await runRebuild({
                    projectDir: sourceDir,
                    verbose: options.verbose,
                    recovery: true,
                    maxRecoveryAttempts: 3,
                    packageManager:
                        options.packageManager === 'auto'
                            ? undefined
                            : options.packageManager,
                    onProgress: (message) => {
                        rebuildSpinner.text = message;
                    },
                });

                if (result.success) {
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
                } else {
                    rebuildSpinner.fail('Rebuild failed');
                    for (const error of result.errors) {
                        console.log(chalk.red(`    ${error}`));
                    }
                }

                if (result.warnings.length > 0 && options.verbose) {
                    for (const warning of result.warnings) {
                        console.log(chalk.yellow(`    Warning: ${warning}`));
                    }
                }
            } else {
                // Just prepare (generate config files)
                const result = await prepareRebuild({
                    projectDir: sourceDir,
                    verbose: options.verbose,
                    overwrite: false,
                    onProgress: (message) => {
                        rebuildSpinner.text = message;
                    },
                });

                if (result.success) {
                    rebuildSpinner.succeed('Rebuild preparation completed');
                    console.log(
                        `    ${chalk.green('✓')} Entry points found: ${chalk.bold(result.entryPoints.length)}`,
                    );
                    if (result.generatedFiles.length > 0) {
                        console.log(
                            `    ${chalk.green('✓')} Generated: ${result.generatedFiles.join(', ')}`,
                        );
                    }
                    console.log();
                    console.log(chalk.gray('  To build the project, run:'));
                    const pm =
                        options.packageManager === 'auto'
                            ? 'pnpm'
                            : options.packageManager;
                    console.log(
                        chalk.cyan(
                            `    cd ${sourceDir} && ${pm} install && ${pm === 'npm' ? 'npm run' : pm} build`,
                        ),
                    );
                } else {
                    rebuildSpinner.fail('Rebuild preparation failed');
                    for (const error of result.errors) {
                        console.log(chalk.red(`    ${error}`));
                    }
                }

                if (result.warnings.length > 0) {
                    for (const warning of result.warnings) {
                        console.log(chalk.yellow(`    Warning: ${warning}`));
                    }
                }
            }
        } catch (error) {
            rebuildSpinner.fail(`Rebuild preparation failed: ${error}`);
        }

        console.log();
    }
}

/**
 * Format bytes to human readable string
 */
function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

main().catch((error) => {
    console.error(chalk.red(`\nFatal error: ${error.message}`));
    if (process.env.DEBUG) {
        console.error(error.stack);
    }
    process.exit(1);
});
