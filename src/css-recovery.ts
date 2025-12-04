/**
 * CSS Recovery Module
 *
 * Provides robust CSS/SCSS/SASS/LESS source recovery from bundled websites.
 * Uses a tiered approach to maximize source recovery:
 *
 * TIER 1: CSS Source Map Extraction (Best Quality)
 *   - Parse CSS bundles for sourceMappingURL comments
 *   - Fetch and extract CSS-specific source maps
 *   - Returns: Original .scss/.sass/.less/.css source files
 *
 * TIER 2: Smart CSS Module Stubbing (Functional)
 *   - Scan TS/JS files for CSS module imports
 *   - Extract used class names from code (styles.foo, styles['bar'])
 *   - Generate stub CSS module files with extracted class names
 *   - Generate .d.ts type declarations
 *   - Returns: Compilable placeholder files
 *
 * TIER 3: Global Declaration Fallback (Minimal)
 *   - Generate global.d.ts with wildcard module declarations
 *   - Returns: TypeScript compiles, but styles are generic
 *
 * The pipeline applies tiers in order, with each tier filling gaps left
 * by the previous one. This ensures maximum recovery regardless of the
 * site's build configuration.
 */

import { normalizePath } from './sourcemap.js';
import { dirname, basename } from 'path';
import { BROWSER_HEADERS, robustFetch } from './http.js';
import {
    extractImportSourcesFromAST,
    extractMemberAccesses,
    safeParse,
    walkAST,
} from './ast-utils.js';

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

/**
 * Represents a recovered CSS/SCSS/SASS/LESS source file
 */
export interface CssSourceFile {
    /** Relative path where this file should be written */
    path: string;
    /** File content (original source or generated stub) */
    content: string;
    /** How this file was recovered */
    source: 'source-map' | 'stub' | 'declaration';
    /** Original import path that referenced this file */
    importPath?: string;
}

/**
 * Information about a CSS module import found in source code
 */
export interface CssModuleImport {
    /** The import path (e.g., './Button.module.scss') */
    importPath: string;
    /** The file containing the import */
    sourceFile: string;
    /** The variable name used (e.g., 'styles') */
    variableName: string;
    /** Class names extracted from usage (e.g., ['container', 'btn-text']) */
    usedClassNames: string[];
}

/**
 * Result from CSS source map extraction (Tier 1)
 */
export interface CssSourceMapResult {
    /** URL of the CSS bundle */
    cssUrl: string;
    /** URL of the source map (if found) */
    sourceMapUrl: string | null;
    /** Extracted source files */
    files: CssSourceFile[];
    /** Any errors during extraction */
    errors: string[];
}

/**
 * Result from CSS module analysis (Tier 2)
 */
export interface CssModuleAnalysisResult {
    /** All CSS module imports found */
    imports: CssModuleImport[];
    /** Imports that need stub files (not covered by Tier 1) */
    needsStubs: CssModuleImport[];
    /** Generated stub files */
    stubs: CssSourceFile[];
}

/**
 * Overall CSS recovery result
 */
export interface CssRecoveryResult {
    /** Files recovered from CSS source maps (Tier 1) */
    sourceMapFiles: CssSourceFile[];
    /** Files recovered via stub generation (Tier 2) */
    stubFiles: CssSourceFile[];
    /** Global declarations generated (Tier 3) */
    globalDeclarations: CssSourceFile[];
    /** Statistics */
    stats: {
        cssSourceMapsFound: number;
        cssSourceMapsExtracted: number;
        cssModuleImportsFound: number;
        stubsGenerated: number;
        globalDeclarationsGenerated: number;
    };
    /** Errors encountered */
    errors: string[];
}

/**
 * Options for CSS recovery
 */
export interface CssRecoveryOptions {
    /** CSS bundle URLs to check for source maps */
    cssBundles: Array<{ url: string; content?: string }>;
    /** Source files to scan for CSS imports */
    sourceFiles: Array<{ path: string; content: string }>;
    /** Directory where recovered files will be written */
    outputDir: string;
    /** Progress callback */
    onProgress?: (message: string) => void;
    /** Skip specific tiers */
    skipTiers?: ('source-map' | 'stub' | 'global-declaration')[];
}

// ============================================================================
// TIER 1: CSS SOURCE MAP EXTRACTION
// ============================================================================

/**
 * Finds the sourceMappingURL in CSS content.
 * CSS uses a different comment syntax: /*# sourceMappingURL=... *\/
 *
 * @param content - CSS file content
 * @returns The source map URL if found
 */
