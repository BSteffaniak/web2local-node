import { readdir, writeFile, stat, readFile } from "fs/promises";
import { join, dirname, basename, relative, extname } from "path";

/**
 * Information about a package that needs stub files
 */
export interface PackageInfo {
  name: string;
  path: string;
  hasIndex: boolean;
  exportedModules: string[];
}

/**
 * Recursively finds all TypeScript/JavaScript files in a directory
 */
async function findSourceFiles(dir: string, baseDir: string = dir): Promise<string[]> {
  const files: string[] = [];
  
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      
      if (entry.isDirectory()) {
        // Skip node_modules within the package
        if (entry.name === 'node_modules') continue;
        files.push(...await findSourceFiles(fullPath, baseDir));
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
          files.push(relative(baseDir, fullPath));
        }
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }
  
  return files;
}

/**
 * Checks if a file exists
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Export information from a file
 */
interface FileExports {
  /** Named exports (export const X, export { X }) */
  named: string[];
  /** Type-only exports (export type X, export interface X) */
  types: string[];
  /** Whether file has a default export */
  hasDefault: boolean;
  /** Name of default export if identifiable */
  defaultName?: string;
}

/**
 * Extracts exported identifiers from a TypeScript/JavaScript file
 */
async function extractExports(filePath: string): Promise<FileExports> {
  const result: FileExports = {
    named: [],
    types: [],
    hasDefault: false,
  };
  
  try {
    const content = await readFile(filePath, 'utf-8');
    
    // Match: export const/let/var/function/class Name (named value exports)
    const namedValuePattern = /export\s+(?:const|let|var|function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
    let match;
    while ((match = namedValuePattern.exec(content)) !== null) {
      result.named.push(match[1]);
    }
    
    // Match: export type/interface Name (type exports)
    const typeExportPattern = /export\s+(?:type|interface)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
    while ((match = typeExportPattern.exec(content)) !== null) {
      result.types.push(match[1]);
    }
    
    // Match: export enum Name
    const enumPattern = /export\s+enum\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
    while ((match = enumPattern.exec(content)) !== null) {
      result.named.push(match[1]);
    }
    
    // Match: export { Name, Name2 } (but not export type { })
    const bracketExportPattern = /export\s+\{([^}]+)\}/g;
    while ((match = bracketExportPattern.exec(content)) !== null) {
      // Check if this is preceded by 'type'
      const beforeMatch = content.slice(Math.max(0, match.index - 10), match.index);
      const isTypeExport = /export\s+type\s*$/.test(beforeMatch);
      
      const names = match[1].split(',').map(n => {
        const parts = n.trim().split(/\s+as\s+/);
        return parts[parts.length - 1].trim();
      }).filter(n => n && n !== 'type');
      
      if (isTypeExport) {
        result.types.push(...names);
      } else {
        result.named.push(...names);
      }
    }
    
    // Match: export default - detect if it has a name
    if (/export\s+default\s/.test(content)) {
      result.hasDefault = true;
      
      // Try to get the name: export default function Name / export default class Name
      const defaultNamedPattern = /export\s+default\s+(?:function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;
      const defaultNamedMatch = content.match(defaultNamedPattern);
      if (defaultNamedMatch) {
        result.defaultName = defaultNamedMatch[1];
      } else {
        // Try: export default Name (where Name is defined elsewhere)
        const defaultRefPattern = /export\s+default\s+([A-Z][A-Za-z0-9_$]*)\s*[;\n]/;
        const defaultRefMatch = content.match(defaultRefPattern);
        if (defaultRefMatch) {
          result.defaultName = defaultRefMatch[1];
        }
      }
    }
    
    // Dedupe
    result.named = [...new Set(result.named)];
    result.types = [...new Set(result.types)];
    
    return result;
  } catch {
    return result;
  }
}

/**
 * Analyzes a package directory and determines what exports it provides
 */
export async function analyzePackage(packagePath: string): Promise<PackageInfo> {
  const name = basename(packagePath);
  const info: PackageInfo = {
    name,
    path: packagePath,
    hasIndex: false,
    exportedModules: [],
  };
  
  // Check for existing index file
  const indexFiles = ['index.ts', 'index.tsx', 'index.js', 'index.jsx'];
  for (const indexFile of indexFiles) {
    if (await fileExists(join(packagePath, indexFile))) {
      info.hasIndex = true;
      break;
    }
    // Also check src/index
    if (await fileExists(join(packagePath, 'src', indexFile))) {
      info.hasIndex = true;
      break;
    }
  }
  
  // Find all source files
  const sourceFiles = await findSourceFiles(packagePath);
  
  // Extract exports from each file
  for (const file of sourceFiles) {
    const exports = await extractExports(join(packagePath, file));
    info.exportedModules.push(...exports.named, ...exports.types);
    if (exports.defaultName) {
      info.exportedModules.push(exports.defaultName);
    }
  }
  
  info.exportedModules = [...new Set(info.exportedModules)].sort();
  
  return info;
}

/**
 * Generates an index.ts file that re-exports all found modules
 */
export async function generateIndexFile(
  packagePath: string,
  options: {
    dryRun?: boolean;
    onProgress?: (message: string) => void;
  } = {}
): Promise<{ generated: boolean; content: string; exports: string[] }> {
  const { dryRun = false, onProgress } = options;
  
  // Find all source files
  const sourceFiles = await findSourceFiles(packagePath);
  
  if (sourceFiles.length === 0) {
    return { generated: false, content: '', exports: [] };
  }
  
  const exportLines: string[] = [];
  const allExports: string[] = [];
  
  // Group files by directory for cleaner exports
  const filesByDir = new Map<string, string[]>();
  
  for (const file of sourceFiles) {
    // Skip test files and stories
    if (file.includes('.test.') || file.includes('.spec.') || file.includes('.stories.')) {
      continue;
    }
    
    const dir = dirname(file);
    if (!filesByDir.has(dir)) {
      filesByDir.set(dir, []);
    }
    filesByDir.get(dir)!.push(file);
  }
  
  // Process each file
  for (const file of sourceFiles) {
    // Skip test files, stories, and type definition files
    if (file.includes('.test.') || file.includes('.spec.') || file.includes('.stories.') || file.endsWith('.d.ts')) {
      continue;
    }
    
    const fullPath = join(packagePath, file);
    const exports = await extractExports(fullPath);
    
    const hasExports = exports.named.length > 0 || exports.types.length > 0 || exports.hasDefault;
    
    if (hasExports) {
      // Create relative import path (without extension)
      let importPath = './' + file.replace(/\.(tsx?|jsx?)$/, '');
      
      // Handle index files in subdirectories
      if (importPath.endsWith('/index')) {
        importPath = importPath.slice(0, -6);
      }
      
      // Generate export lines for this file
      const fileExportParts: string[] = [];
      
      // Named exports
      if (exports.named.length > 0) {
        exportLines.push(`export { ${exports.named.join(', ')} } from '${importPath}';`);
        allExports.push(...exports.named);
        fileExportParts.push(`${exports.named.length} named`);
      }
      
      // Type exports (use export type for isolatedModules compatibility)
      if (exports.types.length > 0) {
        exportLines.push(`export type { ${exports.types.join(', ')} } from '${importPath}';`);
        allExports.push(...exports.types);
        fileExportParts.push(`${exports.types.length} types`);
      }
      
      // Default export - re-export as named using the identified name or filename
      if (exports.hasDefault) {
        const defaultName = exports.defaultName || basename(file).replace(/\.(tsx?|jsx?)$/, '');
        // Use a valid identifier (capitalize first letter if needed, remove invalid chars)
        const safeName = defaultName.replace(/[^a-zA-Z0-9_$]/g, '');
        if (safeName && /^[A-Za-z_$]/.test(safeName)) {
          exportLines.push(`export { default as ${safeName} } from '${importPath}';`);
          allExports.push(safeName);
          fileExportParts.push('default');
        }
      }
      
      onProgress?.(`  Found ${fileExportParts.join(', ')} in ${file}`);
    }
  }
  
  if (exportLines.length === 0) {
    return { generated: false, content: '', exports: [] };
  }
  
  // Determine where to write - prefer src/index.ts if src exists
  const srcDir = join(packagePath, 'src');
  const hasSrc = await fileExists(srcDir);
  
  // If we're writing to src/, we need to adjust paths since findSourceFiles
  // returns paths relative to packagePath, not src/
  let adjustedExportLines = exportLines;
  if (hasSrc) {
    adjustedExportLines = exportLines.map(line => {
      // Change './src/...' to './' since index will be in src/
      return line.replace(/from '\.\/(src\/)?/g, "from './");
    });
  }
  
  const content = [
    '// Auto-generated index file for reconstructed package',
    '// This file was created because the original index.ts was not in the source map',
    '',
    ...adjustedExportLines.sort(),
    '',
  ].join('\n');
  
  if (!dryRun) {
    const indexPath = hasSrc 
      ? join(srcDir, 'index.ts')
      : join(packagePath, 'index.ts');
    
    await writeFile(indexPath, content, 'utf-8');
    onProgress?.(`Generated ${indexPath} with ${allExports.length} exports`);
  }
  
  return { 
    generated: true, 
    content, 
    exports: [...new Set(allExports)].sort() 
  };
}

/**
 * Generates type declaration stubs for SCSS/CSS modules
 */
export async function generateScssModuleDeclarations(
  sourceDir: string,
  options: {
    dryRun?: boolean;
    onProgress?: (message: string) => void;
  } = {}
): Promise<number> {
  const { dryRun = false, onProgress } = options;
  let count = 0;
  
  async function processDir(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') {
            await processDir(fullPath);
          }
        } else if (entry.isFile()) {
          // Check for .module.scss or .module.css files
          if (entry.name.match(/\.module\.(scss|css|sass|less)$/)) {
            const dtsPath = fullPath + '.d.ts';
            
            // Skip if declaration already exists
            if (await fileExists(dtsPath)) {
              continue;
            }
            
            const dtsContent = [
              '// Auto-generated type declaration for CSS module',
              'declare const styles: { readonly [key: string]: string };',
              'export default styles;',
              '',
            ].join('\n');
            
            if (!dryRun) {
              await writeFile(dtsPath, dtsContent, 'utf-8');
              onProgress?.(`Generated ${relative(sourceDir, dtsPath)}`);
            }
            count++;
          }
        }
      }
    } catch {
      // Directory doesn't exist or can't be read
    }
  }
  
  await processDir(sourceDir);
  return count;
}

