/**
 * @web2local/state - WAL Compactor
 *
 * Compacts the write-ahead log into the main state file.
 * This is called periodically and on graceful shutdown.
 */

import { readFile, writeFile, rename, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import type { StateFile } from '../types.js';
import { StateIOError } from '../errors.js';
import { readWAL, applyEvents } from './wal-reader.js';
import type { WALWriter } from './wal-writer.js';
import { createCompactionEvent } from './events.js';

/**
 * Result of a compaction operation.
 */
export interface CompactionResult {
    /** Number of events that were compacted */
    eventsCompacted: number;
    /** New sequence number after compaction */
    newSeq: number;
}

/**
 * Compact WAL events into the main state file.
 *
 * Process:
 * 1. Read current state.json
 * 2. Read all WAL events
 * 3. Apply events to state
 * 4. Write new state.json atomically (temp file + rename)
 * 5. Truncate WAL
 * 6. Write compaction event to WAL
 *
 * @param statePath - Path to state.json
 * @param walPath - Path to state.wal
 * @param walWriter - WAL writer (for truncation and writing compaction event)
 * @returns Compaction result
 */
export async function compact(
    statePath: string,
    walPath: string,
    walWriter: WALWriter,
): Promise<CompactionResult> {
    // Step 1: Read current state
    let state: StateFile;
    try {
        const stateContent = await readFile(statePath, 'utf-8');
        state = JSON.parse(stateContent);
    } catch (error) {
        throw new StateIOError('read state for compaction', error as Error);
    }

    // Step 2: Read WAL events
    const walResult = await readWAL(walPath);

    if (walResult.corrupted) {
        throw new StateIOError(
            'compact WAL',
            new Error(
                `WAL is corrupted at line ${walResult.corruptedAtLine}. ` +
                    `Cannot compact until corruption is resolved.`,
            ),
        );
    }

    // If no events to compact, we're done
    if (walResult.events.length === 0) {
        return {
            eventsCompacted: 0,
            newSeq: state.lastSeq,
        };
    }

    // Step 3: Apply events to state
    const newState = applyEvents(state, walResult.events);
    const eventsCompacted = walResult.events.length;

    // Step 4: Write new state atomically
    const tempPath = `${statePath}.tmp`;
    try {
        await writeFile(tempPath, JSON.stringify(newState, null, 2), 'utf-8');
        await rename(tempPath, statePath);
    } catch (error) {
        // Clean up temp file if it exists
        try {
            if (existsSync(tempPath)) {
                await unlink(tempPath);
            }
        } catch {
            // Ignore cleanup errors
        }
        throw new StateIOError('write compacted state', error as Error);
    }

    // Step 5: Truncate WAL
    await walWriter.truncate();

    // Step 6: Write compaction event
    await walWriter.append(createCompactionEvent(eventsCompacted));

    return {
        eventsCompacted,
        newSeq: newState.lastSeq,
    };
}

/**
 * Read the current state from state.json, applying any uncompacted WAL events.
 *
 * This is used when loading state - it gives you the full current state
 * without requiring a compaction.
 *
 * @param statePath - Path to state.json
 * @param walPath - Path to state.wal
 * @returns Current state with all events applied
 */
export async function loadCurrentState(
    statePath: string,
    walPath: string,
): Promise<{
    state: StateFile;
    walResult: ReturnType<typeof readWAL> extends Promise<infer T> ? T : never;
}> {
    // Read base state
    let state: StateFile;
    try {
        const stateContent = await readFile(statePath, 'utf-8');
        state = JSON.parse(stateContent);
    } catch (error) {
        throw new StateIOError('read state', error as Error);
    }

    // Read and apply WAL events
    const walResult = await readWAL(walPath);

    // Apply valid events (even if WAL is corrupted, apply up to corruption point)
    if (walResult.events.length > 0) {
        state = applyEvents(state, walResult.events);
    }

    return { state, walResult };
}
