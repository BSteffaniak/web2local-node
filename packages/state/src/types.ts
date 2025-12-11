/**
 * @web2local/state - Type definitions
 *
 * Defines the public API types for state management.
 */

// ============================================================================
// VERSION
// ============================================================================

/**
 * Current state file version.
 * Increment this when making breaking changes to the state format.
 */
export const STATE_VERSION = '1.0.0';

// ============================================================================
// PHASE TYPES
// ============================================================================

/**
 * Names of the main execution phases.
 */
export type PhaseName =
    | 'scrape'
    | 'extract'
    | 'dependencies'
    | 'capture'
    | 'rebuild';

/**
 * Status of a phase.
 */
export type PhaseStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

// ============================================================================
// PHASE CONSTANTS
// ============================================================================

/**
 * Phase name constants for type-safe phase references.
 */
export const PHASES = {
    SCRAPE: 'scrape',
    EXTRACT: 'extract',
    DEPENDENCIES: 'dependencies',
    CAPTURE: 'capture',
    REBUILD: 'rebuild',
} as const satisfies Record<string, PhaseName>;

/**
 * Phase status constants for type-safe status references.
 */
export const PHASE_STATUS = {
    PENDING: 'pending',
    IN_PROGRESS: 'in_progress',
    COMPLETED: 'completed',
    FAILED: 'failed',
} as const satisfies Record<string, PhaseStatus>;

// ============================================================================
// STATE MANAGER OPTIONS
// ============================================================================

/**
 * Options for creating a StateManager instance.
 */
export interface StateManagerOptions {
    /** Output directory where state files will be stored */
    outputDir: string;
    /** Target URL being processed */
    url: string;
    /** Whether to resume from existing state (if available) */
    resume?: boolean;
    /** If true, truncate corrupted WAL to last valid entry (use with caution) */
    truncateCorruptedWal?: boolean;
    /** Number of events before triggering compaction (default: 100) */
    compactionThreshold?: number;
}

/**
 * Information about resumable state in an output directory.
 */
export interface ResumeInfo {
    /** State file version */
    version: string;
    /** Original target URL */
    url: string;
    /** Current phase being processed */
    currentPhase: PhaseName | null;
    /** Status of the current phase */
    phaseStatus: PhaseStatus;
    /** Human-readable progress string (e.g., "15/100 pages captured") */
    progress: string;
    /** When the state was created */
    createdAt: string;
    /** When the state was last updated */
    lastUpdatedAt: string;
}

// ============================================================================
// BUNDLE INFO (from scraper)
// ============================================================================

/**
 * Information about a discovered bundle.
 * Matches the structure from @web2local/scraper.
 */
export interface BundleInfo {
    url: string;
    type: 'script' | 'stylesheet' | 'modulepreload';
    sourceMapUrl?: string;
}

/**
 * Information about a vendor bundle (no source map, but package info inferred).
 */
export interface VendorBundleInfo {
    url: string;
    filename: string;
    content?: string;
    inferredPackage?: string;
}

// ============================================================================
// CAPTURE TYPES
// ============================================================================

/**
 * Minimal fixture info for state tracking.
 * Contains only what's needed to identify and skip already-captured fixtures.
 */
export interface CapturedFixtureInfo {
    /** Unique fixture ID */
    id: string;
    /** Request URL */
    url: string;
    /** HTTP method */
    method: string;
    /** Response status code */
    status: number;
    /** Local file path where fixture is stored */
    localPath: string;
}

/**
 * Minimal asset info for state tracking.
 * Contains only what's needed to identify and skip already-captured assets.
 */
export interface CapturedAssetInfo {
    /** Asset URL */
    url: string;
    /** Local file path where asset is stored */
    localPath: string;
    /** Content type */
    contentType: string;
    /** File size in bytes */
    size: number;
}

/**
 * Result of processing a single page during capture.
 */
export interface PageCaptureResult {
    /** Page URL */
    url: string;
    /** Crawl depth */
    depth: number;
    /** Fixtures captured from this page */
    fixtures: CapturedFixtureInfo[];
    /** Assets captured from this page */
    assets: CapturedAssetInfo[];
    /** URLs discovered on this page */
    discoveredUrls?: Array<{ url: string; depth: number }>;
}

// ============================================================================
// PHASE DATA TYPES
// ============================================================================

/**
 * Data stored after scrape phase completion.
 */
export interface ScrapePhaseData {
    bundles: BundleInfo[];
    bundlesWithMaps: BundleInfo[];
    vendorBundles: VendorBundleInfo[];
    bundlesWithoutMaps: BundleInfo[];
    finalUrl?: string;
}

/**
 * Data stored after extract phase completion.
 */
export interface ExtractPhaseData {
    extractedBundles: Array<{
        bundleName: string;
        filesWritten: number;
    }>;
    totalFilesWritten: number;
}

/**
 * Data stored for capture phase (updated incrementally).
 */