/**
 * Checks if a directory looks like a package (has source files, looks like a package name)
 */
async function looksLikePackage(dirPath: string, dirName: string): Promise<boolean> {
  // Skip common non-package directories
  const skipNames = ['src', 'lib', 'dist', 'build', 'assets', 'images', 'styles', 'types', 'utils', 'helpers', 'components', 'hooks', 'api', 'redux', 'store', 'services', 'constants'];
  if (skipNames.includes(dirName.toLowerCase())) {
    return false;
  }
  
  // Package names typically use kebab-case or are scoped (@scope/name)
  if (!/^(@[a-z0-9-]+\/)?[a-z][a-z0-9-]*$/i.test(dirName)) {
    return false;
  }
  
  // Check if it has source files directly or in src/
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    
    // Has a src directory with files?
    const hasSrc = entries.some(e => e.isDirectory() && e.name === 'src');
    if (hasSrc) {
      const srcEntries = await readdir(join(dirPath, 'src'), { withFileTypes: true });
      const hasSrcFiles = srcEntries.some(e => 
        e.isFile() && /\.(tsx?|jsx?)$/.test(e.name)
      );
      if (hasSrcFiles) return true;
    }
    
    // Has TypeScript/JavaScript files at root?
    const hasRootFiles = entries.some(e => 
      e.isFile() && /\.(tsx?|jsx?)$/.test(e.name) && !e.name.startsWith('.')
    );
    if (hasRootFiles) return true;
    
    // Has subdirectories that look like they contain code?
    const hasCodeDirs = entries.some(e => 
      e.isDirectory() && !e.name.startsWith('.') && !['node_modules', 'dist', 'build'].includes(e.name)
    );
    return hasCodeDirs;
  } catch {
    return false;
  }
}

