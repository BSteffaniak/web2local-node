import { describe, it, expect } from 'vitest';
import { toPosixPath } from '../src/index.js';

describe('toPosixPath', () => {
    it('should convert backslashes to forward slashes', () => {
        expect(toPosixPath('src\\components\\Button.tsx')).toBe(
            'src/components/Button.tsx',
        );
    });

    it('should handle paths with mixed separators', () => {
        expect(toPosixPath('src/components\\Button.tsx')).toBe(
            'src/components/Button.tsx',
        );
    });

    it('should leave forward slashes unchanged', () => {
        expect(toPosixPath('src/components/Button.tsx')).toBe(
            'src/components/Button.tsx',
        );
    });

    it('should handle empty string', () => {
        expect(toPosixPath('')).toBe('');
    });

    it('should handle Windows-style absolute paths', () => {
        expect(toPosixPath('C:\\Users\\name\\project\\src')).toBe(
            'C:/Users/name/project/src',
        );
    });

    it('should handle relative paths with ..', () => {
        expect(toPosixPath('..\\..\\src\\index.ts')).toBe('../../src/index.ts');
    });
});
