// ============================================================================
// SIGNAL UTILITIES
// ============================================================================

/**
 * Creates an AbortSignal that combines a timeout with an optional user signal.
 * If both are provided, the signal aborts when either triggers.
 *
 * @param timeout - Timeout in milliseconds
 * @param signal - Optional user-provided AbortSignal
 * @returns Combined AbortSignal, or undefined if neither provided
 */
export function createSignalWithTimeout(
    timeout?: number,
    signal?: AbortSignal,
): AbortSignal | undefined {
    if (!timeout && !signal) return undefined;
    if (!timeout) return signal;

    const timeoutSignal = AbortSignal.timeout(timeout);
    if (!signal) return timeoutSignal;

    // Combine both signals - abort when either fires
    return AbortSignal.any([signal, timeoutSignal]);
}

// ============================================================================
// BROWSER HEADERS
// ============================================================================

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

/**
 * Parses the Retry-After header value.
 * Can be either a number of seconds or an HTTP date.
 *
 * @param retryAfter - The Retry-After header value
 * @returns Delay in milliseconds, or null if parsing fails
 */
function parseRetryAfter(retryAfter: string | null): number | null {
    if (!retryAfter) return null;

    // Try parsing as seconds (e.g., "120")
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) {
        return seconds * 1000;
    }

    // Try parsing as HTTP date (e.g., "Wed, 21 Oct 2015 07:28:00 GMT")
    const date = Date.parse(retryAfter);
    if (!isNaN(date)) {
        const delay = date - Date.now();
        return delay > 0 ? delay : null;
    }

    return null;
}

/**
 * Adds jitter to a delay to prevent thundering herd
 *
 * @param delay - Base delay in milliseconds
 * @param jitterFactor - Maximum jitter as a fraction of delay (default: 0.25)
 * @returns Delay with random jitter added
 */
function addJitter(delay: number, jitterFactor: number = 0.25): number {
    const jitter = delay * jitterFactor * Math.random();
    return Math.floor(delay + jitter);
}

export interface RobustFetchOptions extends RequestInit {
    /** Number of retry attempts for transient errors (default: 2) */
    retries?: number;
}

/**
 * Wrapper around fetch that retries on transient errors (including 429 rate limits)
 * and provides improved error messages.
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
    let lastResponse: Response | undefined;

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const response = await fetch(url, fetchOptions);

            // Handle rate limiting (429 Too Many Requests)
            if (response.status === 429 && attempt < retries) {
                lastResponse = response;

                // Use Retry-After header if present, otherwise exponential backoff
                const retryAfterDelay = parseRetryAfter(
                    response.headers.get('Retry-After'),
                );
                const backoffDelay = RETRY_DELAY_MS * Math.pow(2, attempt);
                const delay = retryAfterDelay ?? backoffDelay;

                // Add jitter to prevent thundering herd
                await sleep(addJitter(delay));
                continue;
            }

            // Handle server errors (5xx) with retry
            if (response.status >= 500 && attempt < retries) {
                lastResponse = response;
                const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
                await sleep(addJitter(delay));
                continue;
            }

            return response;
        } catch (error) {
            lastError = error;

            // Only retry on transient errors, and not on the last attempt
            if (attempt < retries && isTransientError(error)) {
                // Exponential backoff: 1s, 2s, 4s, etc.
                const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
                await sleep(addJitter(delay));
                continue;
            }

            // Non-transient error or last attempt - throw with details
            throw new FetchError(url, error);
        }
    }

    // If we exhausted retries due to 429/5xx, return the last response
    // (caller can decide what to do with it)
    if (lastResponse) {
        return lastResponse;
    }

    // Should not reach here, but just in case
    throw new FetchError(url, lastError);
}

/**
 * Common patterns that indicate a path segment is a dynamic parameter
 */
const DYNAMIC_SEGMENT_PATTERNS = [
    // UUIDs (v4)
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    // Numeric IDs
    /^\d+$/,
    // MongoDB ObjectIDs
    /^[0-9a-f]{24}$/i,
    // Short hashes/IDs (6-12 alphanumeric)
    /^[a-z0-9]{6,12}$/i,
    // Base64-ish strings (longer than 20 chars with mixed case/numbers)
    /^[A-Za-z0-9_-]{20,}$/,
    // Date-like segments (YYYY-MM-DD)
    /^\d{4}-\d{2}-\d{2}$/,
    // Timestamps
    /^\d{10,13}$/,
];

/**
 * Common segment names that suggest what type of ID follows
 */
