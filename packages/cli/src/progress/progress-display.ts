/**
 * Multi-line progress display for parallel capture operations
 *
 * Displays a box with aggregate stats and per-worker status,
 * with a scrolling log history below. Includes:
 * - Progress bar per worker
 * - Elapsed time tracking
 * - Phase text
 * - Adaptive layout based on terminal width
 */

import chalk from 'chalk';
import { terminal } from './terminal.js';
import { renderBox, truncate, visibleLength } from './box-renderer.js';

/**
 * Worker phase types - matches the capture module phases
 */
export type WorkerPhase =
    | 'navigating'
    | 'network-idle'
    | 'scrolling'
    | 'settling'
    | 'extracting-links'
    | 'capturing-html'
    | 'completed'
    | 'error'
    | 'retrying';

/**
 * Worker status types (simplified for display)
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
    phase?: WorkerPhase;
    phaseStartTime?: number;
    /** Number of in-flight requests */
    activeRequests?: number;
    /** Current asset being processed */
    currentAsset?: {
        /** Full path of the asset */
        path: string;
        /** Size in bytes (if known) */
        size?: number;
    };
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
    duplicatesSkipped: number;
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
    private renderInterval: NodeJS.Timeout | null = null;
    private readonly RENDER_INTERVAL_MS = 100;
    private flushingCount: number = 0;
    private flushingStartTime: number | null = null;

    constructor(options: ProgressDisplayOptions) {
        this.options = options;

        // Initialize workers to idle state
        this.workers = [];
        for (let i = 0; i < options.workerCount; i++) {
            this.workers.push({ status: 'idle', phaseStartTime: Date.now() });
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
            duplicatesSkipped: 0,
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

        // Start render loop for elapsed time updates
        this.renderInterval = setInterval(() => {
            if (this.started) {
                this.render();
            }
        }, this.RENDER_INTERVAL_MS);

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

        // Stop render interval
        if (this.renderInterval) {
            clearInterval(this.renderInterval);
            this.renderInterval = null;
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
     * Get a worker's current state
     */
    getWorkerState(workerId: number): WorkerState | undefined {
        return this.workers[workerId];
    }

    /**
     * Update aggregate stats
     */
    updateStats(stats: Partial<AggregateStats>): void {
        Object.assign(this.stats, stats);
        // Don't render here - the interval will handle it
    }

    /**
     * Update a worker's state
     */
    updateWorker(workerId: number, state: Partial<WorkerState>): void {
        if (workerId >= 0 && workerId < this.workers.length) {
            const current = this.workers[workerId];

            // Auto-set phaseStartTime when phase changes
            if (state.phase !== undefined && state.phase !== current.phase) {
                state.phaseStartTime = Date.now();
            }

            // When going idle, reset start time for "idle for X seconds" display
            if (state.status === 'idle' && current.status !== 'idle') {
                state.phaseStartTime = Date.now();
            }

            Object.assign(current, state);
            // Don't render here - the interval will handle it
        }
    }

    /**
     * Set the flushing state - shows a flushing indicator instead of worker status
     * @param count Number of pending assets being flushed (0 to clear)
     */
    setFlushing(count: number): void {
        this.flushingCount = count;
        if (count > 0 && !this.flushingStartTime) {
            this.flushingStartTime = Date.now();
        } else if (count === 0) {
            this.flushingStartTime = null;
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
        const innerWidth = width - 4; // Account for box borders

        // When flushing, show a single flushing line instead of worker lines
        let workerLines: string[];
        if (this.flushingCount > 0) {
            workerLines = this.buildFlushingLines(innerWidth);
        } else {
            workerLines = this.workers.flatMap((w, i) =>
                this.buildWorkerLines(i, w, innerWidth),
            );
        }

        const content = {
            title: 'Capture Progress',
            statsLine: this.buildStatsLine(),
            workerLines,
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
     * Build lines for the flushing state
     */
    private buildFlushingLines(innerWidth: number): string[] {
        const indicator = chalk.yellow('◐');
        const elapsed = this.formatElapsed(this.flushingStartTime ?? undefined);
        const message = `Flushing ${chalk.bold(this.flushingCount)} pending asset downloads...`;
        const messageLen = visibleLength(message);
        const padding = ' '.repeat(
            Math.max(0, innerWidth - messageLen - elapsed.length - 4),
        );

        return [
            `    ${indicator} ${message}${padding}${chalk.gray(elapsed)}`,
            '', // Empty second line to maintain visual consistency
        ];
    }

    /**
     * Build worker lines (main line + asset activity line)
     * Returns an array of 1-2 strings
     */
    private buildWorkerLines(
        id: number,
        state: WorkerState,
        innerWidth: number,
    ): string[] {
        const prefix = `[${id + 1}] `;
        const indicator = this.getStatusIndicator(state.status);
        const basePrefix = prefix + indicator + ' ';
        const basePrefixLen = visibleLength(basePrefix);

        // Calculate available space
        const available = innerWidth - basePrefixLen;

        // Build the main worker line
        let mainLine: string;
        if (state.status === 'idle') {
            const elapsed = this.formatElapsed(state.phaseStartTime);
            const idleText = chalk.gray('Idle');
            const padding = ' '.repeat(
                Math.max(
                    0,
                    available - visibleLength(idleText) - elapsed.length,
                ),
            );
            mainLine = basePrefix + idleText + padding + chalk.gray(elapsed);
        } else {
            // Active worker - build components
            const url = state.url ? this.formatUrl(state.url) : '';
            const elapsed = this.formatElapsed(state.phaseStartTime);
            const progressBar = this.renderProgressBar(state.phase);
            const phaseLabelFull = this.getPhaseLabel(state.phase, true);
            const phaseLabelShort = this.getPhaseLabel(state.phase, false);

            // Adaptive layout based on available space
            mainLine = this.layoutWorkerLine(
                basePrefix,
                url,
                phaseLabelFull,
                phaseLabelShort,
                progressBar,
                elapsed,
                available,
            );
        }

        // Build the asset activity line (second line)
        const assetLine = this.buildAssetLine(state, innerWidth);

        return [mainLine, assetLine];
    }

    /**
     * Build the asset activity line showing current request info
     */
    private buildAssetLine(state: WorkerState, innerWidth: number): string {
        const indent = '    '; // 4 spaces to align under worker line
        const arrow = chalk.gray('↳ ');
        const prefixLen = indent.length + 2; // arrow is 2 visible chars
        const available = innerWidth - prefixLen;

        // If idle or no activity info, show empty/idle
        if (
            state.status === 'idle' ||
            (state.activeRequests === undefined && !state.currentAsset)
        ) {
            return indent + arrow + chalk.gray('');
        }

        // Build the activity text
        const reqCount = state.activeRequests ?? 0;
        const reqText =
            reqCount > 0
                ? chalk.yellow(`${reqCount} req${reqCount !== 1 ? 's' : ''}`)
                : chalk.gray('idle');

        if (!state.currentAsset) {
            return indent + arrow + reqText;
        }

        // Format the asset path (truncate from left if needed)
        const { path, size } = state.currentAsset;
        const sizeStr = size ? ` (${this.formatBytes(size)})` : '';
        const separator = reqCount > 0 ? chalk.gray(' | ') : '';

        // Calculate how much space we have for the path
        const fixedLen =
            visibleLength(reqText) +
            visibleLength(separator) +
            visibleLength(sizeStr);
        const pathSpace = available - fixedLen - 1;

        let displayPath = path;
        if (pathSpace > 0 && path.length > pathSpace) {
            // Truncate from the left with ellipsis
            displayPath = '...' + path.slice(-(pathSpace - 3));
        }

        return (
            indent +
            arrow +
            reqText +
            separator +
            chalk.cyan(displayPath) +
            chalk.gray(sizeStr)
        );
    }

    /**
     * Format bytes to human readable
     */
    private formatBytes(bytes: number): string {
        if (bytes < 1024) return `${bytes}B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    }

    /**
     * Layout worker line components adaptively based on available width
     */
    private layoutWorkerLine(
        prefix: string,
        url: string,
        phaseLabelFull: string,
        phaseLabelShort: string,
        progressBar: string,
        elapsed: string,
        available: number,
    ): string {
        const elapsedLen = elapsed.length;
        const progressLen = visibleLength(progressBar);
        const phaseLabelFullLen = phaseLabelFull
            ? visibleLength(phaseLabelFull) + 1
            : 0; // +1 for space
        const phaseLabelShortLen = phaseLabelShort
            ? visibleLength(phaseLabelShort) + 1
            : 0;

        // Determine what fits
        // Minimum: URL + elapsed
        // Medium: URL + progress + elapsed
        // Large: URL + short phase + progress + elapsed
        // Full: URL + full phase + progress + elapsed

        let includeProgress = false;
        let phaseLabel = '';
        let phaseLabelLen = 0;

        let spaceForUrl = available - elapsedLen - 1; // -1 for minimum spacing

        // Try to fit progress bar (needs ~12 chars)
        if (spaceForUrl > 25) {
            includeProgress = true;
            spaceForUrl -= progressLen + 1;
        }

        // Try to fit phase label
        if (spaceForUrl > 35 && phaseLabelShort) {
            phaseLabel = phaseLabelShort;
            phaseLabelLen = phaseLabelShortLen;
            spaceForUrl -= phaseLabelLen;
        }

        if (spaceForUrl > 50 && phaseLabelFull) {
            phaseLabel = phaseLabelFull;
            phaseLabelLen = phaseLabelFullLen;
            spaceForUrl += phaseLabelShortLen; // Add back short
            spaceForUrl -= phaseLabelLen;
        }

        // Truncate URL to fit
        const truncatedUrl = url
            ? truncate(url, Math.max(10, spaceForUrl))
            : '';
        const urlLen = visibleLength(truncatedUrl);

        // Calculate padding
        let usedSpace = urlLen;
        if (phaseLabel) usedSpace += phaseLabelLen;
        if (includeProgress) usedSpace += progressLen + 1;
        usedSpace += elapsedLen;

        const paddingNeeded = Math.max(0, available - usedSpace);

        // Build the line
        let line = prefix + truncatedUrl;
        line += ' '.repeat(paddingNeeded);
        if (phaseLabel) line += ' ' + chalk.gray(phaseLabel);
        if (includeProgress) line += ' ' + progressBar;
        line += chalk.white(elapsed);

        return line;
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
     * Render progress bar based on current phase
     */
    private renderProgressBar(phase?: WorkerPhase, width: number = 10): string {
        const progress = this.phaseToProgress(phase);
        const filled = Math.round((progress / 100) * width);
        const empty = width - filled;

        return chalk.cyan('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
    }

    /**
     * Map phase to progress percentage
     */
    private phaseToProgress(phase?: WorkerPhase): number {
        switch (phase) {
            case 'navigating':
                return 10;
            case 'network-idle':
                return 30;
            case 'scrolling':
                return 50;
            case 'settling':
                return 70;
            case 'extracting-links':
                return 85;
            case 'capturing-html':
                return 90;
            case 'completed':
                return 100;
            case 'error':
            case 'retrying':
                return 0;
            default:
                return 0;
        }
    }

    /**
     * Get phase label for display
     */
    private getPhaseLabel(phase?: WorkerPhase, full: boolean = false): string {
        if (!phase) return '';

        const labels: Record<WorkerPhase, [string, string]> = {
            navigating: ['navigating', 'nav'],
            'network-idle': ['waiting for network', 'network'],
            scrolling: ['scrolling', 'scroll'],
            settling: ['page settling', 'settle'],
            'extracting-links': ['extracting links', 'links'],
            'capturing-html': ['capturing html', 'html'],
            completed: ['completed', 'done'],
            error: ['error', 'error'],
            retrying: ['retrying', 'retry'],
        };

        const [fullLabel, shortLabel] = labels[phase] || ['', ''];
        const label = full ? fullLabel : shortLabel;
        return label ? `[${label}]` : '';
    }

    /**
     * Format elapsed time
     */
    private formatElapsed(startTime?: number): string {
        if (!startTime) return '';

        const elapsed = (Date.now() - startTime) / 1000;

        if (elapsed < 10) {
            return ` ${elapsed.toFixed(1)}s`;
        } else if (elapsed < 60) {
            return ` ${Math.round(elapsed)}s`;
        } else {
            const mins = Math.floor(elapsed / 60);
            const secs = Math.round(elapsed % 60);
            return ` ${mins}m${secs}s`;
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
