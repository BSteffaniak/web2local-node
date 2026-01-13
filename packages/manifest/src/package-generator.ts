/**
 * Package.json generation for reconstructed projects.
 *
 * Generates a package.json file from detected dependencies, including
 * version confidence metadata, workspace package hints, and bundler alias
 * configuration.
 */

import { writeFile } from 'fs/promises';
import type {
    DependencyInfo,
    DetectedProjectConfig,
    AliasMap,
} from '@web2local/types';

/**
 * Generates a package.json object from dependency analysis results.
 *
 * Creates a complete package.json structure including:
 * - Regular dependencies with version ranges based on confidence level
 * - Dev dependencies for TypeScript and type definitions
 * - Internal/workspace package references
 * - Version confidence metadata for debugging
 * - Import alias configuration hints for bundlers
 *
 * Version handling:
 * - Exact versions (from fingerprinting) are used as-is
 * - Other versions use caret ranges (^) for flexibility
 * - Unknown versions are marked with '*' for manual resolution
 * - Private packages use 'workspace:*' references
 *
 * @param name - The package name for the generated package.json
 * @param dependencies - Map of package names to their dependency info
 * @param aliasMap - Optional map of import aliases detected from source maps
 * @param projectConfig - Optional detected project configuration
 * @returns A package.json object ready to be serialized to JSON
 *
 * @example
 * ```typescript
 * const deps = new Map<string, DependencyInfo>([
 *   ['react', { version: '18.2.0', confidence: 'exact', versionSource: 'fingerprint' }],
 *   ['lodash', { version: '4.17.21', confidence: 'high', versionSource: 'comment' }],
 * ]);
 *
 * const packageJson = generatePackageJson('my-reconstructed-app', deps, undefined, {
 *   hasTypeScript: true,
 *   jsxFramework: 'react',
 * });
 * ```
 *
 * @see {@link writePackageJson} for writing the result to disk
 */
