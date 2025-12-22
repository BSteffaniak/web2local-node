# @web2local/wrapper

Extract and reconstruct original source code from production websites using publicly available source maps.

## Installation

```bash
npm install @web2local/wrapper
```

**Prerequisites:**

- Node.js >= 20.12.0
- Playwright browsers: `npx playwright install`

## Quick Start

```bash
# Extract, analyze, capture API calls, and rebuild (output to ./output/example.com)
npx web2local https://example.com

# Start mock server to develop against captured data
npx web2local serve ./output/example.com
```

## CLI Usage

### Main Command

```bash
web2local <url> [options]
```

Runs the full pipeline: extract sources, analyze dependencies, capture API calls, and rebuild.

| Option                  | Default               | Description                                                              |
| ----------------------- | --------------------- | ------------------------------------------------------------------------ |
| `-o, --output <dir>`    | `./output/<hostname>` | Output directory (explicit path used exactly, default includes hostname) |
| `--overwrite`           | `false`               | Overwrite output directory without prompting                             |
| `-v, --verbose`         | `false`               | Enable verbose logging                                                   |
| `--no-capture`          | —                     | Skip API/asset capture                                                   |
| `--no-rebuild`          | —                     | Skip build step                                                          |
| `--no-crawl`            | —                     | Only process entry page                                                  |
| `--crawl-max-pages <n>` | `100`                 | Max pages to crawl                                                       |
| `--serve`               | `false`               | Start mock server after                                                  |

### Commands

```bash
# Extract sources only (no capture, no rebuild)
web2local extract <url> -o ./output

# Serve captured fixtures and assets
web2local serve <dir> [--port 3000]
```

## Documentation

For full documentation including all CLI options, see the [main README](https://github.com/BSteffaniak/web2local-node#readme).

## License

MIT
