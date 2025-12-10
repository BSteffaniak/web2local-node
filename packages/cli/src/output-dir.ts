/**
 * Output directory resolution and validation utilities.
 */

import { existsSync } from 'fs';
import { rm } from 'fs/promises';
import { join } from 'path';
import prompts from 'prompts';
import chalk from 'chalk';

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
 * - If directory doesn't exist: return immediately
 * - If --overwrite flag is set: delete directory without prompting
 * - Otherwise: prompt user for confirmation
 *
 * @param outputDir - The resolved output directory path
 * @param overwrite - Whether the --overwrite flag was specified
 * @throws Exits process with code 1 if user cancels
 */
export async function checkOutputDirectory(
    outputDir: string,
    overwrite: boolean,
): Promise<void> {
    if (!existsSync(outputDir)) {
        return;
    }

    if (overwrite) {
        console.log(chalk.cyan(`-> Clearing existing directory: ${outputDir}`));
        await rm(outputDir, { recursive: true, force: true });
        return;
    }

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
}
