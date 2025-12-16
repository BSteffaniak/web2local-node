/**
 * Logger middleware for request logging.
 *
 * This module provides Hono middleware that logs HTTP requests with
 * colorized output showing method, path, status code, and response time.
 *
 * @packageDocumentation
 */

import type { Context, Next } from 'hono';
import pc from 'picocolors';

/**
 * Configuration options for the logger middleware.
 */
export interface LoggerOptions {
    /** Whether request logging is enabled. */
    enabled: boolean;
}

/**
 * Formats an HTTP method with appropriate color coding.
 *
 * @param method - The HTTP method to format
 * @returns The colorized method string
 */
function formatMethod(method: string): string {
    switch (method) {
        case 'GET':
            return pc.green(method);
        case 'POST':
            return pc.yellow(method);
        case 'PUT':
            return pc.blue(method);
        case 'DELETE':
            return pc.red(method);
        case 'PATCH':
            return pc.magenta(method);
        default:
            return pc.gray(method);
    }
}

/**
 * Formats an HTTP status code with appropriate color coding.
 *
 * Colors are applied based on status code ranges:
 * - 2xx (success): green
 * - 3xx (redirect): cyan
 * - 4xx (client error): yellow
 * - 5xx (server error): red
 *
 * @param status - The HTTP status code to format
 * @returns The colorized status string
 */
function formatStatus(status: number): string {
    if (status >= 200 && status < 300) {
        return pc.green(String(status));
    } else if (status >= 300 && status < 400) {
        return pc.cyan(String(status));
    } else if (status >= 400 && status < 500) {
        return pc.yellow(String(status));
    } else if (status >= 500) {
        return pc.red(String(status));
    }
    return String(status);
}

/**
 * Formats response time with color coding based on duration.
 *
 * Colors are applied based on response time:
 * - Under 100ms: green (fast)
 * - 100-500ms: yellow (moderate)
 * - Over 500ms: red (slow)
 *
 * @param ms - Response time in milliseconds
 * @returns The colorized time string with "ms" suffix
 */
function formatTime(ms: number): string {
    if (ms < 100) {
        return pc.green(`${ms.toFixed(0)}ms`);
    } else if (ms < 500) {
        return pc.yellow(`${ms.toFixed(0)}ms`);
    }
    return pc.red(`${ms.toFixed(0)}ms`);
}

/**
 * Creates a Hono middleware that logs HTTP requests.
 *
 * Logs each request after the response is sent, including the HTTP method,
 * path, status code, and response time with colorized output.
 *
 * @param options - Logger configuration options
 * @returns A Hono middleware function
 *
 * @example
 * ```typescript
 * import { Hono } from 'hono';
 * import { loggerMiddleware } from '@web2local/server';
 *
 * const app = new Hono();
 * app.use('*', loggerMiddleware({ enabled: true }));
 *
 * // Output example:
 * //   GET /api/users 200 45ms
 * ```
 */
export function loggerMiddleware(options: LoggerOptions = { enabled: true }) {
    return async (c: Context, next: Next) => {
        if (!options.enabled) {
            return next();
        }

        const start = Date.now();
        const method = c.req.method;
        const path = new URL(c.req.url).pathname;

        await next();

        const elapsed = Date.now() - start;
        const status = c.res.status;

        console.log(
            `  ${formatMethod(method)} ${path} ${formatStatus(status)} ${formatTime(elapsed)}`,
        );
    };
}
