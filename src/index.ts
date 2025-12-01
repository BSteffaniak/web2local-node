#!/usr/bin/env node

import chalk from "chalk";
import ora from "ora";
import { parseArgs } from "./cli.js";
import { extractBundleUrls, findAllSourceMaps, type BundleInfo } from "./scraper.js";
import { extractSourcesFromMap, type SourceFile } from "./sourcemap.js";
import {
  reconstructSources,
  writeManifest,
  getBundleName,
  type BundleManifest,
} from "./reconstructor.js";

async function main() {
  const options = parseArgs();

  console.log(chalk.bold.cyan("\n  Source Map Extractor 9001"));
  console.log(chalk.gray("  ─".repeat(20)));
  console.log();

  // Step 1: Fetch the page and extract bundle URLs
  const spinner = ora({
    text: `Fetching ${options.url}...`,
    color: "cyan",
  }).start();

  let bundles: BundleInfo[];
  try {
    bundles = await extractBundleUrls(options.url);
    spinner.succeed(
      `Found ${chalk.bold(bundles.length)} bundles (JS/CSS files)`
    );
  } catch (error) {
    spinner.fail(`Failed to fetch page: ${error}`);
    process.exit(1);
  }

  if (bundles.length === 0) {
    console.log(chalk.yellow("\nNo JavaScript or CSS bundles found on this page."));
    process.exit(0);
  }

  if (options.verbose) {
    console.log(chalk.gray("\nBundles found:"));
    for (const bundle of bundles) {
      console.log(chalk.gray(`  - ${bundle.url}`));
    }
    console.log();
  }

  // Step 2: Find source maps for each bundle
  const mapSpinner = ora({
    text: "Searching for source maps...",
    color: "cyan",
  }).start();

  const bundlesWithMaps = await findAllSourceMaps(
    bundles,
    options.concurrency,
    (completed, total) => {
      mapSpinner.text = `Checking bundles for source maps... (${completed}/${total})`;
    }
  );

  if (bundlesWithMaps.length === 0) {
    mapSpinner.fail("No source maps found for any bundles");
    console.log(
      chalk.yellow(
        "\nThis site may not have publicly accessible source maps, or they may be using inline source maps."
      )
    );
    process.exit(0);
  }

  mapSpinner.succeed(
    `Found ${chalk.bold(bundlesWithMaps.length)} source maps`
  );

  if (options.verbose) {
    console.log(chalk.gray("\nSource maps found:"));
    for (const bundle of bundlesWithMaps) {
      console.log(chalk.gray(`  - ${bundle.sourceMapUrl}`));
    }
    console.log();
  }

  // Step 3: Extract sources from each source map
  const hostname = new URL(options.url).hostname;
  const manifestBundles: BundleManifest[] = [];
  let totalFilesWritten = 0;
  let totalFilesSkipped = 0;

  console.log(chalk.bold("\nExtracting source files:"));
  console.log();

  for (const bundle of bundlesWithMaps) {
    const bundleName = getBundleName(bundle.url);
    const extractSpinner = ora({
      text: `Processing ${chalk.cyan(bundleName)}...`,
      indent: 2,
    }).start();

    try {
      const result = await extractSourcesFromMap(
        bundle.sourceMapUrl!,
        bundle.url
      );

      if (result.errors.length > 0) {
        extractSpinner.warn(
          `${bundleName}: ${result.errors.length} errors during extraction`
        );
        if (options.verbose) {
          for (const error of result.errors) {
            console.log(chalk.red(`    ${error}`));
          }
        }
      }

      if (result.files.length === 0) {
        extractSpinner.info(`${bundleName}: No source files found`);
        continue;
      }

      // Reconstruct the files on disk
      const reconstructResult = await reconstructSources(result.files, {
        outputDir: options.output,
        includeNodeModules: options.includeNodeModules,
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
        files: result.files
          .filter((f) =>
            reconstructResult.filesWritten > 0 ? true : false
          )
          .map((f) => f.path)
          .slice(0, 100), // Limit manifest size
      });

      extractSpinner.succeed(
        `${chalk.cyan(bundleName)}: ${chalk.green(reconstructResult.filesWritten)} files extracted` +
          (reconstructResult.filesSkipped > 0
            ? chalk.gray(` (${reconstructResult.filesSkipped} skipped)`)
            : "")
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
    try {
      await writeManifest(options.output, options.url, manifestBundles);
    } catch (error) {
      console.log(chalk.yellow(`\nFailed to write manifest: ${error}`));
    }
  }

  // Summary
  console.log(chalk.gray("\n  ─".repeat(20)));
  console.log(chalk.bold("\n  Summary:"));
  console.log(`    ${chalk.green("✓")} Files extracted: ${chalk.bold(totalFilesWritten)}`);
  if (totalFilesSkipped > 0) {
    console.log(`    ${chalk.gray("○")} Files skipped: ${chalk.gray(totalFilesSkipped)}`);
  }
  console.log(`    ${chalk.blue("→")} Output directory: ${chalk.cyan(options.output)}`);
  
  if (!options.includeNodeModules && totalFilesSkipped > 0) {
    console.log(
      chalk.gray("\n  Tip: Use --include-node-modules to include dependency source files")
    );
  }

  console.log();
}

main().catch((error) => {
  console.error(chalk.red(`\nFatal error: ${error.message}`));
  if (process.env.DEBUG) {
    console.error(error.stack);
  }
  process.exit(1);
});
