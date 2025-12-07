/**
 * Dynamic peer dependency inference
 *
 * Infers package versions by analyzing peer dependency relationships:
 * 1. If we know package A's version, and package B has A as a peer dep,
 *    we can narrow down B's possible versions
 * 2. Reverse inference: if B requires A as peer with specific version,
 *    and we find B's version, we may be able to infer A's version
 */

import { getPackageMetadata } from './source-fingerprint.js';
import { VersionResult, VersionConfidence } from './version-detector.js';

export interface PeerDepResult extends VersionResult {
    inferredFrom: string;
    peerRange: string;
    matchingVersions: string[];
}

interface KnownVersion {
    name: string;
    version: string;
    confidence: VersionConfidence;
}

/**
 * Simple semver range checker
 * Supports: ^, ~, >=, >, <=, <, =, x.x.x, and || ranges
 */
function satisfiesRange(version: string, range: string): boolean {
    // Handle || (or) ranges
    if (range.includes('||')) {
        return range.split('||').some((r) => satisfiesRange(version, r.trim()));
    }

    // Handle space-separated (and) ranges
    if (range.includes(' ') && !range.includes('||')) {
        const parts = range
            .split(/\s+/)
            .filter((p) => p && !['', '-'].includes(p));
        // Check if it's a hyphen range like "1.0.0 - 2.0.0"
        const hyphenIdx = parts.indexOf('-');
        if (hyphenIdx > 0) {
            const lower = parts[hyphenIdx - 1];
            const upper = parts[hyphenIdx + 1];
            return (
                satisfiesRange(version, `>=${lower}`) &&
                satisfiesRange(version, `<=${upper}`)
            );
        }
        return parts.every((p) => satisfiesRange(version, p));
    }

    // Normalize the range
    range = range.trim();

    // Handle * or empty (any version)
    if (range === '*' || range === '' || range === 'x' || range === 'latest') {
        return true;
    }

    // Parse version into parts
    const parseVersion = (v: string): number[] => {
        const clean = v.replace(/^[^0-9]*/, '').replace(/-.*$/, '');
        return clean.split('.').map((p) => parseInt(p, 10) || 0);
    };

    const vParts = parseVersion(version);

    // Handle caret (^) - compatible with version
    if (range.startsWith('^')) {
        const rangeParts = parseVersion(range.slice(1));

        // ^0.0.x - only patch updates
        if (rangeParts[0] === 0 && rangeParts[1] === 0) {
            return (
                vParts[0] === 0 && vParts[1] === 0 && vParts[2] >= rangeParts[2]
            );
        }
        // ^0.x - only minor updates
        if (rangeParts[0] === 0) {
            return (
                vParts[0] === 0 &&
                vParts[1] === rangeParts[1] &&
                vParts[2] >= rangeParts[2]
            );
        }
        // ^x.y.z - major must match, minor.patch can be >=
        return (
            vParts[0] === rangeParts[0] &&
            (vParts[1] > rangeParts[1] ||
                (vParts[1] === rangeParts[1] && vParts[2] >= rangeParts[2]))
        );
    }

    // Handle tilde (~) - approximately equivalent
    if (range.startsWith('~')) {
        const rangeParts = parseVersion(range.slice(1));
        return (
            vParts[0] === rangeParts[0] &&
            vParts[1] === rangeParts[1] &&
            vParts[2] >= rangeParts[2]
        );
    }

    // Handle >=
    if (range.startsWith('>=')) {
        const rangeParts = parseVersion(range.slice(2));
        for (let i = 0; i < 3; i++) {
            if (vParts[i] > rangeParts[i]) return true;
            if (vParts[i] < rangeParts[i]) return false;
        }
        return true; // Equal
    }

    // Handle >
    if (range.startsWith('>') && !range.startsWith('>=')) {
        const rangeParts = parseVersion(range.slice(1));
        for (let i = 0; i < 3; i++) {
            if (vParts[i] > rangeParts[i]) return true;
            if (vParts[i] < rangeParts[i]) return false;
        }
        return false; // Equal is not valid for >
    }

    // Handle <=
    if (range.startsWith('<=')) {
        const rangeParts = parseVersion(range.slice(2));
        for (let i = 0; i < 3; i++) {
            if (vParts[i] < rangeParts[i]) return true;
            if (vParts[i] > rangeParts[i]) return false;
        }
        return true; // Equal
    }

    // Handle <
    if (range.startsWith('<') && !range.startsWith('<=')) {
        const rangeParts = parseVersion(range.slice(1));
        for (let i = 0; i < 3; i++) {
            if (vParts[i] < rangeParts[i]) return true;
            if (vParts[i] > rangeParts[i]) return false;
        }
        return false; // Equal is not valid for <
    }

    // Handle = or exact version
    const exactRange = range.startsWith('=') ? range.slice(1) : range;
    const rangeParts = parseVersion(exactRange);

    // Check if it's a partial version (e.g., "18" or "18.2")
    const rangeStr = exactRange.replace(/^[^0-9]*/, '').replace(/-.*$/, '');
    const numParts = rangeStr.split('.').length;

    for (let i = 0; i < numParts && i < 3; i++) {
        if (vParts[i] !== rangeParts[i]) return false;
    }

    return true;
}

