/**
 * Import Usage Analyzer
 *
 * Analyzes how imports are used in source code using SWC AST parsing.
 * This module detects usage patterns like:
 *
 * - Member expressions: `Foo.bar`, `Foo.baz()`
 * - JSX member expressions: `\<Foo.Bar /\>`, `\<Foo.Bar.Baz /\>`
 * - Direct calls: `foo()`
 * - Direct JSX usage: `\<Foo /\>`
 * - Constructor usage: `new Foo()`
 *
 * This information is useful for determining which exports are actually used
 * from a package, enabling tree-shaking analysis and re-export generation.
 *
 * @packageDocumentation
 */

import { parseSync } from '@swc/core';
import type { Module } from '@swc/types';

/**
 * Information about how a specific named import is used in code.
 */
export interface NamedImportUsage {
    /** The local name of the import (what it's called in this file) */
    localName: string;
    /** Properties accessed via member expression (e.g., Foo.bar → ['bar']) */
    memberAccesses: string[];
    /** Properties accessed via JSX member expression (e.g., `\<Foo.Bar /\>` results in `['Bar']`) */
    jsxMemberAccesses: string[];
    /** Is it called directly as a function? (e.g., foo()) */
    isCalledDirectly: boolean;
    /** Is it used as a JSX element directly? (e.g., <Foo />) */
    isUsedAsJsxElement: boolean;
    /** Is it used with 'new'? (e.g., new Foo()) */
    isConstructed: boolean;
}

/**
 * Aggregated usage info for imports from a specific source
 */
export interface ImportUsageInfo {
    /** The import source path (e.g., 'sarsaparilla', './Button') */
    source: string;
    /** File that contains this import */
    importingFile: string;
    /** Usage details for each named import */
    namedImports: NamedImportUsage[];
    /** Default import local name (if any) */
    defaultImportName: string | null;
    /** Default import usage (if any) */
    defaultImportUsage: Omit<NamedImportUsage, 'localName'> | null;
    /** Whether there's a namespace import (* as X) */
    hasNamespaceImport: boolean;
    /** Namespace import local name (if any) */
    namespaceImportName: string | null;
}

/**
 * Aggregated usage across multiple files for a single import name
 */
export interface AggregatedUsage {
    /** The import name */
    name: string;
    /** All member accesses across all files */
    allMemberAccesses: Set<string>;
    /** All JSX member accesses across all files */
    allJsxMemberAccesses: Set<string>;
    /** Is it ever called directly? */
    isEverCalledDirectly: boolean;
    /** Is it ever used as a JSX element? */
    isEverUsedAsJsxElement: boolean;
    /** Is it ever constructed? */
    isEverConstructed: boolean;
    /** Files that use this import */
    usedInFiles: string[];
    /** Is this used as a namespace (has member/JSX member accesses)? */
    isUsedAsNamespace: boolean;
}

/**
 * Safely parse source code with SWC
 */
