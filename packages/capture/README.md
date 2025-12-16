# @web2local/capture

Browser automation for capturing API calls and static assets from websites.

## Features

- **API Interception** - Records API calls as replayable fixtures
- **Static Asset Capture** - Downloads images, fonts, stylesheets, and other assets
- **Multi-Page Crawling** - Follows links to discover content across the site
- **Parallel Processing** - Configurable concurrency for faster capture

## Quick Start

```typescript
import { captureWebsite } from '@web2local/capture';

const result = await captureWebsite({
    url: 'https://example.com',
    outputDir: './output',
});

console.log(`Captured ${result.stats.apiCallsCaptured} API calls`);
console.log(`Downloaded ${result.stats.staticAssetsCaptured} assets`);
```

## API

### captureWebsite(options)

Full website capture with API interception and static asset downloading.

```typescript
const result = await captureWebsite({
    url: 'https://example.com',
    outputDir: './output',
    apiFilter: ['**/api/**', '**/graphql**'],
    captureStatic: true,
    headless: true,
    crawl: true,
    crawlMaxPages: 100,
    concurrency: 5,
});
```

### captureApiOnly(url, options?)

Captures only API calls, skipping static assets.

```typescript
const result = await captureApiOnly('https://example.com', {
    apiFilter: ['**/api/**'],
    browseTimeout: 10000,
});
```

### quickCapture(url, outputDir?)

Fast capture with minimal waiting, useful for simple sites.

```typescript
const result = await quickCapture('https://example.com', './output');
```

<details>
<summary><strong>All Options</strong></summary>

| Option                | Type       | Default              | Description                         |
| --------------------- | ---------- | -------------------- | ----------------------------------- |
| `url`                 | `string`   | —                    | URL to capture (required)           |
| `outputDir`           | `string`   | —                    | Output directory (required)         |
| `apiFilter`           | `string[]` | `['**/api/**', ...]` | Glob patterns for API routes        |
| `captureStatic`       | `boolean`  | `true`               | Download static assets              |
| `headless`            | `boolean`  | `true`               | Run browser in headless mode        |
| `browseTimeout`       | `number`   | `10000`              | Time to wait for API calls (ms)     |
| `autoScroll`          | `boolean`  | `true`               | Auto-scroll to trigger lazy loading |
| `crawl`               | `boolean`  | `true`               | Follow links to other pages         |
| `crawlMaxDepth`       | `number`   | `5`                  | Maximum link depth to follow        |
| `crawlMaxPages`       | `number`   | `100`                | Maximum pages to visit              |
| `concurrency`         | `number`   | `5`                  | Parallel page workers               |
| `pageTimeout`         | `number`   | `30000`              | Per-page navigation timeout (ms)    |
| `pageRetries`         | `number`   | `3`                  | Retries for failed navigations      |
| `rateLimitDelay`      | `number`   | `0`                  | Delay between requests (ms)         |
| `networkIdleTimeout`  | `number`   | `5000`               | Network idle wait timeout (ms)      |
| `networkIdleTime`     | `number`   | `1000`               | Idle time threshold (ms)            |
| `captureRenderedHtml` | `boolean`  | `false`              | Capture post-JS HTML (for SPAs)     |
| `verbose`             | `boolean`  | `false`              | Enable verbose logging              |

</details>

## Components

### ApiInterceptor

Intercepts and records API calls from Playwright pages.

```typescript
import { ApiInterceptor } from '@web2local/capture';

const interceptor = new ApiInterceptor({
    apiFilters: ['**/api/**'],
    onCapture: (event) => console.log('Captured:', event.url),
});

interceptor.attach(page);
// ... navigate page ...
const fixtures = interceptor.getFixtures();
```

### StaticCapturer

Downloads static assets and rewrites URLs for local serving.

```typescript
import { StaticCapturer } from '@web2local/capture';

const capturer = new StaticCapturer({
    outputDir: './static',
    captureRenderedHtml: false,
});

await capturer.attach(page, 'https://example.com');
// ... navigate page ...
const assets = capturer.getAssets();
```

### CrawlQueue / CrawlWorker

Manages parallel page crawling with depth and page limits.

```typescript
import { CrawlQueue, CrawlWorker } from '@web2local/capture';

const queue = new CrawlQueue({ maxPages: 100, maxDepth: 5 });
queue.add('https://example.com', 0);

// Workers pull URLs from the queue and process them in parallel
```
