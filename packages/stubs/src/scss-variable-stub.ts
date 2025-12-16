/**
 * SCSS Variable Stub Generator
 *
 * Detects undefined SCSS variables in captured stylesheets and generates
 * stub files with placeholder values to allow successful compilation.
 *
 * Uses postcss with postcss-scss syntax for AST-based accurate detection.
 */

import { Root } from 'postcss';
import { parse as parseScssFile } from 'postcss-scss';
import { dirname, basename, join } from 'path';
import { toPosixPath } from '@web2local/utils';
import { readFile, writeFile, readdir } from 'fs/promises';

/**
 * Regex to match SCSS variable references in values
 * Matches: $variable-name, $_private-var, $var123
 * Does not match: #{$interpolated} (handled separately)
 */
const SCSS_VARIABLE_REGEX = /\$([a-zA-Z_][a-zA-Z0-9_-]*)/g;

/**
 * Result of analyzing an SCSS file for variables
 */
export interface ScssVariableAnalysis {
    /** Path to the SCSS file */
    filePath: string;
    /** Variable names that are defined in this file */
    definitions: Set<string>;
    /** Variable names that are used in this file */
    usages: Set<string>;
    /** Any parse errors encountered */
    parseError?: string;
}

/**
 * Result of generating SCSS variable stubs
 */
export interface ScssVariableStubResult {
    /** Number of stub files generated */
    stubFilesGenerated: number;
    /** Number of source files modified to import stubs */
    sourceFilesModified: number;
    /** Total number of undefined variables stubbed */
    variablesStubbed: number;
    /** Map of file path to the stub file generated for it */
    stubFiles: Map<string, string>;
    /** Any errors encountered */
    errors: string[];
}

/**
 * Parse an SCSS file and return the PostCSS AST.
 *
 * @param content - The SCSS file content to parse
 * @param filePath - The file path (used for error reporting)
 * @returns The PostCSS Root AST node, or null if parsing fails
 */
export function parseScss(content: string, filePath: string): Root | null {
    try {
        return parseScssFile(content, { from: filePath });
    } catch {
        // SCSS parsing can fail on complex or malformed files
        return null;
    }
}

/**
 * Extract all SCSS variable definitions from an AST.
 *
 * Variables are defined as declarations with props starting with `$`,
 * as well as loop variables from `@each` and `@for` rules.
 *
 * @param root - The PostCSS Root AST to analyze
 * @returns Set of variable names (without the `$` prefix)
 */
export function extractVariableDefinitions(root: Root): Set<string> {
    const definitions = new Set<string>();

    root.walkDecls((decl) => {
        // SCSS variable definitions look like: $var-name: value;
        if (decl.prop.startsWith('$')) {
            definitions.add(decl.prop.slice(1)); // Remove the $ prefix
        }
    });

    // Also check for @each, @for loops that define variables
    root.walkAtRules((atRule) => {
        if (atRule.name === 'each') {
            // @each $item in $list
            const match = atRule.params.match(/^\$([a-zA-Z_][a-zA-Z0-9_-]*)/);
            if (match) {
                definitions.add(match[1]);
            }
            // Also capture comma-separated variables like @each $key, $value in $map
            const multiMatch = atRule.params.match(
                /^\$([a-zA-Z_][a-zA-Z0-9_-]*)(?:\s*,\s*\$([a-zA-Z_][a-zA-Z0-9_-]*))+/,
            );
            if (multiMatch) {
                for (let i = 1; i < multiMatch.length; i++) {
                    if (multiMatch[i]) {
                        definitions.add(multiMatch[i]);
                    }
                }
            }
        } else if (atRule.name === 'for') {
            // @for $i from 1 through 10
            const match = atRule.params.match(/^\$([a-zA-Z_][a-zA-Z0-9_-]*)/);
            if (match) {
                definitions.add(match[1]);
            }
        }
    });

    return definitions;
}

/**
 * Extract all SCSS variable usages from an AST.
 *
 * Looks for `$variable` references in declaration values, at-rule params,
 * and selectors (including interpolations like `#{$var}`).
 *
 * @param root - The PostCSS Root AST to analyze
 * @returns Set of variable names (without the `$` prefix) that are used
 */
export function extractVariableUsages(root: Root): Set<string> {
    const usages = new Set<string>();

    // Helper to extract variables from a string
    const extractFromString = (str: string) => {
        let match;
        const regex = new RegExp(SCSS_VARIABLE_REGEX.source, 'g');
        while ((match = regex.exec(str)) !== null) {
            usages.add(match[1]);
        }
    };

    // Check declaration values
    root.walkDecls((decl) => {
        // Skip variable definitions (they're not usages in the value context)
        if (!decl.prop.startsWith('$')) {
            extractFromString(decl.value);
        } else {
            // For variable definitions, the value can reference other variables
            extractFromString(decl.value);
        }
    });

    // Check at-rule parameters (e.g., @if $var, @media #{$breakpoint})
    root.walkAtRules((atRule) => {
        extractFromString(atRule.params);
    });

    // Check selectors (e.g., #{$selector})
    root.walkRules((rule) => {
        extractFromString(rule.selector);
    });

    return usages;
}

