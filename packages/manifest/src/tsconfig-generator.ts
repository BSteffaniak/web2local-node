import { writeFile } from 'fs/promises';
import type {
    AliasPathMapping,
    DetectedProjectConfig,
    WorkspacePackageMapping,
    SubpathMapping,
} from '@web2local/types';

/**
 * Generates a tsconfig.json object based on detected project configuration
 */
export function generateTsConfig(
    aliasPathMappings?: AliasPathMapping[],
    projectConfig?: DetectedProjectConfig,
    vendorBundleDirs?: string[],
    workspacePackages?: WorkspacePackageMapping[],
    subpathMappings?: SubpathMapping[],
): object {
    const paths: Record<string, string[]> = {};

    // Add path mappings for each alias using actual extracted locations
    // Point to src/ subdirectory if it exists (common package structure)
    if (aliasPathMappings && aliasPathMappings.length > 0) {
        for (const mapping of aliasPathMappings) {
            // Sanitize the path to match actual output structure
            // e.g., "./navigation/../../shared-ui" -> "./navigation/shared-ui"
            const normalizedPath = sanitizeSourceMapPath(mapping.relativePath);

            // Try src subdirectory first (where index.ts is typically generated)
            const srcPath = `${normalizedPath}/src`;
            paths[mapping.alias] = [srcPath, normalizedPath];
            paths[`${mapping.alias}/*`] = [
                `${srcPath}/*`,
                `${normalizedPath}/*`,
            ];
        }
    }

    // Add path mappings for workspace packages (internal packages not in node_modules)
    if (workspacePackages && workspacePackages.length > 0) {
        for (const pkg of workspacePackages) {
            if (paths[pkg.name]) continue; // Don't override alias mappings

            // Sanitize the path to match actual output structure
            const normalizedPath = sanitizeSourceMapPath(pkg.relativePath);

            // Try common entry points
            const srcPath = `${normalizedPath}/src`;
            paths[pkg.name] = [srcPath, normalizedPath];
            paths[`${pkg.name}/*`] = [`${srcPath}/*`, `${normalizedPath}/*`];
        }
    }

    // Add path mappings for subpath imports (e.g., 'sarsaparilla/auth' -> './shared-ui/auth')
    if (subpathMappings && subpathMappings.length > 0) {
        for (const mapping of subpathMappings) {
            if (paths[mapping.specifier]) continue; // Don't override existing mappings

            const normalizedPath = sanitizeSourceMapPath(mapping.relativePath);
            const srcPath = `${normalizedPath}/src`;
            paths[mapping.specifier] = [srcPath, normalizedPath];
            paths[`${mapping.specifier}/*`] = [
                `${srcPath}/*`,
                `${normalizedPath}/*`,
            ];
        }
    }

    // Determine lib based on environment
    // Use ES2022 by default to support modern features like Object.hasOwn()
    const lib: string[] = ['ES2022'];

    if (
        projectConfig?.environment === 'browser' ||
        projectConfig?.environment === 'both'
    ) {
        lib.push('DOM', 'DOM.Iterable');
    }

    // Determine target - use ES2022 for modern features
    const target = 'ES2022';

    // Determine JSX setting
    let jsx: string | undefined;
    if (projectConfig?.hasJsx) {
        switch (projectConfig.jsxFramework) {
            case 'react':
                jsx = 'react-jsx';
                break;
            case 'preact':
                jsx = 'react-jsx'; // Preact uses React-compatible JSX
                break;
            case 'solid':
                jsx = 'preserve'; // Solid uses its own JSX transform
                break;
            case 'vue':
                jsx = 'preserve';
                break;
            default:
                jsx = 'react-jsx'; // Default fallback
        }
    }

    // Determine module system
    const module =
        projectConfig?.moduleSystem === 'commonjs' ? 'CommonJS' : 'ESNext';

    // Build compiler options
    const compilerOptions: Record<string, unknown> = {
        target,
        lib,
        module,
        moduleResolution: 'bundler',
    };

    // Only add allowJs if there are JavaScript files
    if (projectConfig?.hasJavaScript) {
        compilerOptions.allowJs = true;
        compilerOptions.checkJs = false;
    }

    // Only add JSX if needed
    if (jsx) {
        compilerOptions.jsx = jsx;
        // Add jsxImportSource for frameworks that need it
        if (projectConfig?.jsxFramework === 'preact') {
            compilerOptions.jsxImportSource = 'preact';
        } else if (projectConfig?.jsxFramework === 'solid') {
            compilerOptions.jsxImportSource = 'solid-js';
        }
    }

    // Path resolution
    compilerOptions.baseUrl = '.';
    if (Object.keys(paths).length > 0) {
        compilerOptions.paths = paths;
    }

    // Type checking - loose for reconstructed code
    compilerOptions.strict = false;
    compilerOptions.skipLibCheck = true;
    compilerOptions.noEmit = true;
    compilerOptions.noImplicitAny = false;
    compilerOptions.noUnusedLocals = false;
    compilerOptions.noUnusedParameters = false;

    // Include @types folder for stub declarations of missing packages
    compilerOptions.typeRoots = ['./node_modules/@types', './@types'];

    // Interop
    compilerOptions.esModuleInterop = true;
    compilerOptions.allowSyntheticDefaultImports = true;
    compilerOptions.forceConsistentCasingInFileNames = false; // Reconstructed paths may have case issues
    compilerOptions.resolveJsonModule = true;
    compilerOptions.isolatedModules = false; // Allow type re-exports

    // Build include patterns based on what files exist
    const include: string[] = [];
    if (projectConfig?.hasTypeScript) {
        include.push('**/*.ts');
        if (projectConfig.hasJsx) {
            include.push('**/*.tsx');
        }
    }
    if (projectConfig?.hasJavaScript) {
        include.push('**/*.js');
        if (projectConfig.hasJsx) {
            include.push('**/*.jsx');
        }
    }
    // Default if nothing detected
    if (include.length === 0) {
        include.push('**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx');
    }

    // Build exclude list
    const exclude: string[] = [
        'node_modules',
        '**/node_modules', // Exclude nested node_modules (e.g., bundleName/node_modules/...)
        'dist',
        'build',
    ];

    // Add vendor bundle directories to exclude
    // These are third-party libraries extracted as separate bundles that may use Flow or other type systems
    if (vendorBundleDirs && vendorBundleDirs.length > 0) {
        for (const dir of vendorBundleDirs) {
            exclude.push(dir);
        }
    }

    const tsconfig: Record<string, unknown> = {
        compilerOptions,
        include,
        exclude,
    };

    return tsconfig;
}

