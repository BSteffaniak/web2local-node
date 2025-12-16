/**
 * Build runner
 *
 * Executes the build process with error handling and recovery
 */

import { spawn } from 'child_process';
import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import type {
    BuildOptions,
    BuildResult,
    RecoverableError,
    PackageManager,
} from './types.js';
import { preserveHtmlIfServerRendered } from './html-generator.js';

/**
 * Detects which package manager to use based on lock files.
 *
 * Checks for pnpm-lock.yaml, yarn.lock, and package-lock.json in order
 * of preference. Defaults to pnpm if no lock file is found.
 *
 * @param projectDir - Project root directory to check
 * @returns The detected package manager
 */
async function detectPackageManager(
    projectDir: string,
): Promise<PackageManager> {
    // Check for lock files - prioritize pnpm over npm
    const lockFiles: Array<{ file: string; manager: PackageManager }> = [
        { file: 'pnpm-lock.yaml', manager: 'pnpm' },
        { file: 'yarn.lock', manager: 'yarn' },
        { file: 'package-lock.json', manager: 'npm' },
    ];

    for (const { file, manager } of lockFiles) {
        try {
            await stat(join(projectDir, file));
            return manager;
        } catch {
            // Lock file doesn't exist
        }
    }

    // Default to pnpm (better for monorepos and disk usage)
    return 'pnpm';
}

/**
 * Resolves the package manager to use, handling 'auto' detection.
 *
 * @param projectDir - Project root directory
 * @param explicit - Explicitly specified package manager or 'auto' for detection
 * @returns The resolved package manager to use
 */
async function resolvePackageManager(
    projectDir: string,
    explicit?: PackageManager | 'auto',
): Promise<PackageManager> {
    if (explicit && explicit !== 'auto') {
        return explicit;
    }
    return detectPackageManager(projectDir);
}

/**
 * Runs a shell command and captures its output.
 *
 * @param command - The command to execute
 * @param args - Arguments to pass to the command
 * @param cwd - Working directory for the command
 * @param onProgress - Optional callback for each output line
 * @param onOutput - Optional callback with stream type (stdout/stderr)
 * @returns Object containing exit code, stdout, and stderr
 */
async function runCommand(
    command: string,
    args: string[],
    cwd: string,
    onProgress?: (line: string) => void,
    onOutput?: (line: string, stream: 'stdout' | 'stderr') => void,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        const proc = spawn(command, args, {
            cwd,
            shell: true,
            env: { ...process.env, FORCE_COLOR: '0' },
        });

        let stdout = '';
        let stderr = '';

        proc.stdout?.on('data', (data) => {
            const text = data.toString();
            stdout += text;
            text.split('\n').forEach((line: string) => {
                if (line.trim()) {
                    onProgress?.(line);
                    onOutput?.(line, 'stdout');
                }
            });
        });

        proc.stderr?.on('data', (data) => {
            const text = data.toString();
            stderr += text;
            text.split('\n').forEach((line: string) => {
                if (line.trim()) {
                    onProgress?.(line);
                    onOutput?.(line, 'stderr');
                }
            });
        });

        proc.on('close', (code) => {
            resolve({ exitCode: code || 0, stdout, stderr });
        });

        proc.on('error', (err) => {
            stderr += err.message;
            resolve({ exitCode: 1, stdout, stderr });
        });
    });
}

/**
 * Parses build errors from command output.
 *
 * Detects various error patterns including missing modules, TypeScript errors,
 * missing type declarations, undefined environment variables, and syntax errors.
 *
 * @param output - Build command output (stdout + stderr combined)
 * @returns Array of parsed recoverable errors with type, message, and suggested fixes
 */
