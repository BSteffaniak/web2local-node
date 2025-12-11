/**
 * Multi-line progress display for parallel capture operations
 *
 * Uses a unified TUI that takes over the terminal with:
 * - Stats at top
 * - Workers in middle
 * - Recent logs at bottom (with full buffer dump on exit)
 * - Progress bar per worker
 * - Elapsed time tracking
 * - Phase text
 * - Adaptive layout based on terminal width
 * - Robust cleanup on exit/interrupt
 */

import chalk from 'chalk';
import { terminal } from './terminal.js';
import type { BoxContent } from './box-renderer.js';
import { renderBox, truncate, visibleLength } from './box-renderer.js';

/**
 * Number of lines each worker occupies in the TUI (main line + asset activity line)
 */
export const LINES_PER_WORKER = 2;

/**
 * Fixed lines in TUI chrome (top border, stats, separator after stats, separator before logs, bottom border)
 * Note: separator before logs is only shown when recentLogsHeight > 0
 */
const TUI_CHROME_LINES = 4; // top border + stats + separator after stats + bottom border
const TUI_LOGS_SEPARATOR = 1; // Additional separator before logs section

/**
 * Fixed height for flush progress section.
 * This accommodates: 3 completed phases (1 line each) + current phase (1 line) + current URL (1 line) + completion message (1 line)
 * Using a fixed height prevents layout jumps when transitioning between phases.
 */