/**
 * Analyze a single SCSS file for variable definitions and usages.
 *
 * Attempts AST-based parsing first, falling back to regex-based
 * extraction if parsing fails.
 *
 * @param content - The SCSS file content to analyze
 * @param filePath - The file path (for reporting and parser context)
 * @returns Analysis result with definitions, usages, and any parse errors
 */
export function analyzeScssFile(
    content: string,
    filePath: string,
): ScssVariableAnalysis {
    const result: ScssVariableAnalysis = {
        filePath,
        definitions: new Set(),
        usages: new Set(),
    };

    const root = parseScss(content, filePath);
    if (!root) {
        result.parseError = `Failed to parse SCSS file: ${filePath}`;
        // Fall back to regex-based extraction for unparseable files
        const defRegex = /\$([a-zA-Z_][a-zA-Z0-9_-]*)\s*:/g;
        let match;
        while ((match = defRegex.exec(content)) !== null) {
            result.definitions.add(match[1]);
        }

        const useRegex = new RegExp(SCSS_VARIABLE_REGEX.source, 'g');
        while ((match = useRegex.exec(content)) !== null) {
            result.usages.add(match[1]);
        }

        return result;
    }

    result.definitions = extractVariableDefinitions(root);
    result.usages = extractVariableUsages(root);

    return result;
}

/**
 * Find all undefined variables across a set of SCSS files.
 *
 * Compares variable usages against all definitions across all files
 * to identify variables that are used but never defined.
 *
 * @param analyses - Array of SCSS file analysis results
 * @returns Map of file path to set of undefined variable names used in that file
 */
export function findUndefinedVariables(
    analyses: ScssVariableAnalysis[],
): Map<string, Set<string>> {
    // Collect all variable definitions across all files
    const allDefinitions = new Set<string>();
    for (const analysis of analyses) {
        for (const def of analysis.definitions) {
            allDefinitions.add(def);
        }
    }

    // Find undefined variables in each file
    const undefinedByFile = new Map<string, Set<string>>();

    for (const analysis of analyses) {
        const undefined_ = new Set<string>();
        for (const usage of analysis.usages) {
            if (!allDefinitions.has(usage)) {
                undefined_.add(usage);
            }
        }

        if (undefined_.size > 0) {
            undefinedByFile.set(analysis.filePath, undefined_);
        }
    }

    return undefinedByFile;
}

/**
 * Generate SCSS variable stub content.
 *
 * Creates SCSS content with placeholder variable definitions using
 * `unset !default` so real definitions take precedence.
 *
 * @param variables - Set of variable names (without `$` prefix) to stub
 * @returns SCSS content string with stub variable definitions
 */
export function generateVariableStubContent(variables: Set<string>): string {
    const sortedVars = Array.from(variables).sort();

    const lines = [
        '// Auto-generated SCSS variable stubs',
        '// These variables were referenced but not defined in the source.',
        '// Using `unset` with !default so real definitions take precedence.',
        '',
    ];

    for (const varName of sortedVars) {
        lines.push(`$${varName}: unset !default;`);
    }

    lines.push('');
    return lines.join('\n');
}

/**
 * Generate the stub filename for a given SCSS file.
 *
 * Creates a filename in the same directory with `._variables-stub.scss` suffix.
 *
 * @param scssFilePath - The path to the original SCSS file
 * @returns The path for the stub file (e.g., `foo/bar._variables-stub.scss`)
 */
export function getStubFilename(scssFilePath: string): string {
    const dir = dirname(scssFilePath);
    const base = basename(scssFilePath, '.scss');
    return toPosixPath(join(dir, `${base}._variables-stub.scss`));
}

/**
 * Check if a file already has the stub import.
 *
 * Checks for `@import` or `@use` statements that reference the stub file.
 *
 * @param content - The SCSS file content to check
 * @param stubFilename - The stub filename to look for
 * @returns True if the stub import already exists
 */
export function hasStubImport(content: string, stubFilename: string): boolean {
    const stubBase = basename(stubFilename, '.scss');
    // Check for various import syntaxes
    const importPatterns = [
        `@import '${stubBase}'`,
        `@import "${stubBase}"`,
        `@use '${stubBase}'`,
        `@use "${stubBase}"`,
    ];

    for (const pattern of importPatterns) {
        if (content.includes(pattern)) {
            return true;
        }
    }

    return false;
}

/**
 * Inject the stub import at the top of an SCSS file.
 *
 * Places the import after any `@charset` declaration or leading comments,
 * or at the very top if neither exists.
 *
 * @param content - The original SCSS file content
 * @param stubFilename - The stub filename to import
 * @returns The modified content with the stub import injected
 */
