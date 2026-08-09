export const COMPANY_STATUSES = ["active", "paused", "archived"] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

export const DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const MAX_COMPANY_ATTACHMENT_MAX_BYTES = 1024 * 1024 * 1024;

export const DEPLOYMENT_EXPOSURES = ["private", "public"] as const;
export type DeploymentExposure = (typeof DEPLOYMENT_EXPOSURES)[number];

export const BIND_MODES = ["loopback", "lan", "tailnet", "custom"] as const;
export type BindMode = (typeof BIND_MODES)[number];

export const AGENT_STATUSES = [
  "active",
  "paused",
  "idle",
  "running",
  "error",
  "pending_approval",
  "terminated",
] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/**
 * Agent names are supplied by ACPX at runtime. This empty compatibility export
 * must never be used as an availability catalog; consumers query the ACPX
 * catalog through the server instead.
 */
export const AGENT_ADAPTER_TYPES = [] as const;
export type AgentAdapterType = string & {};

export const AGENT_DEFAULT_MAX_CONCURRENT_RUNS = 20;
export const WORKSPACE_BRANCH_ROUTINE_VARIABLE = "workspaceBranch";

// Config keys owned by one execution target rather than one concrete adapter.
export const ADAPTER_AGNOSTIC_KEYS = [
  "env",
  "timeoutSec",
  "graceSec",
] as const;
export type AdapterAgnosticKey = (typeof ADAPTER_AGNOSTIC_KEYS)[number];

export const MODEL_PROFILE_KEYS = ["cheap"] as const;
export type ModelProfileKey = (typeof MODEL_PROFILE_KEYS)[number];

export const AGENT_ICON_NAMES = [
  "bot",
  "cpu",
  "brain",
  "zap",
  "rocket",
  "code",
  "terminal",
  "shield",
  "eye",
  "search",
  "wrench",
  "hammer",
  "lightbulb",
  "sparkles",
  "star",
  "heart",
  "flame",
  "bug",
  "cog",
  "database",
  "globe",
  "lock",
  "mail",
  "message-square",
  "file-code",
  "git-branch",
  "package",
  "puzzle",
  "target",
  "wand",
  "atom",
  "circuit-board",
  "radar",
  "swords",
  "telescope",
  "microscope",
  "crown",
  "gem",
  "hexagon",
  "pentagon",
  "fingerprint",
] as const;
export type AgentIconName = (typeof AGENT_ICON_NAMES)[number];

/**
 * Curated Lucide icon set for projects (PAP-68 part 3).
 *
 * The first entry, `"folder"`, is the default for any project without an
 * explicit icon. The remaining entries reuse much of the agent icon set plus a
 * handful of folder/structure icons that read well at small tile sizes.
 */
export const PROJECT_ICON_NAMES = [
  "folder",
  "rocket",
  "code",
  "terminal",
  "database",
  "globe",
  "package",
  "boxes",
  "box",
  "layers",
  "briefcase",
  "compass",
  "target",
  "flame",
  "zap",
  "star",
  "bug",
  "wrench",
  "hammer",
  "lightbulb",
  "sparkles",
  "shield",
  "lock",
  "search",
  "cog",
  "brain",
  "cpu",
  "git-branch",
  "file-code",
  "puzzle",
  "gem",
  "atom",
  "heart",
  "mail",
  "message-square",
  "crown",
  "radar",
  "telescope",
  "hexagon",
] as const;
export type ProjectIconName = (typeof PROJECT_ICON_NAMES)[number];

export const ISSUE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "cancelled",
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const INBOX_MINE_ISSUE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
] as const;
export const INBOX_MINE_ISSUE_STATUS_FILTER = INBOX_MINE_ISSUE_STATUSES.join(",");

export const ISSUE_PRIORITIES = ["critical", "high", "medium", "low"] as const;
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];
export const ISSUE_WORK_MODES = ["standard", "ask", "planning", "skill_test"] as const;
export type IssueWorkMode = (typeof ISSUE_WORK_MODES)[number];
export const ISSUE_HARNESS_KINDS = ["skill_test"] as const;
export type IssueHarnessKind = (typeof ISSUE_HARNESS_KINDS)[number];
export const MAX_ISSUE_REQUEST_DEPTH = 1024;

export const ISSUE_COMMENT_AUTHOR_TYPES = ["user", "agent", "plugin", "system"] as const;
export type IssueCommentAuthorType = (typeof ISSUE_COMMENT_AUTHOR_TYPES)[number];

