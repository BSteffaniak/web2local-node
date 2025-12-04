/**
 * HTML entry point generator
 *
 * Generates an index.html file for Vite to use as the entry point
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type { HtmlOptions, EntryPoint } from './types.js';

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
