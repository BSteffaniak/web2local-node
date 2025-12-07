/**
 * HTML entry point generator
 *
 * Generates an index.html file for Vite to use as the entry point
 */

import { readFile, writeFile, readdir } from 'fs/promises';
import { join } from 'path';
import type { HtmlOptions, EntryPoint } from './types.js';

// ============================================================================
// Types for HTML preservation
// ============================================================================

/**
 * Represents an original bundle reference found in captured HTML
 */
export interface OriginalBundle {
    /** Original path from HTML (e.g., "/js/app.min.js") */
    originalPath: string;
    /** Type of asset */
    type: 'script' | 'stylesheet';
}

/**
 * Mapping from original asset paths to rebuilt asset paths
 */
export interface AssetMapping {
    /** Map of original script paths to rebuilt paths */
    scripts: Map<string, string>;
    /** Map of original stylesheet paths to rebuilt paths */
    stylesheets: Map<string, string>;
}

/**
 * Extract metadata from captured HTML if available
 */
export async function extractHtmlMetadata(
    projectDir: string,
): Promise<{ title?: string; headContent?: string; lang?: string }> {
    const possiblePaths = [
        join(projectDir, '_server', 'static', 'index.html'),
        join(projectDir, 'index.html'),
    ];

    for (const htmlPath of possiblePaths) {
        try {
            const content = await readFile(htmlPath, 'utf-8');

            // Extract title
            const titleMatch = content.match(/<title>([^<]+)<\/title>/i);
            const title = titleMatch ? titleMatch[1] : undefined;

            // Extract lang attribute
            const langMatch = content.match(
                /<html[^>]*\slang=["']([^"']+)["']/i,
            );
            const lang = langMatch ? langMatch[1] : undefined;

            // Extract useful head content (meta tags, links, etc.)
            // Skip scripts as Vite will handle those
            const headMatch = content.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
            let headContent = '';

            if (headMatch) {
                const headHtml = headMatch[1];

                // Extract meta tags (skip charset and viewport as we add those)
                const metaTags = headHtml.match(/<meta[^>]+>/gi) || [];
                const filteredMetas = metaTags.filter((tag) => {
                    const lowerTag = tag.toLowerCase();
                    return (
                        !lowerTag.includes('charset') &&
                        !lowerTag.includes('viewport') &&
                        !lowerTag.includes('x-ua-compatible')
                    );
                });
                headContent += filteredMetas.join('\n  ');

                // Extract favicon/icon links
                const iconLinks =
                    headHtml.match(
                        /<link[^>]*(rel=["'](?:icon|shortcut icon|apple-touch-icon)[^>]+)>/gi,
                    ) || [];
                if (iconLinks.length > 0) {
                    headContent += '\n  ' + iconLinks.join('\n  ');
                }

                // Extract manifest link
                const manifestLink = headHtml.match(
                    /<link[^>]*rel=["']manifest["'][^>]*>/i,
                );
                if (manifestLink) {
                    headContent += '\n  ' + manifestLink[0];
                }
            }

            return {
                title,
                headContent: headContent.trim() || undefined,
                lang,
            };
        } catch {
            // File doesn't exist, try next
        }
    }

    return {};
}

/**
 * Generate index.html content for Vite
 */
export function generateHtml(options: HtmlOptions): string {
    const {
        title,
        entryScript,
        mountElementId,
        headContent,
        lang = 'en',
    } = options;

    // Normalize entry script path
    const scriptPath = entryScript.startsWith('/')
        ? entryScript
        : `/${entryScript}`;

    const html = `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  ${headContent ? headContent + '\n  ' : ''}</head>
<body>
  <div id="${mountElementId}"></div>
  <script type="module" src="${scriptPath}"></script>
</body>
</html>
`;

    return html;
}

/**
 * Generate HTML based on detected entry points
 */
export async function generateHtmlFromEntryPoints(
    projectDir: string,
    entryPoints: EntryPoint[],
    defaultTitle: string = 'Rebuilt App',
): Promise<string> {
    // Get metadata from captured HTML
    const metadata = await extractHtmlMetadata(projectDir);

    if (entryPoints.length === 0) {
        throw new Error('No entry points detected');
    }

    // Use the first (highest confidence) entry point
    const primaryEntry = entryPoints[0];

    const options: HtmlOptions = {
        title: metadata.title || defaultTitle,
        entryScript: primaryEntry.path,
        mountElementId: primaryEntry.mountElement || 'root',
        headContent: metadata.headContent,
        lang: metadata.lang,
    };

    return generateHtml(options);
}

/**
 * Write index.html to the project directory
 */
export async function writeHtml(
    projectDir: string,
    entryPoints: EntryPoint[],
    defaultTitle?: string,
    overwrite: boolean = false,
): Promise<boolean> {
    const htmlPath = join(projectDir, 'index.html');

    // Check if HTML already exists (for rebuild, not the captured one)
    if (!overwrite) {
        try {
            const existing = await readFile(htmlPath, 'utf-8');
            // Check if it's a Vite entry HTML (has module script)
            if (existing.includes('type="module"')) {
                return false; // Already have a Vite entry HTML
            }
        } catch {
            // File doesn't exist, proceed
        }
    }

    // Determine default title from project directory
    const dirName = projectDir.split('/').pop() || 'App';
    const title =
        defaultTitle ||
        dirName.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

    const htmlContent = await generateHtmlFromEntryPoints(
        projectDir,
        entryPoints,
        title,
    );
    await writeFile(htmlPath, htmlContent, 'utf-8');

    return true;
}

/**
 * Generate HTML for multiple entry points (multi-page app)
 */
export async function generateMultiPageHtml(
    projectDir: string,
    entryPoints: EntryPoint[],
): Promise<Map<string, string>> {
    const htmlFiles = new Map<string, string>();
    const metadata = await extractHtmlMetadata(projectDir);

    for (const entry of entryPoints) {
        // Derive HTML filename from entry path
        const baseName = entry.path
            .replace(/^.*\//, '') // Get filename
            .replace(/\.(tsx?|jsx?)$/, '') // Remove extension
            .replace(/^index$/, 'main'); // Rename index to main

        const htmlName =
            baseName === 'main' ? 'index.html' : `${baseName}.html`;

        const options: HtmlOptions = {
            title: metadata.title || `${baseName} - Rebuilt App`,
            entryScript: entry.path,
            mountElementId: entry.mountElement || 'root',
            headContent: metadata.headContent,
            lang: metadata.lang,
        };

        htmlFiles.set(htmlName, generateHtml(options));
    }

    return htmlFiles;
}

// ============================================================================
// Server-rendered HTML preservation
// ============================================================================

/**
 * Checks if HTML content is server-rendered (has actual content)
 * vs. a SPA shell (empty body with just a mount div).
 *
 * @param content - HTML content to check
 * @returns true if HTML has substantial body content
 */
export function isServerRenderedHtml(content: string): boolean {
    const bodyMatch = content.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (!bodyMatch) return false;

    const bodyContent = bodyMatch[1].trim();

    // Remove script tags to check actual content
    const withoutScripts = bodyContent
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .trim();

    // Common SPA mount div patterns
    const spaShellPatterns = [
        /^<div[^>]*id=["'](root|app|__next|__nuxt|__app)["'][^>]*>\s*<\/div>$/i,
        /^<div[^>]*id=["'](root|app|__next|__nuxt|__app)["'][^>]*><\/div>$/i,
    ];

    for (const pattern of spaShellPatterns) {
        if (pattern.test(withoutScripts)) {
            return false; // It's a SPA shell
        }
    }

    // Has substantial content if meaningful length
    return withoutScripts.length > 50;
}

/**
 * Extracts original script and stylesheet paths from captured HTML.
 * Only extracts local paths (not CDN/external resources).
 *
 * @param capturedHtml - HTML content to extract bundles from
 * @returns Array of original bundle references
 */
export function extractOriginalBundles(capturedHtml: string): OriginalBundle[] {
    const bundles: OriginalBundle[] = [];

    // Extract script src paths
    // Matches: <script src="..."> or <script src="..."></script>
    const scriptPattern = /<script[^>]*\ssrc=["']([^"']+)["'][^>]*>/gi;
    let match;

    while ((match = scriptPattern.exec(capturedHtml)) !== null) {
        const src = match[1];

        // Only include local paths (start with / but not //)
        if (src.startsWith('/') && !src.startsWith('//')) {
            bundles.push({
                originalPath: src,
                type: 'script',
            });
        }
    }

    // Extract stylesheet href paths
    // Matches: <link rel="stylesheet" href="..."> or <link href="..." rel="stylesheet">
    const linkPattern =
        /<link[^>]*\shref=["']([^"']+\.css(?:\?[^"']*)?)["'][^>]*>/gi;

    while ((match = linkPattern.exec(capturedHtml)) !== null) {
        const href = match[1];

        // Only include local paths
        if (href.startsWith('/') && !href.startsWith('//')) {
            // Verify it's a stylesheet link (not preload, etc.)
            const fullMatch = match[0].toLowerCase();
            if (
                fullMatch.includes('rel="stylesheet"') ||
                fullMatch.includes("rel='stylesheet'")
            ) {
                bundles.push({
                    originalPath: href,
                    type: 'stylesheet',
                });
            }
        }
    }

    return bundles;
}

/**
 * Builds a mapping from original asset paths to rebuilt asset paths.
 *
 * Scans the rebuilt assets directory and maps:
 * - All original JS bundles → single rebuilt index-*.js
 * - All original CSS bundles → single rebuilt index-*.css (if exists)
 *
 * @param rebuiltDir - Path to rebuilt output directory (e.g., _rebuilt)
 * @param originalBundles - Original bundle references from captured HTML
 * @returns Mapping of original paths to rebuilt paths
 */
export async function buildAssetMapping(
    rebuiltDir: string,
    originalBundles: OriginalBundle[],
): Promise<AssetMapping> {
    const scripts = new Map<string, string>();
    const stylesheets = new Map<string, string>();

    // Scan rebuilt assets directory
    const assetsDir = join(rebuiltDir, 'assets');
    let assetFiles: string[] = [];

    try {
        assetFiles = await readdir(assetsDir);
    } catch {
        // Assets directory doesn't exist
        return { scripts, stylesheets };
    }

    // Find rebuilt JS entry (index-*.js)
    const rebuiltJs = assetFiles.find(
        (f) => f.startsWith('index-') && f.endsWith('.js'),
    );

    // Find rebuilt CSS entry (index-*.css)
    const rebuiltCss = assetFiles.find(
        (f) => f.startsWith('index-') && f.endsWith('.css'),
    );

    // Map all original JS bundles to the single rebuilt JS
    if (rebuiltJs) {
        const rebuiltJsPath = `/assets/${rebuiltJs}`;
        for (const bundle of originalBundles) {
            if (bundle.type === 'script') {
                scripts.set(bundle.originalPath, rebuiltJsPath);
            }
        }
    }

    // Map all original CSS bundles to the single rebuilt CSS
    if (rebuiltCss) {
        const rebuiltCssPath = `/assets/${rebuiltCss}`;
        for (const bundle of originalBundles) {
            if (bundle.type === 'stylesheet') {
                stylesheets.set(bundle.originalPath, rebuiltCssPath);
            }
        }
    }

    return { scripts, stylesheets };
}

/**
 * Preserves server-rendered HTML while updating asset references
 * to point to rebuilt assets.
 *
 * Handles:
 * - <script src="..."> → <script type="module" crossorigin src="...">
 * - <link rel="stylesheet" href="..."> updates
 * - Removes 'defer' attribute (redundant for modules)
 * - Preserves all body content, inline styles, and HTML structure
 *
 * @param capturedHtml - Original captured HTML content
 * @param assetMapping - Mapping of original to rebuilt paths
 * @returns Transformed HTML with updated asset references
 */
export function preserveServerRenderedHtml(
    capturedHtml: string,
    assetMapping: AssetMapping,
): string {
    let html = capturedHtml;

    // Replace script tags with rebuilt paths
    // Pattern matches script tags with src attribute
    const scriptPattern =
        /(<script)([^>]*)\ssrc=["']([^"']+)["']([^>]*)(>(?:<\/script>)?)/gi;

    html = html.replace(
        scriptPattern,
        (match, _tagStart, beforeSrc, src, afterSrc, _tagEnd) => {
            const rebuiltPath = assetMapping.scripts.get(src);

            if (rebuiltPath) {
                // Remove defer attribute (redundant for modules)
                let attrs = (beforeSrc + afterSrc)
                    .replace(/\sdefer(?:=["'][^"']*["'])?/gi, '')
                    .replace(/\s+/g, ' ')
                    .trim();

                // Build new script tag with module type
                const newAttrs = attrs ? ` ${attrs}` : '';
                return `<script type="module" crossorigin src="${rebuiltPath}"${newAttrs}></script>`;
            }

            // Keep original (external/CDN)
            return match;
        },
    );

    // Replace stylesheet links with rebuilt paths
    const linkPattern =
        /(<link)([^>]*)\shref=["']([^"']+\.css(?:\?[^"']*)?)["']([^>]*)(>)/gi;

    html = html.replace(
        linkPattern,
        (match, _tagStart, beforeHref, href, afterHref, _tagEnd) => {
            const rebuiltPath = assetMapping.stylesheets.get(href);

            if (rebuiltPath) {
                // Preserve other attributes
                const attrs = (beforeHref + afterHref).trim();
                return `<link${attrs ? ' ' + attrs : ''} href="${rebuiltPath}">`;
            }

            // Keep original
            return match;
        },
    );

    return html;
}

/**
 * Orchestrates HTML preservation after Vite build.
 *
 * Reads captured HTML from _server/static/index.html, checks if it's
 * server-rendered, builds asset mapping, and writes preserved HTML
 * to the output directory.
 *
 * @param projectDir - Project directory (e.g., output/moosicbox.com)
 * @param outputDir - Rebuilt output directory (e.g., output/moosicbox.com/_rebuilt)
 * @returns true if HTML was preserved, false if Vite's HTML should be kept
 */
export async function preserveHtmlIfServerRendered(
    projectDir: string,
    outputDir: string,
): Promise<boolean> {
    const capturedHtmlPath = join(
        projectDir,
        '_server',
        'static',
        'index.html',
    );

    try {
        const capturedHtml = await readFile(capturedHtmlPath, 'utf-8');

        if (!isServerRenderedHtml(capturedHtml)) {
            return false; // It's a SPA shell, keep Vite's generated HTML
        }

        // Extract original bundles from captured HTML
        const originalBundles = extractOriginalBundles(capturedHtml);

        if (originalBundles.length === 0) {
            return false; // No bundles to map
        }

        // Build mapping from original to rebuilt paths
        const assetMapping = await buildAssetMapping(
            outputDir,
            originalBundles,
        );

        // Check if we have any mappings
        if (
            assetMapping.scripts.size === 0 &&
            assetMapping.stylesheets.size === 0
        ) {
            return false; // No rebuilt assets found
        }

        // Preserve HTML with updated references
        const preservedHtml = preserveServerRenderedHtml(
            capturedHtml,
            assetMapping,
        );

        // Overwrite Vite's generated index.html
        await writeFile(join(outputDir, 'index.html'), preservedHtml, 'utf-8');

        return true;
    } catch {
        // No captured HTML or error - keep Vite's generated HTML
        return false;
    }
}
