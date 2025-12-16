/**
 * Terminal utilities for cursor control and ANSI escape codes
 *
 * Provides low-level terminal manipulation functions for building
 * interactive CLI displays.
 */

/**
 * Terminal control utilities for cursor manipulation and display management.
 *
 * @example
 * ```typescript
 * terminal.write(terminal.hideCursor());
 * terminal.write(terminal.moveTo(1, 1));
 * terminal.write('Hello, World!');
 * terminal.write(terminal.showCursor());
 * ```
 */
export const terminal = {
    /**
     * Returns ANSI escape code to hide the cursor.
     * @returns ANSI escape sequence string
     */
    hideCursor: (): string => '\x1b[?25l',

    /**
     * Returns ANSI escape code to show the cursor.
     * @returns ANSI escape sequence string
     */
    showCursor: (): string => '\x1b[?25h',

    /**
     * Returns ANSI escape code to move cursor to a specific position.
     * @param row - Row number (1-indexed)
     * @param col - Column number (1-indexed)
     * @returns ANSI escape sequence string
     */
    moveTo: (row: number, col: number): string => `\x1b[${row};${col}H`,

    /**
     * Returns ANSI escape code to clear the current line.
     * @returns ANSI escape sequence string
     */
    clearLine: (): string => '\x1b[2K',

    /**
     * Gets the terminal width in columns.
     * @returns Terminal width, defaulting to 80 if unavailable
     */
    getWidth: (): number => process.stdout.columns || 80,

    /**
     * Gets the terminal height in rows.
     * @returns Terminal height, defaulting to 24 if unavailable
     */
    getHeight: (): number => process.stdout.rows || 24,

    /**
     * Checks if stdout is an interactive TTY.
     * @returns True if running in an interactive terminal
     */
    isInteractive: (): boolean => process.stdout.isTTY === true,

    /**
     * Writes a string directly to stdout.
     * @param str - The string to write
     */
    write: (str: string): void => {
        process.stdout.write(str);
    },
};
