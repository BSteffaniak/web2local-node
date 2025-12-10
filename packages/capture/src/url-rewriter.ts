/**
 * URL Rewriting for Captured Assets
 *
 * Provides comprehensive URL rewriting for HTML and CSS content to make
 * captured pages fully self-contained by pointing all external URLs to
 * locally stored copies.
 *
 * Uses node-html-parser to find URL locations in HTML while preserving
 * the original document structure.
 */

import { parse as parseHTML, HTMLElement } from 'node-html-parser';

/**
 * Represents a captured asset with its URL mapping
 */
export interface AssetMapping {
    /** Original URL of the asset */
    url: string;
    /** Local path where the asset is stored */
    localPath: string;
}

/**
 * Represents a URL replacement to be made in content
 */
interface UrlReplacement {
    /** Start position in the source string */
    start: number;
    /** End position in the source string */
    end: number;
    /** The new URL to replace with */
    newUrl: string;
}

/**
 * HTML attributes that may contain URLs
 */
const URL_ATTRIBUTES = [
    'src',
    'href',
    'poster',
    'data',
    'action',
    'formaction',
    'data-src',
    'data-href',
    'data-background',
    'data-poster',
];

/**
 * HTML attributes that contain srcset (special parsing needed)
 */
const SRCSET_ATTRIBUTES = ['srcset', 'data-srcset', 'imagesrcset'];

/**
 * Meta tags with URL content
 */
const URL_META_PROPERTIES = [
    'og:image',
    'og:image:url',
    'og:image:secure_url',
    'og:video',
    'og:video:url',
    'og:video:secure_url',
    'og:audio',
    'og:audio:url',
    'og:audio:secure_url',
    'og:url',
    'twitter:image',
    'twitter:image:src',
    'twitter:player',
];

/**
 * Build a URL mapping from captured assets
 *
 * @param assets - Array of captured asset mappings
 * @param baseUrl - The base URL of the captured site
 * @returns Map from original URL to local path (with leading /)
 */
export function buildUrlMap(
    assets: AssetMapping[],
    baseUrl: string,
): Map<string, string> {
    const urlMap = new Map<string, string>();
    const baseUrlObj = new URL(baseUrl);

    for (const asset of assets) {
        // Ensure local path has leading slash
        const localPath = asset.localPath.startsWith('/')
            ? asset.localPath
            : '/' + asset.localPath;

        // Map the full URL
        urlMap.set(asset.url, localPath);

        // Also map the pathname-only version for same-origin URLs
        try {
            const assetUrl = new URL(asset.url);
            if (assetUrl.origin === baseUrlObj.origin) {
                // Map the pathname (with query string if present)
                const pathWithQuery =
                    assetUrl.pathname +
                    (assetUrl.search ? assetUrl.search : '');
                if (!urlMap.has(pathWithQuery)) {
                    urlMap.set(pathWithQuery, localPath);
                }
            }
        } catch {
            // Invalid URL, skip pathname mapping
        }
    }

    return urlMap;
}

/**
 * Resolve a URL against a base URL
 *
 * @param url - The URL to resolve (may be relative)
 * @param baseUrl - The base URL to resolve against
 * @returns The resolved absolute URL, or null if invalid
 */
function resolveUrl(url: string, baseUrl: string): string | null {
    // Skip non-http URLs
    if (
        url.startsWith('data:') ||
        url.startsWith('javascript:') ||
        url.startsWith('mailto:') ||
        url.startsWith('tel:') ||
        url.startsWith('blob:') ||
        url.startsWith('#')
    ) {
        return null;
    }

    try {
        // Handle protocol-relative URLs
        if (url.startsWith('//')) {
            const baseProtocol = new URL(baseUrl).protocol;
            return new URL(baseProtocol + url).href;
        }

        // Resolve relative URLs
        return new URL(url, baseUrl).href;
    } catch {
        return null;
    }
}

