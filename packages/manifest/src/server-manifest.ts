/**
 * Server manifest generation for the web2local development server.
 *
 * This module generates the `_server` directory structure containing:
 * - A manifest.json file with server configuration
 * - A fixtures directory with captured API responses
 * - A fixture index for efficient route matching
 *
 * The generated structure enables the web2local serve command to replay
 * captured API responses during local development.
 */

import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import type {
    ApiFixture,
    CapturedAsset,
    CapturedRedirect,
    FixtureIndex,
    FixtureIndexEntry,
    ServerManifest,
} from '@web2local/types';
import { createFixtureFilename, extractUrlPattern } from '@web2local/http';

/**
 * Configuration options for server manifest generation.
 *
 * Controls how the `_server` directory and its contents are generated,
 * including server settings, CORS configuration, and response delays.
 */
export interface ManifestGeneratorOptions {
    /** Site name, typically the hostname (e.g., 'example.com'). */
    name: string;

    /** Original URL that was captured (e.g., 'https://example.com/app'). */
    sourceUrl: string;

    /** Output directory where the `_server` folder will be created. */
    outputDir: string;

    /**
     * Default port for the development server.
     * @defaultValue 3000
     */
    defaultPort: number;

    /**
     * Whether to enable CORS headers on all responses.
     * @defaultValue true
     */
    cors: boolean;

    /**
     * Configuration for artificial response delays.
     * Useful for simulating network latency during development.
     */
    delay: {
        /** Whether delay is enabled. */
        enabled: boolean;
        /** Minimum delay in milliseconds. */
        minMs: number;
        /** Maximum delay in milliseconds. */
        maxMs: number;
    };

    /** Captured HTTP redirects to include in the manifest. */
    redirects?: CapturedRedirect[];
}

const DEFAULT_OPTIONS: Partial<ManifestGeneratorOptions> = {
    defaultPort: 3000,
    cors: true,
    delay: {
        enabled: false,
        minMs: 0,
        maxMs: 0,
    },
};

/**
 * Generates the `_server` directory structure with manifest and fixtures.
 *
 * Creates the following structure:
 * ```
 * outputDir/
 * ├── _server/
 * │   ├── manifest.json      # Server configuration
 * │   └── fixtures/
 * │       ├── _index.json    # Fixture index for route matching
 * │       └── *.json         # Individual fixture files
 * └── _server.json           # Quick-access pointer file
 * ```
 *
 * @param fixtures - Array of captured API fixtures to write
 * @param assets - Array of captured static assets (used for manifest metadata)
 * @param options - Configuration options for manifest generation
 * @returns Object containing the manifest path, fixture count, and any errors
 * @throws {Error} When directory creation fails
 *
 * @example
 * ```typescript
 * const result = await generateServerManifest(fixtures, assets, {
 *   name: 'example.com',
 *   sourceUrl: 'https://example.com',
 *   outputDir: '/output/example.com',
 *   defaultPort: 3000,
 *   cors: true,
 *   delay: { enabled: false, minMs: 0, maxMs: 0 },
 * });
 *
 * console.log(`Wrote ${result.fixturesWritten} fixtures to ${result.manifestPath}`);
 * ```
 *
 * @see {@link buildFixtureIndex} for generating fixture indexes separately
 * @see {@link generateCaptureSummary} for capture statistics
 */
export async function generateServerManifest(
    fixtures: ApiFixture[],
    assets: CapturedAsset[],
    options: ManifestGeneratorOptions,
): Promise<{
    /** Path to the generated manifest.json file. */
    manifestPath: string;
    /** Number of fixture files successfully written. */
    fixturesWritten: number;
    /** Array of error messages for any fixtures that failed to write. */
    errors: string[];
}> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const errors: string[] = [];

    const serverDir = join(opts.outputDir, '_server');
    const fixturesDir = join(serverDir, 'fixtures');

    // Create directories
    await mkdir(fixturesDir, { recursive: true });

    // Write individual fixture files
    const fixtureIndex: FixtureIndexEntry[] = [];
    let fixturesWritten = 0;

    for (const fixture of fixtures) {
        try {
            const filename = createFixtureFilename(
                fixture.request.method,
                fixture.request.pattern,
            );
            const filepath = join(fixturesDir, filename);

            await writeFile(
                filepath,
                JSON.stringify(fixture, null, 2),
                'utf-8',
            );

            const { priority } = extractUrlPattern(fixture.request.pattern);

            fixtureIndex.push({
                id: fixture.id,
                file: createFixtureFilename(
                    fixture.request.method,
                    fixture.request.pattern,
                ),
                method: fixture.request.method,
                pattern: fixture.request.pattern,
                params: fixture.request.pathParams,
                status: fixture.response.status,
                priority,
            });

            fixturesWritten++;
        } catch (error) {
            errors.push(`Failed to write fixture ${fixture.id}: ${error}`);
        }
    }

    // Sort fixture index by priority (higher first)
    fixtureIndex.sort((a, b) => b.priority - a.priority);

    // Write fixture index
    const indexContent: FixtureIndex = {
        generatedAt: Date.now(),
        fixtures: fixtureIndex,
    };

    const indexPath = join(fixturesDir, '_index.json');
    await writeFile(indexPath, JSON.stringify(indexContent, null, 2), 'utf-8');

    // Find entrypoint
    const entrypoint = assets.find((a) => a.isEntrypoint);

    // Extract path prefix from source URL
    // For https://example.com/games/snake/ -> /games/snake/
    // For https://example.com/ -> /
    let pathPrefix: string | undefined;
    try {
        const sourceUrlObj = new URL(opts.sourceUrl);
        let pathname = sourceUrlObj.pathname;
        // Normalize: ensure trailing slash for directories
        if (pathname !== '/' && !pathname.endsWith('/')) {
            pathname = pathname + '/';
        }
        // Only store if not root
        if (pathname !== '/') {
            pathPrefix = pathname;
        }
    } catch {
        // Invalid URL, skip pathPrefix
    }

    // Write server manifest
    const manifest: ServerManifest = {
        name: opts.name,
        sourceUrl: opts.sourceUrl,
        capturedAt: new Date().toISOString(),
        server: {
            defaultPort: opts.defaultPort!,
            cors: opts.cors!,
            delay: opts.delay!,
        },
        routes: {
            api: '/api',
            static: '/',
        },
        fixtures: {
            count: fixtures.length,
            indexFile: 'fixtures/_index.json',
        },
        static: {
            enabled: assets.length > 0,
            entrypoint: (entrypoint?.localPath || 'index.html') as string,
            assetCount: assets.length,
            pathPrefix: pathPrefix as string,
        },
        redirects:
            opts.redirects && opts.redirects.length > 0
                ? opts.redirects
                : undefined,
    };

    const manifestPath = join(serverDir, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

    // Write a quick-access pointer file at the site root
    const pointerPath = join(opts.outputDir, '_server.json');
    const pointer = {
        serverDir: '_server',
        manifestFile: '_server/manifest.json',
        fixturesDir: '_server/fixtures',
        staticDir: '_server/static',
    };
    await writeFile(pointerPath, JSON.stringify(pointer, null, 2), 'utf-8');

    return {
        manifestPath,
        fixturesWritten,
        errors,
    };
}

