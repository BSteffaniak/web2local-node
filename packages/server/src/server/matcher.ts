/**
 * URL pattern matching for routing requests to fixtures
 */

import type { LoadedFixture, MatchedFixture, HttpMethod } from "../types.js";

/**
 * Convert a pattern like "/api/users/:userId" to a regex
 */
function patternToRegex(pattern: string): RegExp {
  // Escape special regex characters except for our param syntax
  let regexStr = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\\:([a-zA-Z][a-zA-Z0-9]*)/g, "([^/]+)");

  // Ensure we match the full path
  return new RegExp(`^${regexStr}$`);
}

/**
 * Extract parameter names from a pattern
 */
function extractParamNames(pattern: string): string[] {
  const matches = pattern.match(/:([a-zA-Z][a-zA-Z0-9]*)/g);
  if (!matches) return [];
  return matches.map((m) => m.slice(1));
}

/**
 * Match a URL path against a pattern and extract params
 */
function matchPattern(
  path: string,
  pattern: string
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
 * Fixture matcher - finds the best matching fixture for a request
 */
export class FixtureMatcher {
  private fixtures: LoadedFixture[] = [];
  private fixturesByMethod: Map<HttpMethod, LoadedFixture[]> = new Map();

  constructor(fixtures: LoadedFixture[] = []) {
    this.setFixtures(fixtures);
  }

  /**
   * Set the fixtures to match against
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
   * Find a matching fixture for a request
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
   * Get all fixtures
   */
  getFixtures(): LoadedFixture[] {
    return this.fixtures;
  }

  /**
   * Get fixtures grouped by pattern
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
   * Get fixture count
   */
  get count(): number {
    return this.fixtures.length;
  }
}

/**
 * Check if a path matches a glob-like pattern
 */
export function matchGlob(path: string, pattern: string): boolean {
  // Convert glob pattern to regex
  const regexStr = pattern
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".");

  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(path);
}

/**
 * Normalize a path (remove trailing slash, ensure leading slash)
 */
export function normalizePath(path: string): string {
  let normalized = path;

  // Ensure leading slash
  if (!normalized.startsWith("/")) {
    normalized = "/" + normalized;
  }

  // Remove trailing slash (except for root)
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}
