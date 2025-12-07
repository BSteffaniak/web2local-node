/**
 * Tests for npm version validation
 *
 * These tests verify that:
 * - Valid package versions are correctly validated
 * - Invalid package versions (like @firebase/app@11.3.1) are rejected
 * - Batch validation works correctly
 * - Invalid versions are replaced with latest from npm
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import {
    validateNpmVersion,
    validateNpmVersionsBatch,
} from '@web2local/analyzer';
import { initCache } from '@web2local/cache';
import { server } from './helpers/msw-handlers.js';

// ============================================================================
// Test Setup
// ============================================================================

beforeEach(async () => {
    // Disable caching for tests to ensure fresh fetches
    await initCache({ disabled: true });
});

// ============================================================================
// validateNpmVersion Tests
// ============================================================================

describe('validateNpmVersion', () => {
    it('should return true for valid package version', async () => {
        server.use(
            http.head('https://registry.npmjs.org/react/18.2.0', () => {
                return new HttpResponse(null, { status: 200 });
            }),
        );

        const result = await validateNpmVersion('react', '18.2.0');
        expect(result).toBe(true);
    });

    it('should return false for invalid package version', async () => {
        // @firebase/app does NOT have version 11.3.1 (firebase has it, not @firebase/app)
        server.use(
            http.head(
                'https://registry.npmjs.org/%40firebase%2Fapp/11.3.1',
                () => {
                    return new HttpResponse(null, { status: 404 });
                },
            ),
        );

        const result = await validateNpmVersion('@firebase/app', '11.3.1');
        expect(result).toBe(false);
    });

    it('should return false for non-existent package', async () => {
        server.use(
            http.head(
                'https://registry.npmjs.org/this-package-does-not-exist-12345/1.0.0',
                () => {
                    return new HttpResponse(null, { status: 404 });
                },
            ),
        );

        const result = await validateNpmVersion(
            'this-package-does-not-exist-12345',
            '1.0.0',
        );
        expect(result).toBe(false);
    });

    it('should handle scoped packages correctly', async () => {
        server.use(
            http.head(
                'https://registry.npmjs.org/%40tanstack%2Freact-query/5.0.0',
                () => {
                    return new HttpResponse(null, { status: 200 });
                },
            ),
        );

        const result = await validateNpmVersion(
            '@tanstack/react-query',
            '5.0.0',
        );
        expect(result).toBe(true);
    });
});

// ============================================================================
// validateNpmVersionsBatch Tests
// ============================================================================

describe('validateNpmVersionsBatch', () => {
    it('should validate multiple packages in batch', async () => {
        server.use(
            http.head('https://registry.npmjs.org/react/18.2.0', () => {
                return new HttpResponse(null, { status: 200 });
            }),
            http.head('https://registry.npmjs.org/lodash/4.17.21', () => {
                return new HttpResponse(null, { status: 200 });
            }),
            http.head(
                'https://registry.npmjs.org/%40firebase%2Fapp/11.3.1',
                () => {
                    return new HttpResponse(null, { status: 404 });
                },
            ),
            // Latest version fetch for invalid package
            http.get(
                'https://registry.npmjs.org/%40firebase%2Fapp/latest',
                () => {
                    return HttpResponse.json({ version: '0.14.6' });
                },
            ),
        );

        const packages = [
            { name: 'react', version: '18.2.0' },
            { name: 'lodash', version: '4.17.21' },
            { name: '@firebase/app', version: '11.3.1' },
        ];

        const { validations, replacements } =
            await validateNpmVersionsBatch(packages);

        // Valid versions
        expect(validations.get('react@18.2.0')).toBe(true);
        expect(validations.get('lodash@4.17.21')).toBe(true);

        // Invalid version
        expect(validations.get('@firebase/app@11.3.1')).toBe(false);

        // Replacement should be fetched
        expect(replacements.get('@firebase/app')).toBe('0.14.6');
    });

    it('should call progress callback for each validation', async () => {
        server.use(
            http.head('https://registry.npmjs.org/react/18.2.0', () => {
                return new HttpResponse(null, { status: 200 });
            }),
            http.head('https://registry.npmjs.org/lodash/4.17.21', () => {
                return new HttpResponse(null, { status: 200 });
            }),
        );

        const packages = [
            { name: 'react', version: '18.2.0' },
            { name: 'lodash', version: '4.17.21' },
        ];

        const progressCalls: Array<{
            completed: number;
            total: number;
            name: string;
            version: string;
            valid: boolean;
        }> = [];

        await validateNpmVersionsBatch(
            packages,
            10,
            (completed, total, name, version, valid) => {
                progressCalls.push({ completed, total, name, version, valid });
            },
        );

        expect(progressCalls).toHaveLength(2);
        expect(progressCalls[0].total).toBe(2);
        expect(progressCalls[1].total).toBe(2);
    });

    it('should handle empty package list', async () => {
        const { validations, replacements } = await validateNpmVersionsBatch(
            [],
        );

        expect(validations.size).toBe(0);
        expect(replacements.size).toBe(0);
    });
});

// ============================================================================
// Real-world regression test: @firebase/app version issue
// ============================================================================

describe('Firebase version detection regression', () => {
    it('should detect that @firebase/app@11.3.1 is invalid', async () => {
        // This is the actual bug: firebase SDK bundle contains "@firebase/app" string
        // but it's version 11.3.1 which is from the main "firebase" package.
        // @firebase/app is actually at version 0.x
        server.use(
            http.head(
                'https://registry.npmjs.org/%40firebase%2Fapp/11.3.1',
                () => {
                    return new HttpResponse(null, { status: 404 });
                },
            ),
        );

        const result = await validateNpmVersion('@firebase/app', '11.3.1');
        expect(result).toBe(false);
    });

    it('should detect that firebase@11.3.1 is valid', async () => {
        server.use(
            http.head('https://registry.npmjs.org/firebase/11.3.1', () => {
                return new HttpResponse(null, { status: 200 });
            }),
        );

        const result = await validateNpmVersion('firebase', '11.3.1');
        expect(result).toBe(true);
    });
});
