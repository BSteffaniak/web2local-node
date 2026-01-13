/**
 * Progress display module for the web2local CLI.
 *
 * This module provides a terminal-based UI (TUI) for displaying real-time progress
 * during capture operations. It includes:
 *
 * - Multi-worker progress display with status indicators
 * - Aggregate statistics (pages, APIs, assets)
 * - Recent log display with scrollback
 * - Box rendering utilities for bordered layouts
 * - Terminal control utilities for cursor and ANSI manipulation
 *
 * @example
 * ```typescript
 * import { ProgressDisplay, createCaptureProgressHandler } from './progress';
 *
 * const progress = new ProgressDisplay({
 *   workerCount: 5,
 *   maxPages: 100,
 *   maxDepth: 5,
 *   baseOrigin: 'https://example.com'
 * });
 *
 * progress.start();
 * // ... capture operations with event handlers
 * progress.stop();
 * ```
 */

export {
    ProgressDisplay,
    formatUrlForLog,
    type WorkerStatus,
    type WorkerPhase,
    type WorkerState,
    type AggregateStats,
    type ProgressDisplayOptions,
} from './progress-display.js';

export { terminal } from './terminal.js';

export {
    renderBox,
    stripAnsi,
    visibleLength,
    truncate,
    padRight,
    type BoxContent,
} from './box-renderer.js';

export {
    createCaptureProgressHandler,
    createVerboseHandler,
    PHASE_STATUS_MAP,
    type CaptureEventHandlerOptions,
} from './capture-event-handler.js';
