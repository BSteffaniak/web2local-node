/**
 * Terminal utilities for cursor control and ANSI escape codes.
 *
 * Provides low-level terminal manipulation functions for the TUI display.
 */

/**
 * Terminal utility functions for cursor control and ANSI escape sequences.
 *
 * This object provides methods for manipulating terminal output including
 * cursor visibility, positioning, line clearing, and terminal size queries.
 *
 * @example
 * ```typescript
 * // Hide cursor during TUI display
 * terminal.write(terminal.hideCursor());
 *
 * // Move to top-left and clear line
 * terminal.write(terminal.moveTo(1, 1));
 * terminal.write(terminal.clearLine());
 *
 * // Restore cursor when done
 * terminal.write(terminal.showCursor());
 * ```
 */
export const terminal = {
    /**
     * Returns ANSI escape sequence to hide the cursor.
     * @returns The escape sequence string
     */
    hideCursor: (): string => '\x1b[?25l',

    /**
     * Returns ANSI escape sequence to show the cursor.
     * @returns The escape sequence string
     */
    showCursor: (): string => '\x1b[?25h',

    /**
     * Returns ANSI escape sequence to move cursor to specified position.
     * @param row - Row number (1-indexed)
     * @param col - Column number (1-indexed)
     * @returns The escape sequence string
     */
    moveTo: (row: number, col: number): string => `\x1b[${row};${col}H`,

    /**
     * Returns ANSI escape sequence to clear the current line.
     * @returns The escape sequence string
     */
    clearLine: (): string => '\x1b[2K',

    /**
     * Gets the terminal width in columns.
     * @returns Terminal width, defaults to 80 if unavailable
     */
    getWidth: (): number => process.stdout.columns || 80,

    /**
     * Gets the terminal height in rows.
     * @returns Terminal height, defaults to 24 if unavailable
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
