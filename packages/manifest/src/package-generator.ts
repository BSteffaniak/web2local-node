import { writeFile } from 'fs/promises';
import type {
    DependencyInfo,
    DetectedProjectConfig,
    AliasMap,
} from '@web2local/types';

/**
 * Generates a package.json object from analysis results
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
 * Writes the generated package.json to disk
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
