# @web2local/wrapper

Bundled distribution of the web2local CLI for extracting and reconstructing source code from production websites using publicly available source maps.

## Installation

```bash
npm install @web2local/wrapper
```

### Peer Dependencies

This package requires the following peer dependencies to be installed:

```bash
npm install playwright vite @swc/core hono @hono/node-server
npx playwright install
```

## Usage

```js
import '@web2local/wrapper';
```

Running the import executes the web2local CLI. Pass arguments via `process.argv`.

For CLI options and commands, see the [main documentation](https://github.com/BSteffaniak/web2local-node#readme).

## License

MIT
