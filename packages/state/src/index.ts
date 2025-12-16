/**
 * `@web2local/state`
 *
 * State management with write-ahead logging for web2local resume functionality.
 */

// Main API
export { StateManager } from './state-manager.js';

// Errors
export {
    IncompatibleStateVersionError,
    CorruptedStateError,
    StateIOError,
    InvalidStateTransitionError,
    UrlMismatchError,
} from './errors.js';

// Types
export type {
    // Core types
    StateManagerOptions,
    ResumeInfo,
    PhaseName,
    PhaseStatus,

    // Bundle types
    BundleInfo,
    VendorBundleInfo,

    // Capture types
    CapturedFixtureInfo,
    CapturedAssetInfo,
    PageCaptureResult,

    // Phase data types
    ScrapePhaseData,
    ExtractPhaseData,
    CapturePhaseData,
    RebuildPhaseData,
} from './types.js';

// Constants
export { STATE_VERSION, PHASES, PHASE_STATUS } from './types.js';