export const ISSUE_COMMENT_PRESENTATION_KINDS = [
  "message",
  "run_progress",
  "system_notice",
] as const;
export type IssueCommentPresentationKind = (typeof ISSUE_COMMENT_PRESENTATION_KINDS)[number];

export const ISSUE_COMMENT_PRESENTATION_TONES = ["neutral", "info", "success", "warning", "danger"] as const;
export type IssueCommentPresentationTone = (typeof ISSUE_COMMENT_PRESENTATION_TONES)[number];

export const ISSUE_COMMENT_METADATA_ROW_TYPES = [
  "text",
  "code",
  "key_value",
  "issue_link",
  "agent_link",
  "run_link",
] as const;
export type IssueCommentMetadataRowType = (typeof ISSUE_COMMENT_METADATA_ROW_TYPES)[number];

export function clampIssueRequestDepth(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(MAX_ISSUE_REQUEST_DEPTH, Math.max(0, Math.floor(value)));
}

export const ISSUE_ORIGIN_KINDS = [
  "manual",
  "routine_execution",
  "system_escalation",
] as const;
export type BuiltInIssueOriginKind = (typeof ISSUE_ORIGIN_KINDS)[number];
export type PluginIssueOriginKind = `plugin:${string}`;
export type IssueOriginKind = BuiltInIssueOriginKind | PluginIssueOriginKind;
export const ISSUE_SURFACE_VISIBILITIES = ["default", "plugin_operation"] as const;
export type IssueSurfaceVisibility = (typeof ISSUE_SURFACE_VISIBILITIES)[number];

export function pluginOperationIssueOriginKind(pluginKey: string): PluginIssueOriginKind {
  return `plugin:${pluginKey}:operation`;
}

export function isPluginOperationIssueOriginKind(originKind: string | null | undefined): boolean {
  return typeof originKind === "string" && /^plugin:[^:]+:operation(?::|$)/.test(originKind);
}

export const ISSUE_RELATION_TYPES = ["blocks"] as const;
export type IssueRelationType = (typeof ISSUE_RELATION_TYPES)[number];

export const ISSUE_TREE_CONTROL_MODES = ["pause", "resume", "cancel", "restore"] as const;
export type IssueTreeControlMode = (typeof ISSUE_TREE_CONTROL_MODES)[number];

export const ISSUE_TREE_HOLD_STATUSES = ["active", "released"] as const;
export type IssueTreeHoldStatus = (typeof ISSUE_TREE_HOLD_STATUSES)[number];

export const ISSUE_TREE_HOLD_RELEASE_POLICY_STRATEGIES = ["manual", "after_active_runs_finish"] as const;
export type IssueTreeHoldReleasePolicyStrategy = (typeof ISSUE_TREE_HOLD_RELEASE_POLICY_STRATEGIES)[number];

export const SYSTEM_ISSUE_DOCUMENT_KEYS = [] as const;
export type SystemIssueDocumentKey = (typeof SYSTEM_ISSUE_DOCUMENT_KEYS)[number];

const SYSTEM_ISSUE_DOCUMENT_KEY_SET = new Set<string>(SYSTEM_ISSUE_DOCUMENT_KEYS);

export function isSystemIssueDocumentKey(key: string): key is SystemIssueDocumentKey {
  return SYSTEM_ISSUE_DOCUMENT_KEY_SET.has(key);
}
export const ISSUE_REFERENCE_SOURCE_KINDS = ["title", "request", "comment", "document"] as const;
export type IssueReferenceSourceKind = (typeof ISSUE_REFERENCE_SOURCE_KINDS)[number];

export const DOCUMENT_ANNOTATION_THREAD_STATUSES = ["open", "resolved"] as const;
export type DocumentAnnotationThreadStatus = (typeof DOCUMENT_ANNOTATION_THREAD_STATUSES)[number];

export const DOCUMENT_ANNOTATION_ANCHOR_STATES = ["active", "stale", "orphaned"] as const;
export type DocumentAnnotationAnchorState = (typeof DOCUMENT_ANNOTATION_ANCHOR_STATES)[number];

export const DOCUMENT_ANNOTATION_ANCHOR_CONFIDENCES = [
  "exact",
  "duplicate",
  "fuzzy",
  "ambiguous",
  "missing",
] as const;
export type DocumentAnnotationAnchorConfidence =
  (typeof DOCUMENT_ANNOTATION_ANCHOR_CONFIDENCES)[number];

export const ISSUE_EXECUTION_POLICY_MODES = ["normal", "auto"] as const;
export type IssueExecutionPolicyMode = (typeof ISSUE_EXECUTION_POLICY_MODES)[number];

