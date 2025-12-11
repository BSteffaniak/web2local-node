import { describe, it, expect } from 'vitest';
import { toPosixPath, runConcurrent } from '../src/index.js';

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

describe('runConcurrent', () => {
    it('should process items concurrently and return results in order', async () => {
        const items = [1, 2, 3, 4, 5];
        const results = await runConcurrent(items, 3, async (item) => item * 2);
        expect(results).toEqual([2, 4, 6, 8, 10]);
    });

    it('should respect concurrency limit', async () => {
        let maxConcurrent = 0;
        let currentConcurrent = 0;

        const items = [1, 2, 3, 4, 5, 6];
        await runConcurrent(items, 2, async (item) => {
            currentConcurrent++;
            maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
            await new Promise((resolve) => setTimeout(resolve, 10));
            currentConcurrent--;
            return item;
        });

        expect(maxConcurrent).toBe(2);
    });

    it('should call onItemComplete for each completed item', async () => {
        const completions: Array<{
            result: number;
            index: number;
            completed: number;
            total: number;
        }> = [];

        await runConcurrent(
            [10, 20, 30],
            2,
            async (item) => item * 2,
            (result, index, completed, total) => {
                completions.push({ result, index, completed, total });
            },
        );

        expect(completions).toHaveLength(3);
        expect(completions.map((c) => c.result).sort()).toEqual([20, 40, 60]);
        expect(completions.every((c) => c.total === 3)).toBe(true);
        // Completed count should be 1, 2, 3 (in some order based on execution)
        expect(completions.map((c) => c.completed).sort()).toEqual([1, 2, 3]);
    });

    it('should handle empty array', async () => {
        const results = await runConcurrent([], 5, async (item) => item);
        expect(results).toEqual([]);
    });

    it('should handle concurrency greater than items length', async () => {
        const results = await runConcurrent(
            [1, 2],
            10,
            async (item) => item * 3,
        );
        expect(results).toEqual([3, 6]);
    });

    it('should propagate errors', async () => {
        await expect(
            runConcurrent([1, 2, 3], 2, async (item) => {
                if (item === 2) throw new Error('test error');
                return item;
            }),
        ).rejects.toThrow('test error');
    });
});
