/**
 * API request/response interception and capture
 */

import type { Page, Request, Response } from 'playwright';
import type {
    ApiFixture,
    ApiCaptureEvent,
    CapturedRequest,
    CapturedResponse,
    CaptureVerboseEvent,
    HttpMethod,
    ResourceType,
} from './types.js';
import { extractUrlPattern, generateFixtureId } from './url-pattern.js';

/**
 * Options for API interception
 */
export interface InterceptorOptions {
    /** Filter patterns for API routes (glob-style patterns) */
    apiFilters: string[];
    /** Whether to capture request/response bodies */
    captureBodies: boolean;
    /** Maximum body size to capture (bytes) */
    maxBodySize: number;
    /** Verbose logging */
    verbose: boolean;
    /** Structured progress callback */
    onCapture?: (event: ApiCaptureEvent) => void;
    /** Structured verbose log callback */
    onVerbose?: (event: CaptureVerboseEvent) => void;
}

const DEFAULT_OPTIONS: InterceptorOptions = {
    apiFilters: [
        '**/api/**',
        '**/graphql**',
        '**/v1/**',
        '**/v2/**',
        '**/v3/**',
    ],
    captureBodies: true,
    maxBodySize: 10 * 1024 * 1024, // 10MB
    verbose: false,
};

/**
 * Check if a URL matches any of the filter patterns
 */
function matchesFilter(url: string, filters: string[]): boolean {
    const urlObj = new URL(url);
    const path = urlObj.pathname + urlObj.search;

    for (const filter of filters) {
        // Convert glob pattern to regex
        const regexPattern = filter
            .replace(/\*\*/g, '.*')
            .replace(/\*/g, '[^/]*')
            .replace(/\?/g, '.');

        const regex = new RegExp(regexPattern, 'i');
        if (regex.test(path) || regex.test(url)) {
            return true;
        }
    }

    return false;
}

/**
 * Parse response body based on content type
 */
async function parseResponseBody(
    response: Response,
    maxSize: number,
): Promise<{
    body: unknown;
    bodyRaw?: string;
    bodyType: 'json' | 'text' | 'binary';
}> {
    const contentType = response.headers()['content-type'] || '';
    const contentLength = parseInt(
        response.headers()['content-length'] || '0',
        10,
    );

    // Skip if too large
    if (contentLength > maxSize) {
        return {
            body: `[Body too large: ${contentLength} bytes]`,
            bodyType: 'text',
        };
    }

    try {
        if (contentType.includes('application/json')) {
            const text = await response.text();
            try {
                return {
                    body: JSON.parse(text),
                    bodyRaw: text,
                    bodyType: 'json',
                };
            } catch {
                return { body: text, bodyRaw: text, bodyType: 'text' };
            }
        } else if (
            contentType.includes('text/') ||
            contentType.includes('application/xml') ||
            contentType.includes('application/javascript')
        ) {
            const text = await response.text();
            return { body: text, bodyRaw: text, bodyType: 'text' };
        } else {
            // Binary content - just note the type
            const buffer = await response.body();
            return {
                body: `[Binary data: ${buffer.length} bytes, type: ${contentType}]`,
                bodyType: 'binary',
            };
        }
    } catch (error) {
        return {
            body: `[Error reading body: ${error}]`,
            bodyType: 'text',
        };
    }
}

/**
 * Parse request body
 */
function parseRequestBody(request: Request): {
    body?: unknown;
    bodyRaw?: string;
} {
    const postData = request.postData();
    if (!postData) {
        return {};
    }

    const contentType = request.headers()['content-type'] || '';

    if (contentType.includes('application/json')) {
        try {
            return {
                body: JSON.parse(postData),
                bodyRaw: postData,
            };
        } catch {
            return { body: postData, bodyRaw: postData };
        }
    }

    return { body: postData, bodyRaw: postData };
}

/**
 * Extract query parameters from URL
 */
function extractQueryParams(url: string): Record<string, string> {
    const urlObj = new URL(url);
    const params: Record<string, string> = {};

    urlObj.searchParams.forEach((value, key) => {
        params[key] = value;
    });

    return params;
}

/**
 * Filter and normalize headers (remove sensitive/noisy headers)
 */
function filterHeaders(
    headers: Record<string, string>,
): Record<string, string> {
    const filtered: Record<string, string> = {};
    const skipHeaders = new Set([
        'cookie',
        'set-cookie',
        'authorization',
        'x-csrf-token',
        'x-request-id',
        'x-correlation-id',
        'date',
        'age',
        'etag',
        'last-modified',
        'cf-ray',
        'cf-cache-status',
        'x-amz-request-id',
        'x-amz-id-2',
        'x-served-by',
        'x-cache',
        'x-cache-hits',
        'x-timer',
        'via',
        'server-timing',
        'report-to',
        'nel',
    ]);

    for (const [key, value] of Object.entries(headers)) {
        if (!skipHeaders.has(key.toLowerCase())) {
            filtered[key.toLowerCase()] = value;
        }
    }

    return filtered;
}

/**
 * API Interceptor - captures API calls from a browser page
 */
export class ApiInterceptor {
    private fixtures: ApiFixture[] = [];
    private fixtureIndex = 0;
    private options: InterceptorOptions;
    private pendingRequests: Map<
        string,
        { request: Request; startTime: number }
    > = new Map();

    constructor(options: Partial<InterceptorOptions> = {}) {
        this.options = { ...DEFAULT_OPTIONS, ...options };
    }

