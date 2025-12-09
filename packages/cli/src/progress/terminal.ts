/**
 * Terminal utilities for cursor control and ANSI escape codes
 */

export const terminal = {
    // Cursor visibility
    hideCursor: (): string => '\x1b[?25l',
    showCursor: (): string => '\x1b[?25h',

    // Cursor positioning (1-indexed row and column)
    moveTo: (row: number, col: number): string => `\x1b[${row};${col}H`,

    // Line clearing
    clearLine: (): string => '\x1b[2K',

    // Terminal size
    getWidth: (): number => process.stdout.columns || 80,
    getHeight: (): number => process.stdout.rows || 24,

    // TTY detection
    isInteractive: (): boolean => process.stdout.isTTY === true,

    // Write helper
    write: (str: string): void => {
        process.stdout.write(str);
    },
};
