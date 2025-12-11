/**
 * Shared event handler factory for capture progress events.
 *
 * This module provides a unified way to handle CaptureProgressEvents
 * across different CLI commands (capture, extract, etc.) to avoid
 * code duplication and ensure consistent behavior.
 */

import chalk from 'chalk';
import type { CaptureProgressEvent } from '@web2local/capture';
import {
    ProgressDisplay,
    formatUrlForLog,
    type WorkerStatus,
    type WorkerPhase,
} from './index.js';

/**
 * Options for creating a capture event handler
 */
export interface CaptureEventHandlerOptions {
    /** The progress display instance */
    progress: ProgressDisplay;
    /** Base URL for formatting same-origin URLs */
    baseUrl: string;
    /** Whether to log API captures (default: true) */
    logApiCaptures?: boolean;
    /** Whether to count API captures in stats (default: true) */
    trackApiCaptures?: boolean;
}

/**
 * Phase to worker status mapping
 */
export const PHASE_STATUS_MAP: Record<string, WorkerStatus> = {
    navigating: 'navigating',
    'network-idle': 'waiting',
    scrolling: 'waiting',
    settling: 'waiting',
    'extracting-links': 'extracting',
    'capturing-html': 'waiting',
    completed: 'idle',
    error: 'error',
    retrying: 'retrying',
    'backing-off': 'retrying',
};

/**
 * Handle page-progress events
 */
function handlePageProgress(
    progress: ProgressDisplay,
    event: CaptureProgressEvent & { type: 'page-progress' },
    baseUrl: string,
): void {
    const {
        workerId,
        phase,
        url,
        pagesCompleted,
        queued,
        depth,
        linksDiscovered,
        error,
        backoffMs,
    } = event;

    // Update worker state
    // For backing-off phase, include backoff timing info for countdown display
    const workerUpdate: Parameters<typeof progress.updateWorker>[1] = {
        status: PHASE_STATUS_MAP[phase] || 'idle',
        phase: phase as WorkerPhase,
        url,
    };

    if (phase === 'backing-off' && backoffMs) {
        workerUpdate.backoffMs = backoffMs;
        workerUpdate.backoffStartTime = Date.now();
    } else {
        // Clear backoff state when not backing off
        workerUpdate.backoffMs = undefined;
        workerUpdate.backoffStartTime = undefined;
    }

    progress.updateWorker(workerId, workerUpdate);

    // Update aggregate stats
    progress.updateStats({
        pagesCompleted,
        queued,
        currentDepth: depth,
    });

    // Log significant events
    const shortUrl = formatUrlForLog(url, baseUrl, 60);
    if (phase === 'completed') {
        const linkInfo =
            linksDiscovered !== undefined ? ` (${linksDiscovered} links)` : '';
        progress.log(`${chalk.green('✓')} Completed: ${shortUrl}${linkInfo}`);
    } else if (phase === 'error') {
        progress.log(
            `${chalk.red('✗')} Error: ${shortUrl}${error ? ` - ${error}` : ''}`,
        );
    } else if (phase === 'retrying') {
        progress.log(`${chalk.yellow('↻')} Retrying: ${shortUrl}`);
    } else if (phase === 'backing-off' && backoffMs) {
        const backoffSeconds = (backoffMs / 1000).toFixed(1);
        progress.log(
            `${chalk.yellow('⏳')} Backing off: ${shortUrl} (${backoffSeconds}s)`,
        );
    }
}

/**
 * Handle request-activity events
 */
function handleRequestActivity(
    progress: ProgressDisplay,
    event: CaptureProgressEvent & { type: 'request-activity' },
): void {
    const {
        workerId,
        activeRequests,
        duplicateRequests,
        currentUrl,
        currentSize,
    } = event;
    const urlObj = currentUrl ? new URL(currentUrl) : null;

    // Determine if we need to transition status
    const currentState = progress.getWorkerState(workerId);
    let statusUpdate: { status: WorkerStatus } | object = {};

    if (currentState) {
        // Transition idle -> downloading when requests start
        if (currentState.status === 'idle' && activeRequests > 0) {
            statusUpdate = { status: 'downloading' };
        }
        // Transition downloading -> idle when requests finish
        else if (
            currentState.status === 'downloading' &&
            activeRequests === 0
        ) {
            statusUpdate = { status: 'idle' };
        }
    }

    progress.updateWorker(workerId, {
        ...statusUpdate,
        activeRequests,
        duplicateRequests,
        currentAsset: urlObj
            ? { path: urlObj.pathname + urlObj.search, size: currentSize }
            : undefined,
    });
}

