export const queryKeys = {
  companies: {
    all: ["companies"] as const,
    detail: (id: string) => ["companies", id] as const,
    stats: ["companies", "stats"] as const,
  },
  agents: {
    list: (companyId: string) => ["agents", companyId] as const,
    taskOwnerCatalog: (companyId: string) =>
      ["agents", companyId, "task-owner-catalog"] as const,
    detail: (id: string) => ["agents", "detail", id] as const,
    runtimeState: (id: string) => ["agents", "runtime-state", id] as const,
    runtimeConfiguration: (agentId: string, companyId?: string) =>
      [
        "agents",
        agentId,
        "runtime-configuration",
        companyId ?? null,
      ] as const,
    adapterConfigRevisions: (agentId: string) =>
      ["agents", "adapter-config-revisions", agentId] as const,
    currentAdapterConfigRevisionRoot: (agentId: string) =>
      ["agents", "adapter-config-revision-current", agentId] as const,
  },
  tasks: {
    list: (companyId: string) => ["tasks", companyId] as const,
    mentionPool: (companyId: string) => ["tasks", companyId, "mention-pool"] as const,
    search: (companyId: string, q: string, projectId?: string, limit?: number) =>
      ["tasks", companyId, "search", q, projectId ?? "__all-projects__", limit ?? "__no-limit__"] as const,
    listAssignedToMe: (companyId: string) => ["tasks", companyId, "assigned-to-me"] as const,
    listMineByMe: (companyId: string) => ["tasks", companyId, "mine-by-me"] as const,
    listTouchedByMe: (companyId: string) => ["tasks", companyId, "touched-by-me"] as const,
    listUnreadTouchedByMe: (companyId: string) => ["tasks", companyId, "unread-touched-by-me"] as const,
    listBlockedAttention: (companyId: string) => ["tasks", companyId, "blocked-attention"] as const,
    labels: (companyId: string) => ["tasks", companyId, "labels"] as const,
    listByProject: (companyId: string, projectId: string) =>
      ["tasks", companyId, "project", projectId] as const,
    listPluginOperationsByProject: (companyId: string, projectId: string, originKind: string) =>
      ["tasks", companyId, "project", projectId, "plugin-operations", originKind] as const,
    listByParent: (companyId: string, parentId: string) =>
      ["tasks", companyId, "parent", parentId] as const,
    listByDescendantRoot: (companyId: string, rootTaskId: string) =>
      ["tasks", companyId, "descendants", rootTaskId] as const,
    detail: (id: string) => ["tasks", "detail", id] as const,
    comments: (taskId: string) => ["tasks", "comments", taskId] as const,
    costSummary: (taskId: string, options: { excludeRoot?: boolean } = {}) =>
      options.excludeRoot
        ? (["tasks", "cost-summary", taskId, "exclude-root"] as const)
        : (["tasks", "cost-summary", taskId] as const),
    attachments: (taskId: string) => ["tasks", "attachments", taskId] as const,
    attachmentPreview: (attachmentId: string) => ["tasks", "attachment-preview", attachmentId] as const,
    documents: (taskId: string) => ["tasks", "documents", taskId] as const,
    document: (taskId: string, key: string) => ["tasks", "document", taskId, key] as const,
    documentRevisions: (taskId: string, key: string) => ["tasks", "document-revisions", taskId, key] as const,
    documentAnnotations: (taskId: string, key: string, status: "open" | "resolved" | "all" = "all") =>
      ["tasks", "document-annotations", taskId, key, status] as const,
    activity: (taskId: string) => ["tasks", "activity", taskId] as const,
    runs: (taskId: string, status?: readonly string[]) =>
      ["tasks", "runs", taskId, status?.join(",") ?? "all"] as const,
    approvals: (taskId: string) => ["tasks", "approvals", taskId] as const,
    workProducts: (taskId: string) => ["tasks", "work-products", taskId] as const,
  },
  routines: {
    list: (companyId: string, filters?: { projectId?: string | null }) =>
      ["routines", companyId, filters?.projectId ?? "__all-projects__"] as const,
    detail: (id: string) => ["routines", "detail", id] as const,
    runs: (id: string) => ["routines", "runs", id] as const,
    revisions: (id: string) => ["routines", "revisions", id] as const,
    activity: (companyId: string, id: string) => ["routines", "activity", companyId, id] as const,
    documentAnnotations: (routineId: string, key: "description", status: "open" | "resolved" | "all" = "all") =>
      ["routines", "document-annotations", routineId, key, status] as const,
  },
  folders: {
    list: (companyId: string, kind: string) => ["folders", companyId, kind] as const,
  },
  projects: {
    list: (companyId: string) => ["projects", companyId] as const,
    detail: (id: string) => ["projects", "detail", id] as const,
    codebase: (id: string) => ["projects", "detail", id, "codebase"] as const,
  },
  goals: {
    list: (companyId: string) => ["goals", companyId] as const,
    detail: (id: string) => ["goals", "detail", id] as const,
  },
  artifacts: {
    list: (
      companyId: string,
      kind?: string,
      q?: string,
      groupBy?: string,
      groupTaskId?: string,
    ) =>
      [
        "artifacts",
        companyId,
        kind ?? "all",
        q ?? "",
        groupBy ?? "none",
        groupTaskId ?? "",
      ] as const,
  },
  budgets: {
    overview: (companyId: string) => ["budgets", "overview", companyId] as const,
  },
  approvals: {
    list: (companyId: string, status?: string) =>
      ["approvals", companyId, status] as const,
    detail: (approvalId: string) => ["approvals", "detail", approvalId] as const,
    comments: (approvalId: string) => ["approvals", "comments", approvalId] as const,
    tasks: (approvalId: string) => ["approvals", "tasks", approvalId] as const,
  },
  access: {
    invites: (companyId: string, state: string = "all", limit: number = 20) =>
      ["access", "invites", "paginated-v1", companyId, state, limit] as const,
    joinRequests: (companyId: string, status: string = "pending_approval") =>
      ["access", "join-requests", companyId, status] as const,
    companyMembers: (companyId: string) => ["access", "company-members", companyId] as const,
    companyUserDirectory: (companyId: string) => ["access", "company-user-directory", companyId] as const,
    adminUsers: (query: string) => ["access", "admin-users", query] as const,
    userCompanyAccess: (userId: string) => ["access", "user-company-access", userId] as const,
    invite: (token: string) => ["access", "invite", token] as const,
    currentBoardAccess: (userId: string) =>
      ["access", "current-board-access", userId] as const,
  },
  auth: {
    session: ["auth", "session"] as const,
  },
  inboxAgentPolicy: (companyId: string, userId: string) =>
    ["inbox-agent-policy", companyId, userId] as const,
  sidebarPreferences: {
    companyOrder: (userId: string) => ["sidebar-preferences", "company-order", userId] as const,
    projectOrder: (companyId: string, userId: string) =>
      ["sidebar-preferences", "project-order", companyId, userId] as const,
  },
  resourceMemberships: {
    forUser: (companyId: string, userId: string) =>
      ["resource-memberships", companyId, userId] as const,
  },
  instance: {
    settings: ["instance", "settings"] as const,
    generalSettings: ["instance", "general-settings"] as const,
  },
  health: ["health"] as const,
  secrets: {
    list: (companyId: string) => ["secrets", companyId] as const,
    providers: (companyId: string) => ["secret-providers", companyId] as const,
    providerConfigs: (companyId: string) => ["secret-provider-configs", companyId] as const,
    usage: (secretId: string) => ["secrets", "usage", secretId] as const,
    accessEvents: (secretId: string) => ["secrets", "access-events", secretId] as const,
    userDefinitions: (companyId: string) => ["user-secret-definitions", companyId] as const,
    userDefinitionCoverage: (companyId: string, definitionId: string) =>
      ["user-secret-definitions", companyId, definitionId, "coverage"] as const,
    userSecrets: (companyId: string, userId: string) =>
      ["user-secrets", companyId, userId] as const,
  },
  companySearch: {
    search: (companyId: string, q: string, scope: string, limit: number, offset: number) =>
      ["company-search", companyId, q, scope, limit, offset] as const,
  },
  dashboard: (companyId: string) => ["dashboard", companyId] as const,
  attention: (companyId: string) => ["attention", companyId] as const,
  workTimeline: (companyId: string, lens?: string) => ["work-timeline", companyId, lens ?? "all"] as const,
  userProfile: (companyId: string, userId: string) =>
    ["user-profile", companyId, userId] as const,
  sidebarBadges: (companyId: string) => ["sidebar-badges", companyId] as const,
  inboxDismissals: (companyId: string) => ["inbox-dismissals", companyId] as const,
  activity: (companyId: string) => ["activity", companyId] as const,
  costs: (companyId: string, from?: string, to?: string) =>
    ["costs", companyId, from, to] as const,
  financeSummary: (companyId: string, from?: string, to?: string) =>
    ["finance-summary", companyId, from, to] as const,
  runs: (
    companyId: string,
    filters?: { agentId?: string; status?: readonly string[] },
  ) => [
    "runs",
    companyId,
    filters?.agentId ?? "all-agents",
    filters?.status?.join(",") ?? "all-statuses",
  ] as const,
  runDetail: (runId: string) => ["runs", "detail", runId] as const,
  org: (companyId: string) => ["org", companyId] as const,
  plugins: {
    all: ["plugins"] as const,
    catalog: ["plugins", "catalog"] as const,
    detail: (pluginId: string) => ["plugins", pluginId] as const,
    uiContributions: ["plugins", "ui-contributions"] as const,
    config: (pluginId: string) => ["plugins", pluginId, "config"] as const,
    localFolders: (pluginId: string, companyId: string) =>
      ["plugins", pluginId, "companies", companyId, "local-folders"] as const,
    dashboard: (pluginId: string) => ["plugins", pluginId, "dashboard"] as const,
    logs: (pluginId: string) => ["plugins", pluginId, "logs"] as const,
  },
  adapters: {
    all: ["adapters"] as const,
  },
};
