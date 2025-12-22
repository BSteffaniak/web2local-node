# @web2local/server

Mock server for captured API fixtures and static assets.

## Quick Start

```typescript
import { runServer } from '@web2local/server';

await runServer({
    dir: './captured-site',
    port: 3000,
    host: 'localhost',
});
```

## CLI Usage

### serve

Start the mock server:

```bash
web2local serve ./captured-site --port 3000
```

Options:

- `-p, --port <number>` - Port to listen on (default: 3000)
- `-h, --host <string>` - Host to bind to (default: localhost)
- `-d, --delay <ms>` - Add fixed delay to all responses
- `--no-cors` - Disable CORS headers
- `--static-only` - Only serve static files
- `--api-only` - Only serve API fixtures
- `-v, --verbose` - Enable verbose logging
- `--use-rebuilt` - Serve from rebuilt source instead of captured files

### info

Show information about a captured site:

```bash
web2local serve info ./captured-site
```

### list

List captured fixtures:

```bash
web2local serve list ./captured-site
web2local serve list ./captured-site --json
```

### sites

List captured sites in an output directory:

```bash
web2local serve sites ./output
```

## API

### runServer(options)

Starts the mock server with the given options.

```typescript
await runServer({
    dir: './captured-site',
    port: 3000,
    host: 'localhost',
    delay: 100, // Add response delay (ms)
    verbose: true, // Enable request logging
    staticOnly: false, // Serve only static files
    apiOnly: false, // Serve only API fixtures
    useRebuilt: false, // Serve from rebuilt source instead of captured files
});
```

### createApp(options)

Creates a Hono app instance without starting the server. Useful for testing or custom server setups.

```typescript
import { createApp } from '@web2local/server';

const { app, manifest, fixtureCount } = await createApp({
    dir: './captured-site',
    port: 3000,
    host: 'localhost',
    verbose: true,
});
```

### FixtureMatcher

Matches incoming requests against captured fixtures using URL patterns.

```typescript
import { FixtureMatcher } from '@web2local/server';

const matcher = new FixtureMatcher(fixtures);
const match = matcher.match('GET', '/api/users/123');

if (match) {
    console.log(match.fixture.response.body);
    console.log(match.params); // { id: '123' }
}
```

## Fixture Matching

Fixtures are matched by HTTP method and URL pattern. Patterns support path parameters:

- `/api/users/:id` matches `/api/users/123`
- `/api/posts/:postId/comments/:commentId` matches `/api/posts/1/comments/2`

When multiple fixtures match, they are prioritized by:

1. Specificity (fewer path parameters wins)
2. Capture order (earlier captures win)

## Directory Structure

The server expects the following structure:

```
captured-site/
  _server/
    manifest.json        # Server configuration
    fixtures/
      _index.json        # Fixture index
      *.json             # Individual fixture files
    static/
      index.html         # Entry point
      assets/            # Static assets
```
