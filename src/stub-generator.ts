import { readdir, writeFile, stat, readFile, mkdir } from "fs/promises";
import { join, dirname, basename, relative, extname, resolve, isAbsolute } from "path";

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
export interface FileExports {
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
export async function extractExports(filePath: string): Promise<FileExports> {
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
    
    // Match: export { Name, Name2 } (local value exports, NOT re-exports)
    // We need to exclude re-exports like: export { X } from './other'
    const bracketExportPattern = /export\s+\{([^}]+)\}(?!\s*from\s)/g;
    while ((match = bracketExportPattern.exec(content)) !== null) {
      const names = match[1].split(',').map(n => {
        const parts = n.trim().split(/\s+as\s+/);
        return parts[parts.length - 1].trim();
      }).filter(n => n && n !== 'type');
      
      result.named.push(...names);
    }
    
    // Match: export type { Name, Name2 } (local type exports, NOT re-exports)
    const bracketTypeExportPattern = /export\s+type\s+\{([^}]+)\}(?!\s*from\s)/g;
    while ((match = bracketTypeExportPattern.exec(content)) !== null) {
      const names = match[1].split(',').map(n => {
        const parts = n.trim().split(/\s+as\s+/);
        return parts[parts.length - 1].trim();
      }).filter(n => n && n !== 'type');
      
      result.types.push(...names);
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
  
  // Track used export names to prevent duplicates.
  // We use a single set for both named exports AND default-as-named exports
  // because they both become named exports in the generated index file.
  // This handles cases like:
  //   export function LogInPage() {}  // named export
  //   export default LogInPage;       // default export of same name
  // Without this, we'd generate both:
  //   export { LogInPage } from './LogInPage';
  //   export { default as LogInPage } from './LogInPage';  // DUPLICATE!
  const usedExportNames = new Set<string>();
  const usedTypeExports = new Set<string>();
  
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
      
      // Named exports - filter out already-exported names
      const newNamedExports = exports.named.filter(name => !usedExportNames.has(name));
      if (newNamedExports.length > 0) {
        exportLines.push(`export { ${newNamedExports.join(', ')} } from '${importPath}';`);
        newNamedExports.forEach(name => usedExportNames.add(name));
        allExports.push(...newNamedExports);
        fileExportParts.push(`${newNamedExports.length} named`);
      }
      
      // Type exports - filter out already-exported types
      const newTypeExports = exports.types.filter(name => !usedTypeExports.has(name));
      if (newTypeExports.length > 0) {
        exportLines.push(`export type { ${newTypeExports.join(', ')} } from '${importPath}';`);
        newTypeExports.forEach(name => usedTypeExports.add(name));
        allExports.push(...newTypeExports);
        fileExportParts.push(`${newTypeExports.length} types`);
      }
      
      // Default export - re-export as named using the identified name or filename
      // Skip if this name was already exported (either as named or default-as-named)
      if (exports.hasDefault) {
        const defaultName = exports.defaultName || basename(file).replace(/\.(tsx?|jsx?)$/, '');
        // Use a valid identifier (capitalize first letter if needed, remove invalid chars)
        const safeName = defaultName.replace(/[^a-zA-Z0-9_$]/g, '');
        if (safeName && /^[A-Za-z_$]/.test(safeName) && !usedExportNames.has(safeName)) {
          exportLines.push(`export { default as ${safeName} } from '${importPath}';`);
          usedExportNames.add(safeName);
          allExports.push(safeName);
          fileExportParts.push('default');
        }
      }
      
      if (fileExportParts.length > 0) {
        onProgress?.(`  Found ${fileExportParts.join(', ')} in ${file}`);
      }
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
    
    // Also generate a package.json if one doesn't exist
    const pkgJsonPath = join(packagePath, 'package.json');
    if (!await fileExists(pkgJsonPath)) {
      const packageName = basename(packagePath);
      // Check if this is a scoped package (parent dir starts with @)
      const parentDir = basename(dirname(packagePath));
      const fullPackageName = parentDir.startsWith('@') 
        ? `${parentDir}/${packageName}` 
        : packageName;
      
      const pkgJson = {
        name: fullPackageName,
        version: '0.0.0-reconstructed',
        private: true,
        main: hasSrc ? './src/index.ts' : './index.ts',
        types: hasSrc ? './src/index.ts' : './index.ts',
      };
      await writeFile(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n', 'utf-8');
      onProgress?.(`Generated ${pkgJsonPath}`);
    }
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
      // Directory doesn't exist or can't be read
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
 * Information about an import found in source files
 */
export interface ImportInfo {
  /** The import path as written in the source */
  importPath: string;
  /** The file that contains this import */
  sourceFile: string;
  /** Whether this is a relative import */
  isRelative: boolean;
  /** Whether this imports from a directory (no file extension) */
  isDirectoryImport: boolean;
  /** The resolved absolute path (for relative imports) */
  resolvedPath?: string;
}

/**
 * Scans source files for imports and categorizes them
 */
export async function scanImports(sourceDir: string): Promise<{
  directoryImports: ImportInfo[];
  cssModuleImports: ImportInfo[];
  externalPackageImports: ImportInfo[];
}> {
  const result = {
    directoryImports: [] as ImportInfo[],
    cssModuleImports: [] as ImportInfo[],
    externalPackageImports: [] as ImportInfo[],
  };
  
  const seenDirectoryImports = new Set<string>();
  const seenCssModuleImports = new Set<string>();
  const seenExternalPackages = new Set<string>();
  
  async function processDir(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
            await processDir(fullPath);
          }
        } else if (entry.isFile()) {
          const ext = extname(entry.name).toLowerCase();
          if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
            await processFile(fullPath);
          }
        }
      }
    } catch {
      // Directory doesn't exist
    }
  }
  
  async function processFile(filePath: string): Promise<void> {
    try {
      const content = await readFile(filePath, 'utf-8');
      const fileDir = dirname(filePath);
      
      // Match import statements: import ... from '...' or import '...'
      // Also match require('...')
      const importPatterns = [
        /import\s+(?:[\w\s{},*]+\s+from\s+)?['"]([^'"]+)['"]/g,
        /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
        /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      ];
      
      for (const pattern of importPatterns) {
        let match;
        while ((match = pattern.exec(content)) !== null) {
          const importPath = match[1];
          
          // Skip type-only imports in declaration files
          if (filePath.endsWith('.d.ts')) continue;
          
          const isRelative = importPath.startsWith('.') || importPath.startsWith('/');
          
          // Handle CSS module imports
          if (importPath.match(/\.module\.(scss|css|sass|less)$/)) {
            if (isRelative) {
              const resolvedPath = resolve(fileDir, importPath);
              const key = resolvedPath;
              
              if (!seenCssModuleImports.has(key)) {
                seenCssModuleImports.add(key);
                result.cssModuleImports.push({
                  importPath,
                  sourceFile: filePath,
                  isRelative: true,
                  isDirectoryImport: false,
                  resolvedPath,
                });
              }
            }
            continue;
          }
          
          // Handle relative imports
          if (isRelative) {
            // Check if this is a directory import (no extension)
            const hasExtension = /\.(tsx?|jsx?|json|css|scss|sass|less)$/.test(importPath);
            
            if (!hasExtension) {
              const resolvedPath = resolve(fileDir, importPath);
              
              // Check if resolved path is a directory
              try {
                const stats = await stat(resolvedPath);
                if (stats.isDirectory()) {
                  // Check if it has an index file
                  const indexFiles = ['index.ts', 'index.tsx', 'index.js', 'index.jsx'];
                  let hasIndex = false;
                  for (const idx of indexFiles) {
                    if (await fileExists(join(resolvedPath, idx))) {
                      hasIndex = true;
                      break;
                    }
                  }
                  
                  if (!hasIndex && !seenDirectoryImports.has(resolvedPath)) {
                    seenDirectoryImports.add(resolvedPath);
                    result.directoryImports.push({
                      importPath,
                      sourceFile: filePath,
                      isRelative: true,
                      isDirectoryImport: true,
                      resolvedPath,
                    });
                  }
                }
              } catch {
                // Path doesn't exist or can't be accessed
              }
            }
            continue;
          }
          
          // Handle external package imports
          // Extract package name (handle scoped packages)
          let packageName: string;
          if (importPath.startsWith('@')) {
            // Scoped package: @scope/package or @scope/package/subpath
            const parts = importPath.split('/');
            packageName = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : importPath;
          } else {
            // Regular package: package or package/subpath
            packageName = importPath.split('/')[0];
          }
          
          // Skip Node.js built-in modules
          const builtins = ['fs', 'path', 'os', 'util', 'events', 'stream', 'http', 'https', 'url', 'querystring', 'crypto', 'buffer', 'child_process', 'cluster', 'dgram', 'dns', 'net', 'readline', 'repl', 'tls', 'tty', 'v8', 'vm', 'zlib', 'assert', 'async_hooks', 'console', 'constants', 'domain', 'inspector', 'module', 'perf_hooks', 'process', 'punycode', 'string_decoder', 'sys', 'timers', 'trace_events', 'worker_threads'];
          if (builtins.includes(packageName) || packageName.startsWith('node:')) {
            continue;
          }
          
          if (!seenExternalPackages.has(packageName)) {
            seenExternalPackages.add(packageName);
            result.externalPackageImports.push({
              importPath,
              sourceFile: filePath,
              isRelative: false,
              isDirectoryImport: false,
            });
          }
        }
      }
    } catch {
      // File doesn't exist or can't be read
    }
  }
  
  await processDir(sourceDir);
  return result;
}

