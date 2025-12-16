#!/usr/bin/env node
/**
 * Entry point for the web2local CLI application.
 *
 * This module serves as the executable wrapper that bootstraps the CLI by
 * importing and invoking the main function from `@web2local/cli`. It provides
 * top-level error handling for any fatal, unhandled errors that escape the
 * CLI's own error management.
 *
 * @packageDocumentation
 */

import { main } from '@web2local/cli';

main().catch((error) => {
    console.error(
        `\n[web2local] A fatal, unhandled error occurred: ${error.message}`,
    );
    if (process.env.DEBUG) {
        console.error(error.stack);
    }
    process.exit(1);
});
