/**
 * @module @web2local/manifest
 *
 * Manifest generation utilities for web2local project reconstruction.
 *
 * This module provides tools for generating configuration files needed by
 * reconstructed projects, including:
 * - Server manifests for the development server
 * - package.json with detected dependencies and versions
 * - tsconfig.json with appropriate compiler options
 *
 * @example
 * ```typescript
 * import {
 *   generateServerManifest,
 *   generatePackageJson,
 *   generateTsConfig,
 * } from '@web2local/manifest';
 *
 * // Generate package.json from detected dependencies
 * const packageJson = generatePackageJson('my-app', dependencies, aliasMap, projectConfig);
 *
 * // Generate tsconfig.json based on project configuration
 * const tsconfig = generateTsConfig(aliasMappings, projectConfig);
 * ```
 */

export * from './server-manifest.js';
export * from './package-generator.js';
export * from './tsconfig-generator.js';
