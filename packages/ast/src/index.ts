/**
 * AST parsing and analysis utilities for JavaScript/TypeScript source code.
 *
 * This package provides robust, AST-based alternatives to regex patterns for
 * analyzing JavaScript/TypeScript source code using SWC. Key features include:
 *
 * - **Import extraction** - Extract static imports, dynamic imports, and require() calls
 * - **Export extraction** - Extract named exports, default exports, and type exports
 * - **Code analysis** - Detect frameworks, module systems, environment APIs, and ES features
 * - **Member access tracking** - Extract property accesses for CSS modules, process.env, etc.
 *
 * Using AST parsing ensures code inside strings and comments is not matched,
 * and complex multi-line constructs are handled correctly.
 *
 * @packageDocumentation
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