const SEGMENT_CONTEXT_MAP: Record<string, string> = {
    // User/Account related
    users: 'userId',
    user: 'userId',
    accounts: 'accountId',
    account: 'accountId',
    profiles: 'profileId',
    profile: 'profileId',
    members: 'memberId',
    member: 'memberId',

    // Content
    posts: 'postId',
    post: 'postId',
    articles: 'articleId',
    article: 'articleId',
    comments: 'commentId',
    comment: 'commentId',
    pages: 'pageId',
    page: 'pageId',
    documents: 'documentId',
    document: 'documentId',
    docs: 'docId',
    doc: 'docId',

    // E-commerce
    products: 'productId',
    product: 'productId',
    orders: 'orderId',
    order: 'orderId',
    items: 'itemId',
    item: 'itemId',
    carts: 'cartId',
    cart: 'cartId',
    categories: 'categoryId',
    category: 'categoryId',
    invoices: 'invoiceId',
    invoice: 'invoiceId',
    payments: 'paymentId',
    payment: 'paymentId',
    transactions: 'transactionId',
    transaction: 'transactionId',

    // Organization
    organizations: 'orgId',
    organization: 'orgId',
    orgs: 'orgId',
    org: 'orgId',
    teams: 'teamId',
    team: 'teamId',
    companies: 'companyId',
    company: 'companyId',
    groups: 'groupId',
    group: 'groupId',

    // Projects
    projects: 'projectId',
    project: 'projectId',
    workspaces: 'workspaceId',
    workspace: 'workspaceId',
    repos: 'repoId',
    repo: 'repoId',
    repositories: 'repoId',
    repository: 'repoId',

    // Git related
    branches: 'branchId',
    branch: 'branchId',
    commits: 'commitId',
    commit: 'commitId',
    pulls: 'pullId',
    pull: 'pullId',
    issues: 'issueId',
    issue: 'issueId',
    releases: 'releaseId',
    release: 'releaseId',

    // Infrastructure
    servers: 'serverId',
    server: 'serverId',
    nodes: 'nodeId',
    node: 'nodeId',
    clusters: 'clusterId',
    cluster: 'clusterId',
    containers: 'containerId',
    container: 'containerId',
    pods: 'podId',
    pod: 'podId',
    services: 'serviceId',
    service: 'serviceId',
    deployments: 'deploymentId',
    deployment: 'deploymentId',
    environments: 'envId',
    environment: 'envId',
    envs: 'envId',
    env: 'envId',

    // Media
    images: 'imageId',
    image: 'imageId',
    files: 'fileId',
    file: 'fileId',
    assets: 'assetId',
    asset: 'assetId',
    media: 'mediaId',
    videos: 'videoId',
    video: 'videoId',
    photos: 'photoId',
    photo: 'photoId',
    attachments: 'attachmentId',
    attachment: 'attachmentId',
    uploads: 'uploadId',
    upload: 'uploadId',

    // Communication
    messages: 'messageId',
    message: 'messageId',
    notifications: 'notificationId',
    notification: 'notificationId',
    conversations: 'conversationId',
    conversation: 'conversationId',
    chats: 'chatId',
    chat: 'chatId',
    threads: 'threadId',
    thread: 'threadId',
    channels: 'channelId',
    channel: 'channelId',
    emails: 'emailId',
    email: 'emailId',

    // Events/Scheduling
    events: 'eventId',
    event: 'eventId',
    calendars: 'calendarId',
    calendar: 'calendarId',
    appointments: 'appointmentId',
    appointment: 'appointmentId',
    meetings: 'meetingId',
    meeting: 'meetingId',
    schedules: 'scheduleId',
    schedule: 'scheduleId',

    // Tasks/Workflows
    tasks: 'taskId',
    task: 'taskId',
    jobs: 'jobId',
    job: 'jobId',
    workflows: 'workflowId',
    workflow: 'workflowId',
    runs: 'runId',
    run: 'runId',
    builds: 'buildId',
    build: 'buildId',
    pipelines: 'pipelineId',
    pipeline: 'pipelineId',

    // Permissions/Auth
    roles: 'roleId',
    role: 'roleId',
    permissions: 'permissionId',
    permission: 'permissionId',
    tokens: 'tokenId',
    token: 'tokenId',
    sessions: 'sessionId',
    session: 'sessionId',
    keys: 'keyId',
    key: 'keyId',

    // Tags/Labels
    tags: 'tagId',
    tag: 'tagId',
    labels: 'labelId',
    label: 'labelId',

    // Analytics/Monitoring
    reports: 'reportId',
    report: 'reportId',
    dashboards: 'dashboardId',
    dashboard: 'dashboardId',
    metrics: 'metricId',
    metric: 'metricId',
    alerts: 'alertId',
    alert: 'alertId',
    logs: 'logId',
    log: 'logId',

    // Support
    tickets: 'ticketId',
    ticket: 'ticketId',
    cases: 'caseId',
    case: 'caseId',
    incidents: 'incidentId',
    incident: 'incidentId',

    // Subscriptions/Plans
    subscriptions: 'subscriptionId',
    subscription: 'subscriptionId',
    plans: 'planId',
    plan: 'planId',
    features: 'featureId',
    feature: 'featureId',

    // Webhooks/Integrations
    webhooks: 'webhookId',
    webhook: 'webhookId',
    integrations: 'integrationId',
    integration: 'integrationId',
    connections: 'connectionId',
    connection: 'connectionId',

    // Database
    databases: 'databaseId',
    database: 'databaseId',
    tables: 'tableId',
    table: 'tableId',
    collections: 'collectionId',
    collection: 'collectionId',
    records: 'recordId',
    record: 'recordId',
    entries: 'entryId',
    entry: 'entryId',

    // API
    endpoints: 'endpointId',
    endpoint: 'endpointId',
    routes: 'routeId',
    route: 'routeId',
    versions: 'versionId',
    version: 'versionId',
    apis: 'apiId',
    api: 'apiId',

    // Location
    locations: 'locationId',
    location: 'locationId',
    addresses: 'addressId',
    address: 'addressId',
    regions: 'regionId',
    region: 'regionId',
    countries: 'countryId',
    country: 'countryId',
    cities: 'cityId',
    city: 'cityId',
    states: 'stateId',
    state: 'stateId',
    zones: 'zoneId',
    zone: 'zoneId',

    // Recreation/camping specific
    campsites: 'campsiteId',
    campsite: 'campsiteId',
    campgrounds: 'campgroundId',
    campground: 'campgroundId',
    parks: 'parkId',
    park: 'parkId',
    trails: 'trailId',
    trail: 'trailId',
    permits: 'permitId',
    permit: 'permitId',
    reservations: 'reservationId',
    reservation: 'reservationId',
    bookings: 'bookingId',
    booking: 'bookingId',
    facilities: 'facilityId',
    facility: 'facilityId',
    amenities: 'amenityId',
    amenity: 'amenityId',
    tours: 'tourId',
    tour: 'tourId',
    passes: 'passId',
    pass: 'passId',
    entrances: 'entranceId',
    entrance: 'entranceId',

    // Learning
    courses: 'courseId',
    course: 'courseId',
    lessons: 'lessonId',
    lesson: 'lessonId',
    modules: 'moduleId',
    module: 'moduleId',
    quizzes: 'quizId',
    quiz: 'quizId',
    questions: 'questionId',
    question: 'questionId',
    answers: 'answerId',
    answer: 'answerId',

    // Reviews/Feedback
    reviews: 'reviewId',
    review: 'reviewId',
    ratings: 'ratingId',
    rating: 'ratingId',
    feedback: 'feedbackId',
    feedbacks: 'feedbackId',

    // Forms
    forms: 'formId',
    form: 'formId',
    submissions: 'submissionId',
    submission: 'submissionId',
    responses: 'responseId',
    response: 'responseId',
    fields: 'fieldId',
    field: 'fieldId',

    // Templates
    templates: 'templateId',
    template: 'templateId',
    layouts: 'layoutId',
    layout: 'layoutId',
    themes: 'themeId',
    theme: 'themeId',
    styles: 'styleId',
    style: 'styleId',

    // Apps/Plugins
    apps: 'appId',
    app: 'appId',
    applications: 'applicationId',
    application: 'applicationId',
    plugins: 'pluginId',
    plugin: 'pluginId',
    extensions: 'extensionId',
    extension: 'extensionId',
    addons: 'addonId',
    addon: 'addonId',

    // Search
    searches: 'searchId',
    search: 'searchId',
    queries: 'queryId',
    query: 'queryId',
    filters: 'filterId',
    filter: 'filterId',
    results: 'resultId',
    result: 'resultId',

    // Misc
    settings: 'settingId',
    setting: 'settingId',
    configs: 'configId',
    config: 'configId',
    preferences: 'preferenceId',
    preference: 'preferenceId',
    options: 'optionId',
    option: 'optionId',
    steps: 'stepId',
    step: 'stepId',
    stages: 'stageId',
    stage: 'stageId',
    phases: 'phaseId',
    phase: 'phaseId',
    actions: 'actionId',
    action: 'actionId',
    activities: 'activityId',
    activity: 'activityId',
    objects: 'objectId',
    object: 'objectId',
    entities: 'entityId',
    entity: 'entityId',
    instances: 'instanceId',
    instance: 'instanceId',
    snapshots: 'snapshotId',
    snapshot: 'snapshotId',
    backups: 'backupId',
    backup: 'backupId',
    exports: 'exportId',
    export: 'exportId',
    imports: 'importId',
    import: 'importId',
};

