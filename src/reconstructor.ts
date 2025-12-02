import { mkdir, writeFile, readFile, stat } from "fs/promises";
import { dirname, join } from "path";
import { createHash } from "crypto";
import { SourceFile, shouldIncludePath } from "./sourcemap.js";

export interface ReconstructionOptions {
  outputDir: string;
  includeNodeModules: boolean;
  siteHostname: string;
  bundleName: string;
}

export interface ReconstructionResult {
  filesWritten: number;
  filesSkipped: number;
  filesUnchanged: number;
  errors: string[];
  outputPath: string;
}

export interface Manifest {
  extractedAt: string;
  sourceUrl: string;
  bundles: BundleManifest[];
  totalFiles: number;
  stats: {
    byExtension: Record<string, number>;
    byDirectory: Record<string, number>;
  };
}

export interface BundleManifest {
  bundleUrl: string;
  sourceMapUrl: string;
  filesExtracted: number;
  files: string[];
}

/**
 * Checks if a file exists and has the same content (by comparing size and hash)
 */
async function fileExistsWithSameContent(filePath: string, content: string): Promise<boolean> {
  try {
    const fileStats = await stat(filePath);
    
    // Quick check: if size doesn't match, content is different
    const contentBytes = Buffer.byteLength(content, 'utf-8');
    if (fileStats.size !== contentBytes) {
      return false;
    }
    
    // Size matches, check hash
    const existingContent = await readFile(filePath, 'utf-8');
    const existingHash = createHash('md5').update(existingContent).digest('hex');
    const newHash = createHash('md5').update(content).digest('hex');
    
    return existingHash === newHash;
  } catch {
    // File doesn't exist or can't be read
    return false;
  }
}

/**
 * Reconstructs the original file structure from extracted sources.
 * Skips writing files that already exist with the same content.
 */
export async function reconstructSources(
  files: SourceFile[],
  options: ReconstructionOptions
): Promise<ReconstructionResult> {
  const result: ReconstructionResult = {
    filesWritten: 0,
    filesSkipped: 0,
    filesUnchanged: 0,
    errors: [],
    outputPath: join(options.outputDir, options.siteHostname, options.bundleName),
  };

  for (const file of files) {
    try {
      // Check if we should include this file
      if (!shouldIncludePath(file.path, options.includeNodeModules)) {
        result.filesSkipped++;
        continue;
      }

      // Sanitize the path to prevent directory traversal
      const safePath = sanitizePath(file.path);
      if (!safePath) {
        result.filesSkipped++;
        continue;
      }

      const fullPath = join(result.outputPath, safePath);
      
      // Check if file already exists with same content
      if (await fileExistsWithSameContent(fullPath, file.content)) {
        result.filesUnchanged++;
        result.filesWritten++; // Count as "written" for reporting purposes
        continue;
      }
      
      // Create directory structure
      await mkdir(dirname(fullPath), { recursive: true });
      
      // Write the file
      await writeFile(fullPath, file.content, 'utf-8');
      result.filesWritten++;
    } catch (error) {
      result.errors.push(`Failed to write ${file.path}: ${error}`);
    }
  }

  return result;
}

/**
 * Sanitizes a path to prevent directory traversal attacks
 */
function sanitizePath(path: string): string | null {
  // Remove any null bytes
  let sanitized = path.replace(/\0/g, '');
  
  // Remove leading slashes and dots
  sanitized = sanitized.replace(/^[./\\]+/, '');
  
  // Resolve the path and check it doesn't escape
  const segments = sanitized.split(/[/\\]/);
  const resolved: string[] = [];
  
  for (const segment of segments) {
    if (segment === '..') {
      if (resolved.length > 0) {
        resolved.pop();
      }
      // Don't allow escaping the base directory
    } else if (segment && segment !== '.') {
      // Sanitize each segment
      const cleanSegment = segment.replace(/[<>:"|?*]/g, '_');
      resolved.push(cleanSegment);
    }
  }
  
  if (resolved.length === 0) {
    return null;
  }
  
  return resolved.join('/');
}

/**
 * Generates a manifest file summarizing what was extracted
 */
export async function writeManifest(
  outputDir: string,
  sourceUrl: string,
  bundles: BundleManifest[]
): Promise<void> {
  const stats = {
    byExtension: {} as Record<string, number>,
    byDirectory: {} as Record<string, number>,
  };

  let totalFiles = 0;

  for (const bundle of bundles) {
    totalFiles += bundle.filesExtracted;
    
    for (const file of bundle.files) {
      // Count by extension
      const ext = file.split('.').pop() || 'no-ext';
      stats.byExtension[ext] = (stats.byExtension[ext] || 0) + 1;
      
      // Count by top-level directory
      const topDir = file.split('/')[0] || 'root';
      stats.byDirectory[topDir] = (stats.byDirectory[topDir] || 0) + 1;
    }
  }

  const manifest: Manifest = {
    extractedAt: new Date().toISOString(),
    sourceUrl,
    bundles,
    totalFiles,
    stats,
  };

  const manifestPath = join(outputDir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
}

/**
 * Gets the bundle name from a URL for organizing output
 */
export function getBundleName(bundleUrl: string): string {
  const url = new URL(bundleUrl);
  const pathParts = url.pathname.split('/').filter(Boolean);
  
  // Try to get a meaningful name from the path
  // e.g., /navigation/index-C4LR0b0Z.js -> navigation
  if (pathParts.length > 1) {
    return pathParts[pathParts.length - 2];
  }
  
  // Fallback to filename without hash
  const filename = pathParts[pathParts.length - 1] || 'bundle';
  return filename.replace(/[-_.][a-zA-Z0-9]{6,}\.js$/, '').replace(/\.js$/, '');
}
