/**
 * @web2local/stubs
 *
 * Stub file generation for missing sources
 */

// Universal stub
export { createUniversalStub, __stub__ } from './universal.js';

// CSS recovery and stubs
export {
    findCssSourceMappingUrl,
    isDataUri,
    extractDataUriSourceMap,
    resolveSourceMapUrl,
    extractCssSourceMap,
    extractAllCssSourceMaps,
    findCssModuleImports,
    extractUsedClassNames,
    resolveImportPath,
    generateCssModuleStub,
    generateCssModuleDeclaration,
    generateCssModuleStubs,
    generateGlobalCssDeclarations,
    extractCssBaseName,
    matchCssImportToBundle,
    generateCssStubFromBundle,
    recoverCssSources,
    type CssSourceFile,
    type CssModuleImport,
    type CssSourceMapResult,
    type CssModuleAnalysisResult,
    type CssRecoveryResult,
    type CapturedCssBundle,
    type CssRecoveryOptions,
} from './css-recovery.js';

// SCSS variable stub generation
export {
    parseScss,
    extractVariableDefinitions,
    extractVariableUsages,
    analyzeScssFile,
    findUndefinedVariables,
    generateVariableStubContent,
    getStubFilename,
    hasStubImport,
    injectStubImport,
    generateScssVariableStubs,
    type ScssVariableAnalysis,
    type ScssVariableStubResult,
} from './scss-variable-stub.js';

// Generator utilities (will be split later)
export * from './generator.js';