/**
 * Computes confidence based on how specific the peer dependency range is
 */
function computeConfidence(
    range: string,
    matchCount: number,
): VersionConfidence {
    // Exact version match
    if (/^\d+\.\d+\.\d+$/.test(range)) {
        return 'exact';
    }

    // Very specific range (patch-level caret or tilde)
    if (/^[\^~]\d+\.\d+\.\d+$/.test(range)) {
        return matchCount === 1 ? 'high' : 'medium';
    }

    // Minor-level specification
    if (/^[\^~]?\d+\.\d+/.test(range)) {
        return 'medium';
    }

    // Wide range
    return 'low';
}

/**
 * Infers versions for unknown packages based on peer dependencies of known packages
 *
 * Strategy: For each unknown package, check if any known package has it as a peer dep.
 * If so, we can use the peer dep range to narrow down the version.
 */
export async function inferFromKnownPeers(
    unknownPackages: string[],
    knownVersions: Map<string, KnownVersion>,
    onProgress?: (packageName: string, result: PeerDepResult | null) => void,
): Promise<Map<string, PeerDepResult>> {
    const results = new Map<string, PeerDepResult>();

    // For each unknown package, check if its peer deps match any of our known versions
    for (const unknownPkg of unknownPackages) {
        if (results.has(unknownPkg)) continue;

        const metadata = await getPackageMetadata(unknownPkg);
        if (!metadata) {
            onProgress?.(unknownPkg, null);
            continue;
        }

        // Find versions of unknownPkg whose peer deps match our known versions
        const matchingVersions: Array<{ version: string; score: number }> = [];

        for (const [version, details] of Object.entries(
            metadata.versionDetails,
        ) as [string, any][]) {
            if (!details.peerDependencies) continue;

            let peerMatchCount = 0;
            let peerTotalCount = 0;
            let allPeersSatisfied = true;

            for (const [peerName, peerRange] of Object.entries(
                details.peerDependencies,
            ) as [string, any][]) {
                peerTotalCount++;
                const known = knownVersions.get(peerName);

                if (known) {
                    if (satisfiesRange(known.version, peerRange as string)) {
                        peerMatchCount++;
                    } else {
                        // This version's peer deps don't match our known version
                        allPeersSatisfied = false;
                        break;
                    }
                }
            }

            // Only consider versions where all peer deps we know about are satisfied
            if (allPeersSatisfied && peerMatchCount > 0) {
                // Score based on how many peer deps matched
                const score = peerMatchCount / Math.max(peerTotalCount, 1);
                matchingVersions.push({ version, score });
            }
        }

        if (matchingVersions.length === 0) {
            onProgress?.(unknownPkg, null);
            continue;
        }

        // Sort by score (desc) then by version (desc, to prefer newer)
        matchingVersions.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            // Simple version comparison (prefer higher)
            return b.version.localeCompare(a.version, undefined, {
                numeric: true,
            });
        });

        // If there's a clear winner (or only one match), use it
        const bestMatch = matchingVersions[0];

        // Find which known package(s) helped us infer this
        let inferredFrom = '';
        let peerRange = '';

        const details = metadata.versionDetails[bestMatch.version];
        if (details?.peerDependencies) {
            for (const [peerName, range] of Object.entries(
                details.peerDependencies,
            )) {
                if (knownVersions.has(peerName)) {
                    inferredFrom = peerName;
                    peerRange = range as string;
                    break;
                }
            }
        }

        // Determine confidence based on number of matching versions
        let confidence: VersionConfidence;
        if (matchingVersions.length === 1) {
            confidence = 'high';
        } else if (matchingVersions.length <= 3) {
            confidence = 'medium';
        } else {
            confidence = 'low';
        }

        const result: PeerDepResult = {
            version: bestMatch.version,
            confidence,
            source: 'peer-dep',
            inferredFrom,
            peerRange,
            matchingVersions: matchingVersions
                .slice(0, 5)
                .map((m) => m.version),
        };

        results.set(unknownPkg, result);
        onProgress?.(unknownPkg, result);
    }

    return results;
}

