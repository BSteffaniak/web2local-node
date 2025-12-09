/**
 * Terminal utilities for cursor control and ANSI escape codes
 */

export const terminal = {
    // Cursor visibility
    hideCursor: (): string => '\x1b[?25l',
    showCursor: (): string => '\x1b[?25h',

    // Cursor movement
    moveUp: (n: number): string => (n > 0 ? `\x1b[${n}A` : ''),
    moveDown: (n: number): string => (n > 0 ? `\x1b[${n}B` : ''),
    moveToColumn: (n: number): string => `\x1b[${n}G`,

    // Cursor positioning (1-indexed row and column)
    moveTo: (row: number, col: number): string => `\x1b[${row};${col}H`,
    saveCursor: (): string => '\x1b[s',
    restoreCursor: (): string => '\x1b[u',

    // Scroll region (1-indexed, inclusive)
    setScrollRegion: (top: number, bottom: number): string =>
        `\x1b[${top};${bottom}r`,
    resetScrollRegion: (): string => '\x1b[r',

    // Scroll content up within current scroll region
    scrollUp: (n: number): string => (n > 0 ? `\x1b[${n}S` : ''),

    // Line clearing
    clearLine: (): string => '\x1b[2K',
    clearToEnd: (): string => '\x1b[0J',

    // Terminal size
    getWidth: (): number => process.stdout.columns || 80,
    getHeight: (): number => process.stdout.rows || 24,

    // TTY detection
    isInteractive: (): boolean => process.stdout.isTTY === true,

    // Write helpers
    write: (str: string): void => {
        process.stdout.write(str);
    },

    writeLine: (str: string): void => {
        process.stdout.write(str + '\n');
    },
};