const FLUSH_SECTION_HEIGHT = 6;

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
    | 'retrying'
    | 'downloading';

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
    /** Number of duplicate requests skipped (since page load started) */
    duplicateRequests?: number;
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
    private started: boolean = false;
    private baseOriginParsed: URL | null = null;
    private resizeHandler: (() => void) | null = null;
    private cleanupHandlers: (() => void)[] = [];
    private renderInterval: NodeJS.Timeout | null = null;
    private readonly RENDER_INTERVAL_MS = 100;
    private flushingCount: number = 0;
    private flushingStartTime: number | null = null;

    // Flush progress state for granular progress display
    private flushPhase:
        | 'pending-captures'
        | 'fetching-css-assets'
        | 'rewriting-urls'
        | 'complete'
        | null = null;
    private flushCompleted: number = 0;
    private flushTotal: number = 0;
    private flushFailed: number = 0;
    private flushCurrentItem: string | null = null;
    private flushTotalTimeMs: number | null = null;
    /** Per-phase start times for elapsed tracking */
    private flushPhaseStartTime: number | null = null;
    /** Completed phases for showing checkmarks */
    private flushCompletedPhases: Set<string> = new Set();

    /** Total height of the TUI box in lines */
    private tuiHeight: number = 0;
    /** Row where the TUI starts (1-indexed) */
    private tuiStartRow: number = 1;
    /** Flag to prevent re-entrancy in cleanup */
    private cleaningUp: boolean = false;

    /** Recent logs for display (circular buffer showing in TUI) */
    private recentLogs: string[] = [];
    /** Full log buffer for dump on exit (unlimited) */
    private logBuffer: string[] = [];
    /** Calculated height available for recent logs section */
    private recentLogsHeight: number = 0;

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

        // Calculate layout
        this.calculateLayout();

        // Push existing terminal content into scrollback by printing blank lines
        for (let i = 0; i < this.tuiHeight; i++) {
            terminal.write('\n');
        }

        // Initial render
        this.render();

        // Set up resize handler
        this.resizeHandler = () => this.handleResize();
        process.stdout.on('resize', this.resizeHandler);

        // Set up cleanup handlers for signals
        this.setupCleanupHandlers();

        // Start render loop for elapsed time updates
        this.renderInterval = setInterval(() => {
            if (this.started) {
                this.render();
            }
        }, this.RENDER_INTERVAL_MS);
    }

    /**
     * Calculate layout dimensions based on terminal size
     * Layout: stats at top, workers/flush progress in middle, logs at bottom
     */
    private calculateLayout(): void {
        const termHeight = terminal.getHeight();

        // Determine content section height based on mode
        // Use flush mode if we have a flushing count or are in a flush phase
        const isFlushMode = this.flushingCount > 0 || this.flushPhase !== null;
        const contentHeight = isFlushMode
            ? FLUSH_SECTION_HEIGHT
            : this.options.workerCount * LINES_PER_WORKER;

        const fixedHeight = TUI_CHROME_LINES + contentHeight;

        // Recent logs get remaining space (0 if terminal too small)
        this.recentLogsHeight = Math.max(
            0,
            termHeight - fixedHeight - TUI_LOGS_SEPARATOR,
        );

        // Total TUI height (include logs separator only if we have logs space)
        if (this.recentLogsHeight > 0) {
            this.tuiHeight =
                fixedHeight + TUI_LOGS_SEPARATOR + this.recentLogsHeight;
        } else {
            this.tuiHeight = fixedHeight;
        }

        // TUI starts at row 1 (takes over terminal)
        this.tuiStartRow = 1;
    }

    /**
     * Clear TUI area and recalculate layout.
     * Called when switching between worker mode and flush mode to prevent stale content.
     */
    private recalculateAndClear(): void {
        if (!this.started || !this.isInteractive()) return;
        this.clearTuiArea();
        this.calculateLayout();
    }

    /**
     * Set up cleanup handlers for various exit scenarios
     */
    private setupCleanupHandlers(): void {
        const cleanup = () => {
            if (this.cleaningUp) return;
            this.cleaningUp = true;
            this.forceCleanup();
        };

        // Handle various termination signals
        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);
        process.on('beforeExit', cleanup);

        // Last resort - process.on('exit') is synchronous only
        const exitHandler = () => {
            if (this.started) {
                terminal.write(terminal.showCursor());
            }
        };
        process.on('exit', exitHandler);

        this.cleanupHandlers.push(() => {
            process.off('SIGINT', cleanup);
            process.off('SIGTERM', cleanup);
            process.off('beforeExit', cleanup);
            process.off('exit', exitHandler);
        });
    }

    /**
     * Force cleanup - used by signal handlers
     */
    private forceCleanup(): void {
        // Stop render interval immediately
        if (this.renderInterval) {
            clearInterval(this.renderInterval);
            this.renderInterval = null;
        }

        this.started = false;

        // Clear TUI area
        this.clearTuiArea();

        // Move cursor to top of cleared area
        terminal.write(terminal.moveTo(this.tuiStartRow, 1));

        // Show cursor
        terminal.write(terminal.showCursor());

        // Dump full log buffer with header
        this.dumpLogBuffer();

        // Print interruption message
        console.log(chalk.yellow('Capture interrupted'));
    }

    /**
     * Handle terminal resize
     */
    private handleResize(): void {
        if (!this.started) return;

        // Recalculate layout
        this.calculateLayout();

        // Trim recent logs to fit new size
        while (this.recentLogs.length > this.recentLogsHeight) {
            this.recentLogs.shift();
        }

        // Clear and redraw TUI
        this.clearTuiArea();
        this.render();
    }

    /**
     * Clear the TUI area (all lines where TUI is drawn)
     */
    private clearTuiArea(): void {
        for (let i = 0; i < this.tuiHeight; i++) {
            terminal.write(terminal.moveTo(this.tuiStartRow + i, 1));
            terminal.write(terminal.clearLine());
        }
    }

    /**
     * Dump the full log buffer to terminal with header/footer
     */
    private dumpLogBuffer(): void {
        if (this.logBuffer.length > 0) {
            console.log(
                chalk.gray(
                    '─── Verbose Log History ─────────────────────────────────────',
                ),
            );
            for (const log of this.logBuffer) {
                console.log(log);
            }
            console.log(
                chalk.gray(
                    '─────────────────────────────────────────────────────────────',
                ),
            );
        }
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

        // Run cleanup handlers (removes signal handlers)
        for (const handler of this.cleanupHandlers) {
            handler();
        }
        this.cleanupHandlers = [];

        // Clear TUI area
        this.clearTuiArea();

        // Move cursor to top of cleared area
        terminal.write(terminal.moveTo(this.tuiStartRow, 1));

        // Show cursor
        terminal.write(terminal.showCursor());

        // Dump full log buffer with header
        this.dumpLogBuffer();

        // Print completion message
        if (finalMessage) {
            console.log(finalMessage);
        } else {
            console.log(chalk.green('Capture completed'));
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
     * Update the base origin for URL formatting.
     * This should be called when a redirect is detected to ensure
     * URLs are properly truncated relative to the final destination.
     */
    updateBaseOrigin(newOrigin: string): void {
        try {
            this.baseOriginParsed = new URL(newOrigin);
        } catch {
            // If URL parsing fails, keep the existing base origin
        }
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
        const wasInFlushMode = this.flushingCount > 0;
        const willBeInFlushMode = count > 0;

        this.flushingCount = count;
        if (count > 0 && !this.flushingStartTime) {
            this.flushingStartTime = Date.now();
        } else if (count === 0) {
            this.flushingStartTime = null;
        }

        // Recalculate layout when entering or exiting flush mode
        // This clears the TUI area and adjusts height for the new mode
        if (wasInFlushMode !== willBeInFlushMode) {
            this.recalculateAndClear();
        }
    }

    /**
     * Set the flush progress state for granular progress display
     * @param phase Current flush phase
     * @param completed Number of items completed
     * @param total Total number of items
     * @param failed Number of failed items (optional)
     * @param currentItem Current item being processed (optional)
     * @param totalTimeMs Total elapsed time (only for 'complete' phase)
     */
    setFlushProgress(
        phase:
            | 'pending-captures'
            | 'fetching-css-assets'
            | 'rewriting-urls'
            | 'complete',
        completed: number,
        total: number,
        failed?: number,
        currentItem?: string,
        totalTimeMs?: number,
    ): void {
        // Track phase transitions for checkmarks
        if (this.flushPhase && phase !== this.flushPhase) {
            // Previous phase completed, mark it
            this.flushCompletedPhases.add(this.flushPhase);
        }

        // Start timer for new phase
        if (phase !== this.flushPhase && phase !== 'complete') {
            this.flushPhaseStartTime = Date.now();
        }

        this.flushPhase = phase;
        this.flushCompleted = completed;
        this.flushTotal = total;
        this.flushFailed = failed ?? 0;
        this.flushCurrentItem = currentItem ?? null;
        this.flushTotalTimeMs = totalTimeMs ?? null;

        // When complete, reset flush state for next run
        if (phase === 'complete') {
            // Add final phase to completed set
            this.flushCompletedPhases.add('rewriting-urls');
            // Clear flushing count to signal completion
            this.flushingCount = 0;
            this.flushingStartTime = null;

            // Reset all flush state so next flush starts fresh
            // Use a microtask to allow the completion message to render first
            queueMicrotask(() => {
                this.flushPhase = null;
                this.flushCompleted = 0;
                this.flushTotal = 0;
                this.flushFailed = 0;
                this.flushCurrentItem = null;
                this.flushTotalTimeMs = null;
                this.flushPhaseStartTime = null;
                this.flushCompletedPhases.clear();
                // Recalculate layout to switch back to worker mode height
                this.recalculateAndClear();
            });
        }
    }

    /**
     * Log a message - adds to both recent logs display and full buffer
     */
    log(message: string): void {
        const formattedMessage = this.formatLogMessage(message);

        // Always add to full buffer (unlimited, for dump on exit)
        this.logBuffer.push(formattedMessage);

        // If not interactive or not started, just console.log
        if (!this.isInteractive() || !this.started) {
            console.log(formattedMessage);
            return;
        }

        // Add to recent logs display
        this.recentLogs.push(formattedMessage);

        // Trim recent logs to fit display area
        while (this.recentLogs.length > this.recentLogsHeight) {
            this.recentLogs.shift();
        }

        // The render interval will pick up the new logs
    }

    /**
     * Render the progress box
     * Draws unified TUI with stats, workers, and recent logs
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

        // Calculate how many more logs are in buffer vs displayed
        const moreLogsCount = Math.max(
            0,
            this.logBuffer.length - this.recentLogs.length,
        );

        const content: BoxContent = {
            title: 'Capture Progress',
            statsLine: this.buildStatsLine(),
            workerLines,
            recentLogs: this.recentLogs,
            moreLogsCount,
            recentLogsHeight: this.recentLogsHeight,
        };

        const boxLines = renderBox(content, width);

        // Draw TUI at fixed position
        for (let i = 0; i < boxLines.length; i++) {
            terminal.write(terminal.moveTo(this.tuiStartRow + i, 1));
            terminal.write(terminal.clearLine());
            terminal.write(boxLines[i]);
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
     * Build lines for the flushing state with granular progress
     */
    private buildFlushingLines(innerWidth: number): string[] {
        const lines: string[] = [];

        // If we have granular flush progress, show detailed view
        if (this.flushPhase) {
            // Phase definitions with labels
            const phases = [
                {
                    id: 'pending-captures',
                    label: 'Completing pending downloads',
                },
                {
                    id: 'fetching-css-assets',
                    label: 'Fetching CSS-referenced assets',
                },
                { id: 'rewriting-urls', label: 'Rewriting asset URLs' },
            ];

            for (const phase of phases) {
                const isCompleted = this.flushCompletedPhases.has(phase.id);
                const isCurrent = this.flushPhase === phase.id;

                if (isCompleted) {
                    // Show completed phase with checkmark
                    const indicator = chalk.green('✓');
                    const label = chalk.gray(phase.label);
                    lines.push(`    ${indicator} ${label}`);
                } else if (isCurrent) {
                    // Show current phase with progress bar
                    const indicator = chalk.yellow('◐');
                    const elapsed = this.formatElapsed(
                        this.flushPhaseStartTime ?? undefined,
                    );

                    // Build progress bar
                    const progressBar = this.renderFlushProgressBar(
                        this.flushCompleted,
                        this.flushTotal,
                        20,
                    );

                    // Build progress text: "34/85 (3 failed)"
                    let progressText = `${this.flushCompleted}/${this.flushTotal}`;
                    if (this.flushFailed > 0) {
                        progressText += chalk.red(
                            ` (${this.flushFailed} failed)`,
                        );
                    }

                    const label = phase.label;
                    const mainPart = `${indicator} ${label}... ${progressBar} ${progressText}`;
                    const mainLen = visibleLength(mainPart);
                    const padding = ' '.repeat(
                        Math.max(0, innerWidth - mainLen - elapsed.length - 4),
                    );

                    lines.push(
                        `    ${mainPart}${padding}${chalk.gray(elapsed)}`,
                    );

                    // Show current item on second line if available
                    if (this.flushCurrentItem) {
                        const arrow = chalk.gray('↳');
                        const maxUrlLen = innerWidth - 8;
                        let displayUrl = this.flushCurrentItem;
                        if (displayUrl.length > maxUrlLen) {
                            displayUrl =
                                '...' + displayUrl.slice(-(maxUrlLen - 3));
                        }
                        lines.push(`      ${arrow} ${chalk.cyan(displayUrl)}`);
                    } else {
                        lines.push(''); // Empty line for spacing
                    }
                }
                // Skip pending phases (don't show them at all)
            }

            // If complete, show total time
            if (this.flushPhase === 'complete' && this.flushTotalTimeMs) {
                const totalSecs = (this.flushTotalTimeMs / 1000).toFixed(1);
                lines.push(
                    `    ${chalk.green('✓')} ${chalk.gray(`Flush complete in ${totalSecs}s`)}`,
                );
            }
        } else {
            // Legacy fallback: simple flushing message
            const indicator = chalk.yellow('◐');
            const elapsed = this.formatElapsed(
                this.flushingStartTime ?? undefined,
            );
            const message = `Flushing ${chalk.bold(this.flushingCount)} pending asset downloads...`;
            const messageLen = visibleLength(message);
            const padding = ' '.repeat(
                Math.max(0, innerWidth - messageLen - elapsed.length - 4),
            );

            lines.push(
                `    ${indicator} ${message}${padding}${chalk.gray(elapsed)}`,
            );
            lines.push(''); // Empty second line to maintain visual consistency
        }

        // Pad to fixed height to prevent layout jumps during flush phases
        while (lines.length < FLUSH_SECTION_HEIGHT) {
            lines.push('');
        }

        return lines;
    }

    /**
     * Render a progress bar for flush phases
     * @param completed Number of items completed
     * @param total Total number of items
     * @param width Width of the progress bar in characters
     */
    private renderFlushProgressBar(
        completed: number,
        total: number,
        width: number = 20,
    ): string {
        if (total === 0) {
            return chalk.gray('░'.repeat(width));
        }

        const progress = Math.min(1, completed / total);
        const filled = Math.round(progress * width);
        const empty = width - filled;

        return (
            chalk.cyan('[') +
            chalk.cyan('█'.repeat(filled)) +
            chalk.gray('░'.repeat(empty)) +
            chalk.cyan(']')
        );
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
        } else if (state.status === 'downloading') {
            const elapsed = this.formatElapsed(state.phaseStartTime);
            const downloadingText = chalk.cyan('Downloading');
            const padding = ' '.repeat(
                Math.max(
                    0,
                    available - visibleLength(downloadingText) - elapsed.length,
                ),
            );
            mainLine =
                basePrefix + downloadingText + padding + chalk.gray(elapsed);
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

        const reqCount = state.activeRequests ?? 0;
        const dupCount = state.duplicateRequests ?? 0;

        // If idle or no activity info and no duplicates, show empty line
        // (but not for 'downloading' status - we want to show asset activity)
        if (
            state.status === 'idle' ||
            (state.status !== 'downloading' &&
                reqCount === 0 &&
                dupCount === 0 &&
                !state.currentAsset)
        ) {
            return indent + arrow + chalk.gray('');
        }

        // Build parts array for joining with separators
        const parts: string[] = [];

        // Active requests
        if (reqCount > 0) {
            parts.push(
                chalk.yellow(`${reqCount} req${reqCount !== 1 ? 's' : ''}`),
            );
        }

        // Duplicates
        if (dupCount > 0) {
            parts.push(
                chalk.gray(`${dupCount} duplicate${dupCount !== 1 ? 's' : ''}`),
            );
        }

        // If no parts yet and no current asset, show idle
        if (parts.length === 0 && !state.currentAsset) {
            return indent + arrow + chalk.gray('idle');
        }

        // Current asset path
        if (state.currentAsset) {
            const { path, size } = state.currentAsset;
            const sizeStr = size ? ` (${this.formatBytes(size)})` : '';

            // Calculate available space for path
            const separatorLen = parts.length > 0 ? 3 : 0; // ' | ' between parts
            const partsLen = parts.reduce(
                (acc, p) => acc + visibleLength(p) + 3,
                0,
            ); // each part + ' | '
            const pathSpace =
                available - partsLen - visibleLength(sizeStr) - separatorLen;

            let displayPath = path;
            if (pathSpace > 0 && path.length > pathSpace) {
                // Truncate from the left with ellipsis
                displayPath = '...' + path.slice(-(pathSpace - 3));
            }

            parts.push(chalk.cyan(displayPath) + chalk.gray(sizeStr));
        }

        return indent + arrow + parts.join(chalk.gray(' | '));
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
            case 'downloading':
                return chalk.cyan('↓');
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
