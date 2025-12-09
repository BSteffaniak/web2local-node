/**
 * Signal Utilities
 *
 * Helpers for working with AbortSignal.
 */

/**
 * Creates an AbortSignal that combines a timeout with an optional user signal.
 * If both are provided, the signal aborts when either triggers.
 *
 * @param timeout - Timeout in milliseconds
 * @param signal - Optional user-provided AbortSignal
 * @returns Combined AbortSignal, or undefined if neither provided
 */
export function createSignalWithTimeout(
    timeout?: number,
    signal?: AbortSignal,
): AbortSignal | undefined {
    if (!timeout && !signal) return undefined;
    if (!timeout) return signal;

    const timeoutSignal = AbortSignal.timeout(timeout);
    if (!signal) return timeoutSignal;

    // Combine both signals - abort when either fires
    return AbortSignal.any([signal, timeoutSignal]);
}
