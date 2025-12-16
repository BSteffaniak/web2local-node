/**
 * `@web2local/stubs`
 *
 * Stub file generation for missing sources in reconstructed projects.
 *
 * This package provides utilities for generating placeholder files when source maps
 * don't contain all the original source files. It handles:
 *
 * - **Universal Stubs**: Proxy-based stubs that handle any runtime operation without throwing
 * - **CSS Recovery**: Extract CSS from source maps or generate stubs for CSS modules
 * - **SCSS Variable Stubs**: Detect and stub undefined SCSS variables
 * - **Package Index Files**: Generate barrel files for packages missing entry points
 * - **Type File Stubs**: Create type definitions for missing .types.ts files
 * - **Environment Declarations**: Generate env.d.ts for process.env type coverage
 *
 * @example
 * ```typescript
 * import { generateStubFiles, createUniversalStub } from '@web2local/stubs';
 *
 * // Generate all stub files for a reconstructed project
 * const result = await generateStubFiles('./output', {
 *   internalPackages: new Set(['@company/ui']),
 *   onProgress: console.log,
 * });
 *
 * // Create a universal stub for a missing export
 * const missingExport = createUniversalStub('missingExport');
 * missingExport.foo.bar(); // Works without throwing
 * ```
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