export function parseBuildErrors(output: string): RecoverableError[] {
    const errors: RecoverableError[] = [];

    // Pattern: Cannot find module 'X'
    const moduleNotFound =
        /Cannot find module ['"]([^'"]+)['"]|Module not found.*['"]([^'"]+)['"]/gi;
    let match;
    while ((match = moduleNotFound.exec(output)) !== null) {
        const moduleName = match[1] || match[2];
        errors.push({
            type: 'missing-module',
            message: `Cannot find module '${moduleName}'`,
            suggestedFix: `Install: npm install ${moduleName}`,
        });
    }

    // Pattern: TS2307: Cannot find module './X' or its corresponding type declarations
    const tsModuleNotFound = /TS2307[^\n]*Cannot find module ['"]([^'"]+)['"]/g;
    while ((match = tsModuleNotFound.exec(output)) !== null) {
        errors.push({
            type: 'missing-module',
            message: `TypeScript cannot find module '${match[1]}'`,
            suggestedFix: `Create stub file or install types`,
        });
    }

    // Pattern: TS2304: Cannot find name 'X'
    const nameNotFound = /TS2304[^\n]*Cannot find name ['"]?([^'".\s]+)['"]?/g;
    while ((match = nameNotFound.exec(output)) !== null) {
        errors.push({
            type: 'missing-type',
            message: `Cannot find name '${match[1]}'`,
            suggestedFix: `Add declaration: declare const ${match[1]}: any;`,
        });
    }

    // Pattern: process.env.X is undefined
    const envUndefined = /process\.env\.([A-Z_][A-Z0-9_]*)\s+is\s+undefined/gi;
    while ((match = envUndefined.exec(output)) !== null) {
        errors.push({
            type: 'missing-env',
            message: `Environment variable ${match[1]} is undefined`,
            suggestedFix: `Add to vite.config.ts define section`,
        });
    }

    // Pattern: SyntaxError or Parse error
    const syntaxError = /SyntaxError[^\n]*|Parse error[^\n]*/gi;
    while ((match = syntaxError.exec(output)) !== null) {
        errors.push({
            type: 'syntax-error',
            message: match[0],
        });
    }

    return errors;
}

/**
 * Installs project dependencies using the appropriate package manager.
 *
 * Automatically detects or uses the specified package manager to install
 * dependencies defined in package.json.
 *
 * @param projectDir - Project root directory containing package.json
 * @param onProgress - Optional callback for progress messages
 * @param explicitPackageManager - Explicitly specified package manager or 'auto' for detection
 * @param onOutput - Optional callback for command output with stream type
 * @returns Object with success status, optional error message, and the package manager used
 */
export async function installDependencies(
    projectDir: string,
    onProgress?: (message: string) => void,
    explicitPackageManager?: PackageManager | 'auto',
    onOutput?: (line: string, stream: 'stdout' | 'stderr') => void,
): Promise<{
    success: boolean;
    error?: string;
    packageManager: PackageManager;
}> {
    const packageManager = await resolvePackageManager(
        projectDir,
        explicitPackageManager,
    );

    onProgress?.(`Installing dependencies with ${packageManager}...`);

    const installArgs =
        packageManager === 'pnpm'
            ? ['install', '--ignore-workspace']
            : ['install'];

    const { exitCode, stderr } = await runCommand(
        packageManager,
        installArgs,
        projectDir,
        onProgress,
        onOutput,
    );

    if (exitCode !== 0) {
        return {
            success: false,
            error: `${packageManager} install failed: ${stderr}`,
            packageManager,
        };
    }

    return { success: true, packageManager };
}

/**
 * Runs the Vite build process.
 *
 * Executes the build script using the appropriate package manager and
 * captures any build errors for potential recovery.
 *
 * @param projectDir - Project root directory with vite.config.ts
 * @param onProgress - Optional callback for progress messages
 * @param explicitPackageManager - Explicitly specified package manager or 'auto' for detection
 * @param onOutput - Optional callback for command output with stream type
 * @returns Object with success status, combined output, and parsed errors
 */
export async function runViteBuild(
    projectDir: string,
    onProgress?: (message: string) => void,
    explicitPackageManager?: PackageManager | 'auto',
    onOutput?: (line: string, stream: 'stdout' | 'stderr') => void,
): Promise<{ success: boolean; output: string; errors: RecoverableError[] }> {
    const packageManager = await resolvePackageManager(
        projectDir,
        explicitPackageManager,
    );

    onProgress?.('Running Vite build...');

    const runCmd = packageManager === 'npm' ? 'npm run' : packageManager;
    const { exitCode, stdout, stderr } = await runCommand(
        runCmd,
        ['build'],
        projectDir,
        onProgress,
        onOutput,
    );

    const combinedOutput = stdout + '\n' + stderr;
    const errors = parseBuildErrors(combinedOutput);

    return {
        success: exitCode === 0,
        output: combinedOutput,
        errors,
    };
}

/**
 * Gets a list of all files in the build output directory.
 *
 * Recursively scans the output directory and returns relative paths
 * to all generated files.
 *
 * @param outputDir - Build output directory to scan
 * @returns Array of relative file paths in the output directory
 */
