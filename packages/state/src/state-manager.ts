/**
 * @web2local/state - StateManager
 *
 * Main API for state management with write-ahead logging.
 * Provides crash-safe persistence and resume functionality.
 */

import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type {
    StateManagerOptions,
    ResumeInfo,
    PhaseName,
    PhaseStatus,
    StateFile,
    BundleInfo,
    VendorBundleInfo,
    CapturedFixtureInfo,
    CapturedAssetInfo,
    PageCaptureResult,
    ScrapePhaseData,
    ExtractPhaseData,
    CapturePhaseData,
    RebuildPhaseData,
} from './types.js';
import { STATE_VERSION, PHASES, PHASE_STATUS } from './types.js';
import {
    IncompatibleStateVersionError,
    CorruptedStateError,
    InvalidStateTransitionError,
    UrlMismatchError,
} from './errors.js';
import {
    WALWriter,
    readWAL,
    applyEvents,
    compact,
    loadCurrentState,
    getProgressString,
    createPhaseStartEvent,
    createPhaseCompleteEvent,
    createPhaseFailEvent,
    createScrapeResultEvent,
    createBundleExtractedEvent,
    createPageStartedEvent,
    createPageCompletedEvent,
    createPageFailedEvent,
    createUrlsDiscoveredEvent,
    createRebuildResultEvent,
} from './wal/index.js';

/** Default number of events before triggering compaction */
const DEFAULT_COMPACTION_THRESHOLD = 100;

/** State file name */
const STATE_FILE = 'state.json';

/** WAL file name */
const WAL_FILE = 'state.wal';

/**
 * Create an initial empty state file.
 */
function createInitialState(url: string): StateFile {
    const now = new Date().toISOString();
    return {
        version: STATE_VERSION,
        url,
        createdAt: now,
        lastUpdatedAt: now,
        lastSeq: 0,
        phases: {
            [PHASES.SCRAPE]: { status: PHASE_STATUS.PENDING },
            [PHASES.EXTRACT]: { status: PHASE_STATUS.PENDING },
            [PHASES.DEPENDENCIES]: { status: PHASE_STATUS.PENDING },
            [PHASES.CAPTURE]: { status: PHASE_STATUS.PENDING },
            [PHASES.REBUILD]: { status: PHASE_STATUS.PENDING },
        },
    };
}

/**
 * StateManager provides crash-safe state persistence for web2local operations.
 *
 * Uses a write-ahead log (WAL) pattern for durability:
 * - Events are appended to the WAL immediately
 * - WAL is periodically compacted into the main state file
 * - On resume, state is reconstructed by replaying WAL events
 */
export class StateManager {
    private state: StateFile;
    private walWriter: WALWriter;
    private statePath: string;
    private walPath: string;
    private constructor(
        state: StateFile,
        walWriter: WALWriter,
        statePath: string,
        walPath: string,
    ) {
        this.state = state;
        this.walWriter = walWriter;
        this.statePath = statePath;
        this.walPath = walPath;
    }

    // =========================================================================
    // STATIC FACTORY METHODS
    // =========================================================================

    /**
     * Check if an output directory has resumable state.
     *
     * @param outputDir - Directory to check
     * @returns Resume info if state exists and is compatible, null otherwise
     * @throws CorruptedStateError if WAL is corrupted
     * @throws IncompatibleStateVersionError if version doesn't match
     */
    static async canResume(outputDir: string): Promise<ResumeInfo | null> {
        const statePath = join(outputDir, STATE_FILE);
        const walPath = join(outputDir, WAL_FILE);

        // Check if state file exists
        if (!existsSync(statePath)) {
            return null;
        }

        // Read and validate state file
        let baseState: StateFile;
        try {
            const content = await readFile(statePath, 'utf-8');
            baseState = JSON.parse(content);
        } catch (error) {
            throw new CorruptedStateError(
                statePath,
                undefined,
                `Failed to parse state file: ${(error as Error).message}`,
            );
        }

        // Check version compatibility
        if (baseState.version !== STATE_VERSION) {
            throw new IncompatibleStateVersionError(
                baseState.version,
                STATE_VERSION,
            );
        }

        // Check WAL for corruption
        const walResult = await readWAL(walPath);
        if (walResult.corrupted) {
            throw new CorruptedStateError(
                walPath,
                walResult.corruptedAtLine,
                `WAL corrupted at line ${walResult.corruptedAtLine}: ${walResult.corruptedContent}`,
            );
        }

        // Apply WAL events to get current state
        const currentState = applyEvents(baseState, walResult.events);

        // Find current phase
        const phaseOrder: PhaseName[] = [
            PHASES.SCRAPE,
            PHASES.EXTRACT,
            PHASES.DEPENDENCIES,
            PHASES.CAPTURE,
            PHASES.REBUILD,
        ];
        let currentPhase: PhaseName | null = null;
        let phaseStatus: PhaseStatus = PHASE_STATUS.PENDING;

        for (const phase of phaseOrder) {
            const status = currentState.phases[phase].status;
            if (status !== PHASE_STATUS.COMPLETED) {
                currentPhase = phase;
                phaseStatus = status;
                break;
            }
        }

        return {
            version: currentState.version,
            url: currentState.url,
            currentPhase,
            phaseStatus,
            progress: getProgressString(currentState),
            createdAt: currentState.createdAt,
            lastUpdatedAt: currentState.lastUpdatedAt,
        };
    }

