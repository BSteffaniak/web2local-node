# web2local-node Agent Guidelines

## Project Overview

web2local-node is a TypeScript monorepo for extracting and reconstructing original source code from publicly available source maps. It provides a CLI tool and supporting libraries.

## Build/Test Commands

- **Install**: `pnpm install`
- **Build**: `pnpm build` (all packages via turbo)
- **Test**: `pnpm test` (vitest, all packages)
- **Test single package**: `pnpm test -- --filter=<package>`
- **Typecheck**: `pnpm typecheck`
- **Lint**: `pnpm lint`
- **Format check**: `pnpm pretty`
- **Format fix**: `pnpm pretty:write`
- **Validate all**: `pnpm validate`

## Code Style Guidelines

### TypeScript Patterns

- **Strict TypeScript**: All code must pass strict type checking
- **ESLint**: Code must pass ESLint with the project's configuration
- **Prettier**: All code is formatted with Prettier
- **Imports**: Use ES module imports (`import`/`export`)
- **Async**: Prefer `async`/`await` over raw Promises
- **Error Handling**: Use typed errors; avoid `any` in catch blocks

### Naming Conventions

- **Files**: kebab-case (`source-map.ts`, `css-recovery.ts`)
- **Functions/Variables**: camelCase (`parseSourceMap`, `extractContent`)
- **Types/Interfaces**: PascalCase (`SourceMapData`, `ExtractOptions`)
- **Constants**: SCREAMING_SNAKE_CASE for true constants, camelCase for config objects

### Package Organization

- **Monorepo**: All packages under `packages/`
- **Package Manager**: pnpm with workspaces
- **Build Tool**: turbo for orchestration, tsdown/tsup for bundling
- **Test Framework**: vitest

### Key Packages

| Package     | Purpose                                     |
| ----------- | ------------------------------------------- |
| `web2local` | Main CLI entry point                        |
| `scraper`   | Web scraping and source extraction          |
| `sourcemap` | Source map parsing and validation           |
| `stubs`     | Stub file generation for missing sources    |
| `rebuild`   | Project reconstruction logic                |
| `server`    | Development server for captured fixtures    |
| `manifest`  | Server manifest and package.json generation |
| `cache`     | Caching utilities                           |
| `http`      | HTTP client utilities                       |
| `types`     | Shared TypeScript types                     |

## Test Conventions

- **Framework**: vitest
- **Location**: Tests in `test/` directories within each package, or `*.test.ts` files
- **Naming**: `<name>.test.ts`
- **Structure**: Use `describe`/`it` blocks
- **Mocking**: Use vitest's `vi.mock()`, `vi.spyOn()`
- **Fixtures**: Shared fixtures in root `fixtures/` directory
- **MSW**: Use MSW for HTTP mocking (see `helpers/msw-handlers.ts`)

### Test Example

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('myFunction', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should handle valid input', () => {
        const result = myFunction('input');
        expect(result).toBe('expected');
    });

    it('should throw on invalid input', () => {
        expect(() => myFunction('')).toThrow('Invalid input');
    });
});
```

## Documentation

- **TSDoc**: All public APIs must have TSDoc comments
- **README**: Each package should have a README explaining its purpose
- **Examples**: Complex functions should have `@example` blocks

## Dependencies

- Use exact versions in package.json (managed by syncpack)
- Prefer workspace dependencies for internal packages
- Keep devDependencies in root package.json where possible