    /**
     * Attach interceptor to a page
     */
    attach(page: Page): void {
        // Track request start times
        page.on('request', (request) => {
            const resourceType = request.resourceType() as ResourceType;

            // Only track XHR/fetch requests
            if (resourceType !== 'xhr' && resourceType !== 'fetch') {
                return;
            }

            const url = request.url();

            // Check if URL matches our filters
            if (!matchesFilter(url, this.options.apiFilters)) {
                return;
            }

            // Store request with start time
            this.pendingRequests.set(request.url() + request.method(), {
                request,
                startTime: Date.now(),
            });
        });

        // Capture responses
        page.on('response', async (response) => {
            const request = response.request();
            const resourceType = request.resourceType() as ResourceType;

            // Only process XHR/fetch requests
            if (resourceType !== 'xhr' && resourceType !== 'fetch') {
                return;
            }

            const url = request.url();
            const key = url + request.method();

            // Get pending request info
            const pending = this.pendingRequests.get(key);
            if (!pending) {
                return;
            }

            this.pendingRequests.delete(key);

            const responseTimeMs = Date.now() - pending.startTime;

            try {
                const fixture = await this.captureRequestResponse(
                    pending.request,
                    response,
                    responseTimeMs,
                );

                if (fixture) {
                    this.fixtures.push(fixture);
                    this.options.onCapture?.({
                        type: 'api-capture',
                        method: fixture.request.method,
                        url: fixture.request.url,
                        pattern: fixture.request.pattern,
                        status: fixture.response.status,
                    });

                    if (this.options.verbose) {
                        this.options.onVerbose?.({
                            type: 'verbose',
                            level: 'info',
                            source: 'interceptor',
                            message: `Captured: ${fixture.request.method} ${fixture.request.pattern} (${fixture.response.status})`,
                            data: {
                                method: fixture.request.method,
                                pattern: fixture.request.pattern,
                                status: fixture.response.status,
                            },
                        });
                    }
                }
            } catch (error) {
                if (this.options.verbose) {
                    this.options.onVerbose?.({
                        type: 'verbose',
                        level: 'error',
                        source: 'interceptor',
                        message: `Error capturing ${url}: ${error}`,
                        data: { url, error: String(error) },
                    });
                }
            }
        });
    }

    /**
     * Capture a request/response pair as a fixture
     */
    private async captureRequestResponse(
        request: Request,
        response: Response,
        responseTimeMs: number,
    ): Promise<ApiFixture | null> {
        const url = request.url();
        const urlObj = new URL(url);
        const method = request.method() as HttpMethod;

        // Extract URL pattern
        const { pattern, pathParams } = extractUrlPattern(urlObj.pathname);

        // Build captured request
        const capturedRequest: CapturedRequest & {
            pattern: string;
            pathParams: string[];
        } = {
            method,
            url,
            path: urlObj.pathname,
            pattern,
            pathParams,
            query: extractQueryParams(url),
            headers: filterHeaders(request.headers()),
            ...parseRequestBody(request),
        };

        // Build captured response
        const { body, bodyRaw, bodyType } = await parseResponseBody(
            response,
            this.options.maxBodySize,
        );

        const capturedResponse: CapturedResponse = {
            status: response.status(),
            statusText: response.statusText(),
            headers: filterHeaders(response.headers()),
            body,
            bodyRaw,
            bodyType,
        };

        // Generate fixture ID
        const id = generateFixtureId(method, pattern, this.fixtureIndex++);

        return {
            id,
            request: capturedRequest,
            response: capturedResponse,
            timestamp: Date.now(),
            priority: 0, // Default priority
        };
    }

    /**
     * Get all captured fixtures
     */
    getFixtures(): ApiFixture[] {
        return this.fixtures;
    }

    /**
     * Clear captured fixtures
     */
    clear(): void {
        this.fixtures = [];
        this.fixtureIndex = 0;
        this.pendingRequests.clear();
    }

    /**
     * Get capture statistics
     */
    getStats(): {
        totalCaptured: number;
        byMethod: Record<string, number>;
        byStatus: Record<string, number>;
    } {
        const byMethod: Record<string, number> = {};
        const byStatus: Record<string, number> = {};

        for (const fixture of this.fixtures) {
            const method = fixture.request.method;
            byMethod[method] = (byMethod[method] || 0) + 1;

            const status = String(fixture.response.status);
            byStatus[status] = (byStatus[status] || 0) + 1;
        }

        return {
            totalCaptured: this.fixtures.length,
            byMethod,
            byStatus,
        };
    }
}

/**
 * Deduplicate fixtures by pattern (keep first occurrence)
 */
export function deduplicateFixtures(fixtures: ApiFixture[]): ApiFixture[] {
    const seen = new Set<string>();
    const result: ApiFixture[] = [];

    for (const fixture of fixtures) {
        const key = `${fixture.request.method}:${fixture.request.pattern}`;
        if (!seen.has(key)) {
            seen.add(key);
            result.push(fixture);
        }
    }

    return result;
}

/**
 * Sort fixtures by priority (higher priority first)
 */
export function sortFixturesByPriority(fixtures: ApiFixture[]): ApiFixture[] {
    return [...fixtures].sort((a, b) => {
        const priorityA = extractUrlPattern(a.request.pattern).priority;
        const priorityB = extractUrlPattern(b.request.pattern).priority;
        return priorityB - priorityA;
    });
}