    /**
     * Create a new StateManager instance.
     *
     * @param options - Configuration options
     * @returns Initialized StateManager
     * @throws {IncompatibleStateVersionError} When resuming from an incompatible state version
     * @throws {UrlMismatchError} When resuming with a different URL than the original
     * @throws {CorruptedStateError} When WAL is corrupted and truncateCorruptedWal is false
     */
    static async create(options: StateManagerOptions): Promise<StateManager> {
        const {
            outputDir,
            url,
            resume = false,
            truncateCorruptedWal = false,
            compactionThreshold = DEFAULT_COMPACTION_THRESHOLD,
        } = options;

        const statePath = join(outputDir, STATE_FILE);
        const walPath = join(outputDir, WAL_FILE);

        // Ensure output directory exists
        await mkdir(outputDir, { recursive: true });

        let state: StateFile;
        let startSeq = 0;

        if (resume && existsSync(statePath)) {
            // Resume from existing state
            const { state: loadedState, walResult } = await loadCurrentState(
                statePath,
                walPath,
            );

            // Check version
            if (loadedState.version !== STATE_VERSION) {
                throw new IncompatibleStateVersionError(
                    loadedState.version,
                    STATE_VERSION,
                );
            }

            // Check URL matches
            if (loadedState.url !== url) {
                throw new UrlMismatchError(loadedState.url, url);
            }

            // Handle corrupted WAL
            if (walResult.corrupted) {
                if (truncateCorruptedWal) {
                    // Truncate to last valid entry by compacting now
                    // The loadedState already has events up to corruption applied
                    state = loadedState;
                    startSeq = walResult.lastValidSeq;
                    // We'll write the clean state and start fresh WAL below
                } else {
                    throw new CorruptedStateError(
                        walPath,
                        walResult.corruptedAtLine,
                        `WAL corrupted. Use truncateCorruptedWal option to recover.`,
                    );
                }
            } else {
                state = loadedState;
                startSeq = walResult.lastValidSeq || loadedState.lastSeq;
            }
        } else {
            // Fresh start
            state = createInitialState(url);

            // Write initial state file
            await writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8');
        }

        // Create WAL writer
        const walWriter = new WALWriter(walPath, {
            compactionThreshold,
            onCompactionNeeded: async () => {
                // This will be called by the writer when threshold is reached
                // We'll set up the actual compaction after construction
            },
        });

        const manager = new StateManager(state, walWriter, statePath, walPath);

        // Set up compaction callback
        walWriter.setCompactionCallback(async () => {
            await manager.compact();
        });

        // Open WAL for writing
        await walWriter.open(startSeq);

        return manager;
    }

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Finalize state management.
     * Performs final compaction and closes files.
     */
    async finalize(): Promise<void> {
        // Final compaction to ensure state.json is up to date
        await this.compact();

        // Close WAL
        await this.walWriter.close();
    }

    /**
     * Manually trigger compaction.
     */
    async compact(): Promise<void> {
        if (!this.walWriter.isOpen()) {
            return;
        }

        try {
            await compact(this.statePath, this.walPath, this.walWriter);

            // Reload state after compaction
            const content = await readFile(this.statePath, 'utf-8');
            this.state = JSON.parse(content);
        } catch (error) {
            // Log but don't throw - compaction failures shouldn't break operations
            console.error('Compaction failed:', error);
        }
    }

    // =========================================================================
    // PHASE LIFECYCLE
    // =========================================================================

