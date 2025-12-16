/**
 * Manifest and fixture loading utilities.
 *
 * This module provides functions for loading server manifests, fixture indexes,
 * and individual fixtures from a captured site directory. It handles the
 * various file layout conventions used by web2local.
 *
 * @packageDocumentation
 */

import { readFile, readdir, stat } from 'fs/promises';
import { join, resolve } from 'path';
import type {
    ServerManifest,
    FixtureIndex,
    ApiFixture,
    LoadedFixture,
} from '../types.js';

/**
 * Loads the server manifest from a captured site directory.
 *
 * Attempts to load from `_server/manifest.json` first, then falls back
 * to checking for a `_server.json` pointer file.
 *
 * @param dir - Path to the captured site directory
 * @returns The parsed server manifest
 * @throws \{Error\} When no manifest can be found in the directory
 *
 * @example
 * ```typescript
 * const manifest = await loadManifest('./output/example.com');
 * console.log(manifest.name); // "example.com"
 * ```
 */
export async function loadManifest(dir: string): Promise<ServerManifest> {
    const serverDir = join(dir, '_server');
    const manifestPath = join(serverDir, 'manifest.json');

    try {
        const content = await readFile(manifestPath, 'utf-8');
        return JSON.parse(content) as ServerManifest;
    } catch (_error) {
        // Try the pointer file
        const pointerPath = join(dir, '_server.json');
        try {
            const pointerContent = await readFile(pointerPath, 'utf-8');
            const pointer = JSON.parse(pointerContent);
            const actualManifestPath = join(dir, pointer.manifestFile);
            const content = await readFile(actualManifestPath, 'utf-8');
            return JSON.parse(content) as ServerManifest;
        } catch {
            throw new Error(
                `Could not find server manifest in ${dir}. Expected ${manifestPath} or ${pointerPath}`,
            );
        }
    }
}

/**
 * Loads the fixture index from a captured site directory.
 *
 * The fixture index contains metadata about all available API fixtures
 * including their patterns, methods, and file locations.
 *
 * @param dir - Path to the captured site directory
 * @returns The parsed fixture index
 * @throws \{Error\} When the fixture index cannot be found or parsed
 *
 * @example
 * ```typescript
 * const index = await loadFixtureIndex('./output/example.com');
 * console.log(`Found ${index.fixtures.length} fixtures`);
 * ```
 */
export async function loadFixtureIndex(dir: string): Promise<FixtureIndex> {
    const indexPath = join(dir, '_server', 'fixtures', '_index.json');

    try {
        const content = await readFile(indexPath, 'utf-8');
        return JSON.parse(content) as FixtureIndex;
    } catch (_error) {
        throw new Error(`Could not find fixture index at ${indexPath}`);
    }
}

/**
 * Loads a single fixture file from disk.
 *
 * @param dir - Path to the captured site directory
 * @param relativePath - Relative path to the fixture file within `_server/fixtures/`
 * @returns The loaded fixture with its file path
 * @throws \{Error\} When the fixture file cannot be read or parsed
 *
 * @example
 * ```typescript
 * const fixture = await loadFixture('./output/example.com', 'api/users.json');
 * console.log(fixture.request.method); // "GET"
 * ```
 */
export async function loadFixture(
    dir: string,
    relativePath: string,
): Promise<LoadedFixture> {
    const fixturePath = join(dir, '_server', 'fixtures', relativePath);

    try {
        const content = await readFile(fixturePath, 'utf-8');
        const fixture = JSON.parse(content) as ApiFixture;
        return {
            ...fixture,
            filePath: fixturePath,
        };
    } catch (error) {
        throw new Error(`Could not load fixture at ${fixturePath}: ${error}`);
    }
}

/**
 * Loads all fixtures from the fixture index.
 *
 * Reads the fixture index and loads each fixture file. Fixtures that fail
 * to load are logged as warnings but do not cause the overall load to fail.
 * Results are sorted by priority (higher priority fixtures first).
 *
 * @param dir - Path to the captured site directory
 * @returns Array of loaded fixtures sorted by priority
 *
 * @example
 * ```typescript
 * const fixtures = await loadAllFixtures('./output/example.com');
 * console.log(`Loaded ${fixtures.length} fixtures`);
 * ```
 */
