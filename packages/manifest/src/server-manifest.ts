/**
 * Server manifest generation for web2local serve
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
 * Options for manifest generation
 */
export interface ManifestGeneratorOptions {
    /** Site name (usually hostname) */
    name: string;
    /** Original source URL */
    sourceUrl: string;
    /** Output directory for _server folder */
    outputDir: string;
    /** Default server port */
    defaultPort: number;
    /** Enable CORS by default */
    cors: boolean;
    /** Delay configuration */
    delay: {
        enabled: boolean;
        minMs: number;
        maxMs: number;
    };
    /** Captured redirects to include in manifest */
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
 * Generate the _server directory structure with manifest and fixtures
 */
export async function generateServerManifest(
    fixtures: ApiFixture[],
    assets: CapturedAsset[],
    options: ManifestGeneratorOptions,
): Promise<{
    manifestPath: string;
    fixturesWritten: number;
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
 * Generate fixture index from existing fixtures
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
 * Generate a summary of the captured content
 */
export function generateCaptureSummary(
    fixtures: ApiFixture[],
    assets: CapturedAsset[],
): {
    apiEndpoints: number;
    uniquePatterns: number;
    staticAssets: number;
    totalBytes: number;
    byMethod: Record<string, number>;
    byStatus: Record<string, number>;
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