async function getBuiltFiles(outputDir: string): Promise<string[]> {
    const files: string[] = [];

    async function scanDir(dir: string, base: string = '') {
        try {
            const entries = await readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const relativePath = base
                    ? `${base}/${entry.name}`
                    : entry.name;
                if (entry.isDirectory()) {
                    await scanDir(join(dir, entry.name), relativePath);
                } else {
                    files.push(relativePath);
                }
            }
        } catch {
            // Directory doesn't exist
        }
    }

    await scanDir(outputDir);
    return files;
}

/**
 * Runs the full build process including dependency installation.
 *
 * Installs dependencies, runs Vite build, and optionally attempts
 * error recovery. After a successful build, preserves server-rendered
 * HTML if available.
 *
 * @param options - Build configuration options
 * @returns Build result with success status, output directory, bundles, and any warnings/errors
 */
export async function runBuild(options: BuildOptions): Promise<BuildResult> {
    const {
        projectDir,
        recovery = true,
        maxRecoveryAttempts = 3,
        verbose = false,
        onProgress,
        onOutput,
        packageManager: explicitPackageManager,
    } = options;

    const startTime = Date.now();
    const warnings: string[] = [];
    const errors: string[] = [];
    let recoveryAttempts = 0;

    // Install dependencies first
    onProgress?.('Installing dependencies...');
    const installResult = await installDependencies(
        projectDir,
        onProgress,
        explicitPackageManager,
        onOutput,
    );

    if (!installResult.success) {
        return {
            success: false,
            outputDir: join(projectDir, '_rebuilt'),
            durationMs: Date.now() - startTime,
            bundles: [],
            recoveryAttempts,
            warnings,
            errors: [installResult.error || 'Dependency installation failed'],
        };
    }

    // Run the build
    let buildSuccess = false;
    let lastErrors: RecoverableError[] = [];

    while (recoveryAttempts <= maxRecoveryAttempts) {
        onProgress?.(
            recoveryAttempts > 0
                ? `Build attempt ${recoveryAttempts + 1}...`
                : 'Building...',
        );

        const buildResult = await runViteBuild(
            projectDir,
            onProgress,
            explicitPackageManager,
            onOutput,
        );

        if (buildResult.success) {
            buildSuccess = true;
            break;
        }

        lastErrors = buildResult.errors;

        if (!recovery || buildResult.errors.length === 0) {
            // In verbose mode, show full error output; otherwise truncate to last 500 chars
            const output = verbose
                ? buildResult.output
                : buildResult.output.slice(-500);
            errors.push('Build failed: \n' + output);
            break;
        }

        // Try to recover
        recoveryAttempts++;
        if (recoveryAttempts > maxRecoveryAttempts) {
            errors.push(
                `Build failed after ${maxRecoveryAttempts} recovery attempts`,
            );
            for (const err of lastErrors) {
                errors.push(`- ${err.message}`);
            }
            break;
        }

        onProgress?.(
            `Attempting recovery (${recoveryAttempts}/${maxRecoveryAttempts})...`,
        );

        // Log what we're trying to fix
        for (const err of lastErrors) {
            warnings.push(`Attempting to fix: ${err.message}`);
        }

        // Note: Actual recovery would be implemented in error-recovery.ts
        // For now, we just report the errors and break
        errors.push('Automatic recovery not yet implemented');
        break;
    }

    // Get built files
    const outputDir = join(projectDir, '_rebuilt');
    const bundles = buildSuccess ? await getBuiltFiles(outputDir) : [];

    // Preserve server-rendered HTML if available
    if (buildSuccess) {
        try {
            const preserved = await preserveHtmlIfServerRendered(
                projectDir,
                outputDir,
            );
            if (preserved) {
                onProgress?.(
                    'Preserved server-rendered HTML with rebuilt assets',
                );
            }
        } catch (err) {
            warnings.push(
                `Failed to preserve server-rendered HTML: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    return {
        success: buildSuccess,
        outputDir,
        durationMs: Date.now() - startTime,
        bundles,
        recoveryAttempts,
        warnings,
        errors,
    };
}

/**
 * Checks if a build output exists for the project.
 *
 * @param projectDir - Project root directory
 * @returns True if the _rebuilt directory exists and contains files
 */
export async function hasBuildOutput(projectDir: string): Promise<boolean> {
    try {
        const outputDir = join(projectDir, '_rebuilt');
        const files = await readdir(outputDir);
        return files.length > 0;
    } catch {
        return false;
    }
}
