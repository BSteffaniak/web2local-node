/**
 * `@web2local/state` - WAL Reader
 *
 * Reads and parses write-ahead log events.
 * Detects corruption and provides recovery information.
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import type { WALEvent, StateFile, PhaseName } from '../types.js';
import { PHASES, PHASE_STATUS } from '../types.js';
import { StateIOError } from '../errors.js';
import { validateEvent } from './events.js';

/**
 * Result of reading a WAL file.
 */
export interface WALReadResult {
    /** Successfully parsed events */
    events: WALEvent[];
    /** Last valid sequence number */
    lastValidSeq: number;
    /** Whether corruption was detected */
    corrupted: boolean;
    /** Line number where corruption was detected (1-based) */
    corruptedAtLine?: number;
    /** The corrupted line content (for debugging) */
    corruptedContent?: string;
}

/**
 * Read and parse all events from a WAL file.
 *
 * @param walPath - Path to the WAL file
 * @returns Parsed events and corruption info
 * @throws \{StateIOError\} When file cannot be read
 */
export async function readWAL(walPath: string): Promise<WALReadResult> {
    // If file doesn't exist, return empty result
    if (!existsSync(walPath)) {
        return {
            events: [],
            lastValidSeq: 0,
            corrupted: false,
        };
    }

    let content: string;
    try {
        content = await readFile(walPath, 'utf-8');
    } catch (error) {
        throw new StateIOError('read WAL', error as Error);
    }

    // Handle empty file
    if (!content.trim()) {
        return {
            events: [],
            lastValidSeq: 0,
            corrupted: false,
        };
    }

    const lines = content.split('\n');
    const events: WALEvent[] = [];
    let lastValidSeq = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // Skip empty lines (especially trailing newline)
        if (!line) {
            continue;
        }

        try {
            const parsed = JSON.parse(line);
            const event = validateEvent(parsed);
            events.push(event);
            lastValidSeq = event.seq;
        } catch (_error) {
            // Corruption detected
            return {
                events,
                lastValidSeq,
                corrupted: true,
                corruptedAtLine: i + 1, // 1-based line number
                corruptedContent: line.substring(0, 200), // Truncate for safety
            };
        }
    }

    return {
        events,
        lastValidSeq,
        corrupted: false,
    };
}

/**
 * Apply WAL events to a state file, producing an updated state.
 *
 * Events are applied in sequence order. This is idempotent - applying
 * the same events multiple times produces the same result.
 *
 * @param state - Current state (from state.json)
 * @param events - Events to apply
 * @returns Updated state
 */
export function applyEvents(state: StateFile, events: WALEvent[]): StateFile {
    // Create a mutable copy of the state
    const newState: StateFile = JSON.parse(JSON.stringify(state));

    // Initialize phase data structures if needed
    if (!newState.capture) {
        newState.capture = {
            visitedUrls: [],
            completedUrls: [],
            pendingUrls: [],
            inProgressUrls: [],
            fixtures: [],
            assets: [],
        };
    }
    if (!newState.extract) {
        newState.extract = {
            extractedBundles: [],
            totalFilesWritten: 0,
        };
    }

    for (const event of events) {
        // Skip events we've already applied
        if (event.seq <= newState.lastSeq) {
            continue;
        }

        applyEvent(newState, event);
        newState.lastSeq = event.seq;
        newState.lastUpdatedAt = event.timestamp;
    }

    return newState;
}

/**
 * Apply a single event to the state (mutates state).
 */