/**
 * Forward inference: Given a package's known version, infer related packages
 *
 * Example: If we know react@18.2.0, and we detect react-dom as a dependency,
 * we can check react-dom's versions to find one that has react@^18.2.0 as peer dep.
 */
export async function inferFromPeerRequirements(
    unknownPackages: string[],
    knownVersions: Map<string, KnownVersion>,
    onProgress?: (packageName: string, result: PeerDepResult | null) => void,
): Promise<Map<string, PeerDepResult>> {
    const results = new Map<string, PeerDepResult>();

    for (const unknownPkg of unknownPackages) {
        if (results.has(unknownPkg)) continue;

        const metadata = await getPackageMetadata(unknownPkg);
        if (!metadata) {
            onProgress?.(unknownPkg, null);
            continue;
        }

        // Collect all versions and their peer dep compatibility scores
        const candidates: Array<{
            version: string;
            matchedPeer: string;
            peerRange: string;
            specificity: number;
        }> = [];

        for (const [version, details] of Object.entries(
            metadata.versionDetails,
        ) as [string, any][]) {
            if (!details.peerDependencies) continue;

            for (const [peerName, peerRange] of Object.entries(
                details.peerDependencies,
            )) {
                const known = knownVersions.get(peerName);
                if (!known) continue;

                if (satisfiesRange(known.version, peerRange as string)) {
                    // Calculate specificity - more specific ranges are better
                    let specificity = 0;
                    if (/^\d+\.\d+\.\d+$/.test(peerRange as string)) {
                        specificity = 3; // Exact version
                    } else if (
                        /^[\^~]\d+\.\d+\.\d+$/.test(peerRange as string)
                    ) {
                        specificity = 2; // Patch-level range
                    } else if (/^[\^~]?\d+\.\d+/.test(peerRange as string)) {
                        specificity = 1; // Minor-level range
                    }

                    candidates.push({
                        version,
                        matchedPeer: peerName,
                        peerRange: peerRange as string,
                        specificity,
                    });
                }
            }
        }

        if (candidates.length === 0) {
            onProgress?.(unknownPkg, null);
            continue;
        }

        // Group by version and pick the one with highest specificity peer match
        const versionScores = new Map<
            string,
            { maxSpec: number; peer: string; range: string }
        >();

        for (const c of candidates) {
            const existing = versionScores.get(c.version);
            if (!existing || c.specificity > existing.maxSpec) {
                versionScores.set(c.version, {
                    maxSpec: c.specificity,
                    peer: c.matchedPeer,
                    range: c.peerRange,
                });
            }
        }

        // Sort versions by specificity then by version number
        const sortedVersions = Array.from(versionScores.entries()).sort(
            (a, b) => {
                if (b[1].maxSpec !== a[1].maxSpec)
                    return b[1].maxSpec - a[1].maxSpec;
                return b[0].localeCompare(a[0], undefined, { numeric: true });
            },
        );

        if (sortedVersions.length === 0) {
            onProgress?.(unknownPkg, null);
            continue;
        }

        const [bestVersion, bestInfo] = sortedVersions[0];
        const confidence = computeConfidence(
            bestInfo.range,
            sortedVersions.length,
        );

        const result: PeerDepResult = {
            version: bestVersion,
            confidence,
            source: 'peer-dep',
            inferredFrom: bestInfo.peer,
            peerRange: bestInfo.range,
            matchingVersions: sortedVersions.slice(0, 5).map(([v]) => v),
        };

        results.set(unknownPkg, result);
        onProgress?.(unknownPkg, result);
    }

    return results;
}

/**
 * Main entry point - runs both inference strategies
 */
export async function inferPeerDependencyVersions(
    unknownPackages: string[],
    knownVersions: Map<string, KnownVersion>,
    options: {
        onProgress?: (
            packageName: string,
            result: PeerDepResult | null,
        ) => void;
    } = {},
): Promise<Map<string, PeerDepResult>> {
    const { onProgress } = options;

    // Strategy 1: Forward inference from peer requirements
    const forwardResults = await inferFromPeerRequirements(
        unknownPackages,
        knownVersions,
        onProgress,
    );

    // Get remaining unknown packages
    const stillUnknown = unknownPackages.filter((p) => !forwardResults.has(p));

    // Strategy 2: Reverse inference from known peers
    const reverseResults = await inferFromKnownPeers(
        stillUnknown,
        knownVersions,
        onProgress,
    );

    // Merge results (forward takes priority)
    const combined = new Map<string, PeerDepResult>();

    for (const [name, result] of forwardResults) {
        combined.set(name, result);
    }

    for (const [name, result] of reverseResults) {
        if (!combined.has(name)) {
            combined.set(name, result);
        }
    }

    return combined;
}
