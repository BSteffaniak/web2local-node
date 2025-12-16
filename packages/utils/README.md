# @web2local/utils

Shared utility functions for web2local packages.

## Exports

### VERSION

The current version of web2local as a string constant.

```typescript
import { VERSION } from '@web2local/utils';
// '0.0.1-alpha.1'
```

### toPosixPath(filePath)

Converts file paths to POSIX-style forward slashes for cross-platform compatibility.

```typescript
import { toPosixPath } from '@web2local/utils';

toPosixPath('src\\components\\Button.tsx');
// 'src/components/Button.tsx'
```

### runConcurrent(items, concurrency, fn, onItemComplete?)

Executes async functions concurrently with a limit, reporting progress as each individual item completes.

```typescript
import { runConcurrent } from '@web2local/utils';

const results = await runConcurrent(
    urls,
    5, // max concurrent
    async (url) => fetch(url),
    (result, index, completed, total) => {
        console.log(`Completed ${completed}/${total}`);
    },
);
```