export const ISSUE_EXECUTION_STAGE_TYPES = ["review", "approval"] as const;
export type IssueExecutionStageType = (typeof ISSUE_EXECUTION_STAGE_TYPES)[number];

export const ISSUE_MONITOR_SCHEDULED_BY = ["owner", "board"] as const;
export type IssueMonitorScheduledBy = (typeof ISSUE_MONITOR_SCHEDULED_BY)[number];

export const ISSUE_EXECUTION_MONITOR_KINDS = ["external_service"] as const;
export type IssueExecutionMonitorKind = (typeof ISSUE_EXECUTION_MONITOR_KINDS)[number];

export const ISSUE_EXECUTION_MONITOR_RECOVERY_POLICIES = [
  "system_nudge",
  "create_recovery_issue",
  "escalate_to_board",
] as const;
export type IssueExecutionMonitorRecoveryPolicy =
  (typeof ISSUE_EXECUTION_MONITOR_RECOVERY_POLICIES)[number];

export const ISSUE_EXECUTION_STATE_STATUSES = ["idle", "pending", "changes_requested", "completed"] as const;
export type IssueExecutionStateStatus = (typeof ISSUE_EXECUTION_STATE_STATUSES)[number];

export const ISSUE_EXECUTION_MONITOR_STATE_STATUSES = ["scheduled", "triggered", "cleared"] as const;
export type IssueExecutionMonitorStateStatus = (typeof ISSUE_EXECUTION_MONITOR_STATE_STATUSES)[number];

export const ISSUE_EXECUTION_MONITOR_CLEAR_REASONS = [
  "manual",
  "triggered",
  "done",
  "cancelled",
  "invalid_status",
  "invalid_owner",
  "dispatch_skipped",
  "timeout_exceeded",
  "max_attempts_exhausted",
] as const;
export type IssueExecutionMonitorClearReason = (typeof ISSUE_EXECUTION_MONITOR_CLEAR_REASONS)[number];

export const ISSUE_EXECUTION_DECISION_OUTCOMES = ["approved", "changes_requested"] as const;
export type IssueExecutionDecisionOutcome = (typeof ISSUE_EXECUTION_DECISION_OUTCOMES)[number];

export const GOAL_LEVELS = ["company", "team", "agent", "issue"] as const;
export type GoalLevel = (typeof GOAL_LEVELS)[number];

