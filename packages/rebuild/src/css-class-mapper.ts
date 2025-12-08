/**
 * CSS Class Name Mapper
 *
 * Extracts hashed CSS module class names from captured CSS bundles
 * and builds a mapping from base names to hashed names.
 *
 * CSS modules typically generate class names in formats like:
 * - _className_hash_lineNumber (Vite default)
 * - className_hash (Webpack with localIdentName)
 * - _className_hash (various bundlers)
 */

import { readFile, writeFile, readdir } from 'fs/promises';
import { join, basename } from 'path';

/**
 * Represents a mapping from base class name to its hashed variants
 */
export interface ClassNameMapping {
    /** Original base class name (e.g., "skipLink") */
    baseName: string;
    /** Hashed class names found in CSS (e.g., ["_skipLink_pl5cr_7"]) */
    hashedNames: string[];
}

/**
 * Complete class name map for a project
 */
export interface ClassNameMap {
    /** Version of the mapping format */
    version: 1;
    /** When the mapping was generated */
    generatedAt: string;
    /** CSS files that were parsed */
    sourceFiles: string[];
    /** Mapping from base name to hashed names */
    mappings: Record<string, string[]>;
}

/**
 * Regex patterns for common CSS module hash formats
 *
 * These patterns ONLY match complete class name selectors that actually
 * exist in the CSS. We specifically require the line number suffix because
 * Vite's CSS modules always include it in the generated selectors.
 *
 * Pattern 1: _baseName_hash_number (Vite default with leading underscore)
 * Pattern 2: baseName_hash_number (alternative without leading underscore)
 *
 * NOTE: We intentionally do NOT include a pattern for _baseName_hash (no line number)
 * because those partial names don't exist as actual CSS selectors - they're just
 * substrings of the full class names. Including them causes styles to break because
 * the proxy returns these non-existent partial names instead of the real selectors.
 */
const CSS_MODULE_PATTERNS = [
    // Vite default: ._className_hash_lineNumber
    // Captures: baseName, hash, lineNumber
    /\._([a-zA-Z][a-zA-Z0-9-]*)_([a-z0-9]+)_(\d+)/g,

    // Alternative: .className_hash_lineNumber (without leading underscore)
    /\.([a-zA-Z][a-zA-Z0-9-]*)_([a-z0-9]+)_(\d+)/g,
];

/**
 * Extract hashed class names from CSS content
 */
export function extractHashedClassNames(
    cssContent: string,
): Map<string, Set<string>> {
    const mappings = new Map<string, Set<string>>();

    for (const pattern of CSS_MODULE_PATTERNS) {
        // Reset regex lastIndex
        pattern.lastIndex = 0;

        let match: RegExpExecArray | null;
        while ((match = pattern.exec(cssContent)) !== null) {
            const baseName = match[1];
            const fullHashedName = match[0].slice(1); // Remove leading dot

            // Skip if base name is too short (likely false positive)
            if (baseName.length < 2) continue;

            // Skip common CSS property names that might match
            if (isLikelyCssProperty(baseName)) continue;

            if (!mappings.has(baseName)) {
                mappings.set(baseName, new Set());
            }
            mappings.get(baseName)!.add(fullHashedName);
        }
    }

    return mappings;
}

/**
 * Check if a name is likely a CSS property rather than a class name
 */
function isLikelyCssProperty(name: string): boolean {
    const cssProperties = new Set([
        'color',
        'background',
        'border',
        'margin',
        'padding',
        'width',
        'height',
        'display',
        'position',
        'top',
        'left',
        'right',
        'bottom',
        'flex',
        'grid',
        'font',
        'text',
        'line',
        'overflow',
        'opacity',
        'transform',
        'transition',
        'animation',
        'box',
        'z',
        'min',
        'max',
    ]);

    return cssProperties.has(name.toLowerCase());
}

/**
 * Parse CSS files from a directory and build class name mappings
 */
export async function buildClassNameMap(
    cssDir: string,
    cssFiles: string[],
): Promise<ClassNameMap> {
    const allMappings = new Map<string, Set<string>>();

    for (const file of cssFiles) {
        try {
            const filePath = join(cssDir, file);
            const content = await readFile(filePath, 'utf-8');
            const fileMappings = extractHashedClassNames(content);

            // Merge into allMappings
            for (const [baseName, hashedNames] of fileMappings) {
                if (!allMappings.has(baseName)) {
                    allMappings.set(baseName, new Set());
                }
                for (const hashedName of hashedNames) {
                    allMappings.get(baseName)!.add(hashedName);
                }
            }
        } catch (error) {
            // Skip files that can't be read
            console.warn(`Warning: Could not read CSS file ${file}: ${error}`);
        }
    }

    // Convert to serializable format
    const mappings: Record<string, string[]> = {};
    for (const [baseName, hashedNames] of allMappings) {
        mappings[baseName] = Array.from(hashedNames).sort();
    }

    return {
        version: 1,
        generatedAt: new Date().toISOString(),
        sourceFiles: cssFiles,
        mappings,
    };
}