export async function loadAllFixtures(dir: string): Promise<LoadedFixture[]> {
    const index = await loadFixtureIndex(dir);
    const fixtures: LoadedFixture[] = [];

    for (const entry of index.fixtures) {
        try {
            const fixture = await loadFixture(dir, entry.file);
            fixtures.push(fixture);
        } catch (error) {
            console.warn(
                `Warning: Could not load fixture ${entry.file}: ${error}`,
            );
        }
    }

    // Sort by priority (higher first)
    fixtures.sort((a, b) => {
        const indexA = index.fixtures.find((f) => f.id === a.id);
        const indexB = index.fixtures.find((f) => f.id === b.id);
        return (indexB?.priority || 0) - (indexA?.priority || 0);
    });

    return fixtures;
}

/**
 * Gets the path to the static files directory.
 *
 * Returns either the captured static directory (`_server/static`) or the
 * rebuilt source directory (`_rebuilt`) depending on the `useRebuilt` flag.
 *
 * @param dir - Path to the captured site directory
 * @param useRebuilt - Whether to use the rebuilt source directory
 * @returns Absolute path to the static files directory
 *
 * @example
 * ```typescript
 * const staticDir = getStaticDir('./output/example.com');
 * // Returns: './output/example.com/_server/static'
 *
 * const rebuiltDir = getStaticDir('./output/example.com', true);
 * // Returns: './output/example.com/_rebuilt'
 * ```
 */
export function getStaticDir(dir: string, useRebuilt: boolean = false): string {
    if (useRebuilt) {
        return join(dir, '_rebuilt');
    }
    return join(dir, '_server', 'static');
}

/**
 * Checks if a directory exists at the given path.
 *
 * @param path - Path to check
 * @returns `true` if a directory exists at the path, `false` otherwise
 *
 * @example
 * ```typescript
 * if (await directoryExists('./output/example.com/_server')) {
 *     console.log('Server directory found');
 * }
 * ```
 */
export async function directoryExists(path: string): Promise<boolean> {
    try {
        const stats = await stat(path);
        return stats.isDirectory();
    } catch {
        return false;
    }
}

/**
 * Checks if a file exists at the given path.
 *
 * @param path - Path to check
 * @returns `true` if a file exists at the path, `false` otherwise
 *
 * @example
 * ```typescript
 * if (await fileExists('./output/example.com/_server.json')) {
 *     console.log('Pointer file found');
 * }
 * ```
 */
export async function fileExists(path: string): Promise<boolean> {
    try {
        const stats = await stat(path);
        return stats.isFile();
    } catch {
        return false;
    }
}

/**
 * Resolves and validates a site directory path.
 *
 * Handles various input formats including paths ending in `_server`,
 * directories containing `_server/`, and directories with `_server.json`
 * pointer files.
 *
 * @param input - Path to resolve (may be relative or absolute)
 * @returns Resolved absolute path to the site directory
 * @throws \{Error\} When the input is not a valid captured site directory
 *
 * @example
 * ```typescript
 * // All of these resolve to the same site directory:
 * await resolveSiteDir('./output/example.com');
 * await resolveSiteDir('./output/example.com/_server');
 * await resolveSiteDir('/absolute/path/to/example.com');
 * ```
 */
export async function resolveSiteDir(input: string): Promise<string> {
    const resolved = resolve(input);

    // Check if it's a direct _server directory
    if (resolved.endsWith('_server')) {
        const parentDir = resolve(resolved, '..');
        if (await directoryExists(join(parentDir, '_server'))) {
            return parentDir;
        }
    }

    // Check if it has a _server subdirectory
    if (await directoryExists(join(resolved, '_server'))) {
        return resolved;
    }

    // Check if it has a _server.json pointer
    if (await fileExists(join(resolved, '_server.json'))) {
        return resolved;
    }

    throw new Error(
        `Invalid site directory: ${input}. Expected a directory containing _server/ or _server.json`,
    );
}

/**
 * Lists all captured sites in an output directory.
 *
 * Scans the directory for subdirectories that contain a `_server` folder,
 * indicating they are valid captured sites.
 *
 * @param outputDir - Path to the output directory to scan
 * @returns Array of site directory names (not full paths)
 *
 * @example
 * ```typescript
 * const sites = await listCapturedSites('./output');
 * // Returns: ['example.com', 'other-site.org']
 * ```
 */
export async function listCapturedSites(outputDir: string): Promise<string[]> {
    const sites: string[] = [];

    try {
        const entries = await readdir(outputDir, { withFileTypes: true });

        for (const entry of entries) {
            if (entry.isDirectory()) {
                const siteDir = join(outputDir, entry.name);
                if (await directoryExists(join(siteDir, '_server'))) {
                    sites.push(entry.name);
                }
            }
        }
    } catch {
        // Directory doesn't exist or can't be read
    }

    return sites;
}
