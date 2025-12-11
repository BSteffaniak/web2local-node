/**
 * Tests for StateManager
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
    StateManager,
    IncompatibleStateVersionError,
    CorruptedStateError,
    UrlMismatchError,
    PHASES,
    PHASE_STATUS,
} from '../src/index.js';

describe('StateManager', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'state-test-'));
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    describe('create', () => {
        it('should create fresh state when directory is empty', async () => {
            const outputDir = join(tempDir, 'output');
            const state = await StateManager.create({
                outputDir,
                url: 'https://example.com',
            });

            expect(state.getPhaseStatus(PHASES.SCRAPE)).toBe(
                PHASE_STATUS.PENDING,
            );
            expect(state.getPhaseStatus(PHASES.CAPTURE)).toBe(
                PHASE_STATUS.PENDING,
            );
            expect(state.getUrl()).toBe('https://example.com');

            // Check files were created
            expect(existsSync(join(outputDir, 'state.json'))).toBe(true);

            await state.finalize();
        });

        it('should resume from existing state', async () => {
            const outputDir = join(tempDir, 'output');

            // Create initial state
            const state1 = await StateManager.create({
                outputDir,
                url: 'https://example.com',
            });

            await state1.startPhase(PHASES.SCRAPE);
            await state1.setScrapeResult({
                bundles: [
                    { url: 'https://example.com/app.js', type: 'script' },
                ],
                bundlesWithMaps: [],
                vendorBundles: [],
                bundlesWithoutMaps: [],
            });
            await state1.completePhase(PHASES.SCRAPE);
            await state1.finalize();

            // Resume
            const state2 = await StateManager.create({
                outputDir,
                url: 'https://example.com',
                resume: true,
            });

            expect(state2.getPhaseStatus(PHASES.SCRAPE)).toBe(
                PHASE_STATUS.COMPLETED,
            );
            expect(state2.getScrapeResult()).not.toBeNull();
            expect(state2.getScrapeResult()!.bundles).toHaveLength(1);

            await state2.finalize();
        });

        it('should throw on URL mismatch when resuming', async () => {
            const outputDir = join(tempDir, 'output');

            // Create initial state
            const state1 = await StateManager.create({
                outputDir,
                url: 'https://example.com',
            });
            await state1.finalize();

            // Try to resume with different URL
            await expect(
                StateManager.create({
                    outputDir,
                    url: 'https://other.com',
                    resume: true,
                }),
            ).rejects.toThrow(UrlMismatchError);
        });
    });

    describe('canResume', () => {
        it('should return null for empty directory', async () => {
            const result = await StateManager.canResume(tempDir);
            expect(result).toBeNull();
        });

        it('should return resume info for valid state', async () => {
            const outputDir = join(tempDir, 'output');

            const state = await StateManager.create({
                outputDir,
                url: 'https://example.com',
            });
            await state.startPhase(PHASES.SCRAPE);
            await state.finalize();

            const resumeInfo = await StateManager.canResume(outputDir);

            expect(resumeInfo).not.toBeNull();
            expect(resumeInfo!.url).toBe('https://example.com');
            expect(resumeInfo!.currentPhase).toBe(PHASES.SCRAPE);
            expect(resumeInfo!.phaseStatus).toBe(PHASE_STATUS.IN_PROGRESS);
        });

        it('should throw on version mismatch', async () => {
            const outputDir = join(tempDir, 'output');
            const statePath = join(outputDir, 'state.json');

            // Create state with wrong version
            const state = await StateManager.create({
                outputDir,
                url: 'https://example.com',
            });
            await state.finalize();

            // Modify version
            const content = JSON.parse(await readFile(statePath, 'utf-8'));
            content.version = '0.0.0';
            await writeFile(statePath, JSON.stringify(content));

            await expect(StateManager.canResume(outputDir)).rejects.toThrow(
                IncompatibleStateVersionError,
            );
        });

        it('should throw on corrupted WAL', async () => {
            const outputDir = join(tempDir, 'output');
            const walPath = join(outputDir, 'state.wal');

            const state = await StateManager.create({
                outputDir,
                url: 'https://example.com',
            });
            await state.startPhase(PHASES.SCRAPE);
            await state.finalize();

            // Corrupt the WAL
            await writeFile(walPath, 'invalid json line\n');

            await expect(StateManager.canResume(outputDir)).rejects.toThrow(
                CorruptedStateError,
            );
        });
    });

    describe('phase lifecycle', () => {
        it('should track phase transitions', async () => {
            const outputDir = join(tempDir, 'output');
            const state = await StateManager.create({
                outputDir,
                url: 'https://example.com',
            });

            expect(state.getPhaseStatus(PHASES.SCRAPE)).toBe(
                PHASE_STATUS.PENDING,
            );
            expect(state.getCurrentPhase()).toBe(PHASES.SCRAPE);

            await state.startPhase(PHASES.SCRAPE);
            expect(state.getPhaseStatus(PHASES.SCRAPE)).toBe(
                PHASE_STATUS.IN_PROGRESS,
            );

            await state.completePhase(PHASES.SCRAPE);
            expect(state.getPhaseStatus(PHASES.SCRAPE)).toBe(
                PHASE_STATUS.COMPLETED,
            );
            expect(state.getCurrentPhase()).toBe(PHASES.EXTRACT);

            await state.finalize();
        });

        it('should handle phase failure', async () => {
            const outputDir = join(tempDir, 'output');
            const state = await StateManager.create({
                outputDir,
                url: 'https://example.com',
            });

            await state.startPhase(PHASES.SCRAPE);
            await state.failPhase(PHASES.SCRAPE, 'Network error');

            expect(state.getPhaseStatus(PHASES.SCRAPE)).toBe(
                PHASE_STATUS.FAILED,
            );

            await state.finalize();
        });

        it('should allow retrying failed phase', async () => {
            const outputDir = join(tempDir, 'output');
            const state = await StateManager.create({
                outputDir,
                url: 'https://example.com',
            });

            await state.startPhase(PHASES.SCRAPE);
            await state.failPhase(PHASES.SCRAPE, 'Network error');

            // Should be able to start again
            await state.startPhase(PHASES.SCRAPE);
            expect(state.getPhaseStatus(PHASES.SCRAPE)).toBe(
                PHASE_STATUS.IN_PROGRESS,
            );

            await state.finalize();
        });
    });

    describe('extract phase', () => {
        it('should track extracted bundles', async () => {
            const outputDir = join(tempDir, 'output');
            const state = await StateManager.create({
                outputDir,
                url: 'https://example.com',
            });

            await state.startPhase(PHASES.EXTRACT);

            expect(state.isBundleExtracted('app.js')).toBe(false);

            await state.markBundleExtracted('app.js', 50);
            await state.markBundleExtracted('vendor.js', 30);

            expect(state.isBundleExtracted('app.js')).toBe(true);
            expect(state.isBundleExtracted('vendor.js')).toBe(true);
            expect(state.getTotalFilesExtracted()).toBe(80);

            const bundles = state.getExtractedBundles();
            expect(bundles).toHaveLength(2);

            await state.finalize();
        });
    });

    describe('capture phase', () => {
        it('should track page processing', async () => {
            const outputDir = join(tempDir, 'output');
            const state = await StateManager.create({
                outputDir,
                url: 'https://example.com',
            });

            await state.startPhase(PHASES.CAPTURE);

            // Start a page
            await state.markPageStarted('https://example.com/', 0);
            expect(state.isUrlVisited('https://example.com/')).toBe(true);
            expect(state.isUrlCompleted('https://example.com/')).toBe(false);
            expect(state.getInProgressUrls()).toHaveLength(1);

            // Complete the page
            await state.markPageCompleted({
                url: 'https://example.com/',
                depth: 0,
                fixtures: [
                    {
                        id: 'fix-1',
                        url: '/api/data',
                        method: 'GET',
                        status: 200,
                        localPath: 'fixtures/fix-1.json',
                    },
                ],
                assets: [
                    {
                        url: 'https://example.com/style.css',
                        localPath: 'static/style.css',
                        contentType: 'text/css',
                        size: 1000,
                    },
                ],
            });

            expect(state.isUrlCompleted('https://example.com/')).toBe(true);
            expect(state.getInProgressUrls()).toHaveLength(0);
            expect(state.getCapturedFixtures()).toHaveLength(1);
            expect(state.getCapturedAssets()).toHaveLength(1);

            await state.finalize();
        });

        it('should track pending URLs', async () => {
            const outputDir = join(tempDir, 'output');
            const state = await StateManager.create({
                outputDir,
                url: 'https://example.com',
            });

            await state.startPhase(PHASES.CAPTURE);

            await state.addDiscoveredUrls([
                { url: 'https://example.com/about', depth: 1 },
                { url: 'https://example.com/contact', depth: 1 },
            ]);

            const pending = state.getPendingUrls();
            expect(pending).toHaveLength(2);

            // Mark one as started - should remove from pending
            await state.markPageStarted('https://example.com/about', 1);
            expect(state.getPendingUrls()).toHaveLength(1);

            await state.finalize();
        });

        it('should handle page failures', async () => {
            const outputDir = join(tempDir, 'output');
            const state = await StateManager.create({
                outputDir,
                url: 'https://example.com',
            });

            await state.startPhase(PHASES.CAPTURE);

            await state.markPageStarted('https://example.com/', 0);
            await state.markPageFailed(
                'https://example.com/',
                0,
                'Timeout',
                false,
            );

            expect(state.getInProgressUrls()).toHaveLength(0);

            await state.finalize();
        });
    });

    describe('WAL compaction', () => {
        it('should compact WAL on finalize', async () => {
            const outputDir = join(tempDir, 'output');
            const state = await StateManager.create({
                outputDir,
                url: 'https://example.com',
            });

            // Generate some events
            await state.startPhase(PHASES.SCRAPE);
            await state.setScrapeResult({
                bundles: [],
                bundlesWithMaps: [],
                vendorBundles: [],
                bundlesWithoutMaps: [],
            });
            await state.completePhase(PHASES.SCRAPE);
            await state.finalize();

            // Read state.json - should have all the data
            const stateContent = JSON.parse(
                await readFile(join(outputDir, 'state.json'), 'utf-8'),
            );

            expect(stateContent.phases.scrape.status).toBe(
                PHASE_STATUS.COMPLETED,
            );
        });

        it('should resume correctly after compaction', async () => {
            const outputDir = join(tempDir, 'output');

            // Create and populate state
            const state1 = await StateManager.create({
                outputDir,
                url: 'https://example.com',
            });

            await state1.startPhase(PHASES.SCRAPE);
            await state1.completePhase(PHASES.SCRAPE);
            await state1.startPhase(PHASES.EXTRACT);
            await state1.markBundleExtracted('app.js', 100);
            await state1.finalize();

            // Resume
            const state2 = await StateManager.create({
                outputDir,
                url: 'https://example.com',
                resume: true,
            });

            expect(state2.getPhaseStatus(PHASES.SCRAPE)).toBe(
                PHASE_STATUS.COMPLETED,
            );
            expect(state2.getPhaseStatus(PHASES.EXTRACT)).toBe(
                PHASE_STATUS.IN_PROGRESS,
            );
            expect(state2.isBundleExtracted('app.js')).toBe(true);
            expect(state2.getTotalFilesExtracted()).toBe(100);

            await state2.finalize();
        });
    });

    describe('progress string', () => {
        it('should generate meaningful progress strings', async () => {
            const outputDir = join(tempDir, 'output');
            const state = await StateManager.create({
                outputDir,
                url: 'https://example.com',
            });

            expect(state.getProgressString()).toBe('Scraping bundles');

            await state.startPhase(PHASES.SCRAPE);
            await state.completePhase(PHASES.SCRAPE);

            expect(state.getProgressString()).toBe('Extracting sources');

            await state.finalize();
        });
    });
});
