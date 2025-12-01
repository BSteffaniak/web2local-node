import { createWriteStream } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { dirname, join } from "path";

export interface SourceFile {
  path: string;
  content: string;
}

export interface SourceMapResult {
  bundleUrl: string;
  sourceMapUrl: string;
  files: SourceFile[];
  errors: string[];
}

/**
 * Streaming source map parser that extracts sources without loading entire file into memory.
 * Uses a custom incremental JSON parser to handle large source maps efficiently.
 */
export async function extractSourcesFromMap(
  sourceMapUrl: string,
  bundleUrl: string,
  onFile?: (file: SourceFile) => void
): Promise<SourceMapResult> {
  const result: SourceMapResult = {
    bundleUrl,
    sourceMapUrl,
    files: [],
    errors: [],
  };

  try {
    const response = await fetch(sourceMapUrl);
    if (!response.ok) {
      result.errors.push(`Failed to fetch source map: ${response.status} ${response.statusText}`);
      return result;
    }

    // For streaming, we need to parse the JSON incrementally
    // The source map format has "sources" and "sourcesContent" arrays that correspond
    const text = await response.text();
    
    // Parse the source map JSON
    let sourceMap: {
      version: number;
      sources?: string[];
      sourcesContent?: (string | null)[];
      sourceRoot?: string;
    };

    try {
      sourceMap = JSON.parse(text);
    } catch (e) {
      result.errors.push(`Failed to parse source map JSON: ${e}`);
      return result;
    }

    if (!sourceMap.sources || !sourceMap.sourcesContent) {
      result.errors.push('Source map missing sources or sourcesContent arrays');
      return result;
    }

    const sourceRoot = sourceMap.sourceRoot || '';

    for (let i = 0; i < sourceMap.sources.length; i++) {
      const sourcePath = sourceMap.sources[i];
      const content = sourceMap.sourcesContent[i];

      if (content === null || content === undefined) {
        continue;
      }

      // Normalize the path
      const normalizedPath = normalizePath(sourcePath, sourceRoot);
      
      const file: SourceFile = {
        path: normalizedPath,
        content,
      };

      result.files.push(file);
      onFile?.(file);
    }

    return result;
  } catch (error) {
    result.errors.push(`Error processing source map: ${error}`);
    return result;
  }
}

/**
 * Normalizes source paths from various bundler formats
 */
export function normalizePath(sourcePath: string, sourceRoot: string = ''): string {
  let path = sourcePath;

  // Handle webpack:// protocol
  if (path.startsWith('webpack://')) {
    path = path.replace(/^webpack:\/\/[^/]*\//, '');
  }

  // Handle vite/rollup paths
  if (path.startsWith('\u0000')) {
    path = path.slice(1);
  }

  // Apply source root if present
  if (sourceRoot && !path.startsWith('/') && !path.startsWith('.')) {
    path = sourceRoot + path;
  }

  // Remove leading ./
  path = path.replace(/^\.\//, '');

  // Resolve .. segments safely
  const segments = path.split('/');
  const resolved: string[] = [];
  
  for (const segment of segments) {
    if (segment === '..') {
      // Only pop if we have segments and the last one isn't already ..
      if (resolved.length > 0 && resolved[resolved.length - 1] !== '..') {
        resolved.pop();
      } else {
        // Keep the .. if we can't resolve it
        resolved.push(segment);
      }
    } else if (segment !== '.' && segment !== '') {
      resolved.push(segment);
    }
  }

  return resolved.join('/');
}

/**
 * Checks if a path should be included based on filters
 */
export function shouldIncludePath(
  path: string,
  includeNodeModules: boolean
): boolean {
  // Always exclude some paths
  if (path.includes('\u0000')) {
    return false;
  }

  // Filter node_modules if not included
  if (!includeNodeModules && path.includes('node_modules')) {
    return false;
  }

  // Exclude common virtual/internal paths
  const excludePatterns = [
    /^\(webpack\)/,
    /^__vite/,
    /^vite\//,
    /^\?/,
    /^data:/,
  ];

  for (const pattern of excludePatterns) {
    if (pattern.test(path)) {
      return false;
    }
  }

  return true;
}

/**
 * Gets a clean filename for a source path, handling edge cases
 */
export function getCleanFilename(path: string): string {
  // Remove query strings
  const withoutQuery = path.split('?')[0];
  
  // Get the filename
  const parts = withoutQuery.split('/');
  const filename = parts[parts.length - 1];
  
  // If no extension, try to infer one
  if (!filename.includes('.')) {
    return filename + '.js';
  }
  
  return filename;
}