    /**
     * Get the status of a phase.
     *
     * @param phase - The phase to check
     * @returns Current status of the phase
     */
    getPhaseStatus(phase: PhaseName): PhaseStatus {
        return this.state.phases[phase].status;
    }

    /**
     * Get the currently active phase (first non-completed phase).
     *
     * @returns The first phase that is not completed, or null if all phases are done
     */
    getCurrentPhase(): PhaseName | null {
        const phaseOrder: PhaseName[] = [
            PHASES.SCRAPE,
            PHASES.EXTRACT,
            PHASES.DEPENDENCIES,
            PHASES.CAPTURE,
            PHASES.REBUILD,
        ];

        for (const phase of phaseOrder) {
            if (this.state.phases[phase].status !== PHASE_STATUS.COMPLETED) {
                return phase;
            }
        }

        return null;
    }

    /**
     * Mark a phase as started.
     *
     * @param phase - The phase to start
     * @throws {InvalidStateTransitionError} When phase is not in 'pending' or 'failed' status
     */
    async startPhase(phase: PhaseName): Promise<void> {
        const currentStatus = this.state.phases[phase].status;

        // Allow starting from pending or failed (retry)
        if (
            currentStatus !== PHASE_STATUS.PENDING &&
            currentStatus !== PHASE_STATUS.FAILED
        ) {
            throw new InvalidStateTransitionError(
                phase,
                currentStatus,
                'start',
            );
        }

        await this.walWriter.append(createPhaseStartEvent(phase));

        // Update in-memory state
        this.state.phases[phase] = {
            ...this.state.phases[phase],
            status: PHASE_STATUS.IN_PROGRESS,
            startedAt: new Date().toISOString(),
        };
    }

    /**
     * Mark a phase as completed.
     *
     * @param phase - The phase to complete
     * @throws {InvalidStateTransitionError} When phase is not in 'in_progress' status
     */
    async completePhase(phase: PhaseName): Promise<void> {
        const currentStatus = this.state.phases[phase].status;

        if (currentStatus !== PHASE_STATUS.IN_PROGRESS) {
            throw new InvalidStateTransitionError(
                phase,
                currentStatus,
                'complete',
            );
        }

        await this.walWriter.append(createPhaseCompleteEvent(phase));

        // Update in-memory state
        this.state.phases[phase] = {
            ...this.state.phases[phase],
            status: PHASE_STATUS.COMPLETED,
            completedAt: new Date().toISOString(),
        };
    }

    /**
     * Mark a phase as failed.
     *
     * @param phase - The phase that failed
     * @param error - Error message describing the failure
     */
    async failPhase(phase: PhaseName, error: string): Promise<void> {
        await this.walWriter.append(createPhaseFailEvent(phase, error));

        // Update in-memory state
        this.state.phases[phase] = {
            ...this.state.phases[phase],
            status: PHASE_STATUS.FAILED,
            error,
        };
    }

    // =========================================================================
    // SCRAPE PHASE
    // =========================================================================

    /**
     * Store scrape results.
     *
     * @param result - The scrape phase results to store
     */
    async setScrapeResult(result: {
        bundles: BundleInfo[];
        bundlesWithMaps: BundleInfo[];
        vendorBundles: VendorBundleInfo[];
        bundlesWithoutMaps: BundleInfo[];
        finalUrl?: string;
    }): Promise<void> {
        await this.walWriter.append(createScrapeResultEvent(result));

        // Update in-memory state
        this.state.scrape = {
            bundles: result.bundles,
            bundlesWithMaps: result.bundlesWithMaps,
            vendorBundles: result.vendorBundles,
            bundlesWithoutMaps: result.bundlesWithoutMaps,
            finalUrl: result.finalUrl,
        };
    }

    /**
     * Get scrape results.
     *
     * @returns Stored scrape phase data, or null if not yet set
     */
    getScrapeResult(): ScrapePhaseData | null {
        return this.state.scrape || null;
    }

    // =========================================================================
    // EXTRACT PHASE
    // =========================================================================

    /**
     * Mark a bundle as extracted.
     *
     * @param bundleName - Name of the extracted bundle
     * @param filesWritten - Number of source files written from this bundle
     */
    async markBundleExtracted(
        bundleName: string,
        filesWritten: number,
    ): Promise<void> {
        await this.walWriter.append(
            createBundleExtractedEvent(bundleName, filesWritten),
        );

        // Update in-memory state
        if (!this.state.extract) {
            this.state.extract = {
                extractedBundles: [],
                totalFilesWritten: 0,
            };
        }

        if (
            !this.state.extract.extractedBundles.some(
                (b) => b.bundleName === bundleName,
            )
        ) {
            this.state.extract.extractedBundles.push({
                bundleName,
                filesWritten,
            });
            this.state.extract.totalFilesWritten += filesWritten;
        }
    }

