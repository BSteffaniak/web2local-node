/**
 * Export extraction utilities for JavaScript/TypeScript source code.
 *
 * This module provides AST-based export extraction using SWC, handling all
 * export patterns including named exports, default exports, type exports, and
 * destructured exports. It correctly identifies local exports vs re-exports.
 */

import { parseSync } from '@swc/core';
import type {
    ModuleItem,
    Declaration,
    Pattern,
    ExportSpecifier,
    DefaultDecl,
} from '@swc/types';

/**
 * Export information extracted from a source file
 */
export interface FileExports {
    /** Named exports (export const X, export \{ X \}) */
    named: string[];
    /** Type-only exports (export type X, export interface X) */
    types: string[];
    /** Whether file has a default export */
    hasDefault: boolean;
    /** Name of default export if identifiable */
    defaultName?: string;
}

/**
 * Extracts exports from source code using SWC's parser.
 *
 * This is a robust, AST-based approach that handles all export patterns correctly,
 * including named exports, default exports, type exports, and destructured exports.
 *
 * @param sourceCode - The JavaScript/TypeScript source code to parse
 * @param filename - The filename used to determine parser syntax (e.g., '.tsx' enables JSX)
 * @returns Object containing named exports, type exports, and default export information
 *
 * @example
 * ```typescript
 * const exports = extractExportsFromSource(`
 *   export const foo = 1;
 *   export function bar() {}
 *   export type Baz = string;
 *   export default class MyComponent {}
 * `, 'module.ts');
 *
 * // exports.named === ['foo', 'bar']
 * // exports.types === ['Baz']
 * // exports.hasDefault === true
 * // exports.defaultName === 'MyComponent'
 * ```
 */
export function extractExportsFromSource(
    sourceCode: string,
    filename: string = 'file.tsx',
): FileExports {
    const exports: FileExports = {
        named: [],
        types: [],
        hasDefault: false,
    };

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
            processModuleItem(item, exports);
        }

        // Dedupe
        exports.named = [...new Set(exports.named)];
        exports.types = [...new Set(exports.types)];
    } catch {
        // If parsing fails, return empty exports
        // This can happen with malformed source files
    }

    return exports;
}

/**
 * Process a single module item (statement or declaration)
 */
function processModuleItem(item: ModuleItem, exports: FileExports): void {
    switch (item.type) {
        // export const x = ..., export function x(), export class X {}, export type X = ..., etc.
        case 'ExportDeclaration':
            extractFromDeclaration(item.declaration, exports);
            break;

        // export { a, b } or export { a, b } from './mod' or export type { A, B }
        case 'ExportNamedDeclaration':
            // Skip re-exports (exports that have a source module)
            // e.g., export { X } from './other' should not be counted as a local export
            if (item.source) {
                break;
            }
            for (const spec of item.specifiers) {
                const name = getExportedName(spec);
                if (name) {
                    if (item.typeOnly) {
                        exports.types.push(name);
                    } else {
                        exports.named.push(name);
                    }
                }
            }
            break;

        // export default function X() {} or export default class X {}
        case 'ExportDefaultDeclaration':
            exports.hasDefault = true;
            exports.defaultName = getDefaultDeclName(item.decl);
            break;

        // export default expression (e.g., export default X, export default 42)
        case 'ExportDefaultExpression':
            exports.hasDefault = true;
            if (item.expression.type === 'Identifier') {
                exports.defaultName = item.expression.value;
            }
            break;

        // export * from './mod' - we don't extract names from these
        case 'ExportAllDeclaration':
            // Nothing to extract - we'd need to follow the import
            break;
    }
}

/**
 * Get the exported name from an export specifier
 */
function getExportedName(spec: ExportSpecifier): string | null {
    switch (spec.type) {
        case 'ExportSpecifier':
            // export { orig as exported } - use exported name if present
            if (spec.exported) {
                return spec.exported.type === 'Identifier'
                    ? spec.exported.value
                    : spec.exported.value;
            }
            return spec.orig.type === 'Identifier'
                ? spec.orig.value
                : spec.orig.value;

        case 'ExportDefaultSpecifier':
            // export X from './mod'
            return spec.exported.value;

        case 'ExportNamespaceSpecifier':
            // export * as ns from './mod'
            return spec.name.type === 'Identifier'
                ? spec.name.value
                : spec.name.value;

        default:
            return null;
    }
}

/**
 * Get the name from a default declaration if it has one
 */
function getDefaultDeclName(decl: DefaultDecl): string | undefined {
    switch (decl.type) {
        case 'FunctionExpression':
            return decl.identifier?.value;
        case 'ClassExpression':
            return decl.identifier?.value;
        case 'TsInterfaceDeclaration':
            return decl.id.value;
        default:
            return undefined;
    }
}

/**
 * Extract export names from a declaration
 */
function extractFromDeclaration(decl: Declaration, exports: FileExports): void {
    switch (decl.type) {
        case 'VariableDeclaration':
            // Handles: export const x = ..., export const { a, b } = obj, export const [a, b] = arr
            for (const declarator of decl.declarations) {
                extractFromPattern(declarator.id, exports.named);
            }
            break;

        case 'FunctionDeclaration':
            exports.named.push(decl.identifier.value);
            break;

        case 'ClassDeclaration':
            exports.named.push(decl.identifier.value);
            break;

        case 'TsInterfaceDeclaration':
            exports.types.push(decl.id.value);
            break;

        case 'TsTypeAliasDeclaration':
            exports.types.push(decl.id.value);
            break;

        case 'TsEnumDeclaration':
            // Enums are values, not types
            exports.named.push(decl.id.value);
            break;

        case 'TsModuleDeclaration':
            // Namespace/module declarations - extract the name
            if (decl.id.type === 'Identifier') {
                exports.named.push(decl.id.value);
            }
            break;
    }
}

/**
 * Extract names from a pattern (handles destructuring)
 */
function extractFromPattern(pattern: Pattern, names: string[]): void {
    switch (pattern.type) {
        case 'Identifier':
            names.push(pattern.value);
            break;

        case 'ObjectPattern':
            // Handles: export const { a, b, c: renamed } = obj
            for (const prop of pattern.properties) {
                switch (prop.type) {
                    case 'KeyValuePatternProperty':
                        // { key: value } - extract from value pattern (the local binding)
                        extractFromPattern(prop.value, names);
                        break;
                    case 'AssignmentPatternProperty':
                        // { key } or { key = default }
                        names.push(prop.key.value);
                        break;
                    case 'RestElement':
                        // { ...rest }
                        extractFromPattern(prop.argument, names);
                        break;
                }
            }
            break;

        case 'ArrayPattern':
            // Handles: export const [a, b] = arr
            for (const element of pattern.elements) {
                if (element) {
                    extractFromPattern(element, names);
                }
            }
            break;

        case 'RestElement':
            // Handles: export const [...rest] = arr
            extractFromPattern(pattern.argument, names);
            break;

        case 'AssignmentPattern':
            // Handles: export const { a = defaultValue } = obj (in some contexts)
            extractFromPattern(pattern.left, names);
            break;
    }
}