/**
 * Finds all internal packages that need index files generated
 */
export async function findPackagesNeedingIndex(
  sourceDir: string,
  internalPackages: Set<string>
): Promise<string[]> {
  const packagesNeedingIndex: string[] = [];
  const checkedPaths = new Set<string>();
  
  async function checkAndAddPackage(fullPath: string): Promise<void> {
    if (checkedPaths.has(fullPath)) return;
    checkedPaths.add(fullPath);
    
    const info = await analyzePackage(fullPath);
    if (!info.hasIndex && info.exportedModules.length > 0) {
      packagesNeedingIndex.push(fullPath);
    }
  }
  
  async function searchDir(dir: string, depth: number = 0): Promise<void> {
    // Don't go too deep
    if (depth > 5) return;
    
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        
        const fullPath = join(dir, entry.name);
        
        if (entry.name === 'node_modules') {
          // Check packages inside node_modules
          await searchNodeModules(fullPath);
        } else if (entry.name.startsWith('.')) {
          // Skip hidden directories
          continue;
        } else {
          // Check if this directory is explicitly an internal package
          if (internalPackages.has(entry.name)) {
            await checkAndAddPackage(fullPath);
          }
          // Also check if it looks like a workspace package (not in node_modules)
          // depth > 0 means we're not at sourceDir level (skip bundle dirs like navigation/, mapbox-gl-2.15.0/)
          else if (depth > 0 && await looksLikePackage(fullPath, entry.name)) {
            await checkAndAddPackage(fullPath);
          }
          
          // Recurse into subdirectories
          await searchDir(fullPath, depth + 1);
        }
      }
    } catch {
      // Directory doesn't exist
    }
  }
  
  async function searchNodeModules(nodeModulesDir: string): Promise<void> {
    try {
      const entries = await readdir(nodeModulesDir, { withFileTypes: true });
      
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        
        const fullPath = join(nodeModulesDir, entry.name);
        
        if (entry.name.startsWith('@')) {
          // Scoped package - check subdirectories
          const scopedEntries = await readdir(fullPath, { withFileTypes: true });
          for (const scopedEntry of scopedEntries) {
            if (!scopedEntry.isDirectory()) continue;
            
            const scopedFullPath = join(fullPath, scopedEntry.name);
            const packageName = `${entry.name}/${scopedEntry.name}`;
            
            if (internalPackages.has(packageName)) {
              const info = await analyzePackage(scopedFullPath);
              if (!info.hasIndex && info.exportedModules.length > 0) {
                packagesNeedingIndex.push(scopedFullPath);
              }
            }
          }
        } else {
          // Regular package
          if (internalPackages.has(entry.name)) {
            const info = await analyzePackage(fullPath);
            if (!info.hasIndex && info.exportedModules.length > 0) {
              packagesNeedingIndex.push(fullPath);
            }
          }
        }
      }
    } catch {
      // Directory doesn't exist
    }
  }
  
  await searchDir(sourceDir, 0);
  return packagesNeedingIndex;
}

