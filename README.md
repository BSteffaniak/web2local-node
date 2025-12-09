# web2local

Extract and reconstruct original source code from production websites using publicly available source maps.

## Quick Start

### Prerequisites

- Node.js >= 20.12.0
- pnpm >= 10.24.0

```bash
git clone https://github.com/BSteffaniak/web2local-node
cd web2local-node
pnpm install
pnpm build

# Extract, analyze, capture API calls, and rebuild
pnpm cli https://example.com -o ./my-project

# Start mock server to develop against captured data
pnpm cli serve ./my-project
```

## Features

- **Source Extraction** - Discovers JavaScript/CSS bundles and extracts original source files from source maps with full [ECMA-426](https://tc39.es/ecma426/) spec compliance
- **Multi-Page Crawling** - Follows links to discover bundles across an entire site
- **Dependency Analysis** - Detects npm packages, infers versions from banners/lockfiles/fingerprinting
- **API Capture** - Records API calls as fixtures for offline development
- **Static Asset Capture** - Downloads images, fonts, and other assets
- **Stub Generation** - Creates index files, CSS module stubs, and type declarations for incomplete sources
- **Project Rebuild** - Generates Vite config, package.json, tsconfig.json, and runs the build

## CLI Usage

### Main Command

```bash
web2local <url> [options]
```

Runs the full pipeline: extract sources, analyze dependencies, capture API calls, and rebuild.

| Option                  | Default    | Description             |
| ----------------------- | ---------- | ----------------------- |
| `-o, --output <dir>`    | `./output` | Output directory        |
| `-v, --verbose`         | `false`    | Enable verbose logging  |
| `--no-capture`          | —          | Skip API/asset capture  |
| `--no-rebuild`          | —          | Skip build step         |
| `--no-crawl`            | —          | Only process entry page |
| `--crawl-max-pages <n>` | `100`      | Max pages to crawl      |
| `--serve`               | `false`    | Start mock server after |

### Commands

```bash
# Extract sources only (no capture, no rebuild)
web2local extract <url> -o ./output

# Serve captured fixtures and assets
web2local serve <dir> [--port 3000]
```

<details>
<summary><strong>All Options</strong></summary>

#### Extraction

| Option                       | Default | Description                  |
| ---------------------------- | ------- | ---------------------------- |
| `-c, --concurrency <n>`      | `5`     | Concurrent downloads         |
| `-n, --include-node-modules` | `false` | Include node_modules sources |
| `--no-cache`                 | —       | Disable caching              |

#### Dependency Analysis

| Option                  | Default | Description                              |
| ----------------------- | ------- | ---------------------------------------- |
| `--no-package-json`     | —       | Skip package.json generation             |
| `--use-fingerprinting`  | `false` | Match versions via source fingerprinting |
| `--no-fetch-versions`   | —       | Skip fetching latest npm versions        |
| `--include-prereleases` | `false` | Include alpha/beta/rc versions           |

#### API Capture

| Option                       | Default     | Description                     |
| ---------------------------- | ----------- | ------------------------------- |
| `--api-filter <patterns...>` | `**/api/**` | Glob patterns for API routes    |
| `--no-static`                | —           | Skip static asset capture       |
| `--no-headless`              | —           | Show browser window             |
| `--browse-timeout <ms>`      | `10000`     | Wait time for API calls         |
| `--capture-rendered-html`    | `false`     | Capture post-JS HTML (for SPAs) |

#### Crawling

| Option                  | Default | Description        |
| ----------------------- | ------- | ------------------ |
| `--crawl-max-depth <n>` | `5`     | Max link depth     |
| `--crawl-max-pages <n>` | `100`   | Max pages to visit |

#### Rebuild

| Option                   | Default | Description              |
| ------------------------ | ------- | ------------------------ |
| `--package-manager <pm>` | `auto`  | npm, pnpm, yarn, or auto |

#### Server (with `--serve`)

| Option              | Default     | Description             |
| ------------------- | ----------- | ----------------------- |
| `-p, --port <n>`    | `3000`      | Server port             |
| `-H, --host <host>` | `localhost` | Server host             |
| `-d, --delay <ms>`  | —           | Response delay          |
| `--static-only`     | `false`     | Serve only static files |
| `--api-only`        | `false`     | Serve only API fixtures |

</details>

## How It Works

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Scrape    │---->│   Analyze   │---->│  Generate   │---->│   Rebuild   │
│             │     │             │     │   Stubs     │     │             │
│ - bundles   │     │ - deps      │     │ - indexes   │     │ - vite cfg  │
│ - sources   │     │ - aliases   │     │ - css mods  │     │ - html      │
│ - assets    │     │ - versions  │     │ - types     │     │ - build     │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
       |
       v
┌─────────────┐
│   Capture   │
│             │
│ - API calls │
│ - static    │
│ - crawl     │
└─────────────┘
```

1. **Scrape** - Fetches the target URL, discovers JS/CSS bundles, extracts source files from source maps
2. **Capture** - Uses Playwright to browse the site, intercept API calls, and download static assets
3. **Analyze** - Parses extracted sources to detect dependencies, infer aliases, and identify package versions
4. **Generate Stubs** - Creates missing index files, CSS module stubs, and type declarations
5. **Rebuild** - Generates Vite config and package.json, installs dependencies, runs the build

## Packages

| Package                                      | Description                                   |
| -------------------------------------------- | --------------------------------------------- |
| [@web2local/sourcemap](./packages/sourcemap) | Source map parsing, discovery, and extraction |
| [@web2local/scraper](./packages/scraper)     | Bundle discovery and source reconstruction    |
| [@web2local/capture](./packages/capture)     | Browser automation and API/asset capture      |
| [@web2local/analyzer](./packages/analyzer)   | Dependency detection and version inference    |
| [@web2local/rebuild](./packages/rebuild)     | Vite config generation and build execution    |
| [@web2local/stubs](./packages/stubs)         | Stub file generation for incomplete sources   |
| [@web2local/server](./packages/server)       | Mock server for captured fixtures             |
| [@web2local/cli](./packages/cli)             | Command-line interface                        |
| [@web2local/ast](./packages/ast)             | AST parsing utilities                         |
| [@web2local/cache](./packages/cache)         | Disk and memory caching                       |
| [@web2local/http](./packages/http)           | HTTP utilities with retry logic               |
| [@web2local/manifest](./packages/manifest)   | Server manifest generation                    |
| [@web2local/types](./packages/types)         | Shared TypeScript types                       |
| [@web2local/utils](./packages/utils)         | Common utilities                              |

## Spec Compliance

The source map parser implements the [ECMA-426 Source Map](https://tc39.es/ecma426/) specification:

- 100% of the official [tc39/source-map-tests](https://github.com/tc39/source-map-tests) test suite passes (99 tests)
- Validates both regular source maps and index maps (concatenated source maps)
- Full VLQ mapping validation including:
    - Base64 character validation
    - Segment field count (1, 4, or 5 fields)
    - 32-bit integer range checking
    - Source/name index bounds checking
- `sourceMappingURL` extraction per sections 11.1.2.1 and 11.1.2.2

## Development

### Commands

```bash
# Build all packages
pnpm build

# Run tests
pnpm test

# Type check
pnpm typecheck

# Lint
pnpm lint

# Format
pnpm pretty:write

# Run CLI in development
pnpm cli https://example.com
```

## Troubleshooting

### pnpm workspace conflicts

If your output directory is inside a pnpm workspace (e.g., inside the web2local repo), running `pnpm install` will try to link workspace packages instead of installing from the local `package.json`.

**Solution:** Use the `--ignore-workspace` flag:

```bash
cd output/example.com
pnpm install --ignore-workspace
```

The CLI handles this automatically during rebuild, but you'll need the flag for manual installs.

## License

MIT