/**
 * Result of URL pattern extraction
 */
export interface UrlPatternResult {
    /** Original URL path */
    originalPath: string;
    /** Pattern with :param placeholders */
    pattern: string;
    /** List of parameter names */
    params: string[];
    /** Priority for matching (higher = more specific) */
    priority: number;
}

/**
 * Check if a path segment looks like a dynamic parameter
 */
function isDynamicSegment(segment: string): boolean {
    return DYNAMIC_SEGMENT_PATTERNS.some((pattern) => pattern.test(segment));
}

/**
 * Generate a parameter name based on context
 */
function getParamName(
    segment: string,
    previousSegment: string | null,
    index: number,
): string {
    // Check if previous segment gives us context
    if (previousSegment) {
        const contextName = SEGMENT_CONTEXT_MAP[previousSegment.toLowerCase()];
        if (contextName) {
            return contextName;
        }
    }

    // Check if segment itself looks like a known resource
    const lowerSegment = segment.toLowerCase();
    if (SEGMENT_CONTEXT_MAP[lowerSegment]) {
        return SEGMENT_CONTEXT_MAP[lowerSegment];
    }

    // Fallback to generic param name
    return `param${index}`;
}

/**
 * Calculate pattern priority (more specific patterns get higher priority)
 */
function calculatePriority(pattern: string, params: string[]): number {
    const segments = pattern.split('/').filter(Boolean);
    let priority = 0;

    // More segments = higher base priority
    priority += segments.length * 10;

    // Static segments add more priority than dynamic ones
    for (const segment of segments) {
        if (segment.startsWith(':')) {
            priority += 1; // Dynamic segment
        } else {
            priority += 5; // Static segment
        }
    }

    // Fewer params = more specific = higher priority
    priority -= params.length * 2;

    return priority;
}

