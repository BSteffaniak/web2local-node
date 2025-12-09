/**
 * Multi-line progress display for parallel capture operations
 *
 * Displays a box with aggregate stats and per-worker status,
 * with a scrolling log history below.
 */

import chalk from 'chalk';
import { terminal } from './terminal.js';
import { renderBox, truncate } from './box-renderer.js';

/**
 * Worker status types
 */
export type WorkerStatus =
    | 'idle'
    | 'navigating'
    | 'waiting'
    | 'extracting'
    | 'completed'
    | 'error'
    | 'retrying';

/**
 * State of a single worker
 */
export interface WorkerState {
    status: WorkerStatus;
    url?: string;
}

/**
 * Aggregate statistics for the capture
 */
export interface AggregateStats {
    pagesCompleted: number;
    maxPages: number;
    queued: number;
    currentDepth: number;
    maxDepth: number;
    apisCaptured: number;
    assetsCaptured: number;
}

/**
 * Options for the progress display
 */
export interface ProgressDisplayOptions {
    /** Number of workers to display */
    workerCount: number;
    /** Maximum pages to crawl */
    maxPages: number;
    /** Maximum crawl depth */
    maxDepth: number;
    /** Base origin for same-origin URL detection */
    baseOrigin: string;
    /** Maximum width of the box (defaults to terminal width) */
    maxWidth?: number;
}

/**
 * Multi-line progress display for parallel capture operations
 */
export class ProgressDisplay {
    private options: ProgressDisplayOptions;
    private workers: WorkerState[];
    private stats: AggregateStats;
    private boxLineCount: number = 0;
    private started: boolean = false;
    private baseOriginParsed: URL | null = null;
    private resizeHandler: (() => void) | null = null;
    private cleanupHandlers: (() => void)[] = [];

    constructor(options: ProgressDisplayOptions) {
        this.options = options;

        // Initialize workers to idle state
        this.workers = [];
        for (let i = 0; i < options.workerCount; i++) {
            this.workers.push({ status: 'idle' });
        }

        // Initialize stats
        this.stats = {
            pagesCompleted: 0,
            maxPages: options.maxPages,
            queued: 0,
            currentDepth: 0,
            maxDepth: options.maxDepth,
            apisCaptured: 0,
            assetsCaptured: 0,
        };

        // Parse base origin for URL comparison
        try {
            this.baseOriginParsed = new URL(options.baseOrigin);
        } catch {
            this.baseOriginParsed = null;
        }
    }

    /**
     * Check if the display is in interactive mode
     */
    isInteractive(): boolean {
        return terminal.isInteractive();
    }

    /**
     * Start the progress display
     */
    start(): void {
        if (!this.isInteractive()) {
            return;
        }

        this.started = true;

        // Hide cursor
        terminal.write(terminal.hideCursor());

        // Set up resize handler
        this.resizeHandler = () => this.render();
        process.stdout.on('resize', this.resizeHandler);

        // Set up cleanup handlers for signals
        const cleanup = () => this.stop();
        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);
        this.cleanupHandlers.push(() => {
            process.off('SIGINT', cleanup);
            process.off('SIGTERM', cleanup);
        });

