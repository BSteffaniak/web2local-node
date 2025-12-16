# @web2local/cli

Command-line interface for web2local.

## Usage

### Main Command

```bash
web2local <url> [options]
```

Runs the full pipeline: extract sources, analyze dependencies, capture API calls, and rebuild.

```bash
# Full extraction with defaults (outputs to ./output/example.com/)
web2local https://example.com

# Full extraction with custom output directory
web2local https://example.com -o ./my-project

# Extract only, skip capture and rebuild
web2local https://example.com --no-capture --no-rebuild

# Start server after completion
web2local https://example.com --serve
```

### Extract Command

```bash
web2local extract <url> [options]
```

Extracts source files from source maps only (no capture, no rebuild).

```bash
web2local extract https://example.com/bundle.js.map -o ./sources
web2local extract https://example.com -o ./sources --crawl-max-pages 50
```

### Serve Command

```bash
web2local serve <dir> [options]
```

Starts a mock server for captured API fixtures and static assets.

```bash
web2local serve ./my-project --port 3000
web2local serve ./my-project --api-only
```

## Common Options

| Option                  | Default               | Description                                                              |
| ----------------------- | --------------------- | ------------------------------------------------------------------------ |
| `-o, --output <dir>`    | `./output/<hostname>` | Output directory (explicit path used exactly, default includes hostname) |
| `--overwrite`           | `false`               | Overwrite output directory without prompting                             |
| `-v, --verbose`         | `false`               | Enable verbose logging                                                   |
| `-c, --concurrency <n>` | `5`                   | Concurrent downloads                                                     |
| `--no-capture`          | —                     | Skip API/asset capture                                                   |
| `--no-rebuild`          | —                     | Skip build step                                                          |
| `--no-crawl`            | —                     | Only process entry page                                                  |
| `--serve`               | `false`               | Start mock server after                                                  |

### Output Directory Behavior

When `--output` is **not specified**, the default output directory is `./output/<hostname>`:

```bash
web2local https://example.com       # Outputs to ./output/example.com/
```

When `--output` **is specified**, the exact path is used (no hostname is appended):

```bash
web2local https://example.com -o ./mydir    # Outputs to ./mydir/
```

If the output directory already exists, you will be prompted to confirm overwriting. Use `--overwrite` to skip the prompt:

```bash
web2local https://example.com --overwrite   # Overwrites without prompting
```

See the [main README](../../README.md) for a full list of options.

## Programmatic Usage

```typescript
import { runMain } from '@web2local/cli';

await runMain({
    url: 'https://example.com',
    output: './my-project',
    overwrite: false,
    resume: false,
    verbose: false,
    concurrency: 5,
    noPackageJson: false,
    noFingerprinting: false,
    noFetchVersions: false,
    maxVersions: 0,
    cacheDir: '',
    noCache: false,
    includePrereleases: false,
    fingerprintConcurrency: 5,
    versionConcurrency: 10,
    pathConcurrency: 5,
    forceRefresh: false,
    noCapture: false,
    apiFilter: ['**/api/**', '**/graphql**', '**/v1/**', '**/v2/**', '**/v3/**'],
    captureStatic: true,
    captureRenderedHtml: false,
    headless: true,
    browseTimeout: 10000,
    autoScroll: true,
    captureConcurrency: 5,
    pageRetries: 3,
    assetRetries: 2,
    retryDelay: 500,
    retryDelayMax: 5000,
    rateLimitDelay: 0,
    pageTimeout: 30000,
    networkIdleTimeout: 5000,
    networkIdleTime: 1000,
    scrollDelay: 50,
    pageSettleTime: 1000,
    noRebuild: false,
    packageManager: 'auto',
    serve: false,
    useRebuilt: false,
    saveBundles: false,
    crawl: true,
    crawlMaxDepth: 5,
    crawlMaxPages: 100,
    resolveMaxIterations: 10,
});
```