/**
 * Extract a URL pattern from a concrete URL path
 *
 * @example
 * extractUrlPattern("/api/users/123/posts/456")
 * // Returns: { pattern: "/api/users/:userId/posts/:postId", params: ["userId", "postId"], ... }
 */
export function extractUrlPattern(urlPath: string): UrlPatternResult {
    // Remove query string if present
    const pathOnly = urlPath.split('?')[0];

    const segments = pathOnly.split('/').filter(Boolean);
    const patternSegments: string[] = [];
    const params: string[] = [];
    let paramIndex = 0;

    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const previousSegment = i > 0 ? segments[i - 1] : null;

        if (isDynamicSegment(segment)) {
            const paramName = getParamName(
                segment,
                previousSegment,
                paramIndex,
            );
            patternSegments.push(`:${paramName}`);
            params.push(paramName);
            paramIndex++;
        } else {
            patternSegments.push(segment);
        }
    }

    const pattern = '/' + patternSegments.join('/');
    const priority = calculatePriority(pattern, params);

    return {
        originalPath: pathOnly,
        pattern,
        params,
        priority,
    };
}

/**
 * Group URLs by their extracted pattern
 */
export function groupUrlsByPattern(urls: string[]): Map<string, string[]> {
    const groups = new Map<string, string[]>();

    for (const url of urls) {
        const { pattern } = extractUrlPattern(url);
        const existing = groups.get(pattern) || [];
        existing.push(url);
        groups.set(pattern, existing);
    }

    return groups;
}

/**
 * Create a filename-safe version of a fixture ID
 */
export function createFixtureFilename(method: string, pattern: string): string {
    // Replace path separators and special chars
    const safePath = pattern
        .replace(/^\//, '') // Remove leading slash
        .replace(/\//g, '_') // Replace slashes with underscores
        .replace(/:/g, '') // Remove colons from params
        .replace(/[^a-zA-Z0-9_-]/g, '_'); // Replace other special chars

    return `${method}_${safePath}.json`;
}
