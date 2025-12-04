/**
 * Asset Stub Resolver
 *
 * Detects and resolves bundler-generated asset stubs that were extracted from source maps.
 * When bundlers like Vite process asset imports, they transform them into placeholder
 * references. Source maps capture this post-transform code, not the original asset content.
 *
 * This module:
 * 1. Detects files that are asset stubs (e.g., `export default "__VITE_ASSET__xxx__"`)
 * 2. Generates valid placeholder content based on file extension
 * 3. Replaces stub files with valid assets so the build can succeed
 */

import { readdir, readFile, writeFile } from 'fs/promises';
import { join, extname, relative } from 'path';
import { parseSync } from '@swc/core';
import type {
    ExportDefaultExpression,
    StringLiteral,
    Identifier,
    VariableDeclaration,
    Module,
} from '@swc/types';

/**
 * Information about a detected asset stub
 */
export interface AssetStubInfo {
    /** Absolute path to the stub file */
    filePath: string;
    /** The bundler that generated this stub */
    bundler: 'vite' | 'webpack' | 'unknown';
    /** The asset identifier/hash from the stub */
    assetId: string;
    /** The file extension */
    extension: string;
    /** The original stub value */
    stubValue: string;
}

/**
 * Bundler-specific patterns for asset stubs
 */
const ASSET_STUB_PATTERNS = {
    vite: /^__VITE_ASSET__([A-Za-z0-9_$]+)__$/,
    vitePublic: /^__VITE_PUBLIC_ASSET__([A-Za-z0-9_$]+)__$/,
    // Webpack patterns can be added here
} as const;

/**
 * Asset extensions that we should check for stubs
 */
const ASSET_EXTENSIONS = new Set([
    '.svg',
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
    '.avif',
    '.ico',
    '.woff',
    '.woff2',
    '.ttf',
    '.eot',
    '.mp3',
    '.mp4',
    '.webm',
    '.ogg',
    '.pdf',
]);

/**
 * Finds the default export value in an AST.
 * Handles both direct string literals and variable references.
 */
function findDefaultExportValue(ast: Module): string | null {
    let defaultExportValue: string | null = null;
    const variableValues = new Map<string, string>();

    // First pass: collect all variable declarations with string values
    for (const stmt of ast.body) {
        if (stmt.type === 'VariableDeclaration') {
            const varDecl = stmt as VariableDeclaration;
            for (const decl of varDecl.declarations) {
                if (
                    decl.id.type === 'Identifier' &&
                    decl.init?.type === 'StringLiteral'
                ) {
                    variableValues.set(
                        decl.id.value,
                        (decl.init as StringLiteral).value,
                    );
                }
            }
        }
    }

    // Second pass: find the default export
    for (const stmt of ast.body) {
        if (stmt.type === 'ExportDefaultExpression') {
            // export default "..." or export default someVar
            const exportExpr = stmt as ExportDefaultExpression;
            if (exportExpr.expression.type === 'StringLiteral') {
                defaultExportValue = (exportExpr.expression as StringLiteral)
                    .value;
                break;
            } else if (exportExpr.expression.type === 'Identifier') {
                const varName = (exportExpr.expression as Identifier).value;
                const varValue = variableValues.get(varName);
                if (varValue !== undefined) {
                    defaultExportValue = varValue;
                    break;
                }
            }
        }
        // Note: ExportDefaultDeclaration is for function/class exports, not string literals
    }

    return defaultExportValue;
}

/**
 * Analyzes a file to determine if it's an asset stub.
 * Uses SWC for robust AST parsing.
 */
export function analyzeAssetStub(
    content: string,
    filePath: string,
): AssetStubInfo | null {
    const ext = extname(filePath).toLowerCase();

    // Only check files with asset extensions
    if (!ASSET_EXTENSIONS.has(ext)) {
        return null;
    }

    try {
        const ast = parseSync(content, {
            syntax: 'typescript',
            tsx: false,
        });

        const defaultExportValue = findDefaultExportValue(ast);

        if (!defaultExportValue) {
            return null;
        }

        // Check for Vite asset pattern
        const viteMatch = defaultExportValue.match(ASSET_STUB_PATTERNS.vite);
        if (viteMatch) {
            return {
                filePath,
                bundler: 'vite',
                assetId: viteMatch[1],
                extension: ext,
                stubValue: defaultExportValue,
            };
        }

        // Check for Vite public asset pattern
        const vitePublicMatch = defaultExportValue.match(
            ASSET_STUB_PATTERNS.vitePublic,
        );
        if (vitePublicMatch) {
            return {
                filePath,
                bundler: 'vite',
                assetId: vitePublicMatch[1],
                extension: ext,
                stubValue: defaultExportValue,
            };
        }

        // Add more bundler patterns here as needed

        return null;
    } catch {
        // File couldn't be parsed - not a valid JS/TS file
        return null;
    }
}

