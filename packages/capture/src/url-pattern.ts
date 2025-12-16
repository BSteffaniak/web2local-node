/**
 * URL pattern extraction and matching utilities
 *
 * Converts concrete URLs like "/api/users/123/posts/456"
 * into patterns like "/api/users/:userId/posts/:postId"
 */

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
    pathParams: string[];
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
function calculatePriority(pattern: string, pathParams: string[]): number {
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
    priority -= pathParams.length * 2;

    return priority;
}

/**
 * Extract a URL pattern from a concrete URL path.
 *
 * Converts dynamic path segments (like UUIDs, numeric IDs, etc.) into
 * named parameter placeholders based on context.
 *
 * @param urlPath - The URL path to extract a pattern from (may include query string)
 * @returns Pattern result with the normalized pattern, parameter names, and priority
 *
 * @example
 * ```typescript
 * extractUrlPattern("/api/users/123/posts/456")
 * // Returns: { pattern: "/api/users/:userId/posts/:postId", pathParams: ["userId", "postId"], ... }
 * ```
 */
export function extractUrlPattern(urlPath: string): UrlPatternResult {
    // Remove query string if present
    const pathOnly = urlPath.split('?')[0];

    const segments = pathOnly.split('/').filter(Boolean);
    const patternSegments: string[] = [];
    const pathParams: string[] = [];
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
            pathParams.push(paramName);
            paramIndex++;
        } else {
            patternSegments.push(segment);
        }
    }

    const pattern = '/' + patternSegments.join('/');
    const priority = calculatePriority(pattern, pathParams);

    return {
        originalPath: pathOnly,
        pattern,
        pathParams,
        priority,
    };
}

/**
 * Group URLs by their extracted pattern.
 *
 * @param urls - Array of URLs to group
 * @returns Map from pattern string to array of original URLs
 *
 * @example
 * ```typescript
 * groupUrlsByPattern(['/users/1', '/users/2', '/posts/1'])
 * // Returns: Map { '/users/:userId' => ['/users/1', '/users/2'], '/posts/:postId' => ['/posts/1'] }
 * ```
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
 * Create a filename-safe version of a fixture ID.
 *
 * @param method - HTTP method (GET, POST, etc.)
 * @param pattern - URL pattern with parameter placeholders
 * @returns A safe filename string like "GET_api_users_userId.json"
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

/**
 * Generate a unique fixture ID.
 *
 * @param method - HTTP method (GET, POST, etc.)
 * @param pattern - URL pattern with parameter placeholders
 * @param index - Numeric index to ensure uniqueness
 * @returns A unique fixture ID string like "0001_GET_api-users-userId"
 */
export function generateFixtureId(
    method: string,
    pattern: string,
    index: number,
): string {
    const paddedIndex = String(index).padStart(4, '0');
    const safePattern = pattern
        .replace(/^\//, '')
        .replace(/\//g, '-')
        .replace(/:/g, '')
        .replace(/[^a-zA-Z0-9-]/g, '-');

    return `${paddedIndex}_${method}_${safePattern}`;
}