function safeParse(sourceCode: string, filename: string): Module | null {
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
 * Generic AST walker
 */
function walkAST(
    node: unknown,
    visitor: (
        node: Record<string, unknown>,
        parent: Record<string, unknown> | null,
    ) => void,
    parent: Record<string, unknown> | null = null,
    visited: Set<object> = new Set(),
): void {
    if (!node || typeof node !== 'object') return;
    if (visited.has(node as object)) return;
    visited.add(node as object);

    const obj = node as Record<string, unknown>;
    visitor(obj, parent);

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
 * Extract the base identifier and property chain from a MemberExpression
 */
function extractMemberExpressionChain(
    node: Record<string, unknown>,
): { base: string; properties: string[] } | null {
    const properties: string[] = [];
    let current = node;

    while (current.type === 'MemberExpression') {
        const property = current.property as Record<string, unknown>;

        // Handle Computed wrapper
        let actualProperty = property;
        if (property.type === 'Computed') {
            actualProperty = property.expression as Record<string, unknown>;
        }

        // Get property name
        if (actualProperty.type === 'Identifier') {
            properties.unshift(actualProperty.value as string);
        } else if (actualProperty.type === 'StringLiteral') {
            properties.unshift(actualProperty.value as string);
        } else {
            // Dynamic property - can't extract statically
            return null;
        }

        current = current.object as Record<string, unknown>;
    }

    // Base should be an Identifier
    if (current.type === 'Identifier') {
        return {
            base: current.value as string,
            properties,
        };
    }

    return null;
}

/**
 * Extract the base identifier and property chain from a JSXMemberExpression
 * Handles: `\<Foo.Bar /\>`, `\<Foo.Bar.Baz /\>`
 */
function extractJSXMemberExpressionChain(
    node: Record<string, unknown>,
): { base: string; properties: string[] } | null {
    const properties: string[] = [];
    let current = node;

    while (current.type === 'JSXMemberExpression') {
        const property = current.property as Record<string, unknown>;

        if (
            property.type === 'Identifier' ||
            property.type === 'JSXIdentifier'
        ) {
            properties.unshift(property.value as string);
        } else {
            return null;
        }

        current = current.object as Record<string, unknown>;
    }

    // Base should be a JSXIdentifier or Identifier
    if (current.type === 'Identifier' || current.type === 'JSXIdentifier') {
        return {
            base: current.value as string,
            properties,
        };
    }

    return null;
}

/**
 * Analyzes how imports are used in a source file using SWC AST parsing.
 *
 * Detects the following usage patterns:
 * - Member expressions: `Foo.bar`, `Foo.baz()`
 * - JSX member expressions: `<Foo.Bar />`, `<Foo.Bar.Baz />`
 * - Direct calls: `foo()`
 * - Direct JSX usage: `<Foo />`
 * - Constructor usage: `new Foo()`
 *
 * @param sourceCode - The source code content to analyze
 * @param filename - The filename (used to determine syntax: TypeScript, JSX, etc.)
 * @returns Array of usage information for each import source in the file
 */
export function analyzeImportUsage(
    sourceCode: string,
    filename: string,
): ImportUsageInfo[] {
    const ast = safeParse(sourceCode, filename);
    if (!ast) return [];

    // First pass: collect all imports and their local names
    const importMap = new Map<
        string,
        {
            source: string;
            namedImports: Map<string, string>; // localName -> importedName
            defaultImportName: string | null;
            namespaceImportName: string | null;
        }
    >();

    // Map from local name to source (for quick lookup during usage analysis)
    const localNameToSource = new Map<string, string>();

    for (const item of ast.body) {
        if (item.type === 'ImportDeclaration') {
            const source = (item.source as unknown as Record<string, unknown>)
                .value as string;

            if (!importMap.has(source)) {
                importMap.set(source, {
                    source,
                    namedImports: new Map(),
                    defaultImportName: null,
                    namespaceImportName: null,
                });
            }

            const importInfo = importMap.get(source)!;
            const specifiers = item.specifiers as unknown as Array<
                Record<string, unknown>
            >;

            for (const spec of specifiers) {
                if (spec.type === 'ImportDefaultSpecifier') {
                    const local = spec.local as Record<string, unknown>;
                    const localName = local.value as string;
                    importInfo.defaultImportName = localName;
                    localNameToSource.set(localName, source);
                } else if (spec.type === 'ImportNamespaceSpecifier') {
                    const local = spec.local as Record<string, unknown>;
                    const localName = local.value as string;
                    importInfo.namespaceImportName = localName;
                    localNameToSource.set(localName, source);
                } else if (spec.type === 'ImportSpecifier') {
                    const local = spec.local as Record<string, unknown>;
                    const localName = local.value as string;
                    // imported name might be different due to aliasing
                    const imported = spec.imported as Record<
                        string,
                        unknown
                    > | null;
                    const importedName = imported
                        ? (imported.value as string)
                        : localName;
                    importInfo.namedImports.set(localName, importedName);
                    localNameToSource.set(localName, source);
                }
            }
        }
    }

    // Second pass: analyze usage of each import
    // Track usage per local name
    const usageMap = new Map<
        string,
        {
            memberAccesses: Set<string>;
            jsxMemberAccesses: Set<string>;
            isCalledDirectly: boolean;
            isUsedAsJsxElement: boolean;
            isConstructed: boolean;
        }
    >();

    // Initialize usage tracking for all imports
    for (const localName of localNameToSource.keys()) {
        usageMap.set(localName, {
            memberAccesses: new Set(),
            jsxMemberAccesses: new Set(),
            isCalledDirectly: false,
            isUsedAsJsxElement: false,
            isConstructed: false,
        });
    }

    // Walk the AST to find usages
    walkAST(ast, (node, _parent) => {
        // Check for MemberExpression (Foo.bar)
        if (node.type === 'MemberExpression') {
            const chain = extractMemberExpressionChain(node);
            if (chain && localNameToSource.has(chain.base)) {
                const usage = usageMap.get(chain.base)!;
                // Only add the first property (direct member access)
                if (chain.properties.length > 0) {
                    usage.memberAccesses.add(chain.properties[0]);
                }
            }
        }

        // Check for JSXMemberExpression (<Foo.Bar />)
        if (node.type === 'JSXMemberExpression') {
            const chain = extractJSXMemberExpressionChain(node);
            if (chain && localNameToSource.has(chain.base)) {
                const usage = usageMap.get(chain.base)!;
                // Only add the first property (direct JSX member access)
                if (chain.properties.length > 0) {
                    usage.jsxMemberAccesses.add(chain.properties[0]);
                }
            }
        }

        // Check for direct JSX element usage (<Foo />)
        if (
            node.type === 'JSXOpeningElement' ||
            node.type === 'JSXClosingElement'
        ) {
            const name = node.name as Record<string, unknown>;
            if (name.type === 'Identifier' || name.type === 'JSXIdentifier') {
                const localName = name.value as string;
                if (localNameToSource.has(localName)) {
                    usageMap.get(localName)!.isUsedAsJsxElement = true;
                }
            }
        }

        // Check for direct function call (foo())
        if (node.type === 'CallExpression') {
            const callee = node.callee as Record<string, unknown>;
            if (callee.type === 'Identifier') {
                const localName = callee.value as string;
                if (localNameToSource.has(localName)) {
                    usageMap.get(localName)!.isCalledDirectly = true;
                }
            }
        }

        // Check for constructor usage (new Foo())
        if (node.type === 'NewExpression') {
            const callee = node.callee as Record<string, unknown>;
            if (callee.type === 'Identifier') {
                const localName = callee.value as string;
                if (localNameToSource.has(localName)) {
                    usageMap.get(localName)!.isConstructed = true;
                }
            }
        }
    });

    // Build result
    const result: ImportUsageInfo[] = [];

    for (const [source, importInfo] of importMap) {
        const info: ImportUsageInfo = {
            source,
            importingFile: filename,
            namedImports: [],
            defaultImportName: importInfo.defaultImportName,
            defaultImportUsage: null,
            hasNamespaceImport: importInfo.namespaceImportName !== null,
            namespaceImportName: importInfo.namespaceImportName,
        };

        // Process named imports
        for (const [localName, _importedName] of importInfo.namedImports) {
            const usage = usageMap.get(localName)!;
            info.namedImports.push({
                localName,
                memberAccesses: [...usage.memberAccesses],
                jsxMemberAccesses: [...usage.jsxMemberAccesses],
                isCalledDirectly: usage.isCalledDirectly,
                isUsedAsJsxElement: usage.isUsedAsJsxElement,
                isConstructed: usage.isConstructed,
            });
        }

        // Process default import usage
        if (importInfo.defaultImportName) {
            const usage = usageMap.get(importInfo.defaultImportName)!;
            info.defaultImportUsage = {
                memberAccesses: [...usage.memberAccesses],
                jsxMemberAccesses: [...usage.jsxMemberAccesses],
                isCalledDirectly: usage.isCalledDirectly,
                isUsedAsJsxElement: usage.isUsedAsJsxElement,
                isConstructed: usage.isConstructed,
            };
        }

        result.push(info);
    }

    return result;
}

/**
 * Aggregates import usage from multiple files for a specific package.
 *
 * Combines usage information from multiple source files to create a unified
 * view of how each import from a package is used across the codebase.
 *
 * @param usageInfos - Array of usage info from multiple files (from analyzeImportUsage)
 * @param packageSource - The package source to aggregate usage for (e.g., 'react')
 * @returns Map of import name to aggregated usage across all files
 */
export function aggregateImportUsage(
    usageInfos: ImportUsageInfo[],
    packageSource: string,
): Map<string, AggregatedUsage> {
    const aggregated = new Map<string, AggregatedUsage>();

    for (const info of usageInfos) {
        // Only process imports from the target package
        if (info.source !== packageSource) continue;

        // Process named imports
        for (const namedImport of info.namedImports) {
            let agg = aggregated.get(namedImport.localName);
            if (!agg) {
                agg = {
                    name: namedImport.localName,
                    allMemberAccesses: new Set(),
                    allJsxMemberAccesses: new Set(),
                    isEverCalledDirectly: false,
                    isEverUsedAsJsxElement: false,
                    isEverConstructed: false,
                    usedInFiles: [],
                    isUsedAsNamespace: false,
                };
                aggregated.set(namedImport.localName, agg);
            }

            // Merge member accesses
            for (const access of namedImport.memberAccesses) {
                agg.allMemberAccesses.add(access);
            }
            for (const access of namedImport.jsxMemberAccesses) {
                agg.allJsxMemberAccesses.add(access);
            }

            // Merge boolean flags
            if (namedImport.isCalledDirectly) agg.isEverCalledDirectly = true;
            if (namedImport.isUsedAsJsxElement)
                agg.isEverUsedAsJsxElement = true;
            if (namedImport.isConstructed) agg.isEverConstructed = true;

            // Track files
            if (!agg.usedInFiles.includes(info.importingFile)) {
                agg.usedInFiles.push(info.importingFile);
            }

            // Determine if used as namespace
            if (
                namedImport.memberAccesses.length > 0 ||
                namedImport.jsxMemberAccesses.length > 0
            ) {
                agg.isUsedAsNamespace = true;
            }
        }

        // Process default import
        if (info.defaultImportName && info.defaultImportUsage) {
            let agg = aggregated.get('default');
            if (!agg) {
                agg = {
                    name: 'default',
                    allMemberAccesses: new Set(),
                    allJsxMemberAccesses: new Set(),
                    isEverCalledDirectly: false,
                    isEverUsedAsJsxElement: false,
                    isEverConstructed: false,
                    usedInFiles: [],
                    isUsedAsNamespace: false,
                };
                aggregated.set('default', agg);
            }

            const usage = info.defaultImportUsage;
            for (const access of usage.memberAccesses) {
                agg.allMemberAccesses.add(access);
            }
            for (const access of usage.jsxMemberAccesses) {
                agg.allJsxMemberAccesses.add(access);
            }
            if (usage.isCalledDirectly) agg.isEverCalledDirectly = true;
            if (usage.isUsedAsJsxElement) agg.isEverUsedAsJsxElement = true;
            if (usage.isConstructed) agg.isEverConstructed = true;
            if (!agg.usedInFiles.includes(info.importingFile)) {
                agg.usedInFiles.push(info.importingFile);
            }
            if (
                usage.memberAccesses.length > 0 ||
                usage.jsxMemberAccesses.length > 0
            ) {
                agg.isUsedAsNamespace = true;
            }
        }
    }

    return aggregated;
}

/**
 * Filters usage infos to only include imports from a specific source.
 *
 * Useful for analyzing imports from a particular package when you have
 * usage data from multiple files importing from multiple sources.
 *
 * @param usageInfos - Array of import usage info objects to filter
 * @param source - The import source to filter by (e.g., 'react', '\@tanstack/react-query')
 * @returns Filtered array containing only imports from the specified source
 */
export function filterUsageBySource(
    usageInfos: ImportUsageInfo[],
    source: string,
): ImportUsageInfo[] {
    return usageInfos.filter((info) => info.source === source);
}

/**
 * Gets all unique import sources from usage infos.
 *
 * Extracts and deduplicates all package sources that are imported
 * across the analyzed files.
 *
 * @param usageInfos - Array of import usage info objects
 * @returns Sorted array of unique import source strings
 */
export function getUniqueImportSources(
    usageInfos: ImportUsageInfo[],
): string[] {
    const sources = new Set<string>();
    for (const info of usageInfos) {
        sources.add(info.source);
    }
    return [...sources].sort();
}