/**
 * Generates index.ts files for directories that are imported as modules but lack an index
 */
export async function generateDirectoryIndexFiles(
  sourceDir: string,
  directoryImports: ImportInfo[],
  options: {
    dryRun?: boolean;
    onProgress?: (message: string) => void;
  } = {}
): Promise<number> {
  const { dryRun = false, onProgress } = options;
  let count = 0;
  
  for (const importInfo of directoryImports) {
    if (!importInfo.resolvedPath) continue;
    
    const dirPath = importInfo.resolvedPath;
    
    // Generate index file for this directory
    onProgress?.(`Generating index for directory: ${relative(sourceDir, dirPath)}`);
    const { generated } = await generateIndexFile(dirPath, { dryRun, onProgress });
    
    if (generated) {
      count++;
    }
  }
  
  return count;
}

/**
 * Generates stub CSS module files for imports that don't exist
 */
export async function generateMissingCssModuleStubs(
  sourceDir: string,
  cssModuleImports: ImportInfo[],
  options: {
    dryRun?: boolean;
    onProgress?: (message: string) => void;
  } = {}
): Promise<number> {
  const { dryRun = false, onProgress } = options;
  let count = 0;
  
  for (const importInfo of cssModuleImports) {
    if (!importInfo.resolvedPath) continue;
    
    const cssPath = importInfo.resolvedPath;
    
    // Check if the file already exists
    if (await fileExists(cssPath)) {
      continue;
    }
    
    // Create the stub CSS module file
    const stubContent = [
      '/* Auto-generated CSS module stub */',
      '/* Original file was not available in source maps */',
      `/* Imported by: ${relative(sourceDir, importInfo.sourceFile)} */`,
      '',
      '/* Add your styles here */',
      '',
    ].join('\n');
    
    // Also create the .d.ts declaration
    const dtsContent = [
      '// Auto-generated type declaration for CSS module stub',
      'declare const styles: { readonly [key: string]: string };',
      'export default styles;',
      '',
    ].join('\n');
    
    if (!dryRun) {
      // Ensure directory exists
      await mkdir(dirname(cssPath), { recursive: true });
      
      await writeFile(cssPath, stubContent, 'utf-8');
      await writeFile(cssPath + '.d.ts', dtsContent, 'utf-8');
      onProgress?.(`Generated CSS module stub: ${relative(sourceDir, cssPath)}`);
    }
    
    count++;
  }
  
  return count;
}

