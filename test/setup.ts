/**
 * Vitest Global Setup
 *
 * Configures MSW (Mock Service Worker) for network mocking in tests.
 * This file is referenced in vitest.config.ts setupFiles.
 */

import { afterAll, afterEach, beforeAll } from 'vitest';
import { server } from './helpers/msw-handlers.js';

// Start MSW server before all tests
beforeAll(() => {
    server.listen({ onUnhandledRequest: 'error' });
});

// Reset handlers after each test (removes any per-test overrides)
afterEach(() => {
    server.resetHandlers();
});

// Close server after all tests
afterAll(() => {
    server.close();
});
