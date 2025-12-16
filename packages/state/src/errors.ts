/**
 * `@web2local/state` - Error definitions
 *
 * Custom error classes for state management operations.
 */

/**
 * Error thrown when attempting to resume from an incompatible state version.
 */
export class IncompatibleStateVersionError extends Error {
    readonly name = 'IncompatibleStateVersionError';

    /**
     * @param foundVersion - The version found in the existing state file
     * @param expectedVersion - The version expected by the current code
     */
    constructor(
        public readonly foundVersion: string,
        public readonly expectedVersion: string,
    ) {
        super(
            `State version ${foundVersion} is not compatible with current version ${expectedVersion}. ` +
                `Use --overwrite to start fresh.`,
        );
    }
}

/**
 * Error thrown when state files are corrupted.
 */
export class CorruptedStateError extends Error {
    readonly name = 'CorruptedStateError';

    /**
     * @param filePath - Path to the corrupted file
     * @param line - Line number where corruption was detected (1-based)
     * @param details - Additional details about the corruption
     */
    constructor(
        public readonly filePath: string,
        public readonly line?: number,
        public readonly details?: string,
    ) {
        const location = line !== undefined ? `:${line}` : '';
        super(
            `State file corrupted at ${filePath}${location}. ` +
                `${details || 'Manual intervention required.'}`,
        );
    }

    /**
     * Whether the corruption is potentially recoverable by truncating the WAL.
     * True if we know the specific line that's corrupted.
     */
    get isRecoverable(): boolean {
        return this.line !== undefined;
    }
}

/**
 * Error thrown when state I/O operations fail.
 */
export class StateIOError extends Error {
    readonly name = 'StateIOError';

    /**
     * @param operation - Description of the operation that failed
     * @param cause - The underlying error that caused the failure
     */
    constructor(
        public readonly operation: string,
        public readonly cause: Error,
    ) {
        super(`State ${operation} failed: ${cause.message}`);
    }
}

/**
 * Error thrown when attempting an invalid state transition.
 */
export class InvalidStateTransitionError extends Error {
    readonly name = 'InvalidStateTransitionError';

    /**
     * @param phase - The phase where the invalid transition was attempted
     * @param currentStatus - The current status of the phase
     * @param attemptedAction - The action that was attempted (e.g., 'start', 'complete')
     */
    constructor(
        public readonly phase: string,
        public readonly currentStatus: string,
        public readonly attemptedAction: string,
    ) {
        super(
            `Invalid state transition: cannot ${attemptedAction} phase '${phase}' ` +
                `when status is '${currentStatus}'.`,
        );
    }
}

/**
 * Error thrown when URL validation fails during resume.
 */
export class UrlMismatchError extends Error {
    readonly name = 'UrlMismatchError';

    /**
     * @param stateUrl - The URL stored in the existing state
     * @param requestedUrl - The URL requested for the current operation
     */
    constructor(
        public readonly stateUrl: string,
        public readonly requestedUrl: string,
    ) {
        super(
            `URL mismatch: state was created for '${stateUrl}' but resume was requested for '${requestedUrl}'. ` +
                `Use --overwrite to start fresh with the new URL.`,
        );
    }
}
