# @web2local/http

HTTP utilities for web2local.

## Purpose

Provides HTTP helpers for reliable fetching:

- Browser-like headers to avoid bot detection
- Retry logic for transient errors and rate limiting
- Detailed error messages with hints
- URL pattern extraction for API fixture naming

## Main Exports

```typescript
import {
    robustFetch, // Fetch with retries
    BROWSER_HEADERS, // Common browser headers
    FetchError, // Error class with details
    extractUrlPattern, // Extract patterns from URLs
    createFixtureFilename, // Generate fixture filenames
} from '@web2local/http';
```

## Example

```typescript
import { robustFetch, BROWSER_HEADERS } from '@web2local/http';

// Fetch with automatic retries
const response = await robustFetch('https://example.com/api', {
    headers: BROWSER_HEADERS,
    retries: 3,
});

// Extract URL patterns for fixtures
import { extractUrlPattern } from '@web2local/http';

const result = extractUrlPattern('/api/users/123/posts/456');
// { pattern: '/api/users/:userId/posts/:postId', params: ['userId', 'postId'] }
```

## Retry Behavior

`robustFetch` automatically retries on:

- Transient errors (ECONNRESET, ETIMEDOUT, etc.)
- Rate limiting (429) with Retry-After support
- Server errors (5xx)

Retries use exponential backoff with jitter.