export interface CapturePhaseData {
    /** All URLs that have been visited (started processing) */
    visitedUrls: string[];
    /** URLs that completed successfully */
    completedUrls: string[];
    /** URLs waiting to be processed */
    pendingUrls: Array<{ url: string; depth: number }>;
    /** URLs that were started but not completed (need reprocessing on resume) */
    inProgressUrls: Array<{ url: string; depth: number }>;
    /** All captured fixtures */
    fixtures: CapturedFixtureInfo[];
    /** All captured assets */
    assets: CapturedAssetInfo[];
}

/**
 * Data stored after rebuild phase completion.
 */
export interface RebuildPhaseData {
    success: boolean;
    outputDir?: string;
    bundles?: string[];
    durationMs?: number;
    errors?: string[];
}

// ============================================================================
// STATE FILE STRUCTURE
// ============================================================================

/**
 * State for a single phase.
 */
export interface PhaseState {
    status: PhaseStatus;
    startedAt?: string;
    completedAt?: string;
    error?: string;
}

/**
 * Complete state file structure.
 * This is the format of state.json after compaction.
 */
export interface StateFile {
    /** State format version */
    version: string;
    /** Target URL */
    url: string;
    /** When state was created */
    createdAt: string;
    /** When state was last updated */
    lastUpdatedAt: string;
    /** Last applied sequence number from WAL */
    lastSeq: number;

    /** Status of each phase */
    phases: Record<PhaseName, PhaseState>;

    /** Phase-specific data */
    scrape?: ScrapePhaseData;
    extract?: ExtractPhaseData;
    capture?: CapturePhaseData;
    rebuild?: RebuildPhaseData;
}

// ============================================================================
// WAL EVENT TYPES
// ============================================================================

/**
 * Base structure for all WAL events.
 */
export interface BaseWALEvent {
    /** Event type discriminator */
    type: string;
    /** ISO 8601 timestamp */
    timestamp: string;
    /** Monotonic sequence number */
    seq: number;
}

/**
 * Phase started event.
 */
export interface PhaseStartEvent extends BaseWALEvent {
    type: 'phase:start';
    phase: PhaseName;
}

/**
 * Phase completed event.
 */
export interface PhaseCompleteEvent extends BaseWALEvent {
    type: 'phase:complete';
    phase: PhaseName;
}

/**
 * Phase failed event.
 */
export interface PhaseFailEvent extends BaseWALEvent {
    type: 'phase:fail';
    phase: PhaseName;
    error: string;
}

/**
 * Scrape results event.
 */
export interface ScrapeResultEvent extends BaseWALEvent {
    type: 'scrape:result';
    bundles: BundleInfo[];
    bundlesWithMaps: BundleInfo[];
    vendorBundles: VendorBundleInfo[];
    bundlesWithoutMaps: BundleInfo[];
    finalUrl?: string;
}

/**
 * Bundle extracted event.
 */
export interface BundleExtractedEvent extends BaseWALEvent {
    type: 'extract:bundle';
    bundleName: string;
    filesWritten: number;
}

/**
 * Page started event (for crash recovery).
 */
export interface PageStartedEvent extends BaseWALEvent {
    type: 'capture:page:started';
    url: string;
    depth: number;
}

/**
 * Page completed event (batched with all fixtures/assets).
 */
export interface PageCompletedEvent extends BaseWALEvent {
    type: 'capture:page:completed';
    url: string;
    depth: number;
    fixtures: CapturedFixtureInfo[];
    assets: CapturedAssetInfo[];
}

/**
 * Page failed event.
 */
export interface PageFailedEvent extends BaseWALEvent {
    type: 'capture:page:failed';
    url: string;
    depth: number;
    error: string;
    willRetry: boolean;
}

/**
 * URLs discovered event.
 */
export interface UrlsDiscoveredEvent extends BaseWALEvent {
    type: 'capture:urls:discovered';
    urls: Array<{ url: string; depth: number }>;
}

/**
 * Rebuild result event.
 */
export interface RebuildResultEvent extends BaseWALEvent {
    type: 'rebuild:result';
    success: boolean;
    outputDir?: string;
    bundles?: string[];
    durationMs?: number;
    errors?: string[];
}

/**
 * WAL compaction event (written after compaction).
 */
export interface CompactionEvent extends BaseWALEvent {
    type: 'wal:compacted';
    eventsCompacted: number;
}

/**
 * Union of all WAL event types.
 */
export type WALEvent =
    | PhaseStartEvent
    | PhaseCompleteEvent
    | PhaseFailEvent
    | ScrapeResultEvent
    | BundleExtractedEvent
    | PageStartedEvent
    | PageCompletedEvent
    | PageFailedEvent
    | UrlsDiscoveredEvent
    | RebuildResultEvent
    | CompactionEvent;

/**
 * WAL event type discriminators for type guards.
 */
export type WALEventType = WALEvent['type'];
