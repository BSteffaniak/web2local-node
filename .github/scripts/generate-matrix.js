#!/usr/bin/env node

/**
 * Generates a CI test matrix by fetching latest versions from:
 * - Node.js: https://nodejs.org/dist/index.json
 * - npm: https://registry.npmjs.org/npm
 * - pnpm: https://registry.npmjs.org/pnpm
 * - Bun: https://api.github.com/repos/oven-sh/bun/releases
 *
 * Respects the minimum Node version from package.json engines.node
 *
 * Configuration via environment variables:
 * - LAST_N_VERSIONS: Number of versions to include (default: 2)
 */

import { readFile, appendFile } from 'fs/promises';

const LAST_N_VERSIONS = parseInt(process.env.LAST_N_VERSIONS || '2', 10);
const OS_VERSIONS = ['ubuntu-latest', 'macos-latest'];

async function fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch ${url}: ${response.status}`);
    }
    return response.json();
}

/**
 * Compare semver-like version strings
 */
function compareVersions(a, b) {
    const partsA = a.split('.').map(Number);
    const partsB = b.split('.').map(Number);

    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
        const numA = partsA[i] || 0;
        const numB = partsB[i] || 0;
        if (numA !== numB) {
            return numA - numB;
        }
    }
    return 0;
}

/**
 * Parse minimum major version from engines.node constraint
 * e.g., ">=20.12.0" -> 20, "^18.0.0" -> 18, "20" -> 20
 */
async function getMinNodeVersion() {
    const pkg = JSON.parse(await readFile('package.json', 'utf-8'));
    const constraint = pkg.engines?.node;

    if (!constraint) {
        console.error(
            'No engines.node found in package.json, defaulting to 18',
        );
        return 18;
    }

    const match = constraint.match(/(\d+)/);
    if (!match) {
        console.error(
            `Could not parse engines.node "${constraint}", defaulting to 18`,
        );
        return 18;
    }

    return parseInt(match[1], 10);
}

/**
 * Get last N LTS major versions + latest current from Node.js
 * Filtered to only include versions >= minVersion
 */
async function getNodeVersions(minVersion) {
    const data = await fetchJson('https://nodejs.org/dist/index.json');

    const ltsVersions = new Set();
    let latestCurrent = null;

    for (const release of data) {
        const major = parseInt(release.version.match(/^v(\d+)/)?.[1], 10);
        if (!major || major < minVersion) continue;

        if (!latestCurrent) {
            latestCurrent = major;
        }

        if (release.lts) {
            ltsVersions.add(major);
        }
    }

    const sortedLts = Array.from(ltsVersions)
        .sort((a, b) => b - a)
        .slice(0, LAST_N_VERSIONS);

    const versions = new Set(sortedLts);
    if (latestCurrent) {
        versions.add(latestCurrent);
    }

    return Array.from(versions)
        .sort((a, b) => a - b)
        .map(String);
}

/**
 * Get last N major versions from npm registry
 */
async function getNpmVersions() {
    const data = await fetchJson('https://registry.npmjs.org/npm');
    const versions = Object.keys(data.versions);

    const majorVersions = new Map();
    for (const version of versions) {
        if (version.includes('-')) continue;

        const major = version.split('.')[0];
        const current = majorVersions.get(major);

        if (!current || compareVersions(version, current) > 0) {
            majorVersions.set(major, version);
        }
    }

    const sorted = Array.from(majorVersions.keys())
        .map(Number)
        .sort((a, b) => b - a);

    const lastN = sorted.slice(0, LAST_N_VERSIONS);
    const result = new Set(lastN.map(String));

    return Array.from(result).sort((a, b) => Number(a) - Number(b));
}

/**
 * Get last N major versions from pnpm registry
 */
async function getPnpmVersions() {
    const data = await fetchJson('https://registry.npmjs.org/pnpm');
    const versions = Object.keys(data.versions);

    const majorVersions = new Map();
    for (const version of versions) {
        if (version.includes('-')) continue;

        const major = version.split('.')[0];
        const current = majorVersions.get(major);

        if (!current || compareVersions(version, current) > 0) {
            majorVersions.set(major, version);
        }
    }

    const sorted = Array.from(majorVersions.keys())
        .map(Number)
        .sort((a, b) => b - a);

    const lastN = sorted.slice(0, LAST_N_VERSIONS);
    const result = new Set(lastN.map(String));

    return Array.from(result).sort((a, b) => Number(a) - Number(b));
}

/**
 * Get last N minor versions from Bun GitHub releases
 */
async function getBunVersions() {
    const data = await fetchJson(
        'https://api.github.com/repos/oven-sh/bun/releases',
    );

    const minorVersions = new Map();

    for (const release of data) {
        if (release.prerelease || release.draft) continue;

        const version = release.tag_name.replace(/^bun-v?/, '');
        const match = version.match(/^(\d+\.\d+)/);
        if (!match) continue;

        const minor = match[1];
        const current = minorVersions.get(minor);

        if (!current || compareVersions(version, current) > 0) {
            minorVersions.set(minor, version);
        }
    }

    const sorted = Array.from(minorVersions.keys()).sort((a, b) =>
        compareVersions(b, a),
    );

    const lastN = sorted.slice(0, LAST_N_VERSIONS);
    const result = new Set(lastN);

    return Array.from(result).sort(compareVersions);
}

/**
 * Generate the full matrix
 */
async function generateMatrix() {
    const minNodeVersion = await getMinNodeVersion();
    console.error(`Minimum Node version from package.json: ${minNodeVersion}`);
    console.error(`Fetching last ${LAST_N_VERSIONS} versions...`);

    const [nodeVersions, npmVersions, pnpmVersions, bunVersions] =
        await Promise.all([
            getNodeVersions(minNodeVersion),
            getNpmVersions(),
            getPnpmVersions(),
            getBunVersions(),
        ]);

    console.error(`OS versions: ${OS_VERSIONS.join(', ')}`);
    console.error(`Node versions: ${nodeVersions.join(', ')}`);
    console.error(`npm versions: ${npmVersions.join(', ')}`);
    console.error(`pnpm versions: ${pnpmVersions.join(', ')}`);
    console.error(`Bun versions: ${bunVersions.join(', ')}`);

    const include = [];

    for (const os of OS_VERSIONS) {
        // Short OS name for display (strip -latest suffix)
        const osName = os.replace('-latest', '');

        for (const nodeVersion of nodeVersions) {
            // npm combinations - full cartesian product with pnpm versions for turbo interop
            for (const pmVersion of npmVersions) {
                for (const pnpmVersion of pnpmVersions) {
                    include.push({
                        os,
                        'os-name': osName,
                        'node-version': nodeVersion,
                        'package-manager': 'npm',
                        'pm-version': pmVersion,
                        'pnpm-version': pnpmVersion,
                        'run-cmd': 'npx',
                        'global-install-cmd': 'npm install -g .',
                        'cli-cmd': 'npm run cli --',
                    });
                }
            }

            // pnpm combinations - pnpm-version equals pm-version (same tool for both)
            for (const pmVersion of pnpmVersions) {
                include.push({
                    os,
                    'os-name': osName,
                    'node-version': nodeVersion,
                    'package-manager': 'pnpm',
                    'pm-version': pmVersion,
                    'pnpm-version': pmVersion,
                    'run-cmd': 'pnpm exec',
                    'global-install-cmd': 'pnpm link --global',
                    'cli-cmd': 'pnpm run cli',
                });
            }

            // bun combinations - full cartesian product with pnpm versions for turbo interop
            for (const pmVersion of bunVersions) {
                for (const pnpmVersion of pnpmVersions) {
                    include.push({
                        os,
                        'os-name': osName,
                        'node-version': nodeVersion,
                        'package-manager': 'bun',
                        'pm-version': pmVersion,
                        'pnpm-version': pnpmVersion,
                        'run-cmd': 'bunx',
                        'global-install-cmd': 'bun link',
                        'cli-cmd': 'bun run cli',
                    });
                }
            }
        }
    }

    console.error(`Total matrix combinations: ${include.length}`);

    return { include };
}

// Main
generateMatrix()
    .then(async (matrix) => {
        const json = JSON.stringify(matrix);

        // Output for GitHub Actions
        const output = process.env.GITHUB_OUTPUT;
        if (output) {
            await appendFile(output, `matrix=${json}\n`);
        }

        // Also print to stdout for debugging
        console.log(json);
    })
    .catch((error) => {
        console.error('Failed to generate matrix:', error.message);
        process.exit(1);
    });
