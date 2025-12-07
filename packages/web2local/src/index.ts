#!/usr/bin/env node

import { main } from '@web2local/cli';

// This is the true entry point of the application.
// It imports the main logic from the CLI package and executes it.
main().catch((error) => {
    // This basic error handling is a safeguard.
    // The main function itself should handle its own errors gracefully.
    console.error(
        `\n[web2local] A fatal, unhandled error occurred: ${error.message}`,
    );
    if (process.env.DEBUG) {
        console.error(error.stack);
    }
    process.exit(1);
});