/**
 * Find the position of an attribute value in HTML source
 *
 * Given an element's range and attribute name, finds the start and end
 * positions of the attribute's value (inside the quotes).
 *
 * @param html - The full HTML source
 * @param elementRange - The [start, end] range of the element
 * @param attrName - The attribute name to find
 * @returns The [start, end] positions of the value, or null if not found
 */
function findAttributeValuePosition(
    html: string,
    elementRange: readonly [number, number],
    attrName: string,
): [number, number] | null {
    const [elemStart, elemEnd] = elementRange;

    // Find the end of the opening tag (first > that's not inside a quote)
    let tagEnd = elemStart;
    let inQuote: string | null = null;
    for (let i = elemStart; i < elemEnd && i < html.length; i++) {
        const char = html[i];
        if (inQuote) {
            if (char === inQuote) {
                inQuote = null;
            }
        } else {
            if (char === '"' || char === "'") {
                inQuote = char;
            } else if (char === '>') {
                tagEnd = i;
                break;
            }
        }
    }

    // Search for the attribute within the opening tag
    const tagContent = html.slice(elemStart, tagEnd + 1);

    // Try quoted values first
    const quotedPattern = new RegExp(`\\s${attrName}\\s*=\\s*(['"])`, 'i');
    const quotedMatch = quotedPattern.exec(tagContent);

    if (quotedMatch) {
        const quote = quotedMatch[1];
        const attrStart = quotedMatch.index + quotedMatch[0].length;
        // Find the closing quote
        const closeQuotePos = tagContent.indexOf(quote, attrStart);
        if (closeQuotePos !== -1) {
            return [elemStart + attrStart, elemStart + closeQuotePos];
        }
    }

    // Try unquoted value
    const unquotedPattern = new RegExp(
        `\\s${attrName}\\s*=\\s*([^\\s>"']+)`,
        'i',
    );
    const unquotedMatch = unquotedPattern.exec(tagContent);
    if (unquotedMatch) {
        const valueStart =
            unquotedMatch.index +
            unquotedMatch[0].length -
            unquotedMatch[1].length;
        const valueEnd = valueStart + unquotedMatch[1].length;
        return [elemStart + valueStart, elemStart + valueEnd];
    }

    return null;
}

/**
 * Rewrite URLs in HTML content
 *
 * Uses node-html-parser to find URL-containing attributes and rewrites them
 * using position-based string replacement to preserve the original structure.
 *
 * @param html - The HTML content to rewrite
 * @param urlMap - Map from original URLs to local paths
 * @param baseUrl - The base URL for resolving relative URLs
 * @returns The HTML with URLs rewritten
 */
