/**
 * AST Utilities for robust code analysis using SWC
 *
 * This module provides AST-based alternatives to regex patterns for analyzing
 * JavaScript/TypeScript source code. Using AST parsing ensures:
 * - Code inside strings is not matched
 * - Code inside comments is not matched
 * - Complex multi-line constructs are handled correctly
 * - Edge cases are handled properly
 */

import { parseSync } from '@swc/core';
import type { Module, Pattern } from '@swc/types';

/**
 * Safely parse source code with SWC, returning null on failure
 */
export function safeParse(
    sourceCode: string,
    filename: string = 'file.tsx',
): Module | null {
    try {
        const isTypeScript =
            filename.endsWith('.ts') || filename.endsWith('.tsx');
        const hasJSX = filename.endsWith('.tsx') || filename.endsWith('.jsx');

        return parseSync(sourceCode, {
            syntax: isTypeScript ? 'typescript' : 'ecmascript',
            tsx: hasJSX && isTypeScript,
            jsx: hasJSX && !isTypeScript,
        });
    } catch {
        return null;
    }
}

/**
 * Generic AST visitor that walks all nodes
 */
export function walkAST(
    node: unknown,
    visitor: (
        node: Record<string, unknown>,
        parent: Record<string, unknown> | null,
    ) => void,
    parent: Record<string, unknown> | null = null,
    visited: Set<object> = new Set(),
): void {
    if (!node || typeof node !== 'object' || visited.has(node)) {
        return;
    }
    visited.add(node);

    const obj = node as Record<string, unknown>;

    // Call visitor for this node
    visitor(obj, parent);

    // Recursively visit all properties
    for (const key in obj) {
        const value = obj[key];
        if (Array.isArray(value)) {
            for (const item of value) {
                walkAST(item, visitor, obj, visited);
            }
        } else if (value && typeof value === 'object') {
            walkAST(value, visitor, obj, visited);
        }
    }
}

/**
 * Extract all import sources from source code using AST
 * Returns the import path strings (not the specifiers)
 */
export function extractImportSourcesFromAST(
    sourceCode: string,
    filename: string = 'file.tsx',
): string[] {
    const ast = safeParse(sourceCode, filename);
    if (!ast) return [];

    const sources: string[] = [];

    for (const item of ast.body) {
        // Static imports: import x from 'mod', import { x } from 'mod', import 'mod'
        if (item.type === 'ImportDeclaration') {
            sources.push(item.source.value);
        }

        // Re-exports: export { x } from 'mod', export * from 'mod'
        if (item.type === 'ExportNamedDeclaration' && item.source) {
            sources.push(item.source.value);
        }
        if (item.type === 'ExportAllDeclaration') {
            sources.push(item.source.value);
        }
    }

    // Find dynamic imports and require calls
    walkAST(ast, (node) => {
        if (node.type === 'CallExpression') {
            const callee = node.callee as Record<string, unknown>;
            const args = node.arguments as Array<{
                expression: Record<string, unknown>;
            }>;

            // Dynamic import: import('mod')
            if (callee.type === 'Import' && args.length > 0) {
                const arg = args[0].expression;
                if (arg.type === 'StringLiteral') {
                    sources.push(arg.value as string);
                }
            }

            // Require: require('mod')
            if (
                callee.type === 'Identifier' &&
                callee.value === 'require' &&
                args.length > 0
            ) {
                const arg = args[0].expression;
                if (arg.type === 'StringLiteral') {
                    sources.push(arg.value as string);
                }
            }
        }
    });

    return sources;
}

/**
 * Extract named imports for a specific source path
 */
