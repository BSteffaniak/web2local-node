# @web2local/state

State management with write-ahead logging (WAL) for web2local resume functionality.

## Overview

This package provides crash-safe state persistence for long-running web2local operations. It uses a write-ahead log (WAL) pattern to ensure durability while maintaining high write performance.

## Features

- **Write-Ahead Logging**: Append-only log for fast, crash-safe writes
- **Automatic Compaction**: Periodically compacts WAL into main state file
- **Resume Support**: Detect and resume from interrupted operations
- **Phase Tracking**: Track progress through scrape, extract, dependencies, capture, and rebuild phases
- **Corruption Detection**: Detects and reports WAL corruption with recovery options

## Usage

```typescript
import { StateManager } from '@web2local/state';

// Check if we can resume from an existing checkpoint
const resumeInfo = await StateManager.canResume('./output/example.com');
if (resumeInfo) {
    console.log(`Can resume from ${resumeInfo.currentPhase}: ${resumeInfo.progress}`);
}

// Create a state manager (fresh or resume)
const state = await StateManager.create({
    outputDir: './output/example.com',
    url: 'https://example.com',
    resume: true, // or false for fresh start
});

// Track phase progress
await state.startPhase('scrape');
// ... do scraping work ...
await state.setScrapeResult({ bundles, bundlesWithMaps, ... });
await state.completePhase('scrape');

// Track capture progress (batched per page)
await state.markPageStarted(url, depth);
// ... capture page ...
await state.markPageCompleted({
    url,
    depth,
    fixtures: [...],
    assets: [...],
});

// Finalize (compacts WAL)
await state.finalize();
```

## State Files

The package creates two files in the output directory:

- `state.json` - Compacted state (source of truth after compaction)
- `state.wal` - Write-ahead log (append-only events since last compaction)

## API

### `StateManager.canResume(outputDir)`

Check if an output directory has resumable state.

### `StateManager.create(options)`

Create a new StateManager instance.

### Phase Methods

- `getPhaseStatus(phase)` - Get current status of a phase
- `startPhase(phase)` - Mark a phase as started
- `completePhase(phase)` - Mark a phase as completed
- `failPhase(phase, error)` - Mark a phase as failed

### Scrape Phase

- `setScrapeResult(result)` - Store scrape results
- `getScrapeResult()` - Retrieve scrape results

### Extract Phase

- `markBundleExtracted(name, filesWritten)` - Mark a bundle as extracted
- `isBundleExtracted(name)` - Check if bundle was extracted
- `getExtractedBundles()` - Get list of extracted bundles

### Capture Phase

- `markPageStarted(url, depth)` - Mark page processing started
- `markPageCompleted(result)` - Mark page completed with fixtures/assets
- `markPageFailed(url, depth, error, willRetry)` - Mark page failed
- `addDiscoveredUrls(urls)` - Add newly discovered URLs
- `isUrlVisited(url)` / `isUrlCompleted(url)` - Check URL status
- `getVisitedUrls()` / `getCompletedUrls()` / `getPendingUrls()` - Get URL lists
- `getInProgressUrls()` - Get URLs that started but didn't complete (need reprocessing)

### Rebuild Phase

- `setRebuildResult(result)` - Store rebuild results
- `getRebuildResult()` - Retrieve rebuild results

## Version Compatibility

State files include a version number. If the version is incompatible with the current code, resuming is not allowed and you must use `--overwrite` to start fresh.
