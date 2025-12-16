/**
 * `@web2local/ast`
 *
 * AST parsing and analysis utilities using SWC
 */

// Core AST utilities
export {
    safeParse,
    walkAST,
    extractImportSourcesFromAST,
    extractNamedImportsForSource,
    extractMemberAccesses,
    extractJSXMemberAccesses,
    extractProcessEnvAccesses,
    hasJSXElements,
    detectFrameworkImports,
    detectModuleSystem,
    detectEnvironmentAPIs,
    detectESFeatures,
    extractDeclarationNames,
    stripComments,
    type MemberAccess,
    type JSXMemberAccess,
} from './utils.js';

// Import extraction
export {
    extractImportsFromSource,
    categorizeImport,
    isNodeBuiltin,
    NODE_BUILTINS,
    type ImportDeclarationInfo,
    type NamedImportInfo,
} from './import-extractor.js';

// Export extraction
export {
    extractExportsFromSource,
    type FileExports,
} from './export-extractor.js';