export function rewriteHtml(
    html: string,
    urlMap: Map<string, string>,
    baseUrl: string,
): string {
    const replacements: UrlReplacement[] = [];

    // Parse HTML to find elements with URL attributes
    const root = parseHTML(html, {
        comment: true,
        blockTextElements: {
            script: true,
            noscript: true,
            style: true,
            pre: true,
        },
    });

    // Find all elements with URL attributes
    const allElements = root.querySelectorAll('*');

    for (const element of allElements) {
        if (!(element instanceof HTMLElement)) continue;

        const range = element.range;
        if (!range) continue;

        // Check standard URL attributes
        for (const attrName of URL_ATTRIBUTES) {
            const attrValue = element.getAttribute(attrName);
            if (!attrValue) continue;

            const resolvedUrl = resolveUrl(attrValue, baseUrl);
            if (!resolvedUrl) continue;

            // Look up in URL map
            const localPath = urlMap.get(resolvedUrl) || urlMap.get(attrValue);
            if (!localPath) continue;

            // Find the position of this attribute value
            const valuePos = findAttributeValuePosition(html, range, attrName);
            if (valuePos) {
                replacements.push({
                    start: valuePos[0],
                    end: valuePos[1],
                    newUrl: localPath,
                });
            }
        }

        // Check srcset attributes (need special handling)
        for (const attrName of SRCSET_ATTRIBUTES) {
            const attrValue = element.getAttribute(attrName);
            if (!attrValue) continue;

            const valuePos = findAttributeValuePosition(html, range, attrName);
            if (!valuePos) continue;

            // Rewrite the srcset value
            const rewrittenSrcset = rewriteSrcset(attrValue, urlMap, baseUrl);
            if (rewrittenSrcset !== attrValue) {
                replacements.push({
                    start: valuePos[0],
                    end: valuePos[1],
                    newUrl: rewrittenSrcset,
                });
            }
        }

        // Check style attribute for url() references
        const styleAttr = element.getAttribute('style');
        if (styleAttr && styleAttr.includes('url(')) {
            const valuePos = findAttributeValuePosition(html, range, 'style');
            if (valuePos) {
                const rewrittenStyle = rewriteCss(styleAttr, urlMap, baseUrl);
                if (rewrittenStyle !== styleAttr) {
                    replacements.push({
                        start: valuePos[0],
                        end: valuePos[1],
                        newUrl: rewrittenStyle,
                    });
                }
            }
        }

        // Check meta tags with URL content
        if (element.tagName === 'META') {
            const property = element.getAttribute('property');
            const name = element.getAttribute('name');
            const content = element.getAttribute('content');

            if (
                content &&
                (URL_META_PROPERTIES.includes(property || '') ||
                    URL_META_PROPERTIES.includes(name || ''))
            ) {
                const resolvedUrl = resolveUrl(content, baseUrl);
                if (resolvedUrl) {
                    const localPath =
                        urlMap.get(resolvedUrl) || urlMap.get(content);
                    if (localPath) {
                        const valuePos = findAttributeValuePosition(
                            html,
                            range,
                            'content',
                        );
                        if (valuePos) {
                            replacements.push({
                                start: valuePos[0],
                                end: valuePos[1],
                                newUrl: localPath,
                            });
                        }
                    }
                }
            }
        }
    }

    // Rewrite inline <style> blocks
    const styleElements = root.querySelectorAll('style');
    for (const styleElement of styleElements) {
        if (!(styleElement instanceof HTMLElement)) continue;

        const styleContent = styleElement.textContent;
        if (!styleContent || !styleContent.includes('url(')) continue;

        // Find the position of the style content in the original HTML
        const range = styleElement.range;
        if (!range) continue;

        // Find the opening tag end and closing tag start
        const styleHtml = html.slice(range[0], range[1]);
        const openTagEnd = styleHtml.indexOf('>');
        const closeTagStart = styleHtml.lastIndexOf('</');

        if (openTagEnd !== -1 && closeTagStart !== -1) {
            const contentStart = range[0] + openTagEnd + 1;
            const contentEnd = range[0] + closeTagStart;
            const originalContent = html.slice(contentStart, contentEnd);

            const rewrittenContent = rewriteCss(
                originalContent,
                urlMap,
                baseUrl,
            );
            if (rewrittenContent !== originalContent) {
                replacements.push({
                    start: contentStart,
                    end: contentEnd,
                    newUrl: rewrittenContent,
                });
            }
        }
    }

    // Apply replacements from end to start to preserve positions
    replacements.sort((a, b) => b.start - a.start);

    let result = html;
    for (const replacement of replacements) {
        result =
            result.slice(0, replacement.start) +
            replacement.newUrl +
            result.slice(replacement.end);
    }

    return result;
}

/**
 * Rewrite a srcset attribute value
 *
 * @param srcset - The srcset value
 * @param urlMap - Map from original URLs to local paths
 * @param baseUrl - Base URL for resolving relative URLs
 * @returns The rewritten srcset value
 */