export function extractNamedImportsForSource(
    sourceCode: string,
    sourcePath: string,
    filename: string = 'file.tsx',
): string[] {
    const ast = safeParse(sourceCode, filename);
    if (!ast) return [];

    const names: string[] = [];

    for (const item of ast.body) {
        if (item.type === 'ImportDeclaration') {
            // Check if this import matches the source path (with or without extension)
            const importSource = item.source.value;
            const normalizedSourcePath = sourcePath.replace(
                /\.(tsx?|jsx?)$/,
                '',
            );
            const normalizedImportSource = importSource.replace(
                /\.(tsx?|jsx?)$/,
                '',
            );

            if (
                importSource === sourcePath ||
                importSource === normalizedSourcePath ||
                normalizedImportSource === normalizedSourcePath ||
                importSource.endsWith('/' + sourcePath) ||
                importSource.endsWith('/' + normalizedSourcePath)
            ) {
                for (const spec of item.specifiers) {
                    if (spec.type === 'ImportSpecifier') {
                        // Use imported name (the original export name from source module)
                        // For `import { Foo as Bar }`, imported.value = 'Foo', local.value = 'Bar'
                        // For `import { Foo }`, imported is null, local.value = 'Foo'
                        const importedName = spec.imported
                            ? spec.imported.value
                            : spec.local.value;
                        names.push(importedName);
                    } else if (spec.type === 'ImportDefaultSpecifier') {
                        // Default import - use 'default' as the import name
                        names.push('default');
                    } else if (spec.type === 'ImportNamespaceSpecifier') {
                        // Namespace import - use '*' as the import name
                        names.push('*');
                    }
                }
            }
        }
    }

    return names;
}

/**
 * Represents a member expression access like `styles.container` or `process.env.FOO`
 */
export interface MemberAccess {
    /** The base object name (e.g., 'styles', 'process') */
    object: string;
    /** The property path (e.g., ['container'] or ['env', 'FOO']) */
    properties: string[];
    /** Full path as string (e.g., 'styles.container', 'process.env.FOO') */
    fullPath: string;
}

/**
 * Extract member expression accesses for a specific object name
 * e.g., extractMemberAccesses(code, 'styles') finds styles.foo, styles['bar']
 */
export function extractMemberAccesses(
    sourceCode: string,
    objectName: string,
    filename: string = 'file.tsx',
): MemberAccess[] {
    // Try to parse as-is first
    let ast = safeParse(sourceCode, filename);

    // If parsing fails, try wrapping as an expression (for code snippets)
    if (!ast) {
        ast = safeParse(`(${sourceCode})`, filename);
    }

    // If still fails, try wrapping as JSX element (for JSX snippets like className={styles.foo})
    if (!ast) {
        ast = safeParse(`<div ${sourceCode}/>`, filename);
    }

    // If still fails, try wrapping the JSX brace content only
    if (!ast) {
        // Extract content from {expr} and try to parse that
        const braceMatch = sourceCode.match(/\{([^}]+)\}/);
        if (braceMatch) {
            ast = safeParse(`(${braceMatch[1]})`, filename);
        }
    }

    if (!ast) return [];

    const accesses: MemberAccess[] = [];

    walkAST(ast, (node) => {
        if (node.type === 'MemberExpression') {
            const result = extractMemberChain(node, objectName);
            if (result) {
                accesses.push(result);
            }
        }
    });

    return accesses;
}

/**
 * Helper to extract a member expression chain starting from a specific identifier
 */
function extractMemberChain(
    node: Record<string, unknown>,
    targetObject: string,
): MemberAccess | null {
    const properties: string[] = [];
    let current = node;

    // Walk up the member expression chain
    while (current.type === 'MemberExpression') {
        let property = current.property as Record<string, unknown>;

        // Handle Computed wrapper (SWC wraps bracket notation in Computed node)
        if (property.type === 'Computed') {
            property = property.expression as Record<string, unknown>;
        }

        // Get property name
        if (property.type === 'Identifier') {
            // Dot notation: styles.container
            // OR computed with identifier: styles[varName] - can't extract statically
            // Check if this is computed (bracket notation with variable)
            const isComputed =
                (current.property as Record<string, unknown>).type ===
                'Computed';
            if (isComputed) {
                // Computed with identifier: styles[varName] - can't extract statically
                return null;
            }
            properties.unshift(property.value as string);
        } else if (property.type === 'StringLiteral') {
            // Bracket notation with string: styles['btn-text'] or styles["btn-text"]
            properties.unshift(property.value as string);
        } else {
            // Unknown or dynamic property type - can't extract statically
            return null;
        }

        current = current.object as Record<string, unknown>;
    }

    // Check if base is our target identifier
    if (current.type === 'Identifier' && current.value === targetObject) {
        return {
            object: targetObject,
            properties,
            fullPath: `${targetObject}.${properties.join('.')}`,
        };
    }

    return null;
}

