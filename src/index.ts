#!/usr/bin/env node

import chalk from "chalk";
import ora from "ora";
import { parseArgs } from "./cli.js";
import { extractBundleUrls, findAllSourceMaps, type BundleInfo, type VendorBundle } from "./scraper.js";
import { extractSourcesFromMap, type SourceFile } from "./sourcemap.js";
import {
  reconstructSources,
  writeManifest,
  getBundleName,
  type BundleManifest,
} from "./reconstructor.js";
import {
  generateDependencyManifest,
  writePackageJson,
  writeTsConfig,
  extractNodeModulesPackages,
  identifyInternalPackages,
} from "./dependency-analyzer.js";
import { generateStubFiles } from "./stub-generator.js";
import { initCache } from "./fingerprint-cache.js";
import { join } from "path";

async function main() {
  const options = parseArgs();

  // Initialize the fingerprint cache early (used by fingerprinting, peer dep inference, and source maps)
  // --force-refresh bypasses all caches, --no-cache also disables caching
  await initCache({
    cacheDir: options.cacheDir || undefined,
    disabled: options.noCache || options.forceRefresh,
  });

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

  const { bundlesWithMaps, vendorBundles } = await findAllSourceMaps(
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

  let mapStatusMsg = `Found ${chalk.bold(bundlesWithMaps.length)} source maps`;
  if (vendorBundles.length > 0) {
    mapStatusMsg += chalk.gray(` + ${vendorBundles.length} vendor bundles`);
  }
  mapSpinner.succeed(mapStatusMsg);

  if (options.verbose) {
    console.log(chalk.gray("\nSource maps found:"));
    for (const bundle of bundlesWithMaps) {
      console.log(chalk.gray(`  - ${bundle.sourceMapUrl}`));
    }
    if (vendorBundles.length > 0) {
      console.log(chalk.gray("\nVendor bundles (no source maps):"));
      for (const vb of vendorBundles) {
        const pkg = vb.inferredPackage ? ` -> ${vb.inferredPackage}` : '';
        console.log(chalk.gray(`  - ${vb.filename}${pkg}`));
      }
    }
    console.log();
  }

  // Step 3: Extract sources from each source map
  const hostname = new URL(options.url).hostname;
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

  console.log(chalk.bold("\nExtracting source files:"));
  console.log();

  // Phase 1: Extract all source maps
  for (const bundle of bundlesWithMaps) {
    const bundleName = getBundleName(bundle.url);
    const extractSpinner = ora({
      text: `Extracting ${chalk.cyan(bundleName)}...`,
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
      const filesWithBundlePrefix = result.files.map(f => ({
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
        `${chalk.cyan(bundleName)}: ${chalk.green(result.files.length)} files found`
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
    const nodeModulesPackages = extractNodeModulesPackages(allExtractedFiles);
    
    if (nodeModulesPackages.length > 0) {
      const internalSpinner = ora({
        text: `Checking ${nodeModulesPackages.length} packages against npm registry...`,
        indent: 2,
      }).start();

      internalPackages = await identifyInternalPackages(
        nodeModulesPackages,
        (checked, total, packageName, isInternal) => {
          internalSpinner.text = `Checking packages... (${checked}/${total})${isInternal ? ` - found internal: ${packageName}` : ''}`;
        }
      );

      if (internalPackages.size > 0) {
        internalSpinner.succeed(
          `Found ${chalk.bold(internalPackages.size)} internal packages (not on npm): ${Array.from(internalPackages).slice(0, 5).join(', ')}${internalPackages.size > 5 ? '...' : ''}`
        );
      } else {
        internalSpinner.succeed('All node_modules packages are public npm packages');
      }
    }
  }

  // Phase 3: Reconstruct files with internal packages knowledge
  console.log();
  console.log(chalk.bold("Reconstructing files:"));
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
            reconstructResult.filesWritten > 0 ? true : false
          )
          .map((f) => f.path)
          .slice(0, 100), // Limit manifest size
      });

      reconstructSpinner.succeed(
        `${chalk.cyan(bundleName)}: ${chalk.green(reconstructResult.filesWritten)} files written` +
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
      reconstructSpinner.fail(`${bundleName}: ${error}`);
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
  
  if (options.generatePackageJson && totalFilesWritten > 0) {
    const depSpinner = ora({
      text: "Analyzing dependencies...",
      color: "cyan",
    }).start();

    try {
      const sourceDir = join(options.output, hostname);
      const manifestPath = join(options.output, "manifest.json");
      const projectName = `${hostname}-reconstructed`;

      const { packageJson, tsconfig, stats } = await generateDependencyManifest(
        sourceDir,
        manifestPath,
        projectName,
        {
          onProgress: options.verbose ? (file) => {
            depSpinner.text = `Scanning imports: ${file.split('/').slice(-2).join('/')}`;
          } : undefined,
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
                  depSpinner.text = chalk.green(`Matched ${packageName}@${result.version} (${((result as any).similarity * 100).toFixed(0)}%)`);
                }
                break;
              case 'vendor-bundle':
                depSpinner.text = `Fingerprinting vendor bundles...`;
                break;
              case 'vendor-bundle-matched':
                depSpinner.text = chalk.magenta(`Vendor match: ${packageName}`);
                break;
              case 'peer-dep':
                depSpinner.text = `Inferring from peer dependencies...`;
                break;
              case 'peer-dep-inferred':
                if (result) {
                  depSpinner.text = chalk.cyan(`Inferred ${packageName}@${result.version} (peer-dep)`);
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
          onVendorBundleProgress: (completed, total, bundleFilename) => {
            depSpinner.text = `Vendor bundle fingerprinting... (${completed}/${total}) ${bundleFilename}`;
            depSpinner.render();
          },
          onClassificationProgress: (checked, total, packageName, classification) => {
            if (classification === 'workspace') {
              depSpinner.text = chalk.cyan(`Found workspace package: ${packageName}`);
            } else if (classification === 'internal') {
              depSpinner.text = chalk.cyan(`Found internal package: ${packageName}`);
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
          vendorBundles: vendorBundles.map(vb => ({
            url: vb.url,
            filename: vb.filename,
            content: vb.content,
            inferredPackage: vb.inferredPackage,
          })),
        }
      );

      dependencyStats = stats;

      // Write package.json to the site's output directory
      const packageJsonPath = join(sourceDir, "package.json");
      await writePackageJson(packageJsonPath, packageJson);

      // Write tsconfig.json with alias paths configured
      const tsconfigPath = join(sourceDir, "tsconfig.json");
      await writeTsConfig(tsconfigPath, tsconfig);

      depSpinner.succeed(`Generated package.json and tsconfig.json`);

      // Generate stub files for internal packages (index.ts files, SCSS declarations)
      const stubSpinner = ora({
        text: "Generating stub files for internal packages...",
        color: "cyan",
      }).start();

      try {
        // Extract installed package names from the generated package.json
        // Include regular deps, dev deps, internal deps, AND import aliases
        // This ensures aliased packages like 'sarsaparilla' -> '@fp/sarsaparilla' 
        // don't get stub files generated for them
        const installedPackages = new Set<string>();
        const pkgDeps = (packageJson as any).dependencies || {};
        const pkgDevDeps = (packageJson as any).devDependencies || {};
        const pkgInternal = (packageJson as any)._internalDependencies || {};
        const pkgAliases = (packageJson as any)._importAliases || {};
        for (const pkg of [
          ...Object.keys(pkgDeps), 
          ...Object.keys(pkgDevDeps),
          ...Object.keys(pkgInternal),
          ...Object.keys(pkgAliases),
        ]) {
          installedPackages.add(pkg);
        }

        const stubResult = await generateStubFiles(sourceDir, {
          internalPackages,
          installedPackages,
          generateScssDeclarations: true,
          generateDirectoryIndexes: true,
          generateCssModuleStubs: true,
          generateExternalStubs: true,
          onProgress: (msg) => {
            stubSpinner.text = msg;
          },
        });

        const totalGenerated = stubResult.indexFilesGenerated + 
          stubResult.directoryIndexesGenerated + 
          stubResult.scssDeclarationsGenerated + 
          stubResult.cssModuleStubsGenerated +
          stubResult.externalPackageStubsGenerated;

        if (totalGenerated > 0) {
          const parts = [];
          if (stubResult.indexFilesGenerated > 0) parts.push(`${stubResult.indexFilesGenerated} package indexes`);
          if (stubResult.directoryIndexesGenerated > 0) parts.push(`${stubResult.directoryIndexesGenerated} directory indexes`);
          if (stubResult.scssDeclarationsGenerated > 0) parts.push(`${stubResult.scssDeclarationsGenerated} SCSS declarations`);
          if (stubResult.cssModuleStubsGenerated > 0) parts.push(`${stubResult.cssModuleStubsGenerated} CSS module stubs`);
          if (stubResult.externalPackageStubsGenerated > 0) parts.push(`${stubResult.externalPackageStubsGenerated} external package stubs`);
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
      if (stats.bySource.lockfilePath > 0) sourceCounts.push(`${stats.bySource.lockfilePath} lockfile`);
      if (stats.bySource.banner > 0) sourceCounts.push(`${stats.bySource.banner} banner`);
      if (stats.bySource.versionConstant > 0) sourceCounts.push(`${stats.bySource.versionConstant} constant`);
      if (stats.bySource.packageJson > 0) sourceCounts.push(`${stats.bySource.packageJson} pkg.json`);
      if (stats.bySource.fingerprint > 0) sourceCounts.push(`${stats.bySource.fingerprint} fingerprint`);
      if (stats.bySource.fingerprintMinified > 0) sourceCounts.push(`${chalk.magenta(stats.bySource.fingerprintMinified)} vendor-bundle`);
      if (stats.bySource.peerDep > 0) sourceCounts.push(`${stats.bySource.peerDep} peer-dep`);
      if (stats.bySource.npmLatest > 0) sourceCounts.push(`${chalk.yellow(stats.bySource.npmLatest)} npm-latest`);
      
      if (sourceCounts.length > 0) {
        statusMsg += `\n    Version sources: ${sourceCounts.join(', ')}`;
      }
      
      // Show confidence breakdown
      const confCounts: string[] = [];
      if (stats.byConfidence.exact > 0) confCounts.push(`${chalk.green(stats.byConfidence.exact)} exact`);
      if (stats.byConfidence.high > 0) confCounts.push(`${chalk.cyan(stats.byConfidence.high)} high`);
      if (stats.byConfidence.medium > 0) confCounts.push(`${chalk.blue(stats.byConfidence.medium)} medium`);
      if (stats.byConfidence.low > 0) confCounts.push(`${chalk.yellow(stats.byConfidence.low)} low`);
      if (stats.byConfidence.unverified > 0) confCounts.push(`${chalk.gray(stats.byConfidence.unverified)} unverified`);
      
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
  console.log(chalk.gray("\n  ─".repeat(20)));
  console.log(chalk.bold("\n  Summary:"));
  console.log(`    ${chalk.green("✓")} Files extracted: ${chalk.bold(totalFilesWritten)}`);
  if (totalFilesSkipped > 0) {
    console.log(`    ${chalk.gray("○")} Files skipped: ${chalk.gray(totalFilesSkipped)}`);
  }
  if (dependencyStats) {
    console.log(`    ${chalk.green("✓")} Dependencies found: ${chalk.bold(dependencyStats.totalDependencies)}`);
  }
  console.log(`    ${chalk.blue("→")} Output directory: ${chalk.cyan(options.output)}`);
  
  if (!options.includeNodeModules && totalFilesSkipped > 0) {
    console.log(
      chalk.gray("\n  Tip: Use --include-node-modules to include dependency source files")
    );
  }
  
  if (!options.generatePackageJson && totalFilesWritten > 0) {
    console.log(
      chalk.gray("  Tip: Use --generate-package-json to create a package.json with dependencies")
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
