/**
 * `@web2local/state` - WAL Writer
 *
 * Append-only write-ahead log for durability.
 * Each event is written as a JSON line followed by a newline.
 * fsync is called after each write to ensure durability.
 */

import { open, type FileHandle } from 'fs/promises';
import type { WALEvent } from '../types.js';
import { StateIOError } from '../errors.js';

/**
 * Options for the WAL writer.
 */
export interface WALWriterOptions {
    /** Number of events before triggering compaction callback */
    compactionThreshold: number;
    /** Callback when compaction threshold is reached */
    onCompactionNeeded: () => Promise<void>;
}

/**
 * Write-ahead log writer.
 *
 * Provides append-only durability with fsync after each write.
 * Tracks event count and triggers compaction when threshold is reached.
 */
export class WALWriter {
    private fd: FileHandle | null = null;
    private seq: number = 0;
    private eventsSinceCompaction: number = 0;
    private isCompacting: boolean = false;
    private pendingWrites: Array<{
        event: Omit<WALEvent, 'timestamp' | 'seq'>;
        resolve: (seq: number) => void;
        reject: (error: Error) => void;
    }> = [];
    private isProcessing: boolean = false;

    constructor(
        private walPath: string,
        private options: WALWriterOptions,
    ) {}

    /**
     * Set the compaction callback.
     *
     * Useful when the callback needs to reference objects created after construction.
     *
     * @param callback - Async function to call when compaction is triggered
     */
    setCompactionCallback(callback: () => Promise<void>): void {
        this.options.onCompactionNeeded = callback;
    }

    /**
     * Open the WAL file for appending.
     *
     * @param startSeq - Starting sequence number (from last compacted state)
     * @throws {StateIOError} When the file cannot be opened
     * @throws {Error} When the writer is already open
     */
    async open(startSeq: number = 0): Promise<void> {
        if (this.fd) {
            throw new Error('WAL writer is already open');
        }

        try {
            // Open in append mode, create if doesn't exist
            this.fd = await open(this.walPath, 'a');
            this.seq = startSeq;
            this.eventsSinceCompaction = 0;
        } catch (error) {
            throw new StateIOError('open WAL', error as Error);
        }
    }

    /**
     * Append an event to the WAL.
     *
     * @param event - Event payload (without timestamp and seq)
     * @returns The sequence number assigned to this event
     * @throws {Error} When the writer is not open
     * @throws {StateIOError} When the write operation fails
     */
    async append(event: Omit<WALEvent, 'timestamp' | 'seq'>): Promise<number> {
        if (!this.fd) {
            throw new Error('WAL writer is not open');
        }

        // Queue the write and process
        return new Promise((resolve, reject) => {
            this.pendingWrites.push({ event, resolve, reject });
            this.processQueue();
        });
    }

    /**
     * Process queued writes sequentially.
     */
    private async processQueue(): Promise<void> {
        if (this.isProcessing || this.pendingWrites.length === 0) {
            return;
        }

        this.isProcessing = true;

        while (this.pendingWrites.length > 0) {
            const write = this.pendingWrites.shift()!;

            try {
                const seq = await this.writeEvent(write.event);
                write.resolve(seq);
            } catch (error) {
                write.reject(error as Error);
            }
        }

        this.isProcessing = false;
    }

    /**
     * Actually write an event to the file.
     */
    private async writeEvent(
        event: Omit<WALEvent, 'timestamp' | 'seq'>,
    ): Promise<number> {
        if (!this.fd) {
            throw new Error('WAL writer is not open');
        }

        // Assign sequence number and timestamp
        this.seq++;
        const fullEvent: WALEvent = {
            ...event,
            timestamp: new Date().toISOString(),
            seq: this.seq,
        } as WALEvent;

        // Serialize to JSON line
        const line = JSON.stringify(fullEvent) + '\n';

        try {
            // Write and sync
            await this.fd.write(line);
            await this.fd.sync();

            this.eventsSinceCompaction++;

            // Check if compaction is needed
            if (
                !this.isCompacting &&
                this.eventsSinceCompaction >= this.options.compactionThreshold
            ) {
                // Don't await - let compaction run in background
                this.triggerCompaction();
            }

            return this.seq;
        } catch (error) {
            throw new StateIOError('write WAL event', error as Error);
        }
    }

    /**
     * Trigger compaction in the background.
     */
    private async triggerCompaction(): Promise<void> {
        if (this.isCompacting) {
            return;
        }

        this.isCompacting = true;

        try {
            await this.options.onCompactionNeeded();
        } catch (error) {
            // Log but don't throw - compaction failures shouldn't break writes
            console.error('WAL compaction failed:', error);
        } finally {
            this.isCompacting = false;
        }
    }

    /**
     * Get the current sequence number.
     *
     * @returns The last assigned sequence number
     */
    getCurrentSeq(): number {
        return this.seq;
    }

    /**
     * Get the number of events since last compaction.
     *
     * @returns Count of events written since the last compaction
     */
    getEventsSinceCompaction(): number {
        return this.eventsSinceCompaction;
    }

    /**
     * Reset the events counter after compaction.
     */
    resetEventCounter(): void {
        this.eventsSinceCompaction = 0;
    }

    /**
     * Close the WAL file.
     *
     * Processes any remaining queued writes before closing.
     *
     * @throws {StateIOError} When the file cannot be closed
     */
    async close(): Promise<void> {
        if (!this.fd) {
            return;
        }

        try {
            // Process any remaining writes
            while (this.pendingWrites.length > 0) {
                await this.processQueue();
            }

            await this.fd.close();
            this.fd = null;
        } catch (error) {
            throw new StateIOError('close WAL', error as Error);
        }
    }

    /**
     * Truncate the WAL file (after compaction).
     *
     * This clears all events from the file.
     *
     * @throws {Error} When the writer is not open
     * @throws {StateIOError} When the truncate operation fails
     */
    async truncate(): Promise<void> {
        if (!this.fd) {
            throw new Error('WAL writer is not open');
        }

        try {
            await this.fd.truncate(0);
            await this.fd.sync();
            this.eventsSinceCompaction = 0;
        } catch (error) {
            throw new StateIOError('truncate WAL', error as Error);
        }
    }

    /**
     * Check if the writer is open.
     *
     * @returns True if the WAL file is open for writing
     */
    isOpen(): boolean {
        return this.fd !== null;
    }
}