export function injectStubImport(
    content: string,
    stubFilename: string,
): string {
    const stubBase = basename(stubFilename, '.scss');
    const importStatement = `@import '${stubBase}';\n`;

    // Find the best position to inject the import
    // - After any existing @charset declaration
    // - After any leading comments
    // - At the very top otherwise

    // Look for @charset
    const charsetMatch = content.match(/^(@charset\s+['"][^'"]+['"];\s*\n?)/);
    if (charsetMatch) {
        const charsetEnd = charsetMatch[0].length;
        return (
            content.slice(0, charsetEnd) +
            importStatement +
            content.slice(charsetEnd)
        );
    }

    // Look for leading block comments
    const leadingCommentMatch = content.match(/^(\/\*[\s\S]*?\*\/\s*\n?)/);
    if (leadingCommentMatch) {
        const commentEnd = leadingCommentMatch[0].length;
        return (
            content.slice(0, commentEnd) +
            importStatement +
            content.slice(commentEnd)
        );
    }

    // Otherwise, inject at the very top
    return importStatement + content;
}

/**
 * Recursively find all SCSS files in a directory
 */
async function findScssFiles(dir: string): Promise<string[]> {
    const files: string[] = [];

    try {
        const entries = await readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = join(dir, entry.name);

            if (entry.isDirectory()) {
                // Skip node_modules and common non-source directories
                if (
                    entry.name !== 'node_modules' &&
                    entry.name !== '_rebuilt' &&
                    !entry.name.startsWith('.')
                ) {
                    const subFiles = await findScssFiles(fullPath);
                    files.push(...subFiles);
                }
            } else if (
                entry.isFile() &&
                (entry.name.endsWith('.scss') || entry.name.endsWith('.sass'))
            ) {
                // Skip already-generated stub files
                if (!entry.name.includes('._variables-stub')) {
                    files.push(toPosixPath(fullPath));
                }
            }
        }
    } catch {
        // Directory doesn't exist or can't be read
    }

    return files;
}

/**
 * Main function to generate SCSS variable stubs for a project directory.
 *
 * Scans all SCSS files in the project, analyzes variable definitions and usages,
 * generates stub files for undefined variables, and injects imports into source files.
 *
 * @param projectDir - The root directory to scan for SCSS files
 * @param options - Configuration options
 * @param options.onProgress - Optional progress callback for status updates
 * @param options.dryRun - If true, analyze only without writing files
 * @returns Result containing counts of generated stubs and any errors
 */
export async function generateScssVariableStubs(
    projectDir: string,
    options: {
        onProgress?: (message: string) => void;
        dryRun?: boolean;
    } = {},
): Promise<ScssVariableStubResult> {
    const { onProgress, dryRun = false } = options;

    const result: ScssVariableStubResult = {
        stubFilesGenerated: 0,
        sourceFilesModified: 0,
        variablesStubbed: 0,
        stubFiles: new Map(),
        errors: [],
    };

    onProgress?.('Scanning for SCSS files...');

    // Find all SCSS files in the project
    const scssFiles = await findScssFiles(projectDir);

    if (scssFiles.length === 0) {
        onProgress?.('No SCSS files found');
        return result;
    }

    onProgress?.(`Found ${scssFiles.length} SCSS files, analyzing...`);

    // Analyze all SCSS files
    const analyses: ScssVariableAnalysis[] = [];

    for (const filePath of scssFiles) {
        try {
            const content = await readFile(filePath, 'utf-8');
            const analysis = analyzeScssFile(content, filePath);
            analyses.push(analysis);

            if (analysis.parseError) {
                result.errors.push(analysis.parseError);
            }
        } catch (error) {
            result.errors.push(`Failed to read ${filePath}: ${error}`);
        }
    }

    // Find undefined variables
    const undefinedByFile = findUndefinedVariables(analyses);

    if (undefinedByFile.size === 0) {
        onProgress?.('No undefined SCSS variables found');
        return result;
    }

    // Count total undefined variables
    const allUndefined = new Set<string>();
    for (const vars of undefinedByFile.values()) {
        for (const v of vars) {
            allUndefined.add(v);
        }
    }

    onProgress?.(
        `Found ${allUndefined.size} undefined variables in ${undefinedByFile.size} files`,
    );

    // Generate stub files and modify source files
    for (const [filePath, undefinedVars] of undefinedByFile) {
        const stubPath = getStubFilename(filePath);
        const stubContent = generateVariableStubContent(undefinedVars);

        result.stubFiles.set(filePath, stubPath);
        result.variablesStubbed += undefinedVars.size;

        if (!dryRun) {
            try {
                // Write the stub file
                await writeFile(stubPath, stubContent, 'utf-8');
                result.stubFilesGenerated++;

                // Modify the source file to import the stub
                const sourceContent = await readFile(filePath, 'utf-8');

                if (!hasStubImport(sourceContent, stubPath)) {
                    const modifiedContent = injectStubImport(
                        sourceContent,
                        stubPath,
                    );
                    await writeFile(filePath, modifiedContent, 'utf-8');
                    result.sourceFilesModified++;
                }

                onProgress?.(
                    `Generated stub for ${basename(filePath)} (${undefinedVars.size} variables)`,
                );
            } catch (error) {
                result.errors.push(
                    `Failed to generate stub for ${filePath}: ${error}`,
                );
            }
        }
    }

    return result;
}
