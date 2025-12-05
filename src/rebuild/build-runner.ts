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
 * Detect which package manager to use based on lock files
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
 * Resolve the package manager to use, handling 'auto' detection
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
 * Run a command and capture output
 */
async function runCommand(
    command: string,
    args: string[],
    cwd: string,
    onOutput?: (line: string) => void,
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
            if (onOutput) {
                text.split('\n').forEach((line: string) => {
                    if (line.trim()) onOutput(line);
                });
            }
        });

        proc.stderr?.on('data', (data) => {
            const text = data.toString();
            stderr += text;
            if (onOutput) {
                text.split('\n').forEach((line: string) => {
                    if (line.trim()) onOutput(line);
                });
            }
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
 * Parse build errors from output
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
 * Install dependencies
 */
export async function installDependencies(
    projectDir: string,
    onProgress?: (message: string) => void,
    explicitPackageManager?: PackageManager | 'auto',
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

    const { exitCode, stderr } = await runCommand(
        packageManager,
        ['install'],
        projectDir,
        onProgress,
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
 * Run the Vite build
 */
export async function runViteBuild(
    projectDir: string,
    onProgress?: (message: string) => void,
    explicitPackageManager?: PackageManager | 'auto',
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
 * Get list of built files
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
 * Run the full build process
 */
export async function runBuild(options: BuildOptions): Promise<BuildResult> {
    const {
        projectDir,
        recovery = true,
        maxRecoveryAttempts = 3,
        lenient = false,
        verbose = false,
        onProgress,
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
    );

    if (!installResult.success) {
        if (!lenient) {
            return {
                success: false,
                outputDir: join(projectDir, '_rebuilt'),
                durationMs: Date.now() - startTime,
                bundles: [],
                recoveryAttempts,
                warnings,
                errors: [
                    installResult.error || 'Dependency installation failed',
                ],
            };
        }
        warnings.push(
            installResult.error || 'Dependency installation had issues',
        );
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
 * Check if a build output exists
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