    /**
     * Check if a bundle has been extracted.
     *
     * @param bundleName - Name of the bundle to check
     * @returns True if the bundle has already been extracted
     */
    isBundleExtracted(bundleName: string): boolean {
        return (
            this.state.extract?.extractedBundles.some(
                (b) => b.bundleName === bundleName,
            ) ?? false
        );
    }

    /**
     * Get list of extracted bundles.
     *
     * @returns Array of extracted bundle info with file counts
     */
    getExtractedBundles(): Array<{ bundleName: string; filesWritten: number }> {
        return this.state.extract?.extractedBundles ?? [];
    }

    /**
     * Get total files extracted.
     *
     * @returns Total number of source files extracted across all bundles
     */
    getTotalFilesExtracted(): number {
        return this.state.extract?.totalFilesWritten ?? 0;
    }

    /**
     * Get extract phase data.
     *
     * @returns Stored extract phase data, or null if not yet set
     */
    getExtractResult(): ExtractPhaseData | null {
        return this.state.extract || null;
    }

    // =========================================================================
    // CAPTURE PHASE
    // =========================================================================

    /**
     * Initialize capture state if needed.
     */
    private ensureCaptureState(): void {
        if (!this.state.capture) {
            this.state.capture = {
                visitedUrls: [],
                completedUrls: [],
                pendingUrls: [],
                inProgressUrls: [],
                fixtures: [],
                assets: [],
            };
        }
    }

    /**
     * Mark a page as started (for crash recovery).
     *
     * @param url - URL of the page being processed
     * @param depth - Crawl depth of the page
     */
    async markPageStarted(url: string, depth: number): Promise<void> {
        await this.walWriter.append(createPageStartedEvent(url, depth));

        // Update in-memory state
        this.ensureCaptureState();
        if (!this.state.capture!.visitedUrls.includes(url)) {
            this.state.capture!.visitedUrls.push(url);
        }
        if (!this.state.capture!.inProgressUrls.some((u) => u.url === url)) {
            this.state.capture!.inProgressUrls.push({ url, depth });
        }
        this.state.capture!.pendingUrls =
            this.state.capture!.pendingUrls.filter((u) => u.url !== url);
    }

    /**
     * Mark a page as completed with all its captured data.
     *
     * @param result - Capture result containing fixtures, assets, and discovered URLs
     */
    async markPageCompleted(result: PageCaptureResult): Promise<void> {
        await this.walWriter.append(
            createPageCompletedEvent(
                result.url,
                result.depth,
                result.fixtures,
                result.assets,
            ),
        );

        // Update in-memory state
        this.ensureCaptureState();

        if (!this.state.capture!.completedUrls.includes(result.url)) {
            this.state.capture!.completedUrls.push(result.url);
        }

        this.state.capture!.inProgressUrls =
            this.state.capture!.inProgressUrls.filter(
                (u) => u.url !== result.url,
            );

        for (const fixture of result.fixtures) {
            if (
                !this.state.capture!.fixtures.some((f) => f.id === fixture.id)
            ) {
                this.state.capture!.fixtures.push(fixture);
            }
        }

        for (const asset of result.assets) {
            if (!this.state.capture!.assets.some((a) => a.url === asset.url)) {
                this.state.capture!.assets.push(asset);
            }
        }

        // Handle discovered URLs if provided
        if (result.discoveredUrls && result.discoveredUrls.length > 0) {
            await this.addDiscoveredUrls(result.discoveredUrls);
        }
    }

    /**
     * Mark a page as failed.
     *
     * @param url - URL of the failed page
     * @param depth - Crawl depth of the page
     * @param error - Error message describing the failure
     * @param willRetry - Whether the page will be retried
     */
    async markPageFailed(
        url: string,
        depth: number,
        error: string,
        willRetry: boolean,
    ): Promise<void> {
        await this.walWriter.append(
            createPageFailedEvent(url, depth, error, willRetry),
        );

        // Update in-memory state
        this.ensureCaptureState();
        this.state.capture!.inProgressUrls =
            this.state.capture!.inProgressUrls.filter((u) => u.url !== url);
    }