/**
 * Generates stub type declarations for external packages that aren't installed
 */
export async function generateExternalPackageStubs(
  sourceDir: string,
  externalPackageImports: ImportInfo[],
  installedPackages: Set<string>,
  options: {
    dryRun?: boolean;
    onProgress?: (message: string) => void;
  } = {}
): Promise<number> {
  const { dryRun = false, onProgress } = options;
  let count = 0;
  
  // Group imports by package name
  const packageImports = new Map<string, ImportInfo[]>();
  
  for (const importInfo of externalPackageImports) {
    let packageName: string;
    if (importInfo.importPath.startsWith('@')) {
      const parts = importInfo.importPath.split('/');
      packageName = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : importInfo.importPath;
    } else {
      packageName = importInfo.importPath.split('/')[0];
    }
    
    if (!packageImports.has(packageName)) {
      packageImports.set(packageName, []);
    }
    packageImports.get(packageName)!.push(importInfo);
  }
  
  // Create @types directory if needed
  const typesDir = join(sourceDir, '@types');
  
  for (const [packageName, imports] of packageImports) {
    // Skip if package is already installed
    if (installedPackages.has(packageName)) {
      continue;
    }
    
    // Skip if package exists in node_modules
    const nodeModulesPath = join(sourceDir, 'node_modules', packageName);
    if (await fileExists(nodeModulesPath)) {
      continue;
    }
    
    // Create stub declaration file
    // Handle scoped packages by creating nested directories
    const packagePath = packageName.startsWith('@') 
      ? join(typesDir, packageName.replace('/', '__'))
      : join(typesDir, packageName);
    
    const dtsPath = join(packagePath, 'index.d.ts');
    
    // Collect all unique import paths for this package to generate more specific stubs
    const subPaths = new Set<string>();
    for (const imp of imports) {
      const subPath = imp.importPath.slice(packageName.length);
      if (subPath && subPath !== '/') {
        subPaths.add(subPath);
      }
    }
    
    // Collect all named imports used with this package to generate specific stubs
    const namedImports = new Set<string>();
    for (const imp of imports) {
      // Try to extract named imports from the source file
      // This is a simplified approach - we'll just generate catch-all exports
    }
    
    // Generate the stub content using a wildcard module pattern
    // We create both an index.d.ts and a _types.d.ts for flexibility
    const indexContent = [
      `// Auto-generated type stub for "${packageName}"`,
      '// This package was not available - install it or replace with actual types',
      '',
      '// Default export',
      'declare const _default: any;',
      'export default _default;',
      '',
      '// Allow any named export - these will resolve to "any"',
      '// Add specific types here as needed',
      'export declare const __esModule: boolean;',
      '',
    ];
    
    // Add specific subpath declarations as comments
    if (subPaths.size > 0) {
      indexContent.push('// Subpath imports detected:');
      for (const subPath of subPaths) {
        indexContent.push(`// - "${packageName}${subPath}"`);
      }
      indexContent.push('');
    }
    
    const dtsContent = indexContent.join('\n');
    
    // Also create a wildcard module declaration file for better compatibility
    const wildcardContent = [
      `// Wildcard module declaration for "${packageName}"`,
      `declare module '${packageName}' {`,
      '  const value: any;',
      '  export default value;',
      '  export = value;',
      '}',
      '',
      `declare module '${packageName}/*' {`,
      '  const value: any;',
      '  export default value;',
      '  export = value;',
      '}',
      '',
    ].join('\n');
    
    if (!dryRun) {
      await mkdir(packagePath, { recursive: true });
      await writeFile(dtsPath, dtsContent, 'utf-8');
      // Also write a module declaration file
      await writeFile(join(packagePath, 'module.d.ts'), wildcardContent, 'utf-8');
      onProgress?.(`Generated stub for external package: ${packageName}`);
    }
    
    count++;
  }
  
  return count;
}

