/**
 * CLI spinner management utilities
 *
 * Provides safe concurrent spinner management and signal handling
 * for CLI progress indicators.
 */

import type { Ora } from 'ora';
import chalk from 'chalk';

/**
 * Manages multiple CLI spinners and provides safe logging that doesn't
 * interfere with spinner output.
 *
 * Handles signal cleanup to ensure spinners are properly cleared on exit.
 */
export class SpinnerRegistry {
    private spinners: Set<Ora> = new Set();
    private signalHandlers: Array<() => void> = [];

    /**
     * Registers a spinner for management.
     *
     * @param spinner - The ora spinner instance to track
     */
    register(spinner: Ora) {
        this.spinners.add(spinner);
    }

    /**
     * Unregisters a spinner from management.
     *
     * @param spinner - The ora spinner instance to remove
     */
    unregister(spinner: Ora) {
        this.spinners.delete(spinner);
    }

    /**
     * Logs a message while preserving spinner display.
     *
     * Temporarily clears spinners, prints the message with timestamp,
     * then re-renders spinners to avoid visual artifacts.
     *
     * @param message - The message to log
     * @param isVerbose - If true, uses gray styling for verbose output
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
     * Installs signal handlers to clean up spinners on process exit.
     *
     * Listens for SIGINT and SIGTERM to ensure spinners are cleared
     * before the process terminates.
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
     * Cleans up all spinners and removes signal handlers.
     *
     * Should be called when the CLI operation completes to restore
     * normal terminal state.
     */
    cleanup() {
        this.clearAll();
        this.signalHandlers.forEach((remove) => remove());
        this.signalHandlers = [];
    }
}
