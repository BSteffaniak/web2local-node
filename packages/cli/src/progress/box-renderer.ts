/**
 * Box rendering utilities for the progress display
 */

import chalk from 'chalk';

export interface BoxContent {
    title: string;
    statsLine: string;
    workerLines: string[];
}

// ANSI escape code regex for stripping colors
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

/**
 * Strip ANSI escape codes from a string to get visible length
 */
export function stripAnsi(str: string): string {
    return str.replace(ANSI_REGEX, '');
}

/**
 * Get the visible length of a string (excluding ANSI codes)
 */
export function visibleLength(str: string): number {
    return stripAnsi(str).length;
}

/**
 * Truncate a string to a maximum visible length, adding ellipsis if needed
 */
export function truncate(str: string, maxLen: number): string {
    const visible = stripAnsi(str);
    if (visible.length <= maxLen) {
        return str;
    }

    // For strings with ANSI codes, we need to be more careful
    // Simple approach: strip codes, truncate, lose colors
    // Better approach: iterate and track visible chars
    // Using simple approach for now
    return visible.slice(0, maxLen - 3) + '...';
}

/**
 * Pad a string to a fixed visible length (right-padded with spaces)
 */
export function padRight(str: string, len: number): string {
    const visible = visibleLength(str);
    if (visible >= len) {
        return truncate(str, len);
    }
    return str + ' '.repeat(len - visible);
}

/**
 * Render the progress box
 *
 * @param content - The content to render
 * @param width - Total width of the box
 * @returns Array of lines to write to the terminal
 */
export function renderBox(content: BoxContent, width: number): string[] {
    const lines: string[] = [];

    // Minimum width to render anything useful
    const minWidth = 40;
    const actualWidth = Math.max(width, minWidth);

    // Inner width (excluding "│ " and " │")
    const innerWidth = actualWidth - 4;

    // Box drawing characters
    const topLeft = chalk.cyan('┌');
    const topRight = chalk.cyan('┐');
    const bottomLeft = chalk.cyan('└');
    const bottomRight = chalk.cyan('┘');
    const horizontal = chalk.cyan('─');
    const vertical = chalk.cyan('│');
    const teeLeft = chalk.cyan('├');
    const teeRight = chalk.cyan('┤');

    // Title with padding
    const titleText = ` ${content.title} `;
    const titleLen = titleText.length;
    const remainingWidth = actualWidth - 2 - titleLen; // -2 for corners

    // Top border with title
    lines.push(
        topLeft +
            horizontal +
            chalk.cyan.bold(titleText) +
            horizontal.repeat(Math.max(0, remainingWidth - 1)) +
            topRight,
    );

    // Stats line
    lines.push(
        vertical +
            ' ' +
            padRight(content.statsLine, innerWidth) +
            ' ' +
            vertical,
    );

    // Separator
    lines.push(teeLeft + horizontal.repeat(actualWidth - 2) + teeRight);

    // Worker lines
    for (const workerLine of content.workerLines) {
        lines.push(
            vertical + ' ' + padRight(workerLine, innerWidth) + ' ' + vertical,
        );
    }

    // Bottom border
    lines.push(bottomLeft + horizontal.repeat(actualWidth - 2) + bottomRight);

    return lines;
}