/**
 * Extract all process.env property accesses
 */
export function extractProcessEnvAccesses(
    sourceCode: string,
    filename: string = 'file.tsx',
): string[] {
    const ast = safeParse(sourceCode, filename);
    if (!ast) return [];

    const envVars: string[] = [];

    walkAST(ast, (node) => {
        if (node.type === 'MemberExpression') {
            // Check for process.env.X pattern
            const obj = node.object as Record<string, unknown>;
            if (obj.type === 'MemberExpression') {
                const baseObj = obj.object as Record<string, unknown>;
                const envProp = obj.property as Record<string, unknown>;

                if (
                    baseObj.type === 'Identifier' &&
                    baseObj.value === 'process' &&
                    envProp.type === 'Identifier' &&
                    envProp.value === 'env'
                ) {
                    // This is process.env.X - extract X
                    const prop = node.property as Record<string, unknown>;
                    if (prop.type === 'Identifier') {
                        envVars.push(prop.value as string);
                    } else if (prop.type === 'StringLiteral') {
                        envVars.push(prop.value as string);
                    }
                }
            }
        }
    });

    return envVars;
}

/**
 * Detect JSX usage in source code
 */
export function hasJSXElements(
    sourceCode: string,
    filename: string = 'file.tsx',
): boolean {
    const ast = safeParse(sourceCode, filename);
    if (!ast) return false;

    let hasJSX = false;

    walkAST(ast, (node) => {
        if (
            node.type === 'JSXElement' ||
            node.type === 'JSXFragment' ||
            node.type === 'JSXText'
        ) {
            hasJSX = true;
        }
    });

    return hasJSX;
}

/**
 * Detect which framework is imported (react, preact, solid-js, vue)
 */
export function detectFrameworkImports(
    sourceCode: string,
    filename: string = 'file.tsx',
): {
    react: boolean;
    preact: boolean;
    solid: boolean;
    vue: boolean;
} {
    const imports = extractImportSourcesFromAST(sourceCode, filename);

    return {
        react: imports.some((s) => s === 'react' || s.startsWith('react/')),
        preact: imports.some((s) => s === 'preact' || s.startsWith('preact/')),
        solid: imports.some(
            (s) => s === 'solid-js' || s.startsWith('solid-js/'),
        ),
        vue: imports.some((s) => s === 'vue' || s.startsWith('vue/')),
    };
}

/**
 * Detect module system (ESM vs CommonJS)
 */
export function detectModuleSystem(
    sourceCode: string,
    filename: string = 'file.tsx',
): { hasESM: boolean; hasCommonJS: boolean } {
    const ast = safeParse(sourceCode, filename);
    if (!ast) return { hasESM: false, hasCommonJS: false };

    let hasESM = false;
    let hasCommonJS = false;

    for (const item of ast.body) {
        // ESM indicators
        if (
            item.type === 'ImportDeclaration' ||
            item.type === 'ExportDeclaration' ||
            item.type === 'ExportDefaultDeclaration' ||
            item.type === 'ExportDefaultExpression' ||
            item.type === 'ExportNamedDeclaration' ||
            item.type === 'ExportAllDeclaration'
        ) {
            hasESM = true;
        }
    }

    // Check for CommonJS patterns
    walkAST(ast, (node) => {
        // require() calls
        if (
            node.type === 'CallExpression' &&
            (node.callee as Record<string, unknown>).type === 'Identifier' &&
            (node.callee as Record<string, unknown>).value === 'require'
        ) {
            hasCommonJS = true;
        }

        // module.exports
        if (node.type === 'MemberExpression') {
            const obj = node.object as Record<string, unknown>;
            const prop = node.property as Record<string, unknown>;
            if (
                obj.type === 'Identifier' &&
                obj.value === 'module' &&
                prop.type === 'Identifier' &&
                prop.value === 'exports'
            ) {
                hasCommonJS = true;
            }
        }

        // exports.X
        if (node.type === 'MemberExpression') {
            const obj = node.object as Record<string, unknown>;
            if (obj.type === 'Identifier' && obj.value === 'exports') {
                hasCommonJS = true;
            }
        }
    });

    return { hasESM, hasCommonJS };
}

