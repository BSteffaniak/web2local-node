/**
 * Logger middleware - logs requests
 */

import type { Context, Next } from 'hono';
import pc from 'picocolors';

export interface LoggerOptions {
    enabled: boolean;
}

/**
 * Format HTTP method with color
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
 * Format status code with color
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
 * Format response time
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
 * Create a logger middleware
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
