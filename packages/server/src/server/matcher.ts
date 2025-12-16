/**
 * URL pattern matching for routing requests to fixtures.
 *
 * This module provides the {@link FixtureMatcher} class for matching incoming
 * HTTP requests to captured API fixtures, supporting both exact path matches
 * and parameterized patterns (e.g., `/api/users/:userId`).
 *
 * @packageDocumentation
 */

import type { LoadedFixture, MatchedFixture, HttpMethod } from '../types.js';

/**
 * Converts a URL pattern with parameters to a regular expression.
 *
 * Handles patterns like `/api/users/:userId` where `:paramName` segments
 * are converted to capture groups.
 *
 * @param pattern - URL pattern with optional `:param` segments
 * @returns Regular expression that matches the pattern
 */
function patternToRegex(pattern: string): RegExp {
    // Escape special regex characters except for our param syntax
    const regexStr = pattern
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\\:([a-zA-Z][a-zA-Z0-9]*)/g, '([^/]+)');

    // Ensure we match the full path
    return new RegExp(`^${regexStr}$`);
}

/**
 * Extracts parameter names from a URL pattern.
 *
 * @param pattern - URL pattern with `:param` segments
 * @returns Array of parameter names (without the colon prefix)
 */
function extractParamNames(pattern: string): string[] {
    const matches = pattern.match(/:([a-zA-Z][a-zA-Z0-9]*)/g);
    if (!matches) return [];
    return matches.map((m) => m.slice(1));
}

/**
 * Matches a URL path against a pattern and extracts parameters.
 *
 * @param path - The actual URL path to match
 * @param pattern - The pattern to match against
 * @returns Object mapping parameter names to values, or `null` if no match
 */
function matchPattern(
    path: string,
    pattern: string,
): Record<string, string> | null {
    const regex = patternToRegex(pattern);
    const match = path.match(regex);

    if (!match) return null;

    const paramNames = extractParamNames(pattern);
    const params: Record<string, string> = {};

    for (let i = 0; i < paramNames.length; i++) {
        params[paramNames[i]] = match[i + 1];
    }

    return params;
}

/**
 * Matches HTTP requests to captured API fixtures.
 *
 * Supports exact path matching and parameterized patterns like `/api/users/:userId`.
 * Fixtures are grouped by HTTP method for efficient lookup, and matching
 * prioritizes exact matches before falling back to pattern matching.
 *
 * @example
 * ```typescript
 * const matcher = new FixtureMatcher(fixtures);
 *
 * // Exact match
 * const result = matcher.match('GET', '/api/users');
 *
 * // Parameterized match
 * const result = matcher.match('GET', '/api/users/123');
 * // result.params = { userId: '123' }
 * ```
 */
export class FixtureMatcher {
    private fixtures: LoadedFixture[] = [];
    private fixturesByMethod: Map<HttpMethod, LoadedFixture[]> = new Map();

    /**
     * Creates a new FixtureMatcher instance.
     *
     * @param fixtures - Initial fixtures to match against
     */
    constructor(fixtures: LoadedFixture[] = []) {
        this.setFixtures(fixtures);
    }

    /**
     * Sets the fixtures to match against.
     *
     * Replaces any existing fixtures and rebuilds the internal lookup index.
     *
     * @param fixtures - Array of fixtures to use for matching
     */
    setFixtures(fixtures: LoadedFixture[]): void {
        this.fixtures = fixtures;
        this.fixturesByMethod.clear();

        // Group by method for faster lookup
        for (const fixture of fixtures) {
            const method = fixture.request.method;
            const existing = this.fixturesByMethod.get(method) || [];
            existing.push(fixture);
            this.fixturesByMethod.set(method, existing);
        }
    }

    /**
     * Finds a matching fixture for an HTTP request.
     *
     * First attempts an exact path match, then falls back to pattern matching.
     * Returns `null` if no fixture matches the request.
     *
     * @param method - HTTP method of the request
     * @param path - URL path of the request
     * @returns Matched fixture with extracted parameters, or `null` if no match
     */
    match(method: HttpMethod, path: string): MatchedFixture | null {
        const candidates = this.fixturesByMethod.get(method);
        if (!candidates || candidates.length === 0) {
            return null;
        }

        // Try to find an exact path match first
        for (const fixture of candidates) {
            if (fixture.request.path === path) {
                return { fixture, params: {} };
            }
        }

        // Try pattern matching (fixtures are already sorted by priority)
        for (const fixture of candidates) {
            const params = matchPattern(path, fixture.request.pattern);
            if (params) {
                return { fixture, params };
            }
        }

        return null;
    }

    /**
     * Gets all loaded fixtures.
     *
     * @returns Array of all fixtures in this matcher
     */
    getFixtures(): LoadedFixture[] {
        return this.fixtures;
    }

    /**
     * Gets fixtures grouped by their pattern key.
     *
     * The key format is `METHOD /pattern` (e.g., `GET /api/users/:userId`).
     *
     * @returns Map from pattern keys to arrays of matching fixtures
     */
    getFixturesByPattern(): Map<string, LoadedFixture[]> {
        const byPattern = new Map<string, LoadedFixture[]>();

        for (const fixture of this.fixtures) {
            const key = `${fixture.request.method} ${fixture.request.pattern}`;
            const existing = byPattern.get(key) || [];
            existing.push(fixture);
            byPattern.set(key, existing);
        }

        return byPattern;
    }

    /**
     * Gets the total number of fixtures.
     */
    get count(): number {
        return this.fixtures.length;
    }
}

/**
 * Checks if a path matches a glob-like pattern.
 *
 * Supports glob syntax:
 * - `**` matches any characters including path separators
 * - `*` matches any characters except path separators
 * - `?` matches a single character
 *
 * @param path - The path to test
 * @param pattern - Glob pattern to match against
 * @returns `true` if the path matches the pattern
 *
 * @example
 * ```typescript
 * matchGlob('/api/users/123', '/api/users/*'); // true
 * matchGlob('/api/users/123/posts', '/api/**'); // true
 * matchGlob('/api/users', '/api/posts'); // false
 * ```
 */
export function matchGlob(path: string, pattern: string): boolean {
    // Convert glob pattern to regex
    const regexStr = pattern
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '.');

    const regex = new RegExp(`^${regexStr}$`);
    return regex.test(path);
}

/**
 * Normalizes a URL path by ensuring consistent formatting.
 *
 * - Adds a leading slash if missing
 * - Removes trailing slash (except for root path `/`)
 *
 * @param path - The path to normalize
 * @returns Normalized path string
 *
 * @example
 * ```typescript
 * normalizePath('api/users'); // '/api/users'
 * normalizePath('/api/users/'); // '/api/users'
 * normalizePath('/'); // '/'
 * ```
 */
export function normalizePath(path: string): string {
    let normalized = path;

    // Ensure leading slash
    if (!normalized.startsWith('/')) {
        normalized = '/' + normalized;
    }

    // Remove trailing slash (except for root)
    if (normalized.length > 1 && normalized.endsWith('/')) {
        normalized = normalized.slice(0, -1);
    }

    return normalized;
}
