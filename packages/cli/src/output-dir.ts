/**
 * Output directory resolution and validation utilities.
 */

import { existsSync } from 'fs';
import { rm } from 'fs/promises';
import { join } from 'path';
import prompts from 'prompts';
import chalk from 'chalk';
import {
    StateManager,
    CorruptedStateError,
    IncompatibleStateVersionError,
    type ResumeInfo,
} from '@web2local/state';

/**
 * Result of checking the output directory.
 */
export type OutputDirectoryAction = 'fresh' | 'resume' | 'cancel';

/**
 * Options for checking the output directory.
 */
export interface CheckOutputDirectoryOptions {
    /** Clear existing output directory without prompting */
    overwrite?: boolean;
    /** Resume from checkpoint if available */
    resume?: boolean;
}

/**
 * Resolve the output directory based on CLI options.
 *
 * - If --output is explicitly provided, use it exactly as specified
 * - Otherwise, default to ./output/{hostname}
 *
 * @param outputOption - The --output CLI option value (undefined if not specified)
 * @param hostname - The hostname extracted from the target URL
 * @returns The resolved output directory path
 */
export function resolveOutputDir(
    outputOption: string | undefined,
    hostname: string,
): string {
    if (outputOption !== undefined) {
        return outputOption;
    }
    return join('./output', hostname);
}

/**
 * Check if output directory exists and handle accordingly.
 *
 * - If directory doesn't exist: return 'fresh'
 * - If --overwrite flag is set: delete directory and return 'fresh'
 * - If --resume flag is set: check for checkpoint and return 'resume' or 'fresh'
 * - Otherwise: prompt user for choice (resume/overwrite/cancel)
 *
 * @param outputDir - The resolved output directory path
 * @param options - Options including overwrite and resume flags
 * @returns The action to take: 'fresh', 'resume', or 'cancel'
 * @throws Exits process with code 1 if user cancels
 */
export async function checkOutputDirectory(
    outputDir: string,
    options: CheckOutputDirectoryOptions = {},
): Promise<OutputDirectoryAction> {
    const { overwrite = false, resume = false } = options;

    // Directory doesn't exist - always fresh start
    if (!existsSync(outputDir)) {
        return 'fresh';
    }

    // Explicit overwrite - clear and start fresh
    if (overwrite) {
        console.log(chalk.cyan(`-> Clearing existing directory: ${outputDir}`));
        await rm(outputDir, { recursive: true, force: true });
        return 'fresh';
    }

    // Check for resumable state
    let resumeInfo: ResumeInfo | null = null;
    try {
        resumeInfo = await StateManager.canResume(outputDir);
    } catch (err) {
        if (err instanceof CorruptedStateError) {
            return await handleCorruptedState(outputDir, err);
        }
        if (err instanceof IncompatibleStateVersionError) {
            console.log(
                chalk.yellow(
                    `\n${err.message}\n` +
                        `The checkpoint was created with an older version and cannot be resumed.\n`,
                ),
            );
            // Fall through to prompt for overwrite
        } else {
            throw err;
        }
    }

    // Explicit resume requested
    if (resume) {
        if (!resumeInfo) {
            console.log(
                chalk.yellow(
                    'No valid checkpoint found to resume from. Starting fresh.',
                ),
            );
            return 'fresh';
        }
        console.log(
            chalk.cyan(
                `-> Resuming from checkpoint (${resumeInfo.currentPhase}: ${resumeInfo.progress})`,
            ),
        );
        return 'resume';
    }

    // Interactive prompt
    if (resumeInfo) {
        // Show resume option
        const response = await prompts({
            type: 'select',
            name: 'action',
            message: `Output directory '${outputDir}' exists with checkpoint.`,
            choices: [
                {
                    title: `Resume (${resumeInfo.currentPhase}: ${resumeInfo.progress})`,
                    value: 'resume',
                },
                { title: 'Overwrite (start fresh)', value: 'overwrite' },
                { title: 'Cancel', value: 'cancel' },
            ],
        });

        // Handle Ctrl+C
        if (response.action === undefined) {
            console.log(chalk.yellow('\nOperation cancelled.'));
            process.exit(1);
        }

        if (response.action === 'cancel') {
            console.log(chalk.yellow('Operation cancelled.'));
            process.exit(1);
        }

        if (response.action === 'overwrite') {
            console.log(
                chalk.cyan(`-> Clearing existing directory: ${outputDir}`),
            );
            await rm(outputDir, { recursive: true, force: true });
            return 'fresh';
        }

        return 'resume';
    }

    // No checkpoint - simple overwrite prompt
    const response = await prompts({
        type: 'confirm',
        name: 'overwrite',
        message: `Output directory '${outputDir}' already exists. Overwrite?`,
        initial: false,
    });

    // Handle Ctrl+C (response will be empty object)
    if (response.overwrite === undefined) {
        console.log(chalk.yellow('\nOperation cancelled.'));
        process.exit(1);
    }

    if (!response.overwrite) {
        console.log(chalk.yellow('Operation cancelled.'));
        process.exit(1);
    }

    // User confirmed - clear the directory
    await rm(outputDir, { recursive: true, force: true });
    return 'fresh';
}

/**
 * Handle corrupted state files.
 * Prompts user to choose: continue with potential data loss, overwrite, or cancel.
 */
async function handleCorruptedState(
    outputDir: string,
    error: CorruptedStateError,
): Promise<OutputDirectoryAction> {
    console.log(chalk.red(`\nCorrupted state detected: ${error.message}\n`));

    const choices: Array<{ title: string; value: string }> = [];

    if (error.isRecoverable) {
        console.log(
            chalk.yellow(
                `The write-ahead log appears to have been truncated mid-write.\n` +
                    `Recovery is possible but some recent progress may be lost.\n`,
            ),
        );
        choices.push({
            title: chalk.yellow('Continue anyway (may have data loss)'),
            value: 'continue',
        });
    }

    choices.push(
        {
            title: 'Overwrite (delete everything and start fresh)',
            value: 'overwrite',
        },
        { title: 'Cancel (exit without changes)', value: 'cancel' },
    );

    const response = await prompts({
        type: 'select',
        name: 'action',
        message: 'How would you like to proceed?',
        choices,
    });

    // Handle Ctrl+C
    if (response.action === undefined) {
        console.log(chalk.yellow('\nOperation cancelled.'));
        process.exit(1);
    }

    if (response.action === 'cancel') {
        console.log(chalk.yellow('Operation cancelled.'));
        process.exit(1);
    }

    if (response.action === 'overwrite') {
        console.log(chalk.cyan(`-> Clearing existing directory: ${outputDir}`));
        await rm(outputDir, { recursive: true, force: true });
        return 'fresh';
    }

    // 'continue' - will resume with truncation
    // The StateManager.create() call will need to use truncateCorruptedWal option
    return 'resume';
}

/**
 * Check if we should truncate a corrupted WAL.
 * This is used after handleCorruptedState returns 'resume' to pass the right option.
 */
export async function shouldTruncateCorruptedWal(
    outputDir: string,
): Promise<boolean> {
    try {
        await StateManager.canResume(outputDir);
        return false; // No corruption
    } catch (err) {
        if (err instanceof CorruptedStateError && err.isRecoverable) {
            return true;
        }
        return false;
    }
}