/**
 * Generates all necessary stub files for a reconstructed project
 */
export async function generateStubFiles(
  sourceDir: string,
  options: {
    internalPackages?: Set<string>;
    installedPackages?: Set<string>;
    generateScssDeclarations?: boolean;
    generateDirectoryIndexes?: boolean;
    generateCssModuleStubs?: boolean;
    generateExternalStubs?: boolean;
    dryRun?: boolean;
    onProgress?: (message: string) => void;
  } = {}
): Promise<{
  indexFilesGenerated: number;
  directoryIndexesGenerated: number;
  scssDeclarationsGenerated: number;
  cssModuleStubsGenerated: number;
  externalPackageStubsGenerated: number;
  packages: string[];
}> {
  const {
    internalPackages = new Set(),
    installedPackages = new Set(),
    generateScssDeclarations = true,
    generateDirectoryIndexes = true,
    generateCssModuleStubs = true,
    generateExternalStubs = true,
    dryRun = false,
    onProgress,
  } = options;
  
  const result = {
    indexFilesGenerated: 0,
    directoryIndexesGenerated: 0,
    scssDeclarationsGenerated: 0,
    cssModuleStubsGenerated: 0,
    externalPackageStubsGenerated: 0,
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
  
  // Scan for imports to find missing modules
  onProgress?.('Scanning source files for imports...');
  const imports = await scanImports(sourceDir);
  
  // Generate index files for directories imported as modules
  if (generateDirectoryIndexes && imports.directoryImports.length > 0) {
    onProgress?.(`Found ${imports.directoryImports.length} directory imports without index files...`);
    result.directoryIndexesGenerated = await generateDirectoryIndexFiles(
      sourceDir,
      imports.directoryImports,
      { dryRun, onProgress }
    );
  }
  
  // Generate CSS module stubs for missing files
  if (generateCssModuleStubs && imports.cssModuleImports.length > 0) {
    onProgress?.(`Found ${imports.cssModuleImports.length} CSS module imports...`);
    result.cssModuleStubsGenerated = await generateMissingCssModuleStubs(
      sourceDir,
      imports.cssModuleImports,
      { dryRun, onProgress }
    );
  }
  
  // Generate SCSS module declarations for existing files
  if (generateScssDeclarations) {
    onProgress?.('Generating SCSS module declarations...');
    result.scssDeclarationsGenerated = await generateScssModuleDeclarations(sourceDir, { dryRun, onProgress });
  }
  
  // Generate stubs for external packages
  if (generateExternalStubs && imports.externalPackageImports.length > 0) {
    onProgress?.(`Found ${imports.externalPackageImports.length} external package imports...`);
    result.externalPackageStubsGenerated = await generateExternalPackageStubs(
      sourceDir,
      imports.externalPackageImports,
      installedPackages,
      { dryRun, onProgress }
    );
  }
  
  return result;
}
