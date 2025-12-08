/**
 * Type definitions for the rebuild system
 */

/**
 * Source file with path and content (matches dependency-analyzer's SourceFile)
 */
export interface SourceFile {
    /** Relative path from project root */
    path: string;
    /** File content */
    content: string;
}

/**
 * Detected frontend framework
 */
export type Framework =
    | 'react'
    | 'vue'
    | 'svelte'
    | 'solid'
    | 'preact'
    | 'vanilla'
    | 'unknown';

/**
 * Detected entry point in the reconstructed source
 */
export interface EntryPoint {
    /** Relative path to entry file from project root */
    path: string;
    /** Detected framework */
    framework: Framework;
    /** DOM element ID where app mounts (e.g., "app", "root", "recApp") */
    mountElement?: string;
    /** Confidence score 0-1 */
    confidence: number;
    /** How the entry point was detected */
    detectionMethod:
        | 'render-call'
        | 'main-file'
        | 'html-script'
        | 'package-main'
        | 'heuristic'
        | 'fallback-index';
}

/**
 * Environment variable detected in source code
 */
export interface EnvVariable {
    /** Variable name (e.g., "API_URL") */
    name: string;
    /** Default value if detected */
    defaultValue?: string;
    /** Files where this variable is used */
    usedIn: string[];
}

/**
 * Alias mapping from tsconfig paths
 */
export interface AliasMapping {
    /** Import alias (e.g., "shared-ui") */
    alias: string;
    /** Resolved path (e.g., "./navigation/shared-ui/src") */
    path: string;
}

/**
 * Options for preparing a rebuild
 */
export interface PrepareRebuildOptions {
    /** Project root directory (where package.json is) */
    projectDir: string;
    /** Whether to overwrite existing config files */
    overwrite?: boolean;
    /** Verbose logging */
    verbose?: boolean;
    /** Progress callback */
    onProgress?: (message: string) => void;
    /** Verbose log callback - use this instead of console.log when spinner is active */
    onVerbose?: (message: string) => void;
    /**
     * Source files extracted from source maps.
     * When provided, enables accurate alias detection by analyzing actual imports.
     */
    sourceFiles?: SourceFile[];
}

/**
 * Package manager type
 */
export type PackageManager = 'npm' | 'pnpm' | 'yarn';

/**
 * Options for running the build
 */
export interface BuildOptions extends PrepareRebuildOptions {
    /** Whether to attempt error recovery */
    recovery?: boolean;
    /** Maximum recovery attempts */
    maxRecoveryAttempts?: number;
    /** Whether to continue on non-fatal errors */
    lenient?: boolean;
    /** Package manager to use (auto-detected if not specified) */
    packageManager?: PackageManager | 'auto';
}

/**
 * Result of preparing for rebuild
 */
export interface PrepareResult {
    /** Whether preparation succeeded */
    success: boolean;
    /** Detected entry points */
    entryPoints: EntryPoint[];
    /** Generated files */
    generatedFiles: string[];
    /** Detected environment variables */
    envVariables: EnvVariable[];
    /** Warnings during preparation */
    warnings: string[];
    /** Errors during preparation */
    errors: string[];
}

/**
 * Result of running the build
 */
export interface BuildResult {
    /** Whether build succeeded */
    success: boolean;
    /** Output directory */
    outputDir: string;
    /** Build duration in ms */
    durationMs: number;
    /** Generated bundle files */
    bundles: string[];
    /** Recovery attempts made */
    recoveryAttempts: number;
    /** Warnings during build */
    warnings: string[];
    /** Errors during build */
    errors: string[];
}

/**
 * Build error that can potentially be recovered from
 */
export interface RecoverableError {
    /** Error type for matching */
    type:
        | 'missing-module'
        | 'missing-type'
        | 'missing-env'
        | 'syntax-error'
        | 'type-error'
        | 'unknown';
    /** Original error message */
    message: string;
    /** File where error occurred */
    file?: string;
    /** Line number */
    line?: number;
    /** Suggested fix */
    suggestedFix?: string;
}

/**
 * Vite configuration options
 */
export interface ViteConfigOptions {
    /** Entry points */
    entryPoints: EntryPoint[];
    /** Alias mappings from tsconfig */
    aliases: AliasMapping[];
    /** Environment variables to define */
    envVariables: EnvVariable[];
    /** Framework to configure */
    framework: Framework;
    /** Output directory */
    outDir: string;
    /** Whether to generate source maps */
    sourcemap?: boolean;
}

/**
 * HTML generation options
 */
export interface HtmlOptions {
    /** Page title */
    title: string;
    /** Entry point script path */
    entryScript: string;
    /** Mount element ID */
    mountElementId: string;
    /** Additional head content (meta tags, etc.) */
    headContent?: string;
    /** Language attribute */
    lang?: string;
}

/**
 * Package.json enhancement options
 */
export interface PackageEnhanceOptions {
    /** Path to package.json */
    packageJsonPath: string;
    /** Framework being used */
    framework: Framework;
    /** Whether TypeScript is used (.ts/.tsx files detected) */
    hasTypeScript?: boolean;
    /** Whether SCSS/SASS is used */
    usesSass?: boolean;
    /** Additional dev dependencies to add */
    additionalDevDeps?: Record<string, string>;
}

/**
 * Detected project configuration
 */
export interface ProjectConfig {
    /** Project root directory */
    rootDir: string;
    /** Detected entry points */
    entryPoints: EntryPoint[];
    /** Detected framework */
    framework: Framework;
    /** Alias mappings */
    aliases: AliasMapping[];
    /** Environment variables */
    envVariables: EnvVariable[];
    /** Whether TypeScript is used */
    usesTypeScript: boolean;
    /** Whether SCSS/SASS is used */
    usesSass: boolean;
    /** Whether CSS modules are used */
    usesCssModules: boolean;
    /** Bundle directories (e.g., ["navigation", "mapbox-gl-2.15.0"]) */
    bundleDirs: string[];
}