function rewriteSrcset(
    srcset: string,
    urlMap: Map<string, string>,
    baseUrl: string,
): string {
    // Parse srcset: "url descriptor, url descriptor, ..."
    // Descriptor is optional and can be "100w" or "2x"
    const entries = srcset.split(',').map((entry) => entry.trim());
    const rewrittenEntries: string[] = [];

    for (const entry of entries) {
        if (!entry) continue;

        // Split into URL and descriptor
        const parts = entry.split(/\s+/);
        const url = parts[0];
        const descriptor = parts.slice(1).join(' ');

        if (!url) {
            rewrittenEntries.push(entry);
            continue;
        }

        // Skip data URLs
        if (url.startsWith('data:')) {
            rewrittenEntries.push(entry);
            continue;
        }

        const resolvedUrl = resolveUrl(url, baseUrl);
        if (resolvedUrl) {
            const localPath = urlMap.get(resolvedUrl) || urlMap.get(url);
            if (localPath) {
                rewrittenEntries.push(
                    descriptor ? `${localPath} ${descriptor}` : localPath,
                );
                continue;
            }
        }

        // Keep original if no mapping found
        rewrittenEntries.push(entry);
    }

    return rewrittenEntries.join(', ');
}

/**
 * Rewrite URLs in CSS content
 *
 * Finds all url() references and rewrites them to local paths.
 *
 * @param css - The CSS content to rewrite
 * @param urlMap - Map from original URLs to local paths
 * @param baseUrl - Base URL for resolving relative URLs (usually the CSS file URL)
 * @returns The CSS with URLs rewritten
 */
export function rewriteCss(
    css: string,
    urlMap: Map<string, string>,
    baseUrl: string,
): string {
    // Match url() with optional quotes
    // Handles: url("path"), url('path'), url(path)
    const urlPattern = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

    return css.replace(urlPattern, (match, quote, url) => {
        // Skip data URLs and other non-http URLs
        if (
            url.startsWith('data:') ||
            url.startsWith('blob:') ||
            url.startsWith('#')
        ) {
            return match;
        }

        const resolvedUrl = resolveUrl(url, baseUrl);
        if (!resolvedUrl) {
            return match;
        }

        const localPath = urlMap.get(resolvedUrl) || urlMap.get(url);
        if (!localPath) {
            return match;
        }

        // Preserve the original quote style
        return `url(${quote}${localPath}${quote})`;
    });
}

/**
 * Rewrite @import URLs in CSS
 *
 * @param css - The CSS content
 * @param urlMap - Map from original URLs to local paths
 * @param baseUrl - Base URL for resolving relative URLs
 * @returns The CSS with @import URLs rewritten
 */
export function rewriteCssImports(
    css: string,
    urlMap: Map<string, string>,
    baseUrl: string,
): string {
    // Match @import with url() or direct string
    // @import url("path");
    // @import url('path');
    // @import "path";
    // @import 'path';
    const importPattern =
        /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)/gi;

    return css.replace(
        importPattern,
        (match, urlQuote, urlPath, strQuote, strPath) => {
            const path = urlPath || strPath;
            const quote = urlQuote || strQuote || '"';

            if (!path) {
                return match;
            }

            const resolvedUrl = resolveUrl(path, baseUrl);
            if (!resolvedUrl) {
                return match;
            }

            const localPath = urlMap.get(resolvedUrl) || urlMap.get(path);
            if (!localPath) {
                return match;
            }

            // Preserve the original format
            if (urlPath) {
                return `@import url(${quote}${localPath}${quote})`;
            } else {
                return `@import ${quote}${localPath}${quote}`;
            }
        },
    );
}

/**
 * Rewrite all URLs in CSS content (both url() and @import)
 *
 * @param css - The CSS content to rewrite
 * @param urlMap - Map from original URLs to local paths
 * @param cssUrl - URL of the CSS file (for resolving relative URLs)
 * @returns The CSS with all URLs rewritten
 */
export function rewriteAllCssUrls(
    css: string,
    urlMap: Map<string, string>,
    cssUrl: string,
): string {
    let result = css;
    result = rewriteCssImports(result, urlMap, cssUrl);
    result = rewriteCss(result, urlMap, cssUrl);
    return result;
}
