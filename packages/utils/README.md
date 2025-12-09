# @web2local/utils

Shared utility functions for web2local packages.

## Exports

### toPosixPath(filePath)

Converts file paths to POSIX-style forward slashes for cross-platform compatibility.

```typescript
import { toPosixPath } from '@web2local/utils';

toPosixPath('src\\components\\Button.tsx');
// 'src/components/Button.tsx'
```
