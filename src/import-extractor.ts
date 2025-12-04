import { parseSync } from '@swc/core';
import type { ModuleItem, ImportDeclaration, CallExpression } from '@swc/types';

/**
 * Information about a named import specifier
 */
export interface NamedImportInfo {
    /** The local name (what it's called in this file) */
    name: string;
    /** Whether this specific import is type-only (import { type Foo }) */
    isTypeOnly: boolean;
}

/**
 * Information about an import found in source code
 */
export interface ImportDeclarationInfo {
    /** The import path (e.g., './Button', 'react', '@fp/sarsaparilla') */
    source: string;
    /** Names being imported (for named imports) - just the names for backward compatibility */
    namedImports: string[];
    /** Detailed info about named imports including type-only status */
    namedImportDetails: NamedImportInfo[];
    /** Whether this is a default import */
    hasDefaultImport: boolean;
    /** Whether this is a namespace import (import * as X) */
    hasNamespaceImport: boolean;
    /** Whether this is a type-only import (entire declaration) */
    isTypeOnly: boolean;
    /** Whether this is a side-effect import (import './styles.css') */
    isSideEffect: boolean;
}

/**
 * Extracts import information from source code using SWC's parser.
 * This is more robust than regex-based approaches and handles:
 * - import X from 'mod'
 * - import { a, b } from 'mod'
 * - import { a as b } from 'mod'
 * - import * as X from 'mod'
 * - import 'mod' (side effects)
 * - import type { X } from 'mod'
 * - Dynamic imports: import('mod')
 * - require('mod')
 */
export function extractImportsFromSource(
    sourceCode: string,
    filename: string = 'file.tsx',
): ImportDeclarationInfo[] {
    const imports: ImportDeclarationInfo[] = [];

    try {
        const isTypeScript =
            filename.endsWith('.ts') || filename.endsWith('.tsx');
        const hasJSX = filename.endsWith('.tsx') || filename.endsWith('.jsx');

        const ast = parseSync(sourceCode, {
            syntax: isTypeScript ? 'typescript' : 'ecmascript',
            tsx: hasJSX && isTypeScript,
            jsx: hasJSX && !isTypeScript,
        });

        for (const item of ast.body) {
            processModuleItem(item, imports);
        }

        // Also find dynamic imports and require() calls
        findDynamicImports(ast.body, imports);
    } catch {
        // If parsing fails, return empty imports
        // This can happen with malformed source files
    }

    return imports;
}

/**
 * Process a single module item for import declarations
 */
function processModuleItem(
    item: ModuleItem,
    imports: ImportDeclarationInfo[],
): void {
    if (item.type === 'ImportDeclaration') {
        imports.push(extractFromImportDeclaration(item));
    }
}

/**
 * Extract import info from an ImportDeclaration node
 */
function extractFromImportDeclaration(
    decl: ImportDeclaration,
): ImportDeclarationInfo {
    const info: ImportDeclarationInfo = {
        source: decl.source.value,
        namedImports: [],
        namedImportDetails: [],
        hasDefaultImport: false,
        hasNamespaceImport: false,
        isTypeOnly: decl.typeOnly ?? false,
        isSideEffect: decl.specifiers.length === 0,
    };

    for (const spec of decl.specifiers) {
        switch (spec.type) {
            case 'ImportDefaultSpecifier':
                info.hasDefaultImport = true;
                break;

            case 'ImportNamespaceSpecifier':
                info.hasNamespaceImport = true;
                break;

            case 'ImportSpecifier':
                // Named import - use the local name
                // Check for inline type modifier: import { type Foo } from './mod'
                const isSpecTypeOnly = spec.isTypeOnly ?? false;
                info.namedImports.push(spec.local.value);
                info.namedImportDetails.push({
                    name: spec.local.value,
                    isTypeOnly: isSpecTypeOnly,
                });
                break;
        }
    }

    return info;
}

/**
 * Recursively find dynamic import() and require() calls
 */
function findDynamicImports(
    body: ModuleItem[],
    imports: ImportDeclarationInfo[],
): void {
    const visited = new Set<object>();

    function visit(node: unknown): void {
        if (!node || typeof node !== 'object' || visited.has(node)) {
            return;
        }
        visited.add(node);

        const obj = node as Record<string, unknown>;

        // Check for import() call
        if (obj.type === 'CallExpression') {
            const call = obj as unknown as CallExpression;
            if (call.callee.type === 'Import' && call.arguments.length > 0) {
                const arg = call.arguments[0];
                if (arg.expression.type === 'StringLiteral') {
                    imports.push({
                        source: arg.expression.value,
                        namedImports: [],
                        namedImportDetails: [],
                        hasDefaultImport: false,
                        hasNamespaceImport: false,
                        isTypeOnly: false,
                        isSideEffect: false,
                    });
                }
            }

            // Check for require() call
            if (
                call.callee.type === 'Identifier' &&
                (call.callee as { value?: string }).value === 'require' &&
                call.arguments.length > 0
            ) {
                const arg = call.arguments[0];
                if (arg.expression.type === 'StringLiteral') {
                    imports.push({
                        source: arg.expression.value,
                        namedImports: [],
                        namedImportDetails: [],
                        hasDefaultImport: false,
                        hasNamespaceImport: false,
                        isTypeOnly: false,
                        isSideEffect: false,
                    });
                }
            }
        }

        // Recursively visit all properties
        for (const key in obj) {
            const value = obj[key];
            if (Array.isArray(value)) {
                for (const item of value) {
                    visit(item);
                }
            } else if (value && typeof value === 'object') {
                visit(value);
            }
        }
    }

    for (const item of body) {
        visit(item);
    }
}

/**
 * Categorizes an import source path
 */
export function categorizeImport(source: string): {
    isRelative: boolean;
    isExternal: boolean;
    packageName: string | null;
    isCssModule: boolean;
    isTypeFile: boolean;
} {
    const isRelative = source.startsWith('.') || source.startsWith('/');
    const isCssModule = /\.module\.(scss|css|sass|less)$/.test(source);
    const isTypeFile = /[.\-_]types?$/i.test(source);

    let packageName: string | null = null;
    if (!isRelative) {
        // Extract package name from external imports
        if (source.startsWith('@')) {
            // Scoped package: @scope/package or @scope/package/subpath
            const parts = source.split('/');
            packageName =
                parts.length >= 2 ? `${parts[0]}/${parts[1]}` : source;
        } else {
            // Regular package: package or package/subpath
            packageName = source.split('/')[0];
        }
    }

    return {
        isRelative,
        isExternal: !isRelative,
        packageName,
        isCssModule,
        isTypeFile,
    };
}

/**
 * Node.js built-in modules that should be skipped
 */
export const NODE_BUILTINS = new Set([
    'fs',
    'path',
    'os',
    'util',
    'events',
    'stream',
    'http',
    'https',
    'url',
    'querystring',
    'crypto',
    'buffer',
    'child_process',
    'cluster',
    'dgram',
    'dns',
    'net',
    'readline',
    'repl',
    'tls',
    'tty',
    'v8',
    'vm',
    'zlib',
    'assert',
    'async_hooks',
    'console',
    'constants',
    'domain',
    'inspector',
    'module',
    'perf_hooks',
    'process',
    'punycode',
    'string_decoder',
    'sys',
    'timers',
    'trace_events',
    'worker_threads',
]);

/**
 * Check if a package name is a Node.js built-in
 */
export function isNodeBuiltin(packageName: string): boolean {
    return NODE_BUILTINS.has(packageName) || packageName.startsWith('node:');
}
