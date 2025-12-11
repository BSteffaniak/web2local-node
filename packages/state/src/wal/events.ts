/**
 * @web2local/state - WAL Event utilities
 *
 * Helper functions for creating and validating WAL events.
 */

import type {
    WALEvent,
    WALEventType,
    PhaseName,
    BundleInfo,
    VendorBundleInfo,
    CapturedFixtureInfo,
    CapturedAssetInfo,
} from '../types.js';

/**
 * Valid event types for runtime validation.
 */
export const VALID_EVENT_TYPES: Set<WALEventType> = new Set([
    'phase:start',
    'phase:complete',
    'phase:fail',
    'scrape:result',
    'extract:bundle',
    'capture:page:started',
    'capture:page:completed',
    'capture:page:failed',
    'capture:urls:discovered',
    'rebuild:result',
    'wal:compacted',
]);

/**
 * Check if a value is a valid WAL event type.
 */
export function isValidEventType(type: unknown): type is WALEventType {
    return (
        typeof type === 'string' && VALID_EVENT_TYPES.has(type as WALEventType)
    );
}

/**
 * Validate that an object is a valid WAL event.
 * Returns the event if valid, throws if invalid.
 */
export function validateEvent(obj: unknown): WALEvent {
    if (typeof obj !== 'object' || obj === null) {
        throw new Error('Event must be an object');
    }

    const event = obj as Record<string, unknown>;

    if (!isValidEventType(event.type)) {
        throw new Error(`Invalid event type: ${event.type}`);
    }

    if (typeof event.timestamp !== 'string') {
        throw new Error('Event must have a timestamp string');
    }

    if (typeof event.seq !== 'number' || !Number.isInteger(event.seq)) {
        throw new Error('Event must have an integer seq number');
    }

    return event as unknown as WALEvent;
}

// ============================================================================
// EVENT FACTORIES
// ============================================================================

type EventWithoutMeta<T extends WALEvent> = Omit<T, 'timestamp' | 'seq'>;

/**
 * Create a phase start event payload (without timestamp/seq).
 */
export function createPhaseStartEvent(
    phase: PhaseName,
): EventWithoutMeta<WALEvent & { type: 'phase:start' }> {
    return { type: 'phase:start', phase };
}

/**
 * Create a phase complete event payload.
 */
export function createPhaseCompleteEvent(
    phase: PhaseName,
): EventWithoutMeta<WALEvent & { type: 'phase:complete' }> {
    return { type: 'phase:complete', phase };
}

/**
 * Create a phase fail event payload.
 */
export function createPhaseFailEvent(
    phase: PhaseName,
    error: string,
): EventWithoutMeta<WALEvent & { type: 'phase:fail' }> {
    return { type: 'phase:fail', phase, error };
}

/**
 * Create a scrape result event payload.
 */
export function createScrapeResultEvent(data: {
    bundles: BundleInfo[];
    bundlesWithMaps: BundleInfo[];
    vendorBundles: VendorBundleInfo[];
    bundlesWithoutMaps: BundleInfo[];
    finalUrl?: string;
}): EventWithoutMeta<WALEvent & { type: 'scrape:result' }> {
    return { type: 'scrape:result', ...data };
}

/**
 * Create a bundle extracted event payload.
 */
export function createBundleExtractedEvent(
    bundleName: string,
    filesWritten: number,
): EventWithoutMeta<WALEvent & { type: 'extract:bundle' }> {
    return { type: 'extract:bundle', bundleName, filesWritten };
}

/**
 * Create a page started event payload.
 */
export function createPageStartedEvent(
    url: string,
    depth: number,
): EventWithoutMeta<WALEvent & { type: 'capture:page:started' }> {
    return { type: 'capture:page:started', url, depth };
}

/**
 * Create a page completed event payload.
 */
export function createPageCompletedEvent(
    url: string,
    depth: number,
    fixtures: CapturedFixtureInfo[],
    assets: CapturedAssetInfo[],
): EventWithoutMeta<WALEvent & { type: 'capture:page:completed' }> {
    return { type: 'capture:page:completed', url, depth, fixtures, assets };
}

/**
 * Create a page failed event payload.
 */
export function createPageFailedEvent(
    url: string,
    depth: number,
    error: string,
    willRetry: boolean,
): EventWithoutMeta<WALEvent & { type: 'capture:page:failed' }> {
    return { type: 'capture:page:failed', url, depth, error, willRetry };
}

/**
 * Create a URLs discovered event payload.
 */
export function createUrlsDiscoveredEvent(
    urls: Array<{ url: string; depth: number }>,
): EventWithoutMeta<WALEvent & { type: 'capture:urls:discovered' }> {
    return { type: 'capture:urls:discovered', urls };
}

/**
 * Create a rebuild result event payload.
 */
export function createRebuildResultEvent(data: {
    success: boolean;
    outputDir?: string;
    bundles?: string[];
    durationMs?: number;
    errors?: string[];
}): EventWithoutMeta<WALEvent & { type: 'rebuild:result' }> {
    return { type: 'rebuild:result', ...data };
}

/**
 * Create a compaction event payload.
 */
export function createCompactionEvent(
    eventsCompacted: number,
): EventWithoutMeta<WALEvent & { type: 'wal:compacted' }> {
    return { type: 'wal:compacted', eventsCompacted };
}
