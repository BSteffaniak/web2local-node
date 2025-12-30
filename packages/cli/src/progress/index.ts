/**
 * Progress display module for CLI capture operations.
 *
 * Provides a multi-line TUI for displaying parallel worker progress,
 * aggregate statistics, and recent log messages during website capture.
 *
 * @packageDocumentation
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