/**
 * Generates all necessary stub files for a reconstructed project
 */
export async function generateStubFiles(
  sourceDir: string,
  options: {
    internalPackages?: Set<string>;
    generateScssDeclarations?: boolean;
    dryRun?: boolean;
    onProgress?: (message: string) => void;
  } = {}
): Promise<{
  indexFilesGenerated: number;
  scssDeclarationsGenerated: number;
  packages: string[];
}> {
  const {
    internalPackages = new Set(),
    generateScssDeclarations = true,
    dryRun = false,
    onProgress,
  } = options;
  
  const result = {
    indexFilesGenerated: 0,
    scssDeclarationsGenerated: 0,
    packages: [] as string[],
  };
  
  // Find packages needing index files
  onProgress?.('Scanning for packages needing index files...');
  const packagesNeedingIndex = await findPackagesNeedingIndex(sourceDir, internalPackages);
  
  // Generate index files for each package
  for (const packagePath of packagesNeedingIndex) {
    onProgress?.(`Generating index for ${basename(packagePath)}...`);
    const { generated } = await generateIndexFile(packagePath, { dryRun, onProgress });
    if (generated) {
      result.indexFilesGenerated++;
      result.packages.push(packagePath);
    }
  }
  
  // Generate SCSS module declarations
  if (generateScssDeclarations) {
    onProgress?.('Generating SCSS module declarations...');
    result.scssDeclarationsGenerated = await generateScssModuleDeclarations(sourceDir, { dryRun, onProgress });
  }
  
  return result;
}
