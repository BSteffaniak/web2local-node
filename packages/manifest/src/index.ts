/**
 * @web2local/manifest
 *
 * Project manifest generation utilities.
 *
 * This package provides tools for generating project configuration files:
 * - Server manifest for API fixtures and static assets
 * - Package.json with detected dependencies
 * - TSConfig.json with path aliases
 */

export * from './server-manifest.js';
export * from './package-generator.js';
export * from './tsconfig-generator.js';