export const GOAL_STATUSES = ["planned", "active", "achieved", "cancelled"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const PROJECT_STATUSES = [
  "backlog",
  "planned",
  "in_progress",
  "completed",
  "cancelled",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const ROUTINE_STATUSES = ["active", "paused", "archived"] as const;
export type RoutineStatus = (typeof ROUTINE_STATUSES)[number];

export const ROUTINE_CONCURRENCY_POLICIES = ["coalesce_if_active", "always_enqueue", "skip_if_active"] as const;
export type RoutineConcurrencyPolicy = (typeof ROUTINE_CONCURRENCY_POLICIES)[number];

export const ROUTINE_CATCH_UP_POLICIES = ["skip_missed", "enqueue_missed_with_cap"] as const;
export type RoutineCatchUpPolicy = (typeof ROUTINE_CATCH_UP_POLICIES)[number];

export const ROUTINE_TRIGGER_KINDS = ["schedule", "webhook", "api"] as const;
export type RoutineTriggerKind = (typeof ROUTINE_TRIGGER_KINDS)[number];

export const ROUTINE_TRIGGER_SIGNING_MODES = ["bearer", "hmac_sha256", "github_hmac", "none"] as const;
export type RoutineTriggerSigningMode = (typeof ROUTINE_TRIGGER_SIGNING_MODES)[number];

export const ROUTINE_VARIABLE_TYPES = ["text", "textarea", "number", "boolean", "select", "date"] as const;
export type RoutineVariableType = (typeof ROUTINE_VARIABLE_TYPES)[number];

export const ROUTINE_RUN_STATUSES = [
  "received",
  "coalesced",
  "skipped",
  "issue_created",
  "completed",
  "failed",
 ] as const;
export type RoutineRunStatus = (typeof ROUTINE_RUN_STATUSES)[number];

export const ROUTINE_RUN_SOURCES = ["schedule", "manual", "api", "webhook"] as const;
export type RoutineRunSource = (typeof ROUTINE_RUN_SOURCES)[number];

export const PAUSE_REASONS = ["manual", "budget", "system", "company_archived"] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

export const PROJECT_COLORS = [
  "#6366f1", // indigo
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#ef4444", // red
  "#f97316", // orange
  "#eab308", // yellow
  "#22c55e", // green
  "#14b8a6", // teal
  "#06b6d4", // cyan
  "#3b82f6", // blue
] as const;

export const APPROVAL_TYPES = [
  "hire_agent",
  "budget_override_required",
  "request_board_approval",
] as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[number];

export const APPROVAL_STATUSES = [
  "pending",
  "revision_requested",
  "approved",
  "rejected",
  "cancelled",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const SECRET_PROVIDERS = [
  "local_encrypted",
  "aws_secrets_manager",
  "gcp_secret_manager",
  "vault",
] as const;
export type SecretProvider = (typeof SECRET_PROVIDERS)[number];

export const SECRET_PROVIDER_CONFIG_STATUSES = [
  "ready",
  "warning",
  "coming_soon",
  "disabled",
] as const;
export type SecretProviderConfigStatus = (typeof SECRET_PROVIDER_CONFIG_STATUSES)[number];

export const SECRET_PROVIDER_CONFIG_HEALTH_STATUSES = [
  "ready",
  "warning",
  "error",
  "coming_soon",
  "disabled",
] as const;
export type SecretProviderConfigHealthStatus =
  (typeof SECRET_PROVIDER_CONFIG_HEALTH_STATUSES)[number];

export const SECRET_STATUSES = ["active", "disabled", "archived", "deleted"] as const;
export type SecretStatus = (typeof SECRET_STATUSES)[number];

export const SECRET_SCOPES = ["company", "user"] as const;
export type SecretScope = (typeof SECRET_SCOPES)[number];

export const SECRET_MANAGED_MODES = ["paperclip_managed", "external_reference"] as const;
export type SecretManagedMode = (typeof SECRET_MANAGED_MODES)[number];

export const SECRET_VERSION_STATUSES = [
  "current",
  "previous",
  "disabled",
  "destroyed",
  "failed",
] as const;
export type SecretVersionStatus = (typeof SECRET_VERSION_STATUSES)[number];

export const SECRET_BINDING_TARGET_TYPES = [
  "agent",
  "project",
  "routine",
  "issue",
  "run",
  "system",
] as const;
export type SecretBindingTargetType = (typeof SECRET_BINDING_TARGET_TYPES)[number];

export const SECRET_ACCESS_OUTCOMES = [
  "success",
  "failure",
  "missing",
  "inactive",
  "not_allowed",
  "optional_omitted",
  "provider_error",
] as const;
export type SecretAccessOutcome = (typeof SECRET_ACCESS_OUTCOMES)[number];

export const SECRET_PROJECTION_CLASSES = ["unclassified", "class_3_static_lease"] as const;
export type SecretProjectionClass = (typeof SECRET_PROJECTION_CLASSES)[number];

export const CLASS3_STATIC_LEASE_ALLOWLIST = [
  {
    key: "slack.bot_token",
    label: "Slack bot token",
    targetType: "agent",
    configPath: "env.SLACK_BOT_TOKEN",
    envKey: "SLACK_BOT_TOKEN",
  },
  {
    key: "slack.bot_token",
    label: "Slack bot token",
    targetType: "routine",
    configPath: "env.SLACK_BOT_TOKEN",
    envKey: "SLACK_BOT_TOKEN",
  },
  {
    key: "discord.bot_token",
    label: "Discord bot token",
    targetType: "agent",
    configPath: "env.DISCORD_BOT_TOKEN",
    envKey: "DISCORD_BOT_TOKEN",
  },
  {
    key: "discord.bot_token",
    label: "Discord bot token",
    targetType: "routine",
    configPath: "env.DISCORD_BOT_TOKEN",
    envKey: "DISCORD_BOT_TOKEN",
  },
] as const;
export type Class3StaticLeaseAllowlistKey = (typeof CLASS3_STATIC_LEASE_ALLOWLIST)[number]["key"];

export const STORAGE_PROVIDERS = ["local_disk", "s3"] as const;
export type StorageProvider = (typeof STORAGE_PROVIDERS)[number];

export const FINANCE_EVENT_KINDS = [
  "inference_charge",
  "platform_fee",
  "credit_purchase",
  "credit_refund",
  "credit_expiry",
  "byok_fee",
  "gateway_overhead",
  "log_storage_charge",
  "logpush_charge",
  "provisioned_capacity_charge",
  "training_charge",
  "custom_model_import_charge",
  "custom_model_storage_charge",
  "manual_adjustment",
] as const;
export type FinanceEventKind = (typeof FINANCE_EVENT_KINDS)[number];

export const FINANCE_DIRECTIONS = ["debit", "credit"] as const;
export type FinanceDirection = (typeof FINANCE_DIRECTIONS)[number];

export const FINANCE_UNITS = [
  "input_token",
  "output_token",
  "cached_input_token",
  "request",
  "credit_usd",
  "credit_unit",
  "model_unit_minute",
  "model_unit_hour",
  "gb_month",
  "train_token",
  "unknown",
] as const;
export type FinanceUnit = (typeof FINANCE_UNITS)[number];

export const BUDGET_SCOPE_TYPES = ["company", "agent", "project"] as const;
export type BudgetScopeType = (typeof BUDGET_SCOPE_TYPES)[number];

export const BUDGET_WINDOW_KINDS = ["calendar_month_utc", "lifetime"] as const;
export type BudgetWindowKind = (typeof BUDGET_WINDOW_KINDS)[number];

export const BUDGET_THRESHOLD_TYPES = ["soft", "hard"] as const;
export type BudgetThresholdType = (typeof BUDGET_THRESHOLD_TYPES)[number];

export const BUDGET_INCIDENT_STATUSES = ["open", "resolved", "dismissed"] as const;
export type BudgetIncidentStatus = (typeof BUDGET_INCIDENT_STATUSES)[number];

export const BUDGET_INCIDENT_RESOLUTION_ACTIONS = [
  "keep_paused",
  "raise_budget_and_resume",
] as const;
export type BudgetIncidentResolutionAction = (typeof BUDGET_INCIDENT_RESOLUTION_ACTIONS)[number];

export const RUN_LIVENESS_STATES = [
  "completed",
  "advanced",
  "plan_only",
  "empty_response",
  "blocked",
  "failed",
  "needs_followup",
] as const;
export type RunLivenessState = (typeof RUN_LIVENESS_STATES)[number];

export const LIVE_EVENT_TYPES = [
  "issue.session.event",
  "issue.execution.plan.live",
  "agent.status",
  "activity.logged",
] as const;
export type LiveEventType = (typeof LIVE_EVENT_TYPES)[number];

export const PRINCIPAL_TYPES = ["user", "agent"] as const;
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

export const MEMBERSHIP_STATUSES = ["pending", "active", "suspended", "archived"] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const COMPANY_MEMBERSHIP_ROLES = [
  "owner",
  "admin",
  "operator",
  "viewer",
  "member",
] as const;
export type CompanyMembershipRole = (typeof COMPANY_MEMBERSHIP_ROLES)[number];

export const HUMAN_COMPANY_MEMBERSHIP_ROLES = [
  "owner",
  "admin",
  "operator",
  "viewer",
] as const;
export type HumanCompanyMembershipRole = (typeof HUMAN_COMPANY_MEMBERSHIP_ROLES)[number];

export const HUMAN_COMPANY_MEMBERSHIP_ROLE_LABELS: Record<HumanCompanyMembershipRole, string> = {
  owner: "Owner",
  admin: "Admin",
  operator: "Operator",
  viewer: "Viewer",
};

export const INSTANCE_USER_ROLES = ["instance_admin"] as const;
export type InstanceUserRole = (typeof INSTANCE_USER_ROLES)[number];

export const INVITE_TYPES = ["company_join", "bootstrap_admin"] as const;
export type InviteType = (typeof INVITE_TYPES)[number];

export const INVITE_JOIN_TYPES = ["human", "agent", "both"] as const;
export type InviteJoinType = (typeof INVITE_JOIN_TYPES)[number];

export const INVITE_SOURCES = [
  "board_api",
  "plugin_host",
  "bootstrap_admin_cli",
] as const;
export type InviteSource = (typeof INVITE_SOURCES)[number];

export const JOIN_REQUEST_TYPES = ["human", "agent"] as const;
export type JoinRequestType = (typeof JOIN_REQUEST_TYPES)[number];

export const JOIN_REQUEST_STATUSES = ["pending_approval", "approved", "rejected"] as const;
export type JoinRequestStatus = (typeof JOIN_REQUEST_STATUSES)[number];

export const PERMISSION_KEYS = [
  "agents:create",
  "agents:configure",
  "agents:suggest-changes",
  "skills:create",
  "skills:suggest-changes",
  "inbox:manage",
  "users:invite",
  "users:manage_permissions",
  "joins:approve",
] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];

const HUMAN_ROLE_PERMISSION_KEYS = {
  owner: [
    "agents:create",
    "agents:configure",
    "skills:create",
    "users:invite",
    "users:manage_permissions",
    "joins:approve",
  ],
  admin: [
    "agents:create",
    "agents:configure",
    "skills:create",
    "users:invite",
    "joins:approve",
  ],
  operator: [],
  viewer: [],
} as const satisfies Record<HumanCompanyMembershipRole, readonly PermissionKey[]>;

export function grantsForHumanRole(
  role: HumanCompanyMembershipRole,
): Array<{ permissionKey: PermissionKey; scope: null }> {
  return HUMAN_ROLE_PERMISSION_KEYS[role].map((permissionKey) => ({
    permissionKey,
    scope: null,
  }));
}


// ---------------------------------------------------------------------------
// Plugin System — see doc/plugins/PLUGIN_SPEC.md for the full specification
// ---------------------------------------------------------------------------

/**
 * The current version of the Plugin API contract.
 *
 * Increment this value whenever a breaking change is made to the plugin API
 * so that the host can reject incompatible plugin manifests.
 *
 * @see PLUGIN_SPEC.md §4 — Versioning
 */
export const PLUGIN_API_VERSION = 1 as const;

/** Exact provider-visible name contract for every Paperclip MCP tool. */
export const MCP_TOOL_NAME_MAX_LENGTH = 128;
const MCP_TOOL_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export function isMcpToolName(value: string): boolean {
  return value.length > 0
    && value.length <= MCP_TOOL_NAME_MAX_LENGTH
    && MCP_TOOL_NAME_PATTERN.test(value);
}

/** Canonical provider-visible name for one plugin-owned agent tool. */
export function pluginAgentToolName(pluginKey: string, toolName: string): string {
  return `${pluginKey}__${toolName}`;
}

/**
 * Lifecycle statuses for an installed plugin.
 *
 * State machine: ready → disabled | error, disabled → ready,
 * error → ready | disabled. Uninstall deletes the installation after its
 * runtime and durable authority have been fenced; it is not a lifecycle state.
 * An upgrade that adds capabilities is rejected rather than represented as a
 * lifecycle state.
 *
 * @see {@link PluginStatus} — inferred union type
 * @see PLUGIN_SPEC.md §21.3 `plugins.status`
 */
export const PLUGIN_STATUSES = [
  "ready",
  "disabled",
  "error",
] as const;
export type PluginStatus = (typeof PLUGIN_STATUSES)[number];

/**
 * Plugin classification categories. A plugin declares one or more categories
 * in its manifest to describe its primary purpose.
 *
 * @see PLUGIN_SPEC.md §6.2
 */
export const PLUGIN_CATEGORIES = [
  "connector",
  "workspace",
  "automation",
  "ui",
] as const;
export type PluginCategory = (typeof PLUGIN_CATEGORIES)[number];

/**
 * Named permissions the host grants to a plugin. Plugins declare required
 * capabilities in their manifest; the host enforces them at each worker and
 * request authority boundary.
 *
 * Grouped into: Data Read, Data Write, Plugin State, Runtime/Integration,
 * Agent Tools, and UI.
 *
 * @see PLUGIN_SPEC.md §15 — Capability Model
 */
export const PLUGIN_CAPABILITIES = [
  // Data Read
  "companies.read",
  "projects.read",
  "issues.read",
  "agents.read",
  "goals.read",
  "goals.create",
  "goals.update",
  "access.members.read",
  "access.invites.read",
  "authorization.grants.read",
  "authorization.policies.read",
  "authorization.audit.read",
  "database.namespace.read",
  // Data Write
  "issues.create",
  "issues.update",
  "issues.withdraw",
  "projects.managed",
  "routines.managed",
  "skills.managed",
  "agents.pause",
  "agents.resume",
  "agents.managed",
  "access.members.write",
  "access.invites.write",
  "authorization.grants.write",
  "authorization.policies.write",
  "activity.log.write",
  "metrics.write",
  "telemetry.track",
  "database.namespace.migrate",
  "database.namespace.write",
  // Plugin State
  "plugin.state.read",
  "plugin.state.write",
  // Runtime / Integration
  "events.subscribe",
  "events.emit",
  "jobs.schedule",
  "webhooks.receive",
  "api.routes.register",
  "http.outbound",
  "http.private-network",
  "local.folders",
  "runtime.context.read",
  "runtime.prompt.observe",
  "runtime.records.read",
  // Agent Tools
  "agent.tools.register",
  // UI
  "instance.settings.register",
  "ui.sidebar.register",
  "ui.page.register",
  "ui.detailTab.register",
  "ui.dashboardWidget.register",
  "ui.action.register",
] as const;
export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

export const PLUGIN_DATABASE_NAMESPACE_STATUSES = [
  "active",
  "migration_failed",
] as const;
export type PluginDatabaseNamespaceStatus = (typeof PLUGIN_DATABASE_NAMESPACE_STATUSES)[number];

export const PLUGIN_DATABASE_MIGRATION_STATUSES = [
  "applied",
  "failed",
] as const;
export type PluginDatabaseMigrationStatus = (typeof PLUGIN_DATABASE_MIGRATION_STATUSES)[number];

export const PLUGIN_DATABASE_CORE_READ_TABLES = [
  "companies",
  "projects",
  "goals",
  "agents",
  "issues",
  "issue_documents",
  "issue_relations",
  "issue_comments",
  "issue_execution_runs",
  "cost_events",
  "approvals",
  "issue_approvals",
  "budget_incidents",
] as const;
export type PluginDatabaseCoreReadTable = (typeof PLUGIN_DATABASE_CORE_READ_TABLES)[number];

export const PLUGIN_API_ROUTE_METHODS = ["GET", "POST", "PATCH", "DELETE"] as const;
export type PluginApiRouteMethod = (typeof PLUGIN_API_ROUTE_METHODS)[number];

/**
 * UI extension slot types. Each slot type corresponds to a mount point in the
 * Paperclip UI where plugin components can be rendered.
 *
 * @see PLUGIN_SPEC.md §19 — UI Extension Model
 */
export const PLUGIN_UI_SLOT_TYPES = [
  "page",
  "detailTab",
  "issueDetailView",
  "dashboardWidget",
  "sidebar",
  "routeSidebar",
  "sidebarPanel",
  "projectSidebarItem",
  "globalToolbarButton",
  "toolbarButton",
  "settingsPage",
  "companySettingsPage",
] as const;
export type PluginUiSlotType = (typeof PLUGIN_UI_SLOT_TYPES)[number];

export const PLUGIN_ENTITY_SCOPED_UI_SLOT_TYPES = [
  "detailTab",
  "issueDetailView",
  "projectSidebarItem",
  "toolbarButton",
] as const satisfies readonly PluginUiSlotType[];

/**
 * Reserved company-scoped route segments that plugin page routes may not claim.
 *
 * These map to first-class host pages under `/:companyPrefix/...`.
 */
export const PLUGIN_RESERVED_COMPANY_ROUTE_SEGMENTS = [
  "dashboard",
  "timeline",
  "onboarding",
  "companies",
  "company",
  "skills",
  "org",
  "agents",
  "projects",
  "issues",
  "search",
  "routines",
  "artifacts",
  "approvals",
  "costs",
  "activity",
  "inbox",
  "u",
  "design-guide",
  "instance",
] as const;
export type PluginReservedCompanyRouteSegment =
  (typeof PLUGIN_RESERVED_COMPANY_ROUTE_SEGMENTS)[number];

/**
 * Reserved route segments under `/:companyPrefix/company/settings/...` that
 * plugin company settings pages may not claim.
 */
export const PLUGIN_RESERVED_COMPANY_SETTINGS_ROUTE_SEGMENTS = [
  "members",
  "invites",
  "secrets",
  "instance",
] as const;
export type PluginReservedCompanySettingsRouteSegment =
  (typeof PLUGIN_RESERVED_COMPANY_SETTINGS_ROUTE_SEGMENTS)[number];

/**
 * Launcher placement zones describe where a plugin-owned launcher can appear
 * in the host UI. These are intentionally aligned with current slot surfaces
 * so manifest authors can describe launch intent without coupling to a single
 * component implementation detail.
 */
export const PLUGIN_LAUNCHER_PLACEMENT_ZONES = [
  "sidebar",
  "globalToolbarButton",
  "toolbarButton",
] as const;
export type PluginLauncherPlacementZone = (typeof PLUGIN_LAUNCHER_PLACEMENT_ZONES)[number];

export const PLUGIN_ENTITY_SCOPED_LAUNCHER_PLACEMENT_ZONES = [
  "toolbarButton",
] as const satisfies readonly PluginLauncherPlacementZone[];

/**
 * Launcher action kinds describe what the launcher does when activated.
 */
export const PLUGIN_LAUNCHER_ACTIONS = [
  "navigate",
  "openModal",
  "openDrawer",
  "openPopover",
  "performAction",
  "deepLink",
] as const;
export type PluginLauncherAction = (typeof PLUGIN_LAUNCHER_ACTIONS)[number];

/**
 * Optional size hints the host can use when rendering plugin-owned launcher
 * destinations such as overlays, drawers, or full-page navigation.
 */
export const PLUGIN_LAUNCHER_BOUNDS = [
  "inline",
  "compact",
  "default",
  "wide",
  "full",
] as const;
export type PluginLauncherBounds = (typeof PLUGIN_LAUNCHER_BOUNDS)[number];

/** Concrete host container used by component-rendering launchers. */
export const PLUGIN_LAUNCHER_RENDER_ENVIRONMENTS = ["hostOverlay"] as const;
export type PluginLauncherRenderEnvironment =
  (typeof PLUGIN_LAUNCHER_RENDER_ENVIRONMENTS)[number];

/**
 * Entity types that a `detailTab` UI slot can attach to.
 *
 * @see PLUGIN_SPEC.md §19.3 — Detail Tabs
 */
export const PLUGIN_UI_SLOT_ENTITY_TYPES = [
  "project",
  "issue",
] as const;
export type PluginUiSlotEntityType = (typeof PLUGIN_UI_SLOT_ENTITY_TYPES)[number];

/**
 * Scope kinds for plugin state storage. Determines the granularity at which
 * a plugin stores key-value state data.
 *
 * @see PLUGIN_SPEC.md §21.3 `plugin_state.scope_kind`
 */
export const PLUGIN_STATE_SCOPE_KINDS = [
  "instance",
  "company",
  "project",
  "agent",
  "issue",
  "goal",
  "run",
] as const;
export type PluginStateScopeKind = (typeof PLUGIN_STATE_SCOPE_KINDS)[number];

/** Statuses for a plugin's scheduled job definition. */
export const PLUGIN_JOB_STATUSES = [
  "active",
  "removed",
] as const;
export type PluginJobStatus = (typeof PLUGIN_JOB_STATUSES)[number];

/** Levels persisted by the plugin runtime and accepted by the plugin logs API. */
export const PLUGIN_LOG_LEVELS = [
  "debug",
  "info",
  "warn",
  "error",
  "metric",
] as const;
export type PluginLogLevel = (typeof PLUGIN_LOG_LEVELS)[number];
export type PluginWorkerLogLevel = Exclude<PluginLogLevel, "metric">;

/** Statuses for individual job run executions. */
export const PLUGIN_JOB_RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type PluginJobRunStatus = (typeof PLUGIN_JOB_RUN_STATUSES)[number];

/** What triggered a particular job run. */
export const PLUGIN_JOB_RUN_TRIGGERS = [
  "schedule",
  "manual",
] as const;
export type PluginJobRunTrigger = (typeof PLUGIN_JOB_RUN_TRIGGERS)[number];

/** Statuses for inbound webhook deliveries. */
export const PLUGIN_WEBHOOK_DELIVERY_STATUSES = [
  "pending",
  "success",
  "failed",
] as const;
export type PluginWebhookDeliveryStatus = (typeof PLUGIN_WEBHOOK_DELIVERY_STATUSES)[number];

/**
 * Core domain event types that plugins can subscribe to via the
 * `events.subscribe` capability.
 *
 * @see PLUGIN_SPEC.md §16 — Event System
 */
export const PLUGIN_EVENT_TYPES = [
  "issue.board.comment.created",
  "agent.run.finished",
  "agent.run.failed",
  "agent.run.cancelled",
] as const;
export type PluginEventType = (typeof PLUGIN_EVENT_TYPES)[number];

/**
 * Error codes returned by the plugin bridge when a UI → worker call fails.
 *
 * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
 */
export const PLUGIN_BRIDGE_ERROR_CODES = [
  "WORKER_UNAVAILABLE",
  "CAPABILITY_DENIED",
  "INVOCATION_SCOPE_DENIED",
  "WORKER_ERROR",
  "TIMEOUT",
  "UNKNOWN",
] as const;
export type PluginBridgeErrorCode = (typeof PLUGIN_BRIDGE_ERROR_CODES)[number];

/** Canonical structured failure returned by a plugin UI bridge call. */
export interface PluginBridgeError {
  /** Machine-readable bridge error code. */
  code: PluginBridgeErrorCode;
  /** Human-readable failure description. */
  message: string;
  /** Sanitized host or worker diagnostics, when available. */
  details?: unknown;
}