/**
 * Find CSS bundle files in the static directory
 */
export async function findCssBundles(staticDir: string): Promise<string[]> {
    const cssFiles: string[] = [];

    async function scanDir(dir: string, prefix: string = ''): Promise<void> {
        try {
            const entries = await readdir(dir, { withFileTypes: true });

            for (const entry of entries) {
                const relativePath = prefix
                    ? `${prefix}/${entry.name}`
                    : entry.name;

                if (entry.isDirectory()) {
                    // Skip node_modules and hidden directories
                    if (
                        entry.name !== 'node_modules' &&
                        !entry.name.startsWith('.')
                    ) {
                        await scanDir(join(dir, entry.name), relativePath);
                    }
                } else if (entry.isFile() && entry.name.endsWith('.css')) {
                    // Only include bundled CSS (has hash in name or is in specific locations)
                    if (
                        isBundledCss(entry.name) ||
                        relativePath.includes('navigation/')
                    ) {
                        cssFiles.push(relativePath);
                    }
                }
            }
        } catch {
            // Directory doesn't exist
        }
    }

    await scanDir(staticDir);
    return cssFiles;
}

/**
 * Check if a CSS file appears to be a bundled/compiled CSS file
 */
function isBundledCss(filename: string): boolean {
    // Has hash pattern in filename (e.g., index-CPeWLd_6.css, sarsaparilla-CAVT8XC2.css)
    return /[-.][A-Za-z0-9_-]{6,}\.(css|scss)$/.test(filename);
}

/**
 * Generate a class name map and save it to the project directory
 */
export async function generateClassNameMapFile(
    projectDir: string,
    onVerbose?: (message: string) => void,
): Promise<ClassNameMap | null> {
    const staticDir = join(projectDir, '_server', 'static');
    const outputPath = join(projectDir, '_class-name-map.json');

    // Find CSS bundles
    const cssFiles = await findCssBundles(staticDir);

    if (cssFiles.length === 0) {
        onVerbose?.('No CSS bundle files found');
        return null;
    }

    onVerbose?.(`Found ${cssFiles.length} CSS file(s) to parse`);

    // Build the mapping
    const classNameMap = await buildClassNameMap(staticDir, cssFiles);

    // Calculate stats
    const totalMappings = Object.keys(classNameMap.mappings).length;
    const totalHashedNames = Object.values(classNameMap.mappings).reduce(
        (sum, names) => sum + names.length,
        0,
    );

    onVerbose?.(
        `Extracted ${totalMappings} base class names with ${totalHashedNames} hashed variants`,
    );

    // Save to file
    await writeFile(outputPath, JSON.stringify(classNameMap, null, 2), 'utf-8');
    onVerbose?.(`Class name map saved to ${basename(outputPath)}`);

    return classNameMap;
}

/**
 * Load an existing class name map from a project directory
 */
export async function loadClassNameMap(
    projectDir: string,
): Promise<ClassNameMap | null> {
    const mapPath = join(projectDir, '_class-name-map.json');

    try {
        const content = await readFile(mapPath, 'utf-8');
        return JSON.parse(content) as ClassNameMap;
    } catch {
        return null;
    }
}

/**
 * Resolve a base class name to its hashed equivalent
 *
 * If multiple hashed names exist for a base name, returns the first one.
 * This is a simple strategy that works when components don't share class names.
 *
 * @param baseName - The base class name (e.g., "skipLink")
 * @param classNameMap - The class name mapping
 * @returns The hashed class name, or the original if not found
 */
export function resolveClassName(
    baseName: string,
    classNameMap: ClassNameMap,
): string {
    const hashedNames = classNameMap.mappings[baseName];

    if (!hashedNames || hashedNames.length === 0) {
        // No mapping found, return original
        return baseName;
    }

    // If there's exactly one mapping, use it
    if (hashedNames.length === 1) {
        return hashedNames[0];
    }

    // Multiple mappings exist - return the first one
    // In a more sophisticated implementation, we could use context
    // (component name, file path) to disambiguate
    return hashedNames[0];
}

/**
 * Generate JavaScript code for the class name resolver
 * This is injected into the Vite config
 */
export function generateClassNameResolverCode(
    classNameMap: ClassNameMap,
): string {
    const mappingsJson = JSON.stringify(classNameMap.mappings);

    return `
const __cssClassMappings = ${mappingsJson};

function __resolveCssClassName(baseName) {
  const hashedNames = __cssClassMappings[baseName];
  if (!hashedNames || hashedNames.length === 0) {
    return baseName;
  }
  return hashedNames[0];
}
`;
}
