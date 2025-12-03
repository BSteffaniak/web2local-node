/**
 * Delay middleware - adds artificial latency to responses
 */

import type { Context, Next } from "hono";

export interface DelayConfig {
  enabled: boolean;
  minMs: number;
  maxMs: number;
}

/**
 * Create a delay middleware
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
 * Create a fixed delay middleware
 */
export function fixedDelayMiddleware(ms: number) {
  return async (_c: Context, next: Next) => {
    if (ms > 0) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
    return next();
  };
}
