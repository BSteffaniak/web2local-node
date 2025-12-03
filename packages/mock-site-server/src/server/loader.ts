/**
 * Manifest and fixture loader
 */

import { readFile, readdir, stat } from "fs/promises";
import { join, resolve } from "path";
import type {
  ServerManifest,
  FixtureIndex,
  ApiFixture,
  LoadedFixture,
} from "../types.js";

/**
 * Load the server manifest from a directory
 */
export async function loadManifest(dir: string): Promise<ServerManifest> {
  const serverDir = join(dir, "_server");
  const manifestPath = join(serverDir, "manifest.json");

  try {
    const content = await readFile(manifestPath, "utf-8");
    return JSON.parse(content) as ServerManifest;
  } catch (error) {
    // Try the pointer file
    const pointerPath = join(dir, "_server.json");
    try {
      const pointerContent = await readFile(pointerPath, "utf-8");
      const pointer = JSON.parse(pointerContent);
      const actualManifestPath = join(dir, pointer.manifestFile);
      const content = await readFile(actualManifestPath, "utf-8");
      return JSON.parse(content) as ServerManifest;
    } catch {
      throw new Error(
        `Could not find server manifest in ${dir}. Expected ${manifestPath} or ${pointerPath}`
      );
    }
  }
}

/**
 * Load the fixture index from a directory
 */
export async function loadFixtureIndex(dir: string): Promise<FixtureIndex> {
  const indexPath = join(dir, "_server", "fixtures", "_index.json");

  try {
    const content = await readFile(indexPath, "utf-8");
    return JSON.parse(content) as FixtureIndex;
  } catch (error) {
    throw new Error(`Could not find fixture index at ${indexPath}`);
  }
}

/**
 * Load a single fixture file
 */
export async function loadFixture(
  dir: string,
  relativePath: string
): Promise<LoadedFixture> {
  const fixturePath = join(dir, "_server", relativePath);

  try {
    const content = await readFile(fixturePath, "utf-8");
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
 * Load all fixtures from index
 */
export async function loadAllFixtures(dir: string): Promise<LoadedFixture[]> {
  const index = await loadFixtureIndex(dir);
  const fixtures: LoadedFixture[] = [];

  for (const entry of index.fixtures) {
    try {
      const fixture = await loadFixture(dir, entry.file);
      fixtures.push(fixture);
    } catch (error) {
      console.warn(`Warning: Could not load fixture ${entry.file}: ${error}`);
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
 * Get the static directory path
 */
export function getStaticDir(dir: string): string {
  return join(dir, "_server", "static");
}

/**
 * Check if a directory exists
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
 * Check if a file exists
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
 * Resolve the site directory, handling various input formats
 */
export async function resolveSiteDir(input: string): Promise<string> {
  const resolved = resolve(input);

  // Check if it's a direct _server directory
  if (resolved.endsWith("_server")) {
    const parentDir = resolve(resolved, "..");
    if (await directoryExists(join(parentDir, "_server"))) {
      return parentDir;
    }
  }

  // Check if it has a _server subdirectory
  if (await directoryExists(join(resolved, "_server"))) {
    return resolved;
  }

  // Check if it has a _server.json pointer
  if (await fileExists(join(resolved, "_server.json"))) {
    return resolved;
  }

  throw new Error(
    `Invalid site directory: ${input}. Expected a directory containing _server/ or _server.json`
  );
}

/**
 * List all available captured sites in an output directory
 */
export async function listCapturedSites(outputDir: string): Promise<string[]> {
  const sites: string[] = [];

  try {
    const entries = await readdir(outputDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const siteDir = join(outputDir, entry.name);
        if (await directoryExists(join(siteDir, "_server"))) {
          sites.push(entry.name);
        }
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }

  return sites;
}
