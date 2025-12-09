/**
 * Tests for Signal Utilities
 *
 * Tests the createSignalWithTimeout() function.
 */

import { describe, it, expect } from 'vitest';
import { createSignalWithTimeout } from '../src/utils/signal.js';

describe('createSignalWithTimeout', () => {
    describe('no arguments', () => {
        it('returns undefined when no timeout and no signal', () => {
            const result = createSignalWithTimeout();
            expect(result).toBeUndefined();
        });

        it('returns undefined when both are undefined', () => {
            const result = createSignalWithTimeout(undefined, undefined);
            expect(result).toBeUndefined();
        });
    });

    describe('timeout only', () => {
        it('returns timeout signal when only timeout provided', () => {
            const result = createSignalWithTimeout(1000);

            expect(result).toBeInstanceOf(AbortSignal);
            expect(result?.aborted).toBe(false);
        });

        it('creates signal that aborts after timeout', async () => {
            const result = createSignalWithTimeout(50);

            expect(result?.aborted).toBe(false);

            // Wait for timeout
            await new Promise((resolve) => setTimeout(resolve, 100));

            expect(result?.aborted).toBe(true);
        });
    });

    describe('signal only', () => {
        it('returns user signal when only signal provided', () => {
            const controller = new AbortController();
            const result = createSignalWithTimeout(
                undefined,
                controller.signal,
            );

            expect(result).toBe(controller.signal);
        });

        it('returns user signal when timeout is 0', () => {
            const controller = new AbortController();
            // Note: 0 is falsy, so it's treated as "no timeout"
            const result = createSignalWithTimeout(0, controller.signal);

            expect(result).toBe(controller.signal);
        });
    });

    describe('both timeout and signal', () => {
        it('returns combined signal when both provided', () => {
            const controller = new AbortController();
            const result = createSignalWithTimeout(1000, controller.signal);

            expect(result).toBeInstanceOf(AbortSignal);
            // Should be a new signal (from AbortSignal.any), not the original
            expect(result).not.toBe(controller.signal);
        });

        it('aborts when user signal aborts', () => {
            const controller = new AbortController();
            const result = createSignalWithTimeout(10000, controller.signal);

            expect(result?.aborted).toBe(false);

            controller.abort();

            expect(result?.aborted).toBe(true);
        });

        it('aborts when timeout fires first', async () => {
            const controller = new AbortController();
            const result = createSignalWithTimeout(50, controller.signal);

            expect(result?.aborted).toBe(false);

            // Wait for timeout
            await new Promise((resolve) => setTimeout(resolve, 100));

            expect(result?.aborted).toBe(true);
            // User controller should not be aborted
            expect(controller.signal.aborted).toBe(false);
        });

        it('uses whichever fires first', async () => {
            const controller = new AbortController();
            const result = createSignalWithTimeout(10000, controller.signal);

            // Abort user signal first
            controller.abort();

            expect(result?.aborted).toBe(true);
        });
    });

    describe('pre-aborted signals', () => {
        it('returns aborted signal if user signal is already aborted', () => {
            const controller = new AbortController();
            controller.abort();

            const result = createSignalWithTimeout(10000, controller.signal);

            expect(result?.aborted).toBe(true);
        });
    });

    describe('edge cases', () => {
        it('handles very short timeout', async () => {
            const result = createSignalWithTimeout(1);

            // Wait a bit
            await new Promise((resolve) => setTimeout(resolve, 50));

            expect(result?.aborted).toBe(true);
        });

        it('handles large timeout', () => {
            // Should not throw even with large values
            const result = createSignalWithTimeout(2147483647);

            expect(result).toBeInstanceOf(AbortSignal);
            expect(result?.aborted).toBe(false);
        });
    });
});