/**
 * Detect environment APIs used (browser vs node)
 */
export function detectEnvironmentAPIs(
    sourceCode: string,
    filename: string = 'file.tsx',
): { hasBrowserAPIs: boolean; hasNodeAPIs: boolean } {
    const ast = safeParse(sourceCode, filename);
    if (!ast) return { hasBrowserAPIs: false, hasNodeAPIs: false };

    const browserGlobals = new Set([
        'window',
        'document',
        'localStorage',
        'sessionStorage',
        'navigator',
        'location',
        'history',
        'fetch',
        'XMLHttpRequest',
        'HTMLElement',
        'Element',
        'Node',
        'Event',
        'CustomEvent',
        'addEventListener',
        'removeEventListener',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'getComputedStyle',
        'matchMedia',
        'IntersectionObserver',
        'MutationObserver',
        'ResizeObserver',
        'WebSocket',
        'Worker',
        'ServiceWorker',
        'Blob',
        'File',
        'FileReader',
        'FormData',
        'URL',
        'URLSearchParams',
        'AbortController',
        'Headers',
        'Request',
        'Response',
    ]);

    const nodeGlobals = new Set([
        '__dirname',
        '__filename',
        'Buffer',
        'global',
    ]);

    const nodeModules = new Set([
        'fs',
        'path',
        'os',
        'crypto',
        'http',
        'https',
        'net',
        'stream',
        'child_process',
        'cluster',
        'dgram',
        'dns',
        'readline',
        'repl',
        'tls',
        'tty',
        'util',
        'vm',
        'zlib',
        'worker_threads',
        'perf_hooks',
    ]);

    let hasBrowserAPIs = false;
    let hasNodeAPIs = false;

    // Check for identifier usage
    walkAST(ast, (node) => {
        if (node.type === 'Identifier') {
            const name = node.value as string;
            if (browserGlobals.has(name)) {
                hasBrowserAPIs = true;
            }
            if (nodeGlobals.has(name)) {
                hasNodeAPIs = true;
            }
        }

        // Check for process.env (Node API)
        if (node.type === 'MemberExpression') {
            const obj = node.object as Record<string, unknown>;
            if (obj.type === 'Identifier' && obj.value === 'process') {
                hasNodeAPIs = true;
            }
        }
    });

    // Check imports for Node modules
    const imports = extractImportSourcesFromAST(sourceCode, filename);
    for (const imp of imports) {
        const moduleName = imp.startsWith('node:') ? imp.slice(5) : imp;
        if (nodeModules.has(moduleName)) {
            hasNodeAPIs = true;
        }
    }

    return { hasBrowserAPIs, hasNodeAPIs };
}

/**
 * Detect async/await, optional chaining, nullish coalescing usage
 */
