// @web2local/analyzer

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
