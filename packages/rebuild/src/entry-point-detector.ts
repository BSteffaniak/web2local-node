/**
 * Entry point detection for reconstructed source code
 *
 * Scans the project to find where the application bootstraps
 * (React render, Vue mount, etc.)
 */

import { readFile, readdir, stat } from 'fs/promises';
import { join, relative, extname } from 'path';
import { toPosixPath } from '@web2local/utils';
import type { EntryPoint, Framework, EnvVariable } from './types.js';

/**
 * Patterns to detect framework render/mount calls
 */
const FRAMEWORK_PATTERNS: Record<Framework, RegExp[]> = {
    react: [
        /createRoot\s*\(\s*document\.getElementById\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/,
        /hydrateRoot\s*\(\s*document\.getElementById\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/,
        /ReactDOM\.render\s*\([^,]+,\s*document\.getElementById\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/,
        /render\s*\(\s*<[^>]+>\s*,\s*document\.getElementById\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/,
    ],
    vue: [
        /createApp\s*\([^)]+\)\.mount\s*\(\s*['"`]#?([^'"`]+)['"`]\s*\)/,
        /new\s+Vue\s*\(\s*\{[^}]*el\s*:\s*['"`]#?([^'"`]+)['"`]/,
    ],
    svelte: [
        /new\s+\w+\s*\(\s*\{\s*target\s*:\s*document\.getElementById\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/,
        /mount\s*\(\s*\w+\s*,\s*\{\s*target\s*:\s*document\.getElementById\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/,
    ],
    solid: [
        /render\s*\(\s*\(\)\s*=>\s*<[^>]+>\s*,\s*document\.getElementById\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/,
    ],
    preact: [
        /render\s*\(\s*<[^>]+>\s*,\s*document\.getElementById\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/,
        /hydrate\s*\(\s*<[^>]+>\s*,\s*document\.getElementById\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/,
    ],
    vanilla: [],
    unknown: [],
};

/**
 * Common entry point file names to look for
 */
const ENTRY_FILE_NAMES = [
    'index.tsx',
    'index.ts',
    'index.jsx',
    'index.js',
    'main.tsx',
    'main.ts',
    'main.jsx',
    'main.js',
    'app.tsx',
    'app.ts',
    'App.tsx',
    'App.ts',
    'entry.tsx',
    'entry.ts',
    'entry-client.tsx',
    'entry-client.ts',
];

/**
 * Directories likely to contain entry points
 */
const ENTRY_DIRECTORIES = ['src', 'dev', 'app', 'client', 'pages', ''];

/**
 * Detect the framework from file content
 */
function detectFrameworkFromContent(content: string): Framework {
    // Check imports first
    if (/from\s+['"]react['"]|from\s+['"]react-dom/.test(content)) {
        return 'react';
    }
    if (/from\s+['"]vue['"]/.test(content)) {
        return 'vue';
    }
    if (/from\s+['"]svelte['"]/.test(content)) {
        return 'svelte';
    }
    if (/from\s+['"]solid-js['"]/.test(content)) {
        return 'solid';
    }
    if (/from\s+['"]preact['"]/.test(content)) {
        return 'preact';
    }

    // Check for JSX usage (likely React/Preact)
    if (/<[A-Z][a-zA-Z]*[\s/>]/.test(content)) {
        return 'react'; // Default JSX to React
    }

    return 'unknown';
}

/**
 * Try to extract mount element ID from content
 */
function extractMountElement(
    content: string,
    framework: Framework,
): string | undefined {
    const patterns = FRAMEWORK_PATTERNS[framework];
    for (const pattern of patterns) {
        const match = content.match(pattern);
        if (match && match[1]) {
            return match[1];
        }
    }

    // Generic fallback patterns
    const genericPatterns = [
        /document\.getElementById\s*\(\s*['"`]([^'"`]+)['"`]\s*\)\s*(?:as\s+HTMLElement)?(?:\s*\))?(?:\s*;)?\s*$/m,
        /getElementById\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/,
    ];

    for (const pattern of genericPatterns) {
        const match = content.match(pattern);
        if (match && match[1]) {
            return match[1];
        }
    }

    return undefined;
}

/**
 * Check if file content contains a render/mount call
 */
function hasRenderCall(content: string): boolean {
    const allPatterns = Object.values(FRAMEWORK_PATTERNS).flat();
    return allPatterns.some((pattern) => pattern.test(content));
}

/**
 * Recursively find all source files in a directory
 */
async function findSourceFiles(
    dir: string,
    baseDir: string,
    maxDepth: number = 5,
): Promise<string[]> {
    const files: string[] = [];

    if (maxDepth <= 0) return files;

    try {
        const entries = await readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = join(dir, entry.name);

            // Skip node_modules, hidden dirs, build outputs, and internal dirs (like _bundles)
            if (
                entry.name === 'node_modules' ||
                entry.name.startsWith('.') ||
                entry.name.startsWith('_') ||
                entry.name === 'dist' ||
                entry.name === 'build'
            ) {
                continue;
            }

            if (entry.isDirectory()) {
                const subFiles = await findSourceFiles(
                    fullPath,
                    baseDir,
                    maxDepth - 1,
                );
                files.push(...subFiles);
            } else if (entry.isFile()) {
                const ext = extname(entry.name);
                if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
                    files.push(toPosixPath(relative(baseDir, fullPath)));
                }
            }
        }
    } catch {
        // Directory might not exist or be accessible
    }

    return files;
}

/**
 * Get bundle directories in the project
 */
async function getBundleDirectories(projectDir: string): Promise<string[]> {
    const bundleDirs: string[] = [];

    try {
        const entries = await readdir(projectDir, { withFileTypes: true });

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;

            // Skip special directories
            if (
                entry.name === 'node_modules' ||
                entry.name.startsWith('.') ||
                entry.name.startsWith('_') ||
                entry.name === 'dist' ||
                entry.name === 'build'
            ) {
                continue;
            }

            // Check if it looks like a bundle directory (has source files)
            const bundlePath = join(projectDir, entry.name);
            const hasSource = await hasSourceFiles(bundlePath);
            if (hasSource) {
                bundleDirs.push(entry.name);
            }
        }
    } catch {
        // Ignore errors
    }

    return bundleDirs;
}

/**
 * Check if directory contains source files
 */
async function hasSourceFiles(dir: string): Promise<boolean> {
    try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isFile()) {
                const ext = extname(entry.name);
                if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
                    return true;
                }
            }
            if (
                entry.isDirectory() &&
                !entry.name.startsWith('.') &&
                entry.name !== 'node_modules'
            ) {
                const subHas = await hasSourceFiles(join(dir, entry.name));
                if (subHas) return true;
            }
        }
    } catch {
        // Ignore
    }
    return false;
}

/**
 * Detect entry points in a project
 */
export async function detectEntryPoints(
    projectDir: string,
): Promise<EntryPoint[]> {
    const entryPoints: EntryPoint[] = [];
    const bundleDirs = await getBundleDirectories(projectDir);

    // Search in each bundle directory
    for (const bundleDir of bundleDirs) {
        const bundlePath = join(projectDir, bundleDir);

        // Check common entry directories within the bundle
        for (const entryDir of ENTRY_DIRECTORIES) {
            const searchDir = entryDir
                ? join(bundlePath, entryDir)
                : bundlePath;

            try {
                await stat(searchDir);
            } catch {
                continue; // Directory doesn't exist
            }

            // Check for common entry file names
            for (const fileName of ENTRY_FILE_NAMES) {
                const filePath = join(searchDir, fileName);
                const relativePath = toPosixPath(
                    relative(projectDir, filePath),
                );

                try {
                    const content = await readFile(filePath, 'utf-8');

                    // Check if this file has a render call
                    if (hasRenderCall(content)) {
                        const framework = detectFrameworkFromContent(content);
                        const mountElement = extractMountElement(
                            content,
                            framework,
                        );

                        entryPoints.push({
                            path: relativePath,
                            framework,
                            mountElement,
                            confidence: 0.9,
                            detectionMethod: 'render-call',
                        });
                    }
                } catch {
                    // File doesn't exist or can't be read
                }
            }
        }
    }

    // If no entry points found via render calls, search all files
    if (entryPoints.length === 0) {
        const allFiles = await findSourceFiles(projectDir, projectDir);

        for (const file of allFiles) {
            try {
                const content = await readFile(join(projectDir, file), 'utf-8');

                if (hasRenderCall(content)) {
                    const framework = detectFrameworkFromContent(content);
                    const mountElement = extractMountElement(
                        content,
                        framework,
                    );

                    entryPoints.push({
                        path: file,
                        framework,
                        mountElement,
                        confidence: 0.7,
                        detectionMethod: 'render-call',
                    });
                }
            } catch {
                // Skip files that can't be read
            }
        }
    }

    // If still no entry points, look for main files with framework imports
    if (entryPoints.length === 0) {
        for (const bundleDir of bundleDirs) {
            for (const entryDir of ENTRY_DIRECTORIES) {
                const searchDir = entryDir
                    ? join(projectDir, bundleDir, entryDir)
                    : join(projectDir, bundleDir);

                for (const fileName of [
                    'index.tsx',
                    'index.ts',
                    'main.tsx',
                    'main.ts',
                ]) {
                    const filePath = join(searchDir, fileName);
                    const relativePath = toPosixPath(
                        relative(projectDir, filePath),
                    );

                    try {
                        const content = await readFile(filePath, 'utf-8');
                        const framework = detectFrameworkFromContent(content);

                        if (framework !== 'unknown') {
                            entryPoints.push({
                                path: relativePath,
                                framework,
                                mountElement: 'root', // Default guess
                                confidence: 0.5,
                                detectionMethod: 'main-file',
                            });
                        }
                    } catch {
                        // File doesn't exist
                    }
                }
            }
        }
    }

    // Final fallback: any index.ts/main.ts file (works for vanilla JS, stub files, etc.)
    // No framework detection required - an entry point is just the build starting point
    if (entryPoints.length === 0) {
        for (const bundleDir of bundleDirs) {
            for (const entryDir of ENTRY_DIRECTORIES) {
                const searchDir = entryDir
                    ? join(projectDir, bundleDir, entryDir)
                    : join(projectDir, bundleDir);

                for (const fileName of [
                    'index.ts',
                    'index.tsx',
                    'main.ts',
                    'main.tsx',
                    'index.js',
                    'index.jsx',
                    'main.js',
                    'main.jsx',
                ]) {
                    const filePath = join(searchDir, fileName);
                    const relativePath = toPosixPath(
                        relative(projectDir, filePath),
                    );

                    try {
                        await stat(filePath);
                        entryPoints.push({
                            path: relativePath,
                            framework: 'vanilla',
                            mountElement: undefined,
                            confidence: 0.3,
                            detectionMethod: 'fallback-index',
                        });
                    } catch {
                        // File doesn't exist
                    }
                }
            }
        }
    }

    // Sort by confidence
    entryPoints.sort((a, b) => b.confidence - a.confidence);

    return entryPoints;
}

/**
 * Detect environment variables used in the project
 */
export async function detectEnvVariables(
    projectDir: string,
): Promise<EnvVariable[]> {
    const envVars = new Map<string, EnvVariable>();
    const files = await findSourceFiles(projectDir, projectDir);

    // Patterns to match environment variable usage
    const patterns = [
        /process\.env\.([A-Z][A-Z0-9_]*)/g,
        /import\.meta\.env\.([A-Z][A-Z0-9_]*)/g,
        /\bVITE_([A-Z][A-Z0-9_]*)/g,
    ];

    for (const file of files) {
        try {
            const content = await readFile(join(projectDir, file), 'utf-8');

            for (const pattern of patterns) {
                let match;
                while ((match = pattern.exec(content)) !== null) {
                    const name = match[1];

                    // Skip common built-in vars
                    if (name === 'NODE_ENV') continue;

                    if (envVars.has(name)) {
                        envVars.get(name)!.usedIn.push(file);
                    } else {
                        envVars.set(name, {
                            name,
                            usedIn: [file],
                        });
                    }
                }
            }
        } catch {
            // Skip files that can't be read
        }
    }

    return Array.from(envVars.values());
}

/**
 * Detect the primary framework used in the project
 */
export async function detectPrimaryFramework(
    projectDir: string,
): Promise<Framework> {
    // Check package.json dependencies first
    try {
        const packageJson = JSON.parse(
            await readFile(join(projectDir, 'package.json'), 'utf-8'),
        );
        const deps = {
            ...packageJson.dependencies,
            ...packageJson.devDependencies,
        };

        if (deps['react'] || deps['react-dom']) return 'react';
        if (deps['vue']) return 'vue';
        if (deps['svelte']) return 'svelte';
        if (deps['solid-js']) return 'solid';
        if (deps['preact']) return 'preact';
    } catch {
        // No package.json or can't parse
    }

    // Fall back to scanning files
    const entryPoints = await detectEntryPoints(projectDir);
    if (entryPoints.length > 0) {
        return entryPoints[0].framework;
    }

    return 'unknown';
}

/**
 * Check if project uses SCSS/SASS
 */
export async function usesSass(projectDir: string): Promise<boolean> {
    const files = await findSourceFiles(projectDir, projectDir);

    for (const file of files) {
        if (file.endsWith('.scss') || file.endsWith('.sass')) {
            return true;
        }

        // Also check imports in source files
        try {
            const content = await readFile(join(projectDir, file), 'utf-8');
            if (/import\s+['"][^'"]+\.scss['"]/.test(content)) {
                return true;
            }
        } catch {
            // Skip
        }
    }

    return false;
}

/**
 * Check if project uses CSS modules
 */
export async function usesCssModules(projectDir: string): Promise<boolean> {
    const files = await findSourceFiles(projectDir, projectDir);

    for (const file of files) {
        if (file.includes('.module.css') || file.includes('.module.scss')) {
            return true;
        }
    }

    return false;
}
