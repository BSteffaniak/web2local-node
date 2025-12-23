/**
 * Progress display module for CLI.
 *
 * Provides a rich terminal user interface (TUI) for displaying capture progress,
 * including worker status, stats, and log output. This module coordinates the
 * multi-line progress display used during web page capture operations.
 *
 * @example
 * ```typescript
 * import { ProgressDisplay, createCaptureProgressHandler } from './progress';
 *
 * const progress = new ProgressDisplay({
 *     workerCount: 5,
 *     maxPages: 100,
 *     maxDepth: 5,
 *     baseOrigin: 'https://example.com'
 * });
 *
 * progress.start();
 * // ... capture operations with progress.updateWorker(), progress.log(), etc.
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