export function generatePackageJson(
    name: string,
    dependencies: Map<string, DependencyInfo>,
    aliasMap?: AliasMap,
    projectConfig?: DetectedProjectConfig,
): object {
    const deps: Record<string, string> = {};
    const privateDeps: Record<string, string> = {};
    const devDeps: Record<string, string> = {};
    const scripts: Record<string, string> = {};
    const versionMeta: Record<string, { confidence: string; source: string }> =
        {};

    // Sort dependencies alphabetically
    const sortedDeps = Array.from(dependencies.entries()).sort((a, b) =>
        a[0].localeCompare(b[0]),
    );

    for (const [packageName, info] of sortedDeps) {
        const target = info.isPrivate ? privateDeps : deps;

        if (info.version) {
            // Use exact version when confidence is 'exact' (from fingerprinting),
            // otherwise use caret range for flexibility.
            // This prevents installing a newer (potentially broken) patch version
            // when we know the exact version that was running in production.
            const isExact = info.confidence === 'exact';
            if (isExact) {
                target[packageName] = info.version;
            } else {
                target[packageName] = `^${info.version}`;
            }

            // Debug: log when exact versions are used
            if (isExact) {
                console.log(
                    `[version] Using exact version for ${packageName}: ${info.version} (confidence: ${info.confidence})`,
                );
            }

            // Track version metadata
            if (info.confidence && info.versionSource) {
                versionMeta[packageName] = {
                    confidence: info.confidence,
                    source: info.versionSource,
                };
            }
        } else if (info.isPrivate) {
            // Private packages get a workspace or local reference hint
            target[packageName] = 'workspace:*';
        } else {
            // Mark as unknown for manual resolution
            target[packageName] = '*';
        }
    }

    // Add dev dependencies based on detected project config
    if (projectConfig?.hasTypeScript) {
        devDeps['typescript'] = 'latest';
        scripts['typecheck'] = 'tsc --noEmit';
        scripts['build'] = 'tsc';
    }

    // Add type definitions for detected frameworks
    // Match @types/react version to the detected React version to avoid type mismatches
    // (e.g., React 19 changed RefObject<T> to be non-generic, breaking React 18 code)
    if (projectConfig?.jsxFramework === 'react' && !deps['@types/react']) {
        const reactVersion = deps['react'];
        let typesVersion = 'latest'; // Default fallback

        if (reactVersion && reactVersion !== '*') {
            // Extract major version (e.g., "^18.2.0" -> "18", "~17.0.0" -> "17")
            const majorMatch = reactVersion.match(/(\d+)/);
            if (majorMatch) {
                typesVersion = `^${majorMatch[1]}.0.0`;
            }
        }

        devDeps['@types/react'] = typesVersion;
        devDeps['@types/react-dom'] = typesVersion;
    }

    // Add Node types if Node environment detected
    if (
        (projectConfig?.environment === 'node' ||
            projectConfig?.environment === 'both') &&
        projectConfig?.hasTypeScript
    ) {
        devDeps['@types/node'] = 'latest';
    }

    const result: Record<string, unknown> = {
        name: name,
        version: '0.0.0-reconstructed',
        private: true,
        description: 'Reconstructed from source maps',
    };

    // Add scripts if any
    if (Object.keys(scripts).length > 0) {
        result.scripts = scripts;
    }

    // Add dependencies
    result.dependencies = deps;

    // Add devDependencies if any
    if (Object.keys(devDeps).length > 0) {
        result.devDependencies = devDeps;
    }

    // Add private/internal dependencies as a separate section for clarity
    if (Object.keys(privateDeps).length > 0) {
        result._internalDependencies = privateDeps;
    }

    // Add version confidence metadata
    if (Object.keys(versionMeta).length > 0) {
        result._versionMeta = versionMeta;
    }

    // Add notes
    const notes: string[] = [];
    if (Object.keys(privateDeps).length > 0) {
        notes.push(
            'Internal dependencies (_internalDependencies) are likely workspace packages that need manual setup',
        );
    }
    if (Object.keys(versionMeta).length > 0) {
        notes.push(
            'Version confidence metadata available in _versionMeta (exact/high/medium/low/unverified)',
        );
    }

    if (notes.length > 0) {
        result._notes = notes;
    }

    // Add alias information if any aliases were detected
    if (aliasMap && aliasMap.aliases.size > 0) {
        result._importAliases = Object.fromEntries(aliasMap.aliases);

        // Add bundler config hint showing how to set up these aliases
        result._bundlerAliasConfig = {
            _note: 'These aliases were detected from source map analysis. Configure your bundler accordingly.',
            webpack: Object.fromEntries(
                Array.from(aliasMap.aliases.entries()).map(
                    ([alias, actual]) => [alias, actual],
                ),
            ),
            vite: Object.fromEntries(
                Array.from(aliasMap.aliases.entries()).map(
                    ([alias, actual]) => [alias, actual],
                ),
            ),
        };

        notes.push(
            `${aliasMap.aliases.size} import aliases detected - see _importAliases for bundler configuration`,
        );
    }

    return result;
}

/**
 * Writes the generated package.json to disk.
 *
 * Serializes the package.json object with pretty-printing (2-space indentation)
 * and a trailing newline for POSIX compliance.
 *
 * @param outputPath - Absolute path where the package.json should be written
 * @param packageJson - The package.json object to serialize
 * @throws When the file cannot be written (permissions, disk full, etc.)
 *
 * @example
 * ```typescript
 * const packageJson = generatePackageJson('my-app', dependencies);
 * await writePackageJson('/output/my-app/package.json', packageJson);
 * ```
 *
 * @see {@link generatePackageJson} for creating the package.json object
 */
export async function writePackageJson(
    outputPath: string,
    packageJson: object,
): Promise<void> {
    await writeFile(
        outputPath,
        JSON.stringify(packageJson, null, 2) + '\n',
        'utf-8',
    );
}