/**
 * Writes the generated tsconfig.json to disk
 */
export async function writeTsConfig(
    outputPath: string,
    tsconfig: object,
): Promise<void> {
    await writeFile(
        outputPath,
        JSON.stringify(tsconfig, null, 2) + '\n',
        'utf-8',
    );
}

/**
 * Sanitizes a source map path to match how files are actually written by the reconstructor.
 *
 * Source map paths often contain relative sequences like "../../" which need to be resolved
 * in a way that matches the reconstructor's sanitizePath behavior.
 *
 * For paths like "bundleName/../../package/file.ts":
 * - The first segment (bundleName) is always preserved (it's the output directory)
 * - The remaining path is sanitized: ".." pops the stack, but can't escape the bundle root
 * - Result: "bundleName/package/file.ts"
 *
 * @param relativePath - Path like "./bundleName/../../package" or "./bundleName/package"
 * @returns Normalized path like "./bundleName/package"
 */
function sanitizeSourceMapPath(relativePath: string): string {
    // Remove leading ./ if present
    let path = relativePath.replace(/^\.[\\/]+/, '');

    // Split into segments
    const segments = path.split(/[/\\]/);
    if (segments.length === 0) return './' + path;

    // First segment is the bundle name - always preserved
    const bundleName = segments[0];
    const restSegments = segments.slice(1);

    // Apply sanitization logic to the rest (same as reconstructor's sanitizePath)
    // This resolves ".." by popping, but doesn't allow escaping the bundle root
    const resolved: string[] = [];
    for (const segment of restSegments) {
        if (segment === '..') {
            if (resolved.length > 0) {
                resolved.pop();
            }
            // If resolved is empty, we can't go higher - just ignore the ..
        } else if (segment && segment !== '.') {
            resolved.push(segment);
        }
    }

    // Combine bundle name with resolved path
    if (resolved.length > 0) {
        return './' + bundleName + '/' + resolved.join('/');
    }
    return './' + bundleName;
}