    /**
     * Add newly discovered URLs to the pending queue.
     *
     * URLs that have already been visited or are already pending are filtered out.
     *
     * @param urls - Array of URL/depth pairs to add
     */
    async addDiscoveredUrls(
        urls: Array<{ url: string; depth: number }>,
    ): Promise<void> {
        // Filter out already visited or pending URLs
        this.ensureCaptureState();
        const newUrls = urls.filter(
            (item) =>
                !this.state.capture!.visitedUrls.includes(item.url) &&
                !this.state.capture!.pendingUrls.some(
                    (p) => p.url === item.url,
                ),
        );

        if (newUrls.length === 0) {
            return;
        }

        await this.walWriter.append(createUrlsDiscoveredEvent(newUrls));

        // Update in-memory state
        this.state.capture!.pendingUrls.push(...newUrls);
    }

    /**
     * Check if a URL has been visited (started processing).
     *
     * @param url - URL to check
     * @returns True if the URL has been visited
     */
    isUrlVisited(url: string): boolean {
        return this.state.capture?.visitedUrls.includes(url) ?? false;
    }

    /**
     * Check if a URL has been completed successfully.
     *
     * @param url - URL to check
     * @returns True if the URL has been fully processed
     */
    isUrlCompleted(url: string): boolean {
        return this.state.capture?.completedUrls.includes(url) ?? false;
    }

    /**
     * Get all visited URLs.
     *
     * @returns Array of URLs that have been started
     */
    getVisitedUrls(): string[] {
        return this.state.capture?.visitedUrls ?? [];
    }

    /**
     * Get all completed URLs.
     *
     * @returns Array of URLs that have been fully processed
     */
    getCompletedUrls(): string[] {
        return this.state.capture?.completedUrls ?? [];
    }

    /**
     * Get URLs that were started but not completed (need reprocessing on resume).
     *
     * @returns Array of URL/depth pairs that need reprocessing
     */
    getInProgressUrls(): Array<{ url: string; depth: number }> {
        return this.state.capture?.inProgressUrls ?? [];
    }

    /**
     * Get pending URLs.
     *
     * @returns Array of URL/depth pairs waiting to be processed
     */
    getPendingUrls(): Array<{ url: string; depth: number }> {
        return this.state.capture?.pendingUrls ?? [];
    }

    /**
     * Get all captured fixtures.
     *
     * @returns Array of captured fixture info
     */
    getCapturedFixtures(): CapturedFixtureInfo[] {
        return this.state.capture?.fixtures ?? [];
    }

    /**
     * Get all captured assets.
     *
     * @returns Array of captured asset info
     */
    getCapturedAssets(): CapturedAssetInfo[] {
        return this.state.capture?.assets ?? [];
    }

    /**
     * Get capture phase data.
     *
     * @returns Stored capture phase data, or null if not yet set
     */
    getCaptureResult(): CapturePhaseData | null {
        return this.state.capture || null;
    }

    // =========================================================================
    // REBUILD PHASE
    // =========================================================================

    /**
     * Store rebuild results.
     *
     * @param result - The rebuild phase results to store
     */
    async setRebuildResult(result: {
        success: boolean;
        outputDir?: string;
        bundles?: string[];
        durationMs?: number;
        errors?: string[];
    }): Promise<void> {
        await this.walWriter.append(createRebuildResultEvent(result));

        // Update in-memory state
        this.state.rebuild = {
            success: result.success,
            outputDir: result.outputDir,
            bundles: result.bundles,
            durationMs: result.durationMs,
            errors: result.errors,
        };
    }

    /**
     * Get rebuild results.
     *
     * @returns Stored rebuild phase data, or null if not yet set
     */
    getRebuildResult(): RebuildPhaseData | null {
        return this.state.rebuild || null;
    }

    // =========================================================================
    // UTILITY
    // =========================================================================

    /**
     * Get a human-readable progress string.
     *
     * @returns Progress description (e.g., "15/100 pages captured")
     */
    getProgressString(): string {
        return getProgressString(this.state);
    }

    /**
     * Get the target URL.
     *
     * @returns The URL being processed
     */
    getUrl(): string {
        return this.state.url;
    }

    /**
     * Get when the state was created.
     *
     * @returns ISO 8601 timestamp of state creation
     */
    getCreatedAt(): string {
        return this.state.createdAt;
    }

    /**
     * Get when the state was last updated.
     *
     * @returns ISO 8601 timestamp of last update
     */
    getLastUpdatedAt(): string {
        return this.state.lastUpdatedAt;
    }
}
