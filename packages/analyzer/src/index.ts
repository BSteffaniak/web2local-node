/**
 * `@web2local/analyzer`
 *
 * This package provides source code analysis utilities for the web2local project.
 * It includes tools for:
 *
 * - **Asset stub resolution**: Detecting and resolving bundler-generated asset stubs
 * - **Dependency analysis**: Extracting and analyzing package dependencies from source files
 * - **Export resolution**: Finding actual sources for missing exports in packages
 * - **Dynamic import resolution**: Resolving missing dynamic imports from JS/CSS bundles
 * - **Import usage analysis**: Analyzing how imports are used in source code
 * - **Index reconstruction**: Reconstructing proper index files for internal modules
 * - **Version detection**: Detecting package versions through multiple strategies
 * - **Source fingerprinting**: Matching extracted source to npm package versions
 * - **Peer dependency inference**: Inferring package versions from peer dependency relationships
 *
 * @packageDocumentation
 */

// Asset stub resolver
export {
    analyzeAssetStub,
    generatePlaceholderContent,
    findAssetStubs,
    resolveAssetStubs,
    findAndResolveAssetStubs,
} from './asset-stub-resolver.js';

// Dependency analyzer
export {
    detectImportAliases,
    buildAliasPathMappings,
    extractBareImports,
    inferAliasesFromImports,
    generateDependencyManifest,
    writePackageJson,
    writeTsConfig,
    extractNodeModulesPackages,
    identifyInternalPackages,
    isPublicNpmPackage,
    validateNpmVersion,
    validateNpmVersionsBatch,
    type AliasMap,
} from './dependency-analyzer.js';

// Export resolver
export {
    findNamespaceSourceFile,
    findDependencyReexport,
    resolvePackageMissingExports,
    generateExportStatement,
    groupResolutionsByType,
} from './export-resolver.js';

// Dynamic import resolver
export {
    extractDynamicImportPaths,
    extractCssImportUrls,
    resolveRelativePath,
    resolveMissingDynamicImports,
    updateManifestWithResolvedFiles,
} from './dynamic-import-resolver.js';

// Import usage analyzer
export {
    analyzeImportUsage,
    aggregateImportUsage,
    type ImportUsageInfo,
} from './import-usage-analyzer.js';

// Index reconstructor
export {
    reconstructAllIndexes,
    generateAliasTargetIndexFiles,
} from './index-reconstructor.js';
