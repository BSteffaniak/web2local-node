/**
 * Delay middleware for adding artificial latency to responses.
 *
 * This module provides Hono middleware that simulates network latency,
 * useful for testing loading states and timeout handling in client applications.
 *
 * @packageDocumentation
 */

import type { Context, Next } from 'hono';

/**
 * Configuration for variable delay middleware.
 *
 * @example
 * ```typescript
 * const config: DelayConfig = {
 *     enabled: true,
 *     minMs: 100,
 *     maxMs: 500,
 * };
 * ```
 */
export interface DelayConfig {
    /** Whether the delay middleware is active. */
    enabled: boolean;

    /** Minimum delay in milliseconds. */
    minMs: number;

    /** Maximum delay in milliseconds. */
    maxMs: number;
}

/**
 * Creates a Hono middleware that adds random delay to responses.
 *
 * The delay is randomly selected between `minMs` and `maxMs` for each request,
 * simulating variable network latency.
 *
 * @param config - Delay configuration specifying the delay range
 * @returns A Hono middleware function
 *
 * @example
 * ```typescript
 * import { Hono } from 'hono';
 * import { delayMiddleware } from '@web2local/server';
 *
 * const app = new Hono();
 * app.use('*', delayMiddleware({ enabled: true, minMs: 100, maxMs: 500 }));
 * ```
 */
export function delayMiddleware(config: DelayConfig) {
    return async (_c: Context, next: Next) => {
        if (!config.enabled) {
            return next();
        }

        const delay =
            config.minMs + Math.random() * (config.maxMs - config.minMs);

        if (delay > 0) {
            await new Promise((resolve) => setTimeout(resolve, delay));
        }

        return next();
    };
}

/**
 * Creates a Hono middleware that adds a fixed delay to all responses.
 *
 * Unlike {@link delayMiddleware}, this applies the same delay to every request,
 * useful for consistent latency simulation.
 *
 * @param ms - Fixed delay in milliseconds to apply to each request
 * @returns A Hono middleware function
 *
 * @example
 * ```typescript
 * import { Hono } from 'hono';
 * import { fixedDelayMiddleware } from '@web2local/server';
 *
 * const app = new Hono();
 * app.use('*', fixedDelayMiddleware(200)); // 200ms delay on all requests
 * ```
 */
export function fixedDelayMiddleware(ms: number) {
    return async (_c: Context, next: Next) => {
        if (ms > 0) {
            await new Promise((resolve) => setTimeout(resolve, ms));
        }
        return next();
    };
}