export function findCssSourceMappingUrl(content: string): string | null {
    // Match CSS-style source map comments: /*# source + MappingURL=... */
    // Note: The pattern description above is split to prevent Vite from
    // mistakenly parsing it as an actual source map reference.
    const match = content.match(/\/\*#\s*sourceMappingURL=([^\s*]+)\s*\*\//);
    return match?.[1] || null;
}

/**
 * Checks if a URL is a data URI (inline source map)
 */
export function isDataUri(url: string): boolean {
    return url.startsWith('data:');
}

/**
 * Extracts source map from a data URI
 */
export function extractDataUriSourceMap(dataUri: string): object | null {
    try {
        // Format: data:application/json;base64,<base64-encoded-json>
        const match = dataUri.match(/^data:application\/json;base64,(.+)$/);
        if (!match) return null;

        const decoded = Buffer.from(match[1], 'base64').toString('utf-8');
        return JSON.parse(decoded);
    } catch {
        return null;
    }
}

/**
 * Resolves a relative source map URL against a base CSS URL
 */
export function resolveSourceMapUrl(
    cssUrl: string,
    sourceMapUrl: string,
): string {
    if (
        sourceMapUrl.startsWith('http://') ||
        sourceMapUrl.startsWith('https://')
    ) {
        return sourceMapUrl;
    }

    if (isDataUri(sourceMapUrl)) {
        return sourceMapUrl;
    }

    // Resolve relative URL
    const baseUrl = new URL(cssUrl);
    return new URL(sourceMapUrl, baseUrl).toString();
}

/**
 * Extracts source files from a CSS source map.
 *
 * @param cssUrl - URL of the CSS bundle
 * @param cssContent - Content of the CSS bundle (to find sourceMappingURL)
 * @returns Extracted source files and metadata
 */
export async function extractCssSourceMap(
    cssUrl: string,
    cssContent?: string,
): Promise<CssSourceMapResult> {
    const result: CssSourceMapResult = {
        cssUrl,
        sourceMapUrl: null,
        files: [],
        errors: [],
    };

    try {
        // Get CSS content if not provided
        let content = cssContent;
        if (!content) {
            const response = await robustFetch(cssUrl, {
                headers: BROWSER_HEADERS,
            });
            if (!response.ok) {
                result.errors.push(
                    `HTTP ${response.status} ${response.statusText} fetching CSS from ${cssUrl}`,
                );
                return result;
            }
            content = await response.text();
        }

        // Find source map URL
        const sourceMapUrl = findCssSourceMappingUrl(content);
        if (!sourceMapUrl) {
            // No source map reference found - not an error, just no source map
            return result;
        }

        result.sourceMapUrl = sourceMapUrl;

        // Get source map content
        let sourceMap: {
            version: number;
            sources?: string[];
            sourcesContent?: (string | null)[];
            sourceRoot?: string;
        };

        if (isDataUri(sourceMapUrl)) {
            // Inline source map
            const extracted = extractDataUriSourceMap(sourceMapUrl);
            if (!extracted) {
                result.errors.push(
                    `Failed to parse inline CSS source map from ${cssUrl}`,
                );
                return result;
            }
            sourceMap = extracted as typeof sourceMap;
        } else {
            // External source map
            const fullSourceMapUrl = resolveSourceMapUrl(cssUrl, sourceMapUrl);
            result.sourceMapUrl = fullSourceMapUrl;

            const response = await robustFetch(fullSourceMapUrl, {
                headers: BROWSER_HEADERS,
            });
            if (!response.ok) {
                result.errors.push(
                    `HTTP ${response.status} ${response.statusText} fetching CSS source map from ${fullSourceMapUrl}`,
                );
                return result;
            }

            const text = await response.text();
            try {
                sourceMap = JSON.parse(text);
            } catch (e) {
                const preview = text.slice(0, 1000).replace(/\n/g, ' ');
                result.errors.push(
                    `Failed to parse CSS source map JSON from ${fullSourceMapUrl}: ${e}\n      Response preview: "${preview}${text.length > 1000 ? '...' : ''}"`,
                );
                return result;
            }
        }

        // Validate source map
        if (!sourceMap.sources || !sourceMap.sourcesContent) {
            result.errors.push(
                `CSS source map from ${result.sourceMapUrl} is missing sources or sourcesContent arrays`,
            );
            return result;
        }

        const sourceRoot = sourceMap.sourceRoot || '';

        // Extract source files
        for (let i = 0; i < sourceMap.sources.length; i++) {
            const sourcePath = sourceMap.sources[i];
            const content = sourceMap.sourcesContent[i];

            // Skip null/undefined content
            if (content === null || content === undefined) {
                continue;
            }

            // Normalize the path
            const normalizedPath = normalizePath(sourcePath, sourceRoot);

            result.files.push({
                path: normalizedPath,
                content,
                source: 'source-map',
            });
        }

        return result;
    } catch (error) {
        result.errors.push(`Error extracting CSS source map: ${error}`);
        return result;
    }
}

/**
 * Processes multiple CSS bundles and extracts all available source maps.
 */
export async function extractAllCssSourceMaps(
    cssBundles: Array<{ url: string; content?: string }>,
    onProgress?: (completed: number, total: number, url: string) => void,
): Promise<CssSourceFile[]> {
    const allFiles: CssSourceFile[] = [];

    for (let i = 0; i < cssBundles.length; i++) {
        const bundle = cssBundles[i];
        onProgress?.(i, cssBundles.length, bundle.url);

        const result = await extractCssSourceMap(bundle.url, bundle.content);
        allFiles.push(...result.files);
    }

    return allFiles;
}

// ============================================================================
// TIER 2: CSS MODULE STUB GENERATION
// ============================================================================

/**
 * Scans source files for CSS module imports using AST parsing.
 * This properly handles imports in all contexts (not just top-level)
 * and ignores code inside strings/comments.
 *
 * Detects patterns like:
 *   import styles from './Button.module.scss'
 *   import * as css from './styles.module.css'
 *   const styles = require('./Component.module.sass')
 */
export function findCssModuleImports(
    sourceFiles: Array<{ path: string; content: string }>,
): CssModuleImport[] {
    const imports: CssModuleImport[] = [];

    for (const file of sourceFiles) {
        // Use AST to find all CSS module imports
        const cssModulePattern = /\.module\.(scss|sass|css|less)$/;

        // Parse the file to find CSS module imports and their variable names
        const ast = safeParse(file.content, file.path);
        if (!ast) continue;

        // Map to store import path -> variable name
        const cssImportVars = new Map<string, string>();

        for (const item of ast.body) {
            // Handle ESM imports: import styles from './Button.module.scss'
            if (item.type === 'ImportDeclaration') {
                const importPath = item.source.value;
                if (cssModulePattern.test(importPath)) {
                    // Get the variable name from specifiers
                    for (const spec of item.specifiers) {
                        if (
                            spec.type === 'ImportDefaultSpecifier' ||
                            spec.type === 'ImportNamespaceSpecifier'
                        ) {
                            cssImportVars.set(importPath, spec.local.value);
                        }
                    }
                }
            }
        }

        // Also look for require() calls in variable declarations
        walkAST(ast, (node) => {
            // Handle: const styles = require('./Button.module.scss')
            if (node.type === 'VariableDeclarator') {
                const id = node.id as Record<string, unknown>;
                const init = node.init as Record<string, unknown> | null;

                if (
                    id.type === 'Identifier' &&
                    init?.type === 'CallExpression'
                ) {
                    const callee = init.callee as Record<string, unknown>;
                    const args = init.arguments as Array<{
                        expression: Record<string, unknown>;
                    }>;

                    if (
                        callee.type === 'Identifier' &&
                        callee.value === 'require' &&
                        args.length > 0
                    ) {
                        const arg = args[0].expression;
                        if (arg.type === 'StringLiteral') {
                            const importPath = arg.value as string;
                            if (cssModulePattern.test(importPath)) {
                                cssImportVars.set(
                                    importPath,
                                    id.value as string,
                                );
                            }
                        }
                    }
                }
            }
        });

        // For each CSS module import, extract used class names
        for (const [importPath, variableName] of cssImportVars) {
            const usedClassNames = extractUsedClassNames(
                file.content,
                variableName,
                file.path,
            );

            imports.push({
                importPath,
                sourceFile: file.path,
                variableName,
                usedClassNames: Array.from(usedClassNames),
            });
        }
    }

    return imports;
}

/**
 * Extracts class names used from a CSS module variable using AST parsing.
 * This properly handles code in all contexts and ignores strings/comments.
 *
 * Detects patterns like:
 *   styles.container
 *   styles['btn-text']
 *   styles["nav-item"]
 */
export function extractUsedClassNames(
    content: string,
    variableName: string,
    filename: string = 'file.tsx',
): Set<string> {
    const classNames = new Set<string>();

    // Use AST-based member access extraction
    const accesses = extractMemberAccesses(content, variableName, filename);

    for (const access of accesses) {
        // Get the first property (the class name)
        if (access.properties.length > 0) {
            const className = access.properties[0];
            // Filter out common method names that aren't CSS classes
            if (
                !['toString', 'valueOf', 'hasOwnProperty'].includes(className)
            ) {
                classNames.add(className);
            }
        }
    }

    return classNames;
}

/**
 * Resolves an import path relative to a source file.
 * Returns a normalized relative path (not absolute).
 */
export function resolveImportPath(
    sourceFile: string,
    importPath: string,
): string {
    if (importPath.startsWith('./') || importPath.startsWith('../')) {
        const sourceDir = dirname(sourceFile);
        // Join paths and normalize (don't use resolve which creates absolute paths)
        const joined = sourceDir ? `${sourceDir}/${importPath}` : importPath;

        // Normalize the path: remove ./ and resolve .. segments
        const segments = joined.split('/').filter(Boolean);
        const resolved: string[] = [];

        for (const segment of segments) {
            if (segment === '..') {
                if (
                    resolved.length > 0 &&
                    resolved[resolved.length - 1] !== '..'
                ) {
                    resolved.pop();
                } else {
                    resolved.push(segment);
                }
            } else if (segment !== '.') {
                resolved.push(segment);
            }
        }

        return resolved.join('/');
    }
    // Assume it's relative to src/ or root
    return importPath.replace(/^\.\//, '');
}

/**
 * Generates a stub CSS module file with placeholder styles.
 */
export function generateCssModuleStub(
    importInfo: CssModuleImport,
): CssSourceFile {
    const resolvedPath = resolveImportPath(
        importInfo.sourceFile,
        importInfo.importPath,
    );

    const lines = [
        '// Auto-generated stub - original source not available in source maps',
        '// This file was created based on CSS module usage analysis',
        '',
    ];

    if (importInfo.usedClassNames.length === 0) {
        lines.push('// No class names were detected in the source code');
        lines.push('// Add your styles here');
    } else {
        for (const className of importInfo.usedClassNames) {
            lines.push(`.${className} {`);
            lines.push(`  // Used in: ${importInfo.sourceFile}`);
            lines.push('}');
            lines.push('');
        }
    }

    return {
        path: resolvedPath,
        content: lines.join('\n'),
        source: 'stub',
        importPath: importInfo.importPath,
    };
}

/**
 * Generates a TypeScript declaration file for a CSS module.
 */
export function generateCssModuleDeclaration(
    importInfo: CssModuleImport,
): CssSourceFile {
    const resolvedPath =
        resolveImportPath(importInfo.sourceFile, importInfo.importPath) +
        '.d.ts';

    const lines = [
        '// Auto-generated TypeScript declaration for CSS module',
        '// This file was created based on CSS module usage analysis',
        '',
        'declare const styles: {',
    ];

    for (const className of importInfo.usedClassNames) {
        // Use quoted syntax for kebab-case class names
        if (className.includes('-')) {
            lines.push(`  readonly '${className}': string;`);
        } else {
            lines.push(`  readonly ${className}: string;`);
        }
    }

    // Add index signature for any other classes
    lines.push('  readonly [key: string]: string;');
    lines.push('};');
    lines.push('');
    lines.push('export default styles;');

    return {
        path: resolvedPath,
        content: lines.join('\n'),
        source: 'declaration',
        importPath: importInfo.importPath,
    };
}

/**
 * Analyzes source files and generates stubs for missing CSS modules.
 */
export async function generateCssModuleStubs(
    sourceFiles: Array<{ path: string; content: string }>,
    existingCssFiles: Set<string>,
    onProgress?: (message: string) => void,
): Promise<CssModuleAnalysisResult> {
    onProgress?.('Scanning for CSS module imports...');

    const imports = findCssModuleImports(sourceFiles);
    const needsStubs: CssModuleImport[] = [];
    const stubs: CssSourceFile[] = [];

    // Determine which imports need stubs
    for (const imp of imports) {
        const resolvedPath = resolveImportPath(imp.sourceFile, imp.importPath);

        // Check if we already have this file from source maps
        if (existingCssFiles.has(resolvedPath)) {
            continue;
        }

        needsStubs.push(imp);
    }

    // Generate stubs and declarations
    onProgress?.(`Generating stubs for ${needsStubs.length} CSS modules...`);

    // Group imports by resolved path to combine class names from multiple usages
    const importsByPath = new Map<string, CssModuleImport>();
    for (const imp of needsStubs) {
        const resolvedPath = resolveImportPath(imp.sourceFile, imp.importPath);
        const existing = importsByPath.get(resolvedPath);

        if (existing) {
            // Merge class names
            for (const className of imp.usedClassNames) {
                if (!existing.usedClassNames.includes(className)) {
                    existing.usedClassNames.push(className);
                }
            }
        } else {
            importsByPath.set(resolvedPath, { ...imp });
        }
    }

    // Generate stubs for unique paths
    for (const imp of importsByPath.values()) {
        stubs.push(generateCssModuleStub(imp));
        stubs.push(generateCssModuleDeclaration(imp));
    }

    return {
        imports,
        needsStubs,
        stubs,
    };
}

// ============================================================================
// TIER 3: GLOBAL DECLARATION FALLBACK
// ============================================================================

/**
 * Generates a global.d.ts file with wildcard CSS module declarations.
 */
export function generateGlobalCssDeclarations(): CssSourceFile {
    const content = `// Auto-generated CSS module declarations
// This file provides TypeScript type support for CSS module imports

// CSS Modules (*.module.scss, *.module.css, etc.)
declare module '*.module.scss' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

declare module '*.module.sass' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

declare module '*.module.less' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

// Raw CSS imports (non-module)
declare module '*.scss' {
  const content: string;
  export default content;
}

declare module '*.css' {
  const content: string;
  export default content;
}

declare module '*.sass' {
  const content: string;
  export default content;
}

declare module '*.less' {
  const content: string;
  export default content;
}
`;

    return {
        path: 'global.d.ts',
        content,
        source: 'declaration',
    };
}

// ============================================================================
// MAIN PIPELINE
// ============================================================================

/**
 * Main CSS recovery pipeline.
 *
 * Applies all tiers in order:
 * 1. Extract from CSS source maps (best quality)
 * 2. Generate stubs for missing CSS modules (functional)
 * 3. Generate global declarations for any remaining imports (fallback)
 */
export async function recoverCssSources(
    options: CssRecoveryOptions,
): Promise<CssRecoveryResult> {
    const result: CssRecoveryResult = {
        sourceMapFiles: [],
        stubFiles: [],
        globalDeclarations: [],
        stats: {
            cssSourceMapsFound: 0,
            cssSourceMapsExtracted: 0,
            cssModuleImportsFound: 0,
            stubsGenerated: 0,
            globalDeclarationsGenerated: 0,
        },
        errors: [],
    };

    const skipTiers = new Set(options.skipTiers || []);

    // -------------------------------------------------------------------------
    // TIER 1: CSS Source Map Extraction
    // -------------------------------------------------------------------------
    if (!skipTiers.has('source-map')) {
        options.onProgress?.('Tier 1: Extracting CSS source maps...');

        for (const bundle of options.cssBundles) {
            const extractResult = await extractCssSourceMap(
                bundle.url,
                bundle.content,
            );

            if (extractResult.sourceMapUrl) {
                result.stats.cssSourceMapsFound++;
            }

            if (extractResult.files.length > 0) {
                result.stats.cssSourceMapsExtracted++;
                result.sourceMapFiles.push(...extractResult.files);
            }

            result.errors.push(...extractResult.errors);
        }
    }

    // -------------------------------------------------------------------------
    // TIER 2: CSS Module Stub Generation
    // -------------------------------------------------------------------------
    if (!skipTiers.has('stub')) {
        options.onProgress?.('Tier 2: Generating CSS module stubs...');

        // Build set of existing CSS files from Tier 1
        const existingCssFiles = new Set(
            result.sourceMapFiles.map((f) => f.path),
        );

        const stubResult = await generateCssModuleStubs(
            options.sourceFiles,
            existingCssFiles,
            options.onProgress,
        );

        result.stats.cssModuleImportsFound = stubResult.imports.length;
        result.stats.stubsGenerated = stubResult.stubs.filter(
            (s) => s.source === 'stub',
        ).length;
        result.stubFiles.push(...stubResult.stubs);
    }

    // -------------------------------------------------------------------------
    // TIER 3: Global Declaration Fallback
    // -------------------------------------------------------------------------
    if (!skipTiers.has('global-declaration')) {
        options.onProgress?.('Tier 3: Generating global CSS declarations...');

        const globalDecl = generateGlobalCssDeclarations();
        result.globalDeclarations.push(globalDecl);
        result.stats.globalDeclarationsGenerated = 1;
    }

    return result;
}