/**
 * Generates a fixture index from an array of API fixtures.
 *
 * The fixture index is used by the development server for efficient route
 * matching. Fixtures are sorted by priority (higher priority first) to ensure
 * more specific routes are matched before generic ones.
 *
 * @param fixtures - Array of API fixtures to index
 * @returns A fixture index object with entries sorted by priority
 *
 * @example
 * ```typescript
 * const fixtures = [
 *   { id: '1', request: { method: 'GET', pattern: '/api/users/:id' }, response: { status: 200 } },
 *   { id: '2', request: { method: 'GET', pattern: '/api/users' }, response: { status: 200 } },
 * ];
 *
 * const index = buildFixtureIndex(fixtures);
 * // index.fixtures is sorted so '/api/users/:id' comes before '/api/users'
 * ```
 *
 * @see {@link generateServerManifest} for full manifest generation
 */
export function buildFixtureIndex(fixtures: ApiFixture[]): FixtureIndex {
    const entries: FixtureIndexEntry[] = [];

    for (const fixture of fixtures) {
        const { priority } = extractUrlPattern(fixture.request.pattern);

        entries.push({
            id: fixture.id,
            file: createFixtureFilename(
                fixture.request.method,
                fixture.request.pattern,
            ),
            method: fixture.request.method,
            pattern: fixture.request.pattern,
            params: fixture.request.pathParams,
            status: fixture.response.status,
            priority,
        });
    }

    // Sort by priority (higher first)
    entries.sort((a, b) => b.priority - a.priority);

    return {
        generatedAt: Date.now(),
        fixtures: entries,
    };
}

/**
 * Generates a statistical summary of captured content.
 *
 * Provides an overview of what was captured during the scraping process,
 * useful for logging and debugging. Statistics include counts by HTTP method,
 * status code, and asset type.
 *
 * @param fixtures - Array of captured API fixtures
 * @param assets - Array of captured static assets
 * @returns Summary object with various capture statistics
 *
 * @example
 * ```typescript
 * const summary = generateCaptureSummary(fixtures, assets);
 *
 * console.log(`Captured ${summary.apiEndpoints} API endpoints`);
 * console.log(`Captured ${summary.staticAssets} static assets (${summary.totalBytes} bytes)`);
 * console.log(`Methods: ${JSON.stringify(summary.byMethod)}`);
 * // Methods: { "GET": 45, "POST": 12, "PUT": 3 }
 * ```
 */
export function generateCaptureSummary(
    fixtures: ApiFixture[],
    assets: CapturedAsset[],
): {
    /** Total number of API fixtures captured. */
    apiEndpoints: number;
    /** Number of unique method+pattern combinations. */
    uniquePatterns: number;
    /** Total number of static assets captured. */
    staticAssets: number;
    /** Total size of all assets in bytes. */
    totalBytes: number;
    /** Fixture count grouped by HTTP method. */
    byMethod: Record<string, number>;
    /** Fixture count grouped by HTTP status code. */
    byStatus: Record<string, number>;
    /** Asset count grouped by content type category. */
    byAssetType: Record<string, number>;
} {
    const byMethod: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    const patterns = new Set<string>();

    for (const fixture of fixtures) {
        const method = fixture.request.method;
        byMethod[method] = (byMethod[method] || 0) + 1;

        const status = String(fixture.response.status);
        byStatus[status] = (byStatus[status] || 0) + 1;

        patterns.add(`${method}:${fixture.request.pattern}`);
    }

    const byAssetType: Record<string, number> = {};
    let totalBytes = 0;

    for (const asset of assets) {
        const type = asset.contentType.split('/')[0] || 'other';
        byAssetType[type] = (byAssetType[type] || 0) + 1;
        totalBytes += asset.size;
    }

    return {
        apiEndpoints: fixtures.length,
        uniquePatterns: patterns.size,
        staticAssets: assets.length,
        totalBytes,
        byMethod,
        byStatus,
        byAssetType,
    };
}