/**
 * Placeholder content generators for different asset types
 */
const PLACEHOLDER_GENERATORS: Record<string, () => string | Buffer> = {
    // SVG - minimal valid SVG
    '.svg': () =>
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect fill="#ccc" width="1" height="1"/></svg>`,

    // PNG - 1x1 transparent PNG (base64 decoded)
    '.png': () =>
        Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
            'base64',
        ),

    // JPG - 1x1 white JPEG
    '.jpg': () =>
        Buffer.from(
            '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBEQCEAwEPwAB//9k=',
            'base64',
        ),

    '.jpeg': () =>
        Buffer.from(
            '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBEQCEAwEPwAB//9k=',
            'base64',
        ),

    // GIF - 1x1 transparent GIF
    '.gif': () =>
        Buffer.from(
            'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
            'base64',
        ),

    // WebP - 1x1 transparent WebP
    '.webp': () =>
        Buffer.from(
            'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==',
            'base64',
        ),

    // AVIF - 1x1 transparent AVIF (minimal valid AVIF)
    '.avif': () =>
        Buffer.from(
            'AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADybWV0YQAAAAAAAAAoaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAGxpYmF2aWYAAAAADnBpdG0AAAAAAAEAAAAeaWxvYwAAAABEAAABAAEAAAABAAABGgAAAB0AAAAoaWluZgAAAAAAAQAAABppbmZlAgAAAAABAABhdjAxQ29sb3IAAAAAamlwcnAAAABLaXBjbwAAABRpc3BlAAAAAAAAAAEAAAABAAAAEHBpeGkAAAAAAwgICAAAAAxhdjFDgQ0MAAAAABNjb2xybmNseAACAAIAAYAAAAAXaXBtYQAAAAAAAAABAAEEAQKDBAAAACVtZGF0EgAKBzgABpAQ0AIQ',
            'base64',
        ),

    // ICO - minimal valid ICO (1x1)
    '.ico': () =>
        Buffer.from(
            'AAABAAEAAQEAAAEAGAAwAAAAFgAAACgAAAABAAAAAgAAAAEAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAA=',
            'base64',
        ),

    // Fonts - minimal valid font files would be complex
    // For now, return empty buffer and let the build warn
    '.woff': () => Buffer.alloc(0),
    '.woff2': () => Buffer.alloc(0),
    '.ttf': () => Buffer.alloc(0),
    '.eot': () => Buffer.alloc(0),

    // Media files - empty buffer, build will warn but not crash
    '.mp3': () => Buffer.alloc(0),
    '.mp4': () => Buffer.alloc(0),
    '.webm': () => Buffer.alloc(0),
    '.ogg': () => Buffer.alloc(0),

    // PDF - minimal valid PDF
    '.pdf': () =>
        Buffer.from(
            '%PDF-1.0\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 1 1]/Parent 2 0 R>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \n0000000101 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n161\n%%EOF',
        ),
};

/**
 * Generates placeholder content for an asset type
 */
export function generatePlaceholderContent(
    extension: string,
): string | Buffer | null {
    const generator = PLACEHOLDER_GENERATORS[extension.toLowerCase()];
    if (!generator) {
        return null;
    }
    return generator();
}

/**
 * Checks if a file is an asset file based on extension
 */
function isAssetFile(filePath: string): boolean {
    const ext = extname(filePath).toLowerCase();
    return ASSET_EXTENSIONS.has(ext);
}

/**
 * Recursively finds all asset stub files in a directory
 */
export async function findAssetStubs(
    sourceDir: string,
    options: {
        internalPackages?: Set<string>;
        onProgress?: (message: string) => void;
    } = {},
): Promise<Map<string, AssetStubInfo>> {
    const { internalPackages = new Set(), onProgress } = options;
    const assetStubs = new Map<string, AssetStubInfo>();

    async function processNodeModules(nodeModulesDir: string): Promise<void> {
        try {
            const entries = await readdir(nodeModulesDir, {
                withFileTypes: true,
            });

            for (const entry of entries) {
                if (!entry.isDirectory()) continue;

                const fullPath = join(nodeModulesDir, entry.name);

                if (entry.name.startsWith('@')) {
                    const scopedEntries = await readdir(fullPath, {
                        withFileTypes: true,
                    });
                    for (const scopedEntry of scopedEntries) {
                        if (!scopedEntry.isDirectory()) continue;
                        const scopedPackageName = `${entry.name}/${scopedEntry.name}`;
                        if (internalPackages.has(scopedPackageName)) {
                            await processDir(join(fullPath, scopedEntry.name));
                        }
                    }
                } else if (internalPackages.has(entry.name)) {
                    await processDir(fullPath);
                }
            }
        } catch {
            // Directory doesn't exist
        }
    }

    async function processDir(dir: string): Promise<void> {
        try {
            const entries = await readdir(dir, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = join(dir, entry.name);

                if (entry.isDirectory()) {
                    if (entry.name === 'node_modules') {
                        await processNodeModules(fullPath);
                    } else if (
                        !entry.name.startsWith('.') &&
                        !entry.name.startsWith('_')
                    ) {
                        await processDir(fullPath);
                    }
                } else if (entry.isFile() && isAssetFile(entry.name)) {
                    await processFile(fullPath);
                }
            }
        } catch {
            // Directory doesn't exist
        }
    }

    async function processFile(filePath: string): Promise<void> {
        try {
            const content = await readFile(filePath, 'utf-8');
            const stubInfo = analyzeAssetStub(content, filePath);

            if (stubInfo) {
                assetStubs.set(filePath, stubInfo);
            }
        } catch {
            // File can't be read
        }
    }

    onProgress?.('Scanning for asset stubs...');
    await processDir(sourceDir);

    return assetStubs;
}

/**
 * Resolves asset stubs by replacing them with valid placeholder content
 */
export async function resolveAssetStubs(
    sourceDir: string,
    assetStubs: Map<string, AssetStubInfo>,
    options: {
        dryRun?: boolean;
        onProgress?: (message: string) => void;
    } = {},
): Promise<{
    resolved: number;
    failed: number;
    byExtension: Record<string, number>;
}> {
    const { dryRun = false, onProgress } = options;
    let resolved = 0;
    let failed = 0;
    const byExtension: Record<string, number> = {};

    for (const [filePath, stubInfo] of assetStubs) {
        const placeholder = generatePlaceholderContent(stubInfo.extension);

        if (placeholder === null) {
            onProgress?.(
                `No placeholder available for ${stubInfo.extension}: ${relative(sourceDir, filePath)}`,
            );
            failed++;
            continue;
        }

        if (!dryRun) {
            try {
                await writeFile(filePath, placeholder);
                resolved++;
                byExtension[stubInfo.extension] =
                    (byExtension[stubInfo.extension] || 0) + 1;
            } catch (error) {
                onProgress?.(
                    `Failed to write placeholder: ${relative(sourceDir, filePath)}`,
                );
                failed++;
            }
        } else {
            resolved++;
            byExtension[stubInfo.extension] =
                (byExtension[stubInfo.extension] || 0) + 1;
        }
    }

    if (resolved > 0 && !dryRun) {
        const extSummary = Object.entries(byExtension)
            .map(([ext, count]) => `${count} ${ext}`)
            .join(', ');
        onProgress?.(`Resolved ${resolved} asset stubs (${extSummary})`);
    }

    return { resolved, failed, byExtension };
}

/**
 * Combined function to find and resolve all asset stubs in a project
 */
export async function findAndResolveAssetStubs(
    sourceDir: string,
    options: {
        internalPackages?: Set<string>;
        dryRun?: boolean;
        onProgress?: (message: string) => void;
    } = {},
): Promise<{
    found: number;
    resolved: number;
    failed: number;
    byExtension: Record<string, number>;
}> {
    const { internalPackages, dryRun = false, onProgress } = options;

    // Find all asset stubs
    const assetStubs = await findAssetStubs(sourceDir, {
        internalPackages,
        onProgress,
    });

    if (assetStubs.size === 0) {
        return { found: 0, resolved: 0, failed: 0, byExtension: {} };
    }

    onProgress?.(`Found ${assetStubs.size} asset stubs to resolve...`);

    // Resolve them
    const result = await resolveAssetStubs(sourceDir, assetStubs, {
        dryRun,
        onProgress,
    });

    return {
        found: assetStubs.size,
        ...result,
    };
}