        // Initial render
        this.render();
    }

    /**
     * Stop the progress display
     */
    stop(finalMessage?: string): void {
        if (!this.isInteractive()) {
            if (finalMessage) {
                console.log(finalMessage);
            }
            return;
        }

        if (!this.started) {
            return;
        }

        this.started = false;

        // Remove resize handler
        if (this.resizeHandler) {
            process.stdout.off('resize', this.resizeHandler);
            this.resizeHandler = null;
        }

        // Run cleanup handlers
        for (const handler of this.cleanupHandlers) {
            handler();
        }
        this.cleanupHandlers = [];

        // Show cursor
        terminal.write(terminal.showCursor());

        // Clear the box
        this.clearBox();

        if (finalMessage) {
            console.log(finalMessage);
        }
    }

    /**
     * Get current aggregate stats
     */
    getStats(): Readonly<AggregateStats> {
        return { ...this.stats };
    }

    /**
     * Update aggregate stats
     */
    updateStats(stats: Partial<AggregateStats>): void {
        Object.assign(this.stats, stats);
        this.render();
    }

    /**
     * Update a worker's state
     */
    updateWorker(workerId: number, state: Partial<WorkerState>): void {
        if (workerId >= 0 && workerId < this.workers.length) {
            Object.assign(this.workers[workerId], state);
            this.render();
        }
    }

    /**
     * Log a message below the progress box
     */
    log(message: string): void {
        if (!this.isInteractive()) {
            // Non-TTY: just print directly
            console.log(this.formatLogMessage(message));
            return;
        }

        if (!this.started) {
            console.log(this.formatLogMessage(message));
            return;
        }

        // Clear the box, print message, re-render box
        this.clearBox();
        console.log(this.formatLogMessage(message));
        this.render();
    }

    /**
     * Render the progress box
     */
    private render(): void {
        if (!this.isInteractive() || !this.started) {
            return;
        }

        const width = this.options.maxWidth ?? terminal.getWidth();

        const content = {
            title: 'Capture Progress',
            statsLine: this.buildStatsLine(),
            workerLines: this.workers.map((w, i) => this.buildWorkerLine(i, w)),
        };

        const boxLines = renderBox(content, width);

        // Clear previous box
        this.clearBox();

        // Draw new box
        for (const line of boxLines) {
            terminal.writeLine(line);
        }

        this.boxLineCount = boxLines.length;
    }

    /**
     * Clear the progress box from the terminal
     */
    private clearBox(): void {
        if (this.boxLineCount > 0) {
            // Move up to the top of the box
            terminal.write(terminal.moveUp(this.boxLineCount));

            // Clear each line
            for (let i = 0; i < this.boxLineCount; i++) {
                terminal.write(terminal.clearLine());
                if (i < this.boxLineCount - 1) {
                    terminal.write('\n');
                }
            }

            // Move back up
            terminal.write(terminal.moveUp(this.boxLineCount - 1));
        }
    }

    /**
     * Build the stats line
     */
    private buildStatsLine(): string {
        const {
            pagesCompleted,
            maxPages,
            queued,
            currentDepth,
            maxDepth,
            apisCaptured,
            assetsCaptured,
        } = this.stats;

        const parts = [
            `Pages: ${chalk.bold(pagesCompleted)}/${maxPages}`,
            `Queued: ${queued}`,
            `Depth: ${currentDepth}/${maxDepth}`,
            `APIs: ${chalk.bold(apisCaptured)}`,
            `Assets: ${chalk.bold(assetsCaptured)}`,
        ];

        return parts.join(chalk.gray(' │ '));
    }

    /**
     * Build a worker line
     */
    private buildWorkerLine(id: number, state: WorkerState): string {
        const indicator = this.getStatusIndicator(state.status);
        const statusText = state.url
            ? this.formatUrl(state.url)
            : this.getStatusText(state.status);

        return `[${id + 1}] ${indicator} ${statusText}`;
    }

    /**
     * Get the status indicator character with color
     */
    private getStatusIndicator(status: WorkerStatus): string {
        switch (status) {
            case 'navigating':
                return chalk.cyan('●');
            case 'waiting':
            case 'extracting':
                return chalk.yellow('◐');
            case 'idle':
                return chalk.gray('◌');
            case 'completed':
                return chalk.green('✓');
            case 'error':
                return chalk.red('✗');
            case 'retrying':
                return chalk.yellow('↻');
            default:
                return chalk.gray('◌');
        }
    }

    /**
     * Get the status text for display
     */
    private getStatusText(status: WorkerStatus): string {
        switch (status) {
            case 'idle':
                return chalk.gray('Idle');
            case 'waiting':
                return chalk.yellow('Waiting...');
            case 'extracting':
                return chalk.yellow('Extracting links...');
            case 'completed':
                return chalk.green('Completed');
            case 'error':
                return chalk.red('Error');
            case 'retrying':
                return chalk.yellow('Retrying...');
            case 'navigating':
                return chalk.cyan('Navigating...');
            default:
                return '';
        }
    }

    /**
     * Format a URL for display
     * - Same-origin URLs show path only
     * - Cross-origin URLs show full URL
     */
    private formatUrl(url: string): string {
        try {
            const parsed = new URL(url);

            // Same origin: show path only
            if (
                this.baseOriginParsed &&
                parsed.origin === this.baseOriginParsed.origin
            ) {
                return parsed.pathname + parsed.search;
            }

            // Cross-origin: show full URL
            return url;
        } catch {
            return url;
        }
    }

    /**
     * Format a log message with timestamp
     */
    private formatLogMessage(message: string): string {
        const timestamp = this.getTimestamp();
        return chalk.gray(`[${timestamp}]`) + ' ' + message;
    }

    /**
     * Get the current timestamp string
     */
    private getTimestamp(): string {
        const now = new Date();
        const time = now.toLocaleTimeString('en-US', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
        const ms = now.getMilliseconds().toString().padStart(3, '0');
        return `${time}.${ms}`;
    }
}

/**
 * Format a URL for log display
 * - Same-origin URLs show path only
 * - Cross-origin URLs show full URL (possibly truncated)
 */
export function formatUrlForLog(
    url: string,
    baseOrigin: string,
    maxLen?: number,
): string {
    try {
        const parsed = new URL(url);
        const base = new URL(baseOrigin);

        let display: string;
        if (parsed.origin === base.origin) {
            display = parsed.pathname + parsed.search;
        } else {
            display = url;
        }

        if (maxLen && display.length > maxLen) {
            return truncate(display, maxLen);
        }

        return display;
    } catch {
        if (maxLen && url.length > maxLen) {
            return truncate(url, maxLen);
        }
        return url;
    }
}