export function detectESFeatures(
    sourceCode: string,
    filename: string = 'file.tsx',
): {
    asyncAwait: boolean;
    optionalChaining: boolean;
    nullishCoalescing: boolean;
} {
    const ast = safeParse(sourceCode, filename);
    if (!ast)
        return {
            asyncAwait: false,
            optionalChaining: false,
            nullishCoalescing: false,
        };

    let asyncAwait = false;
    let optionalChaining = false;
    let nullishCoalescing = false;

    walkAST(ast, (node) => {
        // Async functions
        if (
            (node.type === 'FunctionDeclaration' ||
                node.type === 'FunctionExpression' ||
                node.type === 'ArrowFunctionExpression') &&
            node.async === true
        ) {
            asyncAwait = true;
        }

        // Await expressions
        if (node.type === 'AwaitExpression') {
            asyncAwait = true;
        }

        // Optional chaining: obj?.prop, obj?.method(), obj?.[expr]
        if (node.type === 'OptionalChainingExpression') {
            optionalChaining = true;
        }
        // Also check member expressions with optional flag
        if (node.type === 'MemberExpression' && node.optional === true) {
            optionalChaining = true;
        }
        if (node.type === 'CallExpression' && node.optional === true) {
            optionalChaining = true;
        }

        // Nullish coalescing: a ?? b
        if (node.type === 'BinaryExpression' && node.operator === '??') {
            nullishCoalescing = true;
        }
    });

    return { asyncAwait, optionalChaining, nullishCoalescing };
}

/**
 * Extract function, class, and variable declaration names from source
 * Useful for code signature generation
 */
export function extractDeclarationNames(
    sourceCode: string,
    filename: string = 'file.tsx',
): string[] {
    const ast = safeParse(sourceCode, filename);
    if (!ast) return [];

    const names: string[] = [];

    function extractFromPattern(pattern: Pattern): void {
        switch (pattern.type) {
            case 'Identifier':
                names.push(pattern.value);
                break;
            case 'ObjectPattern':
                for (const prop of pattern.properties) {
                    if (prop.type === 'KeyValuePatternProperty') {
                        extractFromPattern(prop.value);
                    } else if (prop.type === 'AssignmentPatternProperty') {
                        names.push(prop.key.value);
                    } else if (prop.type === 'RestElement') {
                        extractFromPattern(prop.argument);
                    }
                }
                break;
            case 'ArrayPattern':
                for (const element of pattern.elements) {
                    if (element) {
                        extractFromPattern(element);
                    }
                }
                break;
            case 'RestElement':
                extractFromPattern(pattern.argument);
                break;
            case 'AssignmentPattern':
                extractFromPattern(pattern.left);
                break;
        }
    }

    for (const item of ast.body) {
        switch (item.type) {
            case 'FunctionDeclaration':
                names.push(item.identifier.value);
                break;

            case 'ClassDeclaration':
                names.push(item.identifier.value);
                break;

            case 'VariableDeclaration':
                for (const decl of item.declarations) {
                    extractFromPattern(decl.id);
                }
                break;

            case 'ExportDeclaration':
                // Handle exported declarations
                if (item.declaration) {
                    switch (item.declaration.type) {
                        case 'FunctionDeclaration':
                            names.push(item.declaration.identifier.value);
                            break;
                        case 'ClassDeclaration':
                            names.push(item.declaration.identifier.value);
                            break;
                        case 'VariableDeclaration':
                            for (const decl of item.declaration.declarations) {
                                extractFromPattern(decl.id);
                            }
                            break;
                    }
                }
                break;

            case 'ExportDefaultDeclaration':
                if (
                    item.decl.type === 'FunctionExpression' &&
                    item.decl.identifier
                ) {
                    names.push(item.decl.identifier.value);
                } else if (
                    item.decl.type === 'ClassExpression' &&
                    item.decl.identifier
                ) {
                    names.push(item.decl.identifier.value);
                }
                break;
        }
    }

    return names;
}

/**
 * Strip comments from source code using AST-based approach
 * This correctly handles comments inside strings (doesn't remove them)
 */
