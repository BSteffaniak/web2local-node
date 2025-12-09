import type { Ora } from 'ora';
import chalk from 'chalk';

export class SpinnerRegistry {
    private spinners: Set<Ora> = new Set();
    private signalHandlers: Array<() => void> = [];

    register(spinner: Ora) {
        this.spinners.add(spinner);
    }

    unregister(spinner: Ora) {
        this.spinners.delete(spinner);
    }

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

        // Stop all active spinners
        const stoppedSpinners: Ora[] = [];
        for (const spinner of this.spinners) {
            if (spinner.isSpinning) {
                spinner.stop();
                stoppedSpinners.push(spinner);
            }
        }

        // Print message
        console.log(formattedMessage);

        // Restart stopped spinners
        for (const spinner of stoppedSpinners) {
            spinner.start();
        }
    }

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

    clearAll() {
        for (const spinner of this.spinners) {
            spinner.clear();
        }
    }

    cleanup() {
        this.clearAll();
        this.signalHandlers.forEach((remove) => remove());
        this.signalHandlers = [];
    }
}
