# @web2local/rebuild

Build system integration for reconstructed source code.

## Purpose

Prepares extracted source code for building:

- Generates Vite configuration with detected aliases
- Creates index.html entry point
- Enhances package.json with build dependencies
- Injects global CSS when source maps were unavailable
- Runs the build with error recovery

## Quick Start

```typescript
import { rebuild } from '@web2local/rebuild';

const result = await rebuild({
    projectDir: './my-project',
    packageManager: 'pnpm',
    verbose: true,
    onProgress: (msg) => console.log(msg),
});

if (result.success) {
    console.log(`Built in ${result.durationMs}ms`);
}
```

## API

### rebuild(options)

Full rebuild pipeline: prepare config files, install dependencies, and run the build.

```typescript
const result = await rebuild({
    projectDir: './my-project',
    packageManager: 'auto', // 'npm' | 'pnpm' | 'yarn' | 'auto'
    maxRecoveryAttempts: 3,
    verbose: true,
});
```

### prepareRebuild(options)

Generates configuration files without running the build.

```typescript
import { prepareRebuild } from '@web2local/rebuild';

const result = await prepareRebuild({
    projectDir: './my-project',
    overwrite: false,
});

console.log('Generated:', result.generatedFiles);
// ['vite.config.ts', 'index.html', '.env.example']
```

### analyzeProject(projectDir)

Analyzes a project and returns its configuration.

```typescript
import { analyzeProject } from '@web2local/rebuild';

const config = await analyzeProject('./my-project');
console.log(config.framework); // 'react'
console.log(config.entryPoints); // [{ path: 'src/main.tsx', framework: 'react', ... }]
console.log(config.aliases); // [{ alias: '@/*', path: './src/*' }]
```

### Lower-Level Functions

- `detectEntryPoints(dir)` - Find main entry files
- `detectEnvVariables(dir)` - Find referenced environment variables
- `generateViteConfig(options)` - Generate Vite config content
- `generateHtml(options)` - Generate index.html content
- `enhancePackageJson(options)` - Add build dependencies
- `runBuild(options)` - Execute the build process
- `injectGlobalCss(options)` - Inject captured CSS into entry points

## Notes

### pnpm workspace handling

When using pnpm, `installDependencies` automatically passes `--ignore-workspace` to avoid conflicts when the output directory is inside a pnpm workspace. If you run `pnpm install` manually in an output directory that's inside a workspace, you'll need to include this flag yourself.
