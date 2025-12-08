import { defineConfig } from 'tsdown';

export default defineConfig({
    entry: ['src/index.ts'],
    format: 'esm',
    target: 'node18',
    outDir: 'dist',
    clean: true,
    // Keep heavy native/binary dependencies external
    external: ['playwright', '@swc/core', 'vite', '@hono/node-server', 'hono'],
    // Bundle all @web2local/* packages and pure JS deps
    noExternal: [
        /^@web2local\//,
        'chalk',
        'ora',
        'commander',
        'picocolors',
        'node-html-parser',
    ],
    shims: true,
    sourcemap: true,
});
