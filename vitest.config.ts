import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
        setupFiles: ['./test/setup.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html'],
            include: ['src/**/*.ts'],
            exclude: ['src/**/*.test.ts', 'src/cli.ts', 'src/index.ts'],
        },
    },
    resolve: {
        alias: {
            '@web2local/analyzer': resolve('./packages/analyzer/dist/index.js'),
            '@web2local/ast': resolve('./packages/ast/dist/index.js'),
            '@web2local/cache': resolve('./packages/cache/dist/index.js'),
            '@web2local/capture': resolve('./packages/capture/dist/index.js'),
            '@web2local/cli': resolve('./packages/cli/dist/index.js'),
            '@web2local/http': resolve('./packages/http/dist/index.js'),
            '@web2local/manifest': resolve('./packages/manifest/dist/index.js'),
            '@web2local/rebuild': resolve('./packages/rebuild/dist/index.js'),
            '@web2local/scraper': resolve('./packages/scraper/dist/index.js'),
            '@web2local/server': resolve('./packages/server/dist/index.js'),
            '@web2local/stubs': resolve('./packages/stubs/dist/index.js'),
            '@web2local/types': resolve('./packages/types/dist/index.js'),
            web2local: resolve('./packages/web2local/dist/index.js'),
        },
    },
});
