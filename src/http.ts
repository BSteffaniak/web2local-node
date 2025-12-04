/**
 * Common browser-like headers to avoid bot detection when fetching from websites
 */
export const BROWSER_HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br',
    Connection: 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
};

/** Error codes that are considered transient and worth retrying */
const TRANSIENT_ERROR_CODES = new Set([
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'EPIPE',
    'ENOTFOUND', // DNS can be flaky
    'EAI_AGAIN', // DNS temporary failure
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
]);

/** Default number of retry attempts for transient errors */
const DEFAULT_RETRY_ATTEMPTS = 2;

/** Delay between retry attempts in milliseconds */
const RETRY_DELAY_MS = 1000;

/**
 * Extracts detailed error information from a fetch error.
 * Node.js fetch errors (via undici) wrap the actual cause in error.cause,
 * which can be nested multiple levels deep.
 */
export function getFetchErrorDetails(error: unknown): {
    message: string;
    code?: string;
    cause?: string;
    hint?: string;
} {
    if (!(error instanceof Error)) {
        return { message: String(error) };
    }

    // Build a chain of causes by walking error.cause
    const causes: string[] = [];
    let current: Error | undefined = error;
    let code: string | undefined;

    while (current) {
        // Capture error codes from any level
        if ((current as NodeJS.ErrnoException).code && !code) {
            code = (current as NodeJS.ErrnoException).code;
        }

        // Add unique messages to the chain
        if (current.message && !causes.includes(current.message)) {
            causes.push(current.message);
        }

        current = (current as { cause?: Error }).cause as Error | undefined;
    }

    // Build the cause string
    let causeStr = causes.length > 1 ? causes.slice(1).join(' → ') : undefined;
    if (code && causeStr) {
        causeStr = `[${code}] ${causeStr}`;
    } else if (code) {
        causeStr = `[${code}]`;
    }

    // Determine helpful hints based on error patterns
    const fullText = causes.join(' ').toLowerCase();
    let hint: string | undefined;

    if (code === 'ENOTFOUND' || fullText.includes('getaddrinfo')) {
        hint =
            'DNS resolution failed. Check the URL spelling or your network connection.';
    } else if (code === 'ECONNREFUSED') {
        hint =
            'Connection refused. The server may be down or blocking connections.';
    } else if (code === 'ECONNRESET') {
        hint =
            'Connection reset by server. This may be a transient network issue.';
    } else if (code === 'ETIMEDOUT' || fullText.includes('timeout')) {
        hint = 'Request timed out. The server may be slow or unresponsive.';
    } else if (
        code === 'CERT_HAS_EXPIRED' ||
        fullText.includes('certificate')
    ) {
        hint =
            'SSL certificate error. The site may have an expired or invalid certificate.';
    } else if (fullText.includes('ssl') || fullText.includes('tls')) {
        hint =
            'SSL/TLS handshake failed. There may be a certificate or protocol issue.';
    } else if (code === 'EPROTO') {
        hint =
            'Protocol error. The server may not support the required TLS version.';
    } else if (fullText.includes('socket hang up')) {
        hint =
            'Connection closed unexpectedly. The server may have dropped the connection.';
    }

    return {
        message: causes[0] || 'Unknown error',
        code,
        cause: causeStr,
        hint,
    };
}

/**
 * Formats a fetch error into a human-readable message.
 *
 * @param error - The error thrown by fetch
 * @param url - The URL that was being fetched
 * @param verbose - If true, includes additional details and hints
 */
export function formatFetchError(
    error: unknown,
    url: string,
    verbose = false,
): string {
    const details = getFetchErrorDetails(error);

    let message = `Failed to fetch ${url}: ${details.message}`;

    if (details.cause) {
        message += `\n  Cause: ${details.cause}`;
    }

    if (verbose && details.hint) {
        message += `\n  Hint: ${details.hint}`;
    }

    return message;
}

/**
 * Custom error class for fetch failures with detailed information
 */
export class FetchError extends Error {
    public readonly url: string;
    public readonly code?: string;
    public readonly hint?: string;
    public readonly originalError: unknown;

    constructor(url: string, originalError: unknown) {
        const details = getFetchErrorDetails(originalError);

        let message = details.message;
        if (details.cause) {
            message += ` (${details.cause})`;
        }

        super(message);
        this.name = 'FetchError';
        this.url = url;
        this.code = details.code;
        this.hint = details.hint;
        this.originalError = originalError;
    }

    /**
     * Returns a formatted error message suitable for display
     */
    format(verbose = false): string {
        let msg = `Failed to fetch ${this.url}: ${this.message}`;
        if (verbose && this.hint) {
            msg += `\n  Hint: ${this.hint}`;
        }
        return msg;
    }
}

/**
 * Checks if an error is transient and worth retrying
 */
function isTransientError(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }

    // Walk the cause chain looking for transient error codes
    let current: Error | undefined = error;
    while (current) {
        const code = (current as NodeJS.ErrnoException).code;
        if (code && TRANSIENT_ERROR_CODES.has(code)) {
            return true;
        }
        current = (current as { cause?: Error }).cause as Error | undefined;
    }

    // Also check for common transient error messages
    const message = error.message.toLowerCase();
    if (
        message.includes('socket hang up') ||
        message.includes('other side closed') ||
        message.includes('connection reset')
    ) {
        return true;
    }

    return false;
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RobustFetchOptions extends RequestInit {
    /** Number of retry attempts for transient errors (default: 2) */
    retries?: number;
}

/**
 * Wrapper around fetch that retries on transient errors and provides improved error messages.
 *
 * @param url - The URL to fetch
 * @param options - Fetch options plus optional retry count
 * @returns The fetch Response
 * @throws FetchError with detailed error information on failure
 */
export async function robustFetch(
    url: string,
    options: RobustFetchOptions = {},
): Promise<Response> {
    const { retries = DEFAULT_RETRY_ATTEMPTS, ...fetchOptions } = options;

    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const response = await fetch(url, fetchOptions);
            return response;
        } catch (error) {
            lastError = error;

            // Only retry on transient errors, and not on the last attempt
            if (attempt < retries && isTransientError(error)) {
                // Exponential backoff: 1s, 2s, 4s, etc.
                const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
                await sleep(delay);
                continue;
            }

            // Non-transient error or last attempt - throw with details
            throw new FetchError(url, error);
        }
    }

    // Should not reach here, but just in case
    throw new FetchError(url, lastError);
}
