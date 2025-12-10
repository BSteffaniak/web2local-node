/**
 * Extract command implementation
 *
 * A simple, focused command that only extracts source files from source maps.
 * No dependency analysis, no API capture, no rebuild.
 */

import chalk from 'chalk';
import ora from 'ora';
import { join } from 'path';
import { mkdir, writeFile } from 'fs/promises';
import type { ExtractOptions } from './cli.js';
import { SpinnerRegistry } from './spinner-registry.js';
import {
    ProgressDisplay,
    createCaptureProgressHandler,
    createVerboseHandler,
} from './progress/index.js';
import { resolveOutputDir, checkOutputDirectory } from './output-dir.js';

import {
    extractBundleUrls,
    findAllSourceMaps,
    extractSourcesFromMap,
    reconstructSources,
    getBundleName,
    type BundleInfo,
    type BundleManifest,
} from '@web2local/scraper';
import { initCache } from '@web2local/cache';
import { extractSourceMap, shouldIncludeSource } from '@web2local/sourcemap';
import { FetchError } from '@web2local/http';

// ============================================================================
// TYPES
// ============================================================================

interface ExtractManifest {
    extractedAt: string;
    sourceUrl: string;
    mode: 'page' | 'direct';
    bundles: BundleManifest[];
    totalFiles: number;
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Detects if a URL is a direct source map URL
 */
function isSourceMapUrl(url: string): boolean {
    const urlWithoutQuery = url.split('?')[0];
    return (
        urlWithoutQuery.endsWith('.map') ||
        url.startsWith('data:application/json')
    );
}

/**
 * Extracts hostname from URL for output directory
 */
function getHostname(url: string): string {
    try {
        return new URL(url).hostname;
    } catch {
        return 'extracted';
    }
}

/**
 * Writes a simple extraction manifest
 */
async function writeExtractManifest(
    outputDir: string,
    manifest: ExtractManifest,
): Promise<void> {
    const manifestPath = join(outputDir, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
}

// ============================================================================
// DIRECT SOURCE MAP EXTRACTION
// ============================================================================

/**
 * Extract sources directly from a source map URL
 */
async function extractFromSourceMapUrl(
    options: ExtractOptions,
    registry: SpinnerRegistry,
): Promise<void> {
    const hostname = getHostname(options.url);
    const outputDir = resolveOutputDir(options.output, hostname);

    // Check if output directory exists
    await checkOutputDirectory(outputDir, options.overwrite);

    const spinner = ora({
        text: `Extracting from ${chalk.cyan(options.url)}...`,
        color: 'cyan',
    }).start();
    registry.register(spinner);

    try {
        // Use the convenience function from @web2local/sourcemap
        const result = await extractSourceMap(options.url, {
            includeNodeModules: options.includeNodeModules,
        });

        if (result.errors.length > 0 && result.sources.length === 0) {
            spinner.fail('Failed to extract sources');
            for (const error of result.errors) {
                console.log(chalk.red(`  ${error.message}`));
            }
            process.exit(1);
        }

        // Create output directory
        await mkdir(outputDir, { recursive: true });

        // Write files directly to hostname/ (no bundle subdirectory)
        let filesWritten = 0;
        let filesSkipped = 0;

        for (const source of result.sources) {
            // Check if we should include this file
            if (
                !shouldIncludeSource(source.path, {
                    includeNodeModules: options.includeNodeModules,
                })
            ) {
                filesSkipped++;
                continue;
            }

            const filePath = join(outputDir, source.path);
            const fileDir = join(filePath, '..');

            try {
                await mkdir(fileDir, { recursive: true });
                await writeFile(filePath, source.content, 'utf-8');
                filesWritten++;
            } catch (error) {
                if (options.verbose) {
                    console.log(
                        chalk.yellow(
                            `  Failed to write ${source.path}: ${error}`,
                        ),
                    );
                }
            }
        }

        spinner.succeed(`Extracted ${chalk.green(filesWritten)} files`);

        // Write manifest
        const manifest: ExtractManifest = {
            extractedAt: new Date().toISOString(),
            sourceUrl: options.url,
            mode: 'direct',
            bundles: [
                {
                    bundleUrl: result.bundleUrl || options.url,
                    sourceMapUrl: result.sourceMapUrl || options.url,
                    filesExtracted: filesWritten,
                    files: result.sources
                        .map((s: { path: string }) => s.path)
                        .slice(0, 100),
                },
            ],
            totalFiles: filesWritten,
        };
        await writeExtractManifest(outputDir, manifest);

        // Summary
        console.log(chalk.gray('\n  ' + '─'.repeat(20)));
        console.log(chalk.bold('\n  Summary:'));
        console.log(
            `    ${chalk.green('✓')} Files extracted: ${chalk.bold(filesWritten)}`,
        );
        if (filesSkipped > 0) {
            console.log(
                `    ${chalk.gray('○')} Files skipped: ${chalk.gray(filesSkipped)} (node_modules)`,
            );
        }
        console.log(`    ${chalk.blue('→')} Output: ${chalk.cyan(outputDir)}`);

        if (!options.includeNodeModules && filesSkipped > 0) {
            console.log(
                chalk.gray(
                    '\n  Tip: Use --include-node-modules to include dependency source files',
                ),
            );
        }
        console.log();
    } catch (error) {
        spinner.fail(
            `Failed to extract: ${error instanceof Error ? error.message : error}`,
        );
        process.exit(1);
    }
}

// ============================================================================
// PAGE-BASED EXTRACTION
// ============================================================================

/**
 * Extract sources from all bundles found on a page
 */
async function extractFromPageUrl(
    options: ExtractOptions,
    registry: SpinnerRegistry,
): Promise<void> {
    const hostname = getHostname(options.url);
    const outputDir = resolveOutputDir(options.output, hostname);

    // Check if output directory exists
    await checkOutputDirectory(outputDir, options.overwrite);

    console.log(chalk.bold.cyan('\n  web2local extract'));
    console.log(chalk.gray('  ' + '─'.repeat(18)));
    console.log();

    // Step 1: Fetch the page and extract bundle URLs
    const fetchSpinner = ora({
        text: `Fetching ${options.url}...`,
        color: 'cyan',
    }).start();
    registry.register(fetchSpinner);

    let bundles: BundleInfo[];
    try {
        const result = await extractBundleUrls(options.url);
        bundles = result.bundles;

        if (result.redirect) {
            fetchSpinner.succeed(
                `Found ${chalk.bold(bundles.length)} bundles ${chalk.gray(`(redirected: ${result.redirect.from} → ${result.redirect.to})`)}`,
            );
        } else {
            fetchSpinner.succeed(`Found ${chalk.bold(bundles.length)} bundles`);
        }
    } catch (error) {
        if (error instanceof FetchError) {
            fetchSpinner.fail(error.format(options.verbose));
        } else {
            fetchSpinner.fail(`Failed to fetch page: ${error}`);
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

    const { bundlesWithMaps, bundlesWithoutMaps } = await findAllSourceMaps(
        bundles,
        {
            concurrency: options.concurrency,
            onProgress: (completed, total) => {
                mapSpinner.text = `Checking bundles for source maps... (${completed}/${total})`;
            },
        },
    );

    if (bundlesWithMaps.length === 0) {
        mapSpinner.fail('No source maps found for any bundles');
        console.log(
            chalk.yellow(
                '\nThis site may not have publicly accessible source maps.',
            ),
        );
        process.exit(0);
    }

    mapSpinner.succeed(
        `Found ${chalk.bold(bundlesWithMaps.length)} source maps`,
    );

    if (options.verbose && bundlesWithMaps.length > 0) {
        console.log(chalk.gray('\nSource maps found:'));
        for (const bundle of bundlesWithMaps) {
            console.log(chalk.gray(`  - ${bundle.sourceMapUrl}`));
        }
        console.log();
    }

    // Step 3: Extract sources from each source map
    console.log(chalk.bold('\nExtracting source files:'));
    console.log();

    const manifestBundles: BundleManifest[] = [];
    let totalFilesWritten = 0;
    let totalFilesSkipped = 0;

    for (const bundle of bundlesWithMaps) {
        const bundleName = getBundleName(bundle.url);
        const extractSpinner = ora({
            text: `Extracting ${chalk.cyan(bundleName)}...`,
            indent: 2,
        }).start();
        registry.register(extractSpinner);

        try {
            // Extract sources
            const result = await extractSourcesFromMap(
                bundle.sourceMapUrl!,
                bundle.url,
            );

            if (result.errors.length > 0) {
                extractSpinner.warn(
                    `${bundleName}: ${result.errors.length} errors during extraction`,
                );
                if (options.verbose) {
                    for (const error of result.errors) {
                        console.log(chalk.red(`    ${error}`));
                    }
                }
            }

            if (result.sources.length === 0) {
                extractSpinner.info(`${bundleName}: No source files found`);
                continue;
            }

            // Reconstruct files on disk
            const reconstructResult = await reconstructSources(result.sources, {
                outputDir,
                includeNodeModules: options.includeNodeModules,
                bundleName,
            });

            totalFilesWritten += reconstructResult.filesWritten;
            totalFilesSkipped += reconstructResult.filesSkipped;

            // Track for manifest
            manifestBundles.push({
                bundleUrl: bundle.url,
                sourceMapUrl: bundle.sourceMapUrl!,
                filesExtracted: reconstructResult.filesWritten,
                files: result.sources.map((f) => f.path).slice(0, 100),
            });

            extractSpinner.succeed(
                `${chalk.cyan(bundleName)}: ${chalk.green(reconstructResult.filesWritten)} files` +
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
            extractSpinner.fail(`${bundleName}: ${error}`);
        }
    }

    // Step 4: Write manifest
    if (manifestBundles.length > 0) {
        const manifest: ExtractManifest = {
            extractedAt: new Date().toISOString(),
            sourceUrl: options.url,
            mode: 'page',
            bundles: manifestBundles,
            totalFiles: totalFilesWritten,
        };
        await writeExtractManifest(outputDir, manifest);
    }

    // Summary
    console.log(chalk.gray('\n  ' + '─'.repeat(20)));
    console.log(chalk.bold('\n  Summary:'));
    if (totalFilesWritten > 0) {
        console.log(
            `    ${chalk.green('✓')} Files extracted: ${chalk.bold(totalFilesWritten)}`,
        );
    }
    if (totalFilesSkipped > 0) {
        console.log(
            `    ${chalk.gray('○')} Files skipped: ${chalk.gray(totalFilesSkipped)} (node_modules)`,
        );
    }
    if (bundlesWithoutMaps.length > 0) {
        console.log(
            `    ${chalk.yellow('○')} Bundles without source maps: ${chalk.yellow(bundlesWithoutMaps.length)}`,
        );
    }
    console.log(`    ${chalk.blue('→')} Output: ${chalk.cyan(outputDir)}`);

    if (!options.includeNodeModules && totalFilesSkipped > 0) {
        console.log(
            chalk.gray(
                '\n  Tip: Use --include-node-modules to include dependency source files',
            ),
        );
    }
    console.log();
}

// ============================================================================
// CRAWL-BASED EXTRACTION
// ============================================================================

/**
 * Extract sources by crawling the site with a browser.
 * This discovers bundles as they're loaded during navigation.
 */
async function extractWithCrawl(
    options: ExtractOptions,
    registry: SpinnerRegistry,
): Promise<void> {
    // Dynamically import capture module to avoid loading Playwright when not needed
    const { captureWebsite } = await import('@web2local/capture');
    // Import type separately
    type CapturedAssetInfo = import('@web2local/capture').CapturedAssetInfo;

    const hostname = getHostname(options.url);
    const outputDir = resolveOutputDir(options.output, hostname);

    // Check if output directory exists
    await checkOutputDirectory(outputDir, options.overwrite);

    console.log(chalk.bold.cyan('\n  web2local extract'));
    console.log(chalk.gray('  ' + '─'.repeat(25)));
    console.log();

    // Collect JS/CSS bundles during crawl
    const capturedBundles: Map<
        string,
        { content: string; contentType: string }
    > = new Map();

    // Create multi-line progress display
    const progress = new ProgressDisplay({
        workerCount: 5, // Default concurrency for extract
        maxPages: options.crawlMaxPages ?? 100,
        maxDepth: options.crawlMaxDepth ?? 5,
        baseOrigin: options.url,
    });

    progress.start();

    try {
        // Use captureWebsite with a filter for JS/CSS only and skipAssetWrite
        const result = await captureWebsite({
            url: options.url,
            outputDir,
            apiFilter: [], // Don't capture API calls
            captureStatic: true,
            headless: options.headless ?? true,
            browseTimeout: 5000, // Shorter timeout for extract
            autoScroll: false, // Skip scrolling for extract
            verbose: options.verbose,
            crawl: true,
            crawlMaxDepth: options.crawlMaxDepth ?? 5,
            crawlMaxPages: options.crawlMaxPages ?? 100,
            // Only capture JS and CSS bundles
            staticFilter: {
                extensions: ['.js', '.mjs', '.css'],
            },
            // Don't write assets to disk - we'll process them differently
            skipAssetWrite: true,
            // Collect bundle content
            onAssetCaptured: (asset: CapturedAssetInfo) => {
                const contentStr =
                    typeof asset.content === 'string'
                        ? asset.content
                        : asset.content.toString('utf-8');
                capturedBundles.set(asset.url, {
                    content: contentStr,
                    contentType: asset.contentType,
                });
            },
            // Use shared event handlers (extract doesn't need API capture logging/tracking)
            onProgress: createCaptureProgressHandler({
                progress,
                baseUrl: options.url,
                logApiCaptures: false,
                trackApiCaptures: false,
            }),
            // Always create verbose handler - it filters based on verboseMode
            // This ensures warnings/errors always appear in the TUI logs
            onVerbose: createVerboseHandler(progress, options.verbose),
        });

        progress.stop();

        // Check for critical errors (like browser launch failure)
        if (result.errors.length > 0) {
            // If we have errors and no bundles, it's likely a critical failure
            if (capturedBundles.size === 0) {
                console.log(
                    chalk.red(
                        `✗ Capture failed with ${result.errors.length} error(s):`,
                    ),
                );
                for (const error of result.errors) {
                    console.log(chalk.red(`    ${error}`));
                }
                return;
            }
            // Otherwise, show warnings but continue
            console.log(
                chalk.yellow(
                    `⚠ Capture completed with ${result.errors.length} error(s)`,
                ),
            );
            if (options.verbose) {
                for (const error of result.errors) {
                    console.log(chalk.red(`    ${error}`));
                }
            }
        }

        const crawlStats = result.stats.crawlStats;
        console.log(
            chalk.green(
                `✓ Crawled ${chalk.bold(crawlStats?.pagesVisited || 1)} pages, found ${chalk.bold(capturedBundles.size)} bundles`,
            ),
        );

        if (options.verbose) {
            console.log(chalk.gray('\nBundles captured:'));
            for (const url of capturedBundles.keys()) {
                console.log(chalk.gray(`  - ${url}`));
            }
            console.log();
        }

        if (capturedBundles.size === 0) {
            console.log(
                chalk.yellow(
                    '\nNo JavaScript or CSS bundles found during crawl.',
                ),
            );
            return;
        }

        // Convert captured bundles to BundleInfo format
        const bundles: BundleInfo[] = Array.from(capturedBundles.entries()).map(
            ([url, { contentType }]) => ({
                url,
                type: contentType.includes('css')
                    ? ('stylesheet' as const)
                    : ('script' as const),
            }),
        );

        // Create pre-fetched bundles for findAllSourceMaps
        const preFetchedBundles = Array.from(capturedBundles.entries()).map(
            ([url, { content, contentType }]) => ({
                url,
                content,
                contentType,
            }),
        );

        // Find source maps using pre-fetched content
        const mapSpinner = ora({
            text: 'Checking bundles for source maps...',
            color: 'cyan',
        }).start();
        registry.register(mapSpinner);

        const { bundlesWithMaps, bundlesWithoutMaps } = await findAllSourceMaps(
            bundles,
            {
                concurrency: options.concurrency,
                preFetchedBundles,
                onProgress: (completed, total) => {
                    mapSpinner.text = `Checking bundles for source maps... (${completed}/${total})`;
                },
            },
        );

        if (bundlesWithMaps.length === 0) {
            mapSpinner.fail('No source maps found for any bundles');
            console.log(
                chalk.yellow(
                    '\nThis site may not have publicly accessible source maps.',
                ),
            );
            return;
        }

        mapSpinner.succeed(
            `Found ${chalk.bold(bundlesWithMaps.length)} source maps`,
        );

        // Extract sources from each source map (same logic as extractFromPageUrl)
        console.log(chalk.bold('\nExtracting source files:'));
        console.log();

        const manifestBundles: BundleManifest[] = [];
        let totalFilesWritten = 0;
        let totalFilesSkipped = 0;

        for (const bundle of bundlesWithMaps) {
            const bundleName = getBundleName(bundle.url);
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
                    if (options.verbose) {
                        for (const error of result.errors) {
                            console.log(chalk.red(`    ${error}`));
                        }
                    }
                }

                if (result.sources.length === 0) {
                    extractSpinner.info(`${bundleName}: No source files found`);
                    continue;
                }

                const reconstructResult = await reconstructSources(
                    result.sources,
                    {
                        outputDir,
                        includeNodeModules: options.includeNodeModules,
                        bundleName,
                    },
                );

                totalFilesWritten += reconstructResult.filesWritten;
                totalFilesSkipped += reconstructResult.filesSkipped;

                manifestBundles.push({
                    bundleUrl: bundle.url,
                    sourceMapUrl: bundle.sourceMapUrl!,
                    filesExtracted: reconstructResult.filesWritten,
                    files: result.sources.map((f) => f.path).slice(0, 100),
                });

                extractSpinner.succeed(
                    `${chalk.cyan(bundleName)}: ${chalk.green(reconstructResult.filesWritten)} files` +
                        (reconstructResult.filesSkipped > 0
                            ? chalk.gray(
                                  ` (${reconstructResult.filesSkipped} skipped)`,
                              )
                            : ''),
                );
            } catch (error) {
                extractSpinner.fail(`${bundleName}: ${error}`);
            }
        }

        // Write manifest
        if (manifestBundles.length > 0) {
            const manifest: ExtractManifest = {
                extractedAt: new Date().toISOString(),
                sourceUrl: options.url,
                mode: 'page',
                bundles: manifestBundles,
                totalFiles: totalFilesWritten,
            };
            await writeExtractManifest(outputDir, manifest);
        }

        // Summary
        console.log(chalk.gray('\n  ' + '─'.repeat(20)));
        console.log(chalk.bold('\n  Summary:'));
        if (crawlStats) {
            console.log(
                `    ${chalk.blue('○')} Pages crawled: ${chalk.bold(crawlStats.pagesVisited)}`,
            );
        }
        if (totalFilesWritten > 0) {
            console.log(
                `    ${chalk.green('✓')} Files extracted: ${chalk.bold(totalFilesWritten)}`,
            );
        }
        if (totalFilesSkipped > 0) {
            console.log(
                `    ${chalk.gray('○')} Files skipped: ${chalk.gray(totalFilesSkipped)} (node_modules)`,
            );
        }
        if (bundlesWithoutMaps.length > 0) {
            console.log(
                `    ${chalk.yellow('○')} Bundles without source maps: ${chalk.yellow(bundlesWithoutMaps.length)}`,
            );
        }
        console.log(`    ${chalk.blue('→')} Output: ${chalk.cyan(outputDir)}`);

        if (!options.includeNodeModules && totalFilesSkipped > 0) {
            console.log(
                chalk.gray(
                    '\n  Tip: Use --include-node-modules to include dependency source files',
                ),
            );
        }
        console.log();
    } catch (error) {
        progress.stop();
        console.log(
            chalk.red(
                `✗ Crawl failed: ${error instanceof Error ? error.message : error}`,
            ),
        );
        process.exit(1);
    }
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

/**
 * Main entry point for the extract command
 */
export async function runExtract(options: ExtractOptions): Promise<void> {
    // Initialize spinner registry for synchronized logging
    const registry = new SpinnerRegistry();
    registry.setupSignalHandlers();

    // Initialize cache
    await initCache({
        disabled: options.noCache,
    });

    try {
        // Detect if URL is a direct source map URL or a page URL
        if (isSourceMapUrl(options.url)) {
            await extractFromSourceMapUrl(options, registry);
        } else if (options.crawl) {
            // Use browser-based crawling to discover bundles
            await extractWithCrawl(options, registry);
        } else {
            await extractFromPageUrl(options, registry);
        }
    } finally {
        registry.cleanup();
    }
}
