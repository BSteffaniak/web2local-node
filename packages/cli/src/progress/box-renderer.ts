/**
 * Box rendering utilities for the progress display.
 *
 * Provides functions for rendering bordered boxes with title, stats, workers,
 * and log sections in the terminal using Unicode box-drawing characters.
 */

import chalk from 'chalk';

/**
 * Content structure for rendering a progress box.
 */
export interface BoxContent {
    /** Title displayed in the top border. */
    title: string;
    /** Stats line displayed below the title. */
    statsLine: string;
    /** Array of worker status lines. */
    workerLines: string[];
    /** Recent log lines to display at the bottom of the box. */
    recentLogs: string[];
    /** Number of additional logs in buffer not shown (0 = hide indicator). */
    moreLogsCount: number;
    /** Total height available for the logs section (including indicator line). */
    recentLogsHeight: number;
}

// ANSI escape code regex for stripping colors
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

/**
 * Strips ANSI escape codes from a string.
 *
 * @param str - The string potentially containing ANSI codes
 * @returns The string with all ANSI escape sequences removed
 */
export function stripAnsi(str: string): string {
    return str.replace(ANSI_REGEX, '');
}

/**
 * Gets the visible length of a string, excluding ANSI escape codes.
 *
 * @param str - The string to measure
 * @returns The number of visible characters
 */
export function visibleLength(str: string): number {
    return stripAnsi(str).length;
}

/**
 * Truncates a string to a maximum visible length, adding ellipsis if needed.
 *
 * @param str - The string to truncate
 * @param maxLen - Maximum visible length
 * @returns The truncated string with ellipsis if it was shortened
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
 * Pads a string to a fixed visible length (right-padded with spaces).
 *
 * If the string is longer than the target length, it will be truncated.
 *
 * @param str - The string to pad
 * @param len - Target visible length
 * @returns The padded or truncated string
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
 * Layout:
 * ┌─ Title ─────────────────────────────────┐
 * │ Stats line                              │
 * ├─────────────────────────────────────────┤
 * │ Worker lines...                         │
 * ├─────────────────────────────────────────┤
 * │ Recent log lines...                     │
 * │                          [+N more logs] │  (only if moreLogsCount \> 0)
 * └─────────────────────────────────────────┘
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

    // Separator after stats
    lines.push(teeLeft + horizontal.repeat(actualWidth - 2) + teeRight);

    // Worker lines
    for (const workerLine of content.workerLines) {
        lines.push(
            vertical + ' ' + padRight(workerLine, innerWidth) + ' ' + vertical,
        );
    }

    // Only show logs section if there's space for it
    if (content.recentLogsHeight > 0) {
        // Separator before logs
        lines.push(teeLeft + horizontal.repeat(actualWidth - 2) + teeRight);

        // Calculate lines available for actual log content
        // If moreLogsCount > 0, we need 1 line for the indicator
        const indicatorNeeded = content.moreLogsCount > 0 ? 1 : 0;
        const logLinesAvailable = content.recentLogsHeight - indicatorNeeded;

        // Recent log lines (show most recent first, pad with empty lines if fewer logs)
        for (let i = 0; i < logLinesAvailable; i++) {
            const logIndex = content.recentLogs.length - 1 - i;
            const logText = logIndex >= 0 ? content.recentLogs[logIndex] : '';
            lines.push(
                vertical +
                    ' ' +
                    padRight(truncate(logText, innerWidth), innerWidth) +
                    ' ' +
                    vertical,
            );
        }

        // Buffer indicator line (only if there are more logs in buffer)
        if (content.moreLogsCount > 0) {
            const indicator = chalk.gray(
                `[+${content.moreLogsCount} more logs]`,
            );
            const indicatorLen = visibleLength(indicator);
            const padding = ' '.repeat(Math.max(0, innerWidth - indicatorLen));
            lines.push(vertical + ' ' + padding + indicator + ' ' + vertical);
        }
    }

    // Bottom border
    lines.push(bottomLeft + horizontal.repeat(actualWidth - 2) + bottomRight);

    return lines;
}
