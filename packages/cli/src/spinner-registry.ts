/**
 * Spinner registry for managing multiple ora spinners.
 *
 * Provides synchronized logging that doesn't interfere with active spinners,
 * and handles graceful cleanup on process signals.
 */

import type { Ora } from 'ora';
import chalk from 'chalk';

/**
 * Registry for managing multiple ora spinners with synchronized logging.
 *
 * When multiple spinners are active, logging directly to console can cause
 * visual artifacts. This registry tracks active spinners and temporarily
 * clears them before logging, then re-renders them afterwards.
 *
 * @example
 * ```typescript
 * const registry = new SpinnerRegistry();
 * registry.setupSignalHandlers();
 *
 * const spinner = ora('Loading...').start();
 * registry.register(spinner);
 *
 * // Log without interfering with spinner
 * registry.safeLog('Something happened');
 *
 * spinner.succeed('Done');
 * registry.cleanup();
 * ```
 */
export class SpinnerRegistry {
    /** Set of currently registered spinners. */
    private spinners: Set<Ora> = new Set();
    /** Cleanup functions for registered signal handlers. */
    private signalHandlers: Array<() => void> = [];

    /**
     * Registers a spinner with the registry.
     *
     * @param spinner - The ora spinner instance to register
     */
    register(spinner: Ora) {
        this.spinners.add(spinner);
    }

    /**
     * Unregisters a spinner from the registry.
     *
     * @param spinner - The ora spinner instance to unregister
     */
    unregister(spinner: Ora) {
        this.spinners.delete(spinner);
    }

    /**
     * Logs a message without interfering with active spinners.
     *
     * Temporarily clears all spinning spinners, prints the timestamped message,
     * then re-renders the spinners.
     *
     * @param message - The message to log
     * @param isVerbose - If true, formats message in gray (verbose style)
     */
    safeLog(message: string, isVerbose: boolean = false) {
        const now = new Date();
        const timestamp =
            now.toLocaleTimeString('en-US', {
                hour12: false,
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
            }) +
            '.' +
            now.getMilliseconds().toString().padStart(3, '0');

        const formattedMessage = isVerbose
            ? chalk.gray(`[${timestamp}] ${message}`)
            : chalk.cyan(`[${timestamp}] ${message}`);

        // Clear spinner lines without stopping them (avoids flicker)
        for (const spinner of this.spinners) {
            if (spinner.isSpinning) {
                spinner.clear();
            }
        }

        // Print message
        console.log(formattedMessage);

        // Re-render spinners immediately (they're still running)
        for (const spinner of this.spinners) {
            if (spinner.isSpinning) {
                spinner.render();
            }
        }
    }

    /**
     * Sets up signal handlers to clean up spinners on SIGINT/SIGTERM.
     *
     * Should be called early in the CLI lifecycle. Call `cleanup()` when
     * done to remove the handlers.
     */
    setupSignalHandlers() {
        const cleanup = () => {
            this.clearAll();
            process.exit(0);
        };

        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);

        this.signalHandlers.push(() => {
            process.off('SIGINT', cleanup);
            process.off('SIGTERM', cleanup);
        });
    }

    /**
     * Clears all registered spinners from the terminal.
     */
    clearAll() {
        for (const spinner of this.spinners) {
            spinner.clear();
        }
    }

    /**
     * Cleans up the registry by clearing spinners and removing signal handlers.
     *
     * Should be called when the CLI operation completes or on early exit.
     */
    cleanup() {
        this.clearAll();
        this.signalHandlers.forEach((remove) => remove());
        this.signalHandlers = [];
    }
}