export function stripComments(sourceCode: string): string {
    // SWC doesn't have a direct "strip comments" API, but we can use
    // a simple state machine that's aware of string literals

    let result = '';
    let i = 0;
    const len = sourceCode.length;

    while (i < len) {
        // Check for string literals
        if (
            sourceCode[i] === '"' ||
            sourceCode[i] === "'" ||
            sourceCode[i] === '`'
        ) {
            const quote = sourceCode[i];
            result += quote;
            i++;

            // Handle template literals specially
            if (quote === '`') {
                while (i < len) {
                    if (sourceCode[i] === '\\' && i + 1 < len) {
                        result += sourceCode[i] + sourceCode[i + 1];
                        i += 2;
                    } else if (sourceCode[i] === '`') {
                        result += sourceCode[i];
                        i++;
                        break;
                    } else if (
                        sourceCode[i] === '$' &&
                        sourceCode[i + 1] === '{'
                    ) {
                        // Template expression - need to handle nested braces
                        result += '${';
                        i += 2;
                        let braceDepth = 1;
                        while (i < len && braceDepth > 0) {
                            if (sourceCode[i] === '{') braceDepth++;
                            else if (sourceCode[i] === '}') braceDepth--;
                            result += sourceCode[i];
                            i++;
                        }
                    } else {
                        result += sourceCode[i];
                        i++;
                    }
                }
            } else {
                // Regular string
                while (i < len) {
                    if (sourceCode[i] === '\\' && i + 1 < len) {
                        result += sourceCode[i] + sourceCode[i + 1];
                        i += 2;
                    } else if (sourceCode[i] === quote) {
                        result += sourceCode[i];
                        i++;
                        break;
                    } else if (sourceCode[i] === '\n') {
                        // Unterminated string - just break
                        break;
                    } else {
                        result += sourceCode[i];
                        i++;
                    }
                }
            }
        }
        // Check for single-line comment
        else if (sourceCode[i] === '/' && sourceCode[i + 1] === '/') {
            // Skip until end of line
            while (i < len && sourceCode[i] !== '\n') {
                i++;
            }
        }
        // Check for multi-line comment
        else if (sourceCode[i] === '/' && sourceCode[i + 1] === '*') {
            i += 2;
            while (i < len) {
                if (sourceCode[i] === '*' && sourceCode[i + 1] === '/') {
                    i += 2;
                    break;
                }
                i++;
            }
        }
        // Check for regex literals (simplified - may not cover all edge cases)
        else if (sourceCode[i] === '/' && i > 0) {
            // Check if this could be a regex (after certain tokens)
            const before = sourceCode.slice(Math.max(0, i - 10), i).trim();
            const regexPreceding =
                /[=(:,\[!&|?{};]$/.test(before) ||
                before === '' ||
                /\breturn$/.test(before);

            if (regexPreceding) {
                result += sourceCode[i];
                i++;
                // Consume regex
                while (
                    i < len &&
                    sourceCode[i] !== '/' &&
                    sourceCode[i] !== '\n'
                ) {
                    if (sourceCode[i] === '\\' && i + 1 < len) {
                        result += sourceCode[i] + sourceCode[i + 1];
                        i += 2;
                    } else if (sourceCode[i] === '[') {
                        // Character class
                        result += sourceCode[i];
                        i++;
                        while (
                            i < len &&
                            sourceCode[i] !== ']' &&
                            sourceCode[i] !== '\n'
                        ) {
                            if (sourceCode[i] === '\\' && i + 1 < len) {
                                result += sourceCode[i] + sourceCode[i + 1];
                                i += 2;
                            } else {
                                result += sourceCode[i];
                                i++;
                            }
                        }
                    } else {
                        result += sourceCode[i];
                        i++;
                    }
                }
                if (i < len && sourceCode[i] === '/') {
                    result += sourceCode[i];
                    i++;
                    // Consume flags
                    while (i < len && /[gimsuy]/.test(sourceCode[i])) {
                        result += sourceCode[i];
                        i++;
                    }
                }
            } else {
                result += sourceCode[i];
                i++;
            }
        } else {
            result += sourceCode[i];
            i++;
        }
    }

    return result;
}