function applyEvent(state: StateFile, event: WALEvent): void {
    switch (event.type) {
        case 'phase:start':
            state.phases[event.phase] = {
                ...state.phases[event.phase],
                status: PHASE_STATUS.IN_PROGRESS,
                startedAt: event.timestamp,
            };
            break;

        case 'phase:complete':
            state.phases[event.phase] = {
                ...state.phases[event.phase],
                status: PHASE_STATUS.COMPLETED,
                completedAt: event.timestamp,
            };
            break;

        case 'phase:fail':
            state.phases[event.phase] = {
                ...state.phases[event.phase],
                status: PHASE_STATUS.FAILED,
                error: event.error,
            };
            break;

        case 'scrape:result':
            state.scrape = {
                bundles: event.bundles,
                bundlesWithMaps: event.bundlesWithMaps,
                vendorBundles: event.vendorBundles,
                bundlesWithoutMaps: event.bundlesWithoutMaps,
                finalUrl: event.finalUrl,
            };
            break;

        case 'extract:bundle':
            if (!state.extract) {
                state.extract = {
                    extractedBundles: [],
                    totalFilesWritten: 0,
                };
            }
            {
                // Check if bundle already recorded (idempotency)
                const existingBundle = state.extract.extractedBundles.find(
                    (b) => b.bundleName === event.bundleName,
                );
                if (!existingBundle) {
                    state.extract.extractedBundles.push({
                        bundleName: event.bundleName,
                        filesWritten: event.filesWritten,
                    });
                    state.extract.totalFilesWritten += event.filesWritten;
                }
                break;
            }

        case 'capture:page:started':
            if (!state.capture) {
                state.capture = {
                    visitedUrls: [],
                    completedUrls: [],
                    pendingUrls: [],
                    inProgressUrls: [],
                    fixtures: [],
                    assets: [],
                };
            }
            {
                // Add to visited and in-progress
                if (!state.capture.visitedUrls.includes(event.url)) {
                    state.capture.visitedUrls.push(event.url);
                }
                // Track as in-progress (will be removed on complete/fail)
                const inProgressEntry = { url: event.url, depth: event.depth };
                if (
                    !state.capture.inProgressUrls.some(
                        (u) => u.url === event.url,
                    )
                ) {
                    state.capture.inProgressUrls.push(inProgressEntry);
                }
                // Remove from pending if it was there
                state.capture.pendingUrls = state.capture.pendingUrls.filter(
                    (u) => u.url !== event.url,
                );
                break;
            }

        case 'capture:page:completed':
            if (!state.capture) {
                state.capture = {
                    visitedUrls: [],
                    completedUrls: [],
                    pendingUrls: [],
                    inProgressUrls: [],
                    fixtures: [],
                    assets: [],
                };
            }
            // Mark as completed
            if (!state.capture.completedUrls.includes(event.url)) {
                state.capture.completedUrls.push(event.url);
            }
            // Remove from in-progress
            state.capture.inProgressUrls = state.capture.inProgressUrls.filter(
                (u) => u.url !== event.url,
            );
            // Add fixtures (dedupe by id)
            for (const fixture of event.fixtures) {
                if (!state.capture.fixtures.some((f) => f.id === fixture.id)) {
                    state.capture.fixtures.push(fixture);
                }
            }
            // Add assets (dedupe by url)
            for (const asset of event.assets) {
                if (!state.capture.assets.some((a) => a.url === asset.url)) {
                    state.capture.assets.push(asset);
                }
            }
            break;

        case 'capture:page:failed':
            if (!state.capture) {
                state.capture = {
                    visitedUrls: [],
                    completedUrls: [],
                    pendingUrls: [],
                    inProgressUrls: [],
                    fixtures: [],
                    assets: [],
                };
            }
            // Remove from in-progress
            state.capture.inProgressUrls = state.capture.inProgressUrls.filter(
                (u) => u.url !== event.url,
            );
            // If it won't retry, it's effectively "done" (failed)
            // We keep it in visitedUrls so it won't be re-queued
            break;

        case 'capture:urls:discovered':
            if (!state.capture) {
                state.capture = {
                    visitedUrls: [],
                    completedUrls: [],
                    pendingUrls: [],
                    inProgressUrls: [],
                    fixtures: [],
                    assets: [],
                };
            }
            // Add new URLs to pending (skip if already visited or pending)
            for (const item of event.urls) {
                if (
                    !state.capture.visitedUrls.includes(item.url) &&
                    !state.capture.pendingUrls.some((p) => p.url === item.url)
                ) {
                    state.capture.pendingUrls.push(item);
                }
            }
            break;

        case 'rebuild:result':
            state.rebuild = {
                success: event.success,
                outputDir: event.outputDir,
                bundles: event.bundles,
                durationMs: event.durationMs,
                errors: event.errors,
            };
            break;

        case 'wal:compacted':
            // This event is informational, no state changes needed
            break;
    }
}

/**
 * Get a human-readable progress string for a state.
 *
 * @param state - The state file to generate progress for
 * @returns Human-readable progress description (e.g., "15/100 pages captured")
 */
export function getProgressString(state: StateFile): string {
    // Find the current phase (first non-completed phase)
    const phaseOrder: PhaseName[] = [
        PHASES.SCRAPE,
        PHASES.EXTRACT,
        PHASES.DEPENDENCIES,
        PHASES.CAPTURE,
        PHASES.REBUILD,
    ];

    let currentPhase: PhaseName | null = null;
    for (const phase of phaseOrder) {
        if (state.phases[phase].status !== PHASE_STATUS.COMPLETED) {
            currentPhase = phase;
            break;
        }
    }

    if (!currentPhase) {
        return 'All phases completed';
    }

    switch (currentPhase) {
        case PHASES.SCRAPE:
            return 'Scraping bundles';

        case PHASES.EXTRACT:
            if (state.extract && state.scrape) {
                const extracted = state.extract.extractedBundles.length;
                const total = state.scrape.bundlesWithMaps.length;
                return `${extracted}/${total} bundles extracted`;
            }
            return 'Extracting sources';

        case PHASES.DEPENDENCIES:
            return 'Analyzing dependencies';

        case PHASES.CAPTURE:
            if (state.capture) {
                const completed = state.capture.completedUrls.length;
                const pending = state.capture.pendingUrls.length;
                const inProgress = state.capture.inProgressUrls.length;
                const total = completed + pending + inProgress;
                return `${completed}/${total} pages captured`;
            }
            return 'Capturing API calls';

        case PHASES.REBUILD:
            return 'Rebuilding project';

        default:
            return `${currentPhase} in progress`;
    }
}

/**
 * Validate WAL events against expected sequence.
 *
 * @param events - Array of events to validate
 * @param startSeq - Expected starting sequence number (events should start at startSeq + 1)
 * @returns Index of first out-of-sequence event, or -1 if all events are valid
 */
export function validateEventSequence(
    events: WALEvent[],
    startSeq: number,
): number {
    let expectedSeq = startSeq + 1;

    for (let i = 0; i < events.length; i++) {
        if (events[i].seq !== expectedSeq) {
            return i;
        }
        expectedSeq++;
    }

    return -1;
}