/**
 * Create an onProgress handler for captureWebsite()
 *
 * This factory function creates a standardized event handler that can be used
 * by both the main capture flow and the extract command.
 *
 * @param options - Configuration options for the handler
 * @returns A function that handles CaptureProgressEvents
 */
export function createCaptureProgressHandler(
    options: CaptureEventHandlerOptions,
): (event: CaptureProgressEvent) => void {
    const {
        progress,
        logApiCaptures = true,
        trackApiCaptures = true,
    } = options;

    // Track the current base URL - may be updated on redirect
    let currentBaseUrl = options.baseUrl;

    return (event: CaptureProgressEvent) => {
        switch (event.type) {
            case 'page-progress': {
                handlePageProgress(progress, event, currentBaseUrl);
                break;
            }

            case 'api-capture': {
                if (trackApiCaptures) {
                    const stats = progress.getStats();
                    progress.updateStats({
                        apisCaptured: stats.apisCaptured + 1,
                    });
                }
                if (logApiCaptures) {
                    progress.log(
                        `API: ${event.method} ${event.pattern} (${event.status})`,
                    );
                }
                break;
            }

            case 'asset-capture': {
                const stats = progress.getStats();
                progress.updateStats({
                    assetsCaptured: stats.assetsCaptured + 1,
                });
                // Don't log individual assets - too noisy
                break;
            }

            case 'request-activity': {
                handleRequestActivity(progress, event);
                break;
            }

            case 'duplicate-skipped': {
                const stats = progress.getStats();
                progress.updateStats({
                    duplicatesSkipped: (stats.duplicatesSkipped ?? 0) + 1,
                });
                // Don't log individual skips - too noisy
                break;
            }

            case 'lifecycle': {
                if (event.phase === 'redirect-detected' && event.finalUrl) {
                    // Update base URL for path truncation in logs
                    currentBaseUrl = event.finalUrl;
                    // Update ProgressDisplay's base origin for formatUrl()
                    progress.updateBaseOrigin(event.finalUrl);
                } else if (event.phase === 'flushing-assets') {
                    // Enter flush mode - the actual progress will come from flush-progress events
                    progress.setFlushing(1);
                } else if (event.phase === 'flushing-complete') {
                    progress.setFlushing(0);
                }
                break;
            }

            case 'flush-progress': {
                progress.setFlushProgress(
                    event.phase,
                    event.completed,
                    event.total,
                    event.failed,
                    event.completedItem,
                    event.totalTimeMs,
                    event.activeItems,
                );
                break;
            }
        }
    };
}

/**
 * Create an onVerbose handler for captureWebsite()
 *
 * @param progress - The progress display instance
 * @param verboseMode - If true, show all log levels; if false, only show warn/error
 * @returns A function that handles verbose log events
 */
export function createVerboseHandler(
    progress: ProgressDisplay,
    verboseMode: boolean = true,
): (event: {
    workerId?: number;
    source: string;
    message: string;
    level?: 'debug' | 'info' | 'warn' | 'error';
}) => void {
    return (event) => {
        const level = event.level ?? 'debug';

        // Always show warnings and errors; only show debug/info if verbose mode
        if (!verboseMode && level !== 'warn' && level !== 'error') {
            return;
        }

        // Build prefix with indicator inside brackets for warnings/errors
        let prefix: string;
        if (level === 'warn') {
            prefix =
                event.workerId !== undefined
                    ? `[${chalk.yellow('⚠')} Worker ${event.workerId}]`
                    : `[${chalk.yellow('⚠')} ${event.source}]`;
        } else if (level === 'error') {
            prefix =
                event.workerId !== undefined
                    ? `[${chalk.red('✗')} Worker ${event.workerId}]`
                    : `[${chalk.red('✗')} ${event.source}]`;
        } else {
            prefix =
                event.workerId !== undefined
                    ? `[Worker ${event.workerId}]`
                    : `[${event.source}]`;
        }

        progress.log(`${prefix} ${event.message}`);
    };
}
