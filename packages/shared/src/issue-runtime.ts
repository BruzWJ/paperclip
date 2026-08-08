/**
 * Canonical, closed vocabulary for the issue-execution runtime.
 *
 * This module is intentionally independent from the legacy issue and agent
 * contracts. Runtime cutover code imports these atoms directly; legacy
 * workflow/status contracts are removed only at the fenced cutover.
 */

export const AGENT_CONTEXT_GRANT_KEYS = [
  "carry_context",
  "read_issue_comments",
  "read_issue_agent_run",
  "list_sub_issues",
  "read_sub_issue_comments",
  "read_sub_issue_agent_run",
  "list_company_issues",
  "read_company_issue_comments",
  "read_company_issue_agent_run",
] as const;

export type AgentContextGrantKey = (typeof AGENT_CONTEXT_GRANT_KEYS)[number];

export type ContextAccess = Partial<
  Record<AgentContextGrantKey, false>
>;

export type RawContextAccess = Partial<
  Record<AgentContextGrantKey, boolean>
>;

/**
 * Canonicalize a creation-time context-access mask exactly once.
 *
 * Raw `true` means "leave the grant unchanged" and therefore disappears;
 * raw `false` is the only durable value. Empty canonical identity is stored
 * as null rather than as a second equivalent representation.
 */
export function normalizeContextAccess(
  value: unknown,
): ContextAccess | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Context access mask must be an object");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set<string>(AGENT_CONTEXT_GRANT_KEYS);
  for (const [key, enabled] of Object.entries(input)) {
    if (!allowed.has(key) || typeof enabled !== "boolean") {
      throw new TypeError(
        "Context access mask accepts only known boolean context-grant keys",
      );
    }
  }
  const canonical: ContextAccess = {};
  for (const key of AGENT_CONTEXT_GRANT_KEYS) {
    if (input[key] === false) canonical[key] = false;
  }
  return Object.keys(canonical).length > 0 ? canonical : null;
}

export interface IssueDisposition {
  message: string;
  structuredResult?: unknown;
}

export function decodeIssueDisposition(value: unknown): IssueDisposition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Issue disposition must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.some(
      (key) => key !== "message" && key !== "structuredResult",
    ) ||
    typeof record.message !== "string" ||
    record.message.trim().length === 0
  ) {
    throw new TypeError(
      "Issue disposition must contain a non-empty message and only the optional structuredResult field",
    );
  }
  if (
    Object.hasOwn(record, "structuredResult") &&
    record.structuredResult === undefined
  ) {
    throw new TypeError(
      "Issue disposition structuredResult must be omitted rather than undefined",
    );
  }
  return Object.hasOwn(record, "structuredResult")
    ? {
        message: record.message,
        structuredResult: record.structuredResult,
      }
    : { message: record.message };
}

export const SYSTEM_CREATOR_SOURCE_KINDS = [
  "recovery",
  "liveness",
] as const;

export type SystemCreatorSourceKind =
  (typeof SYSTEM_CREATOR_SOURCE_KINDS)[number];

export function isSystemCreatorSourceKind(
  value: unknown,
): value is SystemCreatorSourceKind {
  return (
    typeof value === "string" &&
    (SYSTEM_CREATOR_SOURCE_KINDS as readonly string[]).includes(value)
  );
}

export function decodeSystemCreatorSourceKind(
  value: unknown,
): SystemCreatorSourceKind {
  if (!isSystemCreatorSourceKind(value)) {
    throw new TypeError(
      "System creator source must be recovery or liveness",
    );
  }
  return value;
}

export const ISSUE_CREATOR_EDGE_TERMINAL_REASONS = [
  "creator_execution_superseded",
  "agent_terminated",
  "agent_deleted",
  "plugin_disabled",
  "plugin_uninstalled",
  "routine_deleted",
] as const;

export type IssueCreatorEdgeTerminalReason =
  (typeof ISSUE_CREATOR_EDGE_TERMINAL_REASONS)[number];

export function isIssueCreatorEdgeTerminalReason(
  value: unknown,
): value is IssueCreatorEdgeTerminalReason {
  return (
    typeof value === "string" &&
    (ISSUE_CREATOR_EDGE_TERMINAL_REASONS as readonly string[]).includes(value)
  );
}

export function decodeIssueCreatorEdgeTerminalReason(
  value: unknown,
): IssueCreatorEdgeTerminalReason {
  if (!isIssueCreatorEdgeTerminalReason(value)) {
    throw new TypeError("Creator edge has a non-canonical terminal reason");
  }
  return value;
}

/**
 * Configurable agent action grants. Relationship-derived issue authority is
 * intentionally absent: creating an issue permits assignment, while issue
 * updates compile from the active creator/owner relationship.
 */
export const PAPERCLIP_ACTION_KEYS = [
  "issue_create",
  "mention_agent",
  "mention_board",
  "agent_hire",
  "agent_configure",
] as const;

export type PaperclipActionKey = (typeof PAPERCLIP_ACTION_KEYS)[number];

/**
 * Closed runtime tool vocabulary. `issue_assign` and `issue_update` are
 * runtime actions, but never independently configurable grants.
 */
export const PAPERCLIP_RUNTIME_ACTION_KEYS = [
  "issue_create",
  "issue_assign",
  "issue_update",
  "mention_agent",
  "mention_board",
  "agent_hire",
  "agent_configure",
] as const;

export type PaperclipRuntimeActionKey =
  (typeof PAPERCLIP_RUNTIME_ACTION_KEYS)[number];

export const AGENT_MENTION_REACH_GRANT_KEYS = [
  "mention_any_descendant",
  "mention_any_ancestor",
] as const;

export type AgentMentionReachGrantKey =
  (typeof AGENT_MENTION_REACH_GRANT_KEYS)[number];

export type SparseBooleanGrantMap<Key extends string> = Partial<
  Record<Key, boolean>
>;

export interface RuntimeAgentConfigurationSnapshot {
  identity: {
    name: string;
    title: string | null;
    capabilities: string | null;
    reportsTo: string | null;
    instruction: string | null;
  };
  contextGrants: SparseBooleanGrantMap<AgentContextGrantKey>;
  actionGrants: SparseBooleanGrantMap<PaperclipActionKey>;
  mentionReachGrants: SparseBooleanGrantMap<AgentMentionReachGrantKey>;
}

export interface RuntimeAgentConfigurationUpdate {
  name?: string;
  title?: string | null;
  capabilities?: string | null;
  reportsTo?: string | null;
  contextGrants?: SparseBooleanGrantMap<AgentContextGrantKey>;
  actionGrants?: SparseBooleanGrantMap<PaperclipActionKey>;
  mentionReachGrants?: SparseBooleanGrantMap<AgentMentionReachGrantKey>;
}

export const AGENT_VISIBLE_ISSUE_STATUSES = [
  "open",
  "blocked",
  "done",
  "cancelled",
] as const;

export type AgentVisibleIssueStatus =
  (typeof AGENT_VISIBLE_ISSUE_STATUSES)[number];

export const ISSUE_OWNER_KINDS = ["agent", "user", "board"] as const;
export type IssueOwnerKind = (typeof ISSUE_OWNER_KINDS)[number];

export type IssueOwner =
  | { kind: "agent"; agentId: string }
  | { kind: "user"; userId: string }
  | { kind: "board" };

export const ISSUE_CREATOR_KINDS = [
  "agent-execution",
  "user/board",
  "plugin",
  "routine",
  "system",
] as const;

export type IssueCreatorKind = (typeof ISSUE_CREATOR_KINDS)[number];

export type IssueCreator =
  | {
      kind: "agent-execution";
      issueExecutionAuthorityId: string;
      adapterConfigRevisionId: string;
    }
  | {
      kind: "user/board";
      userId: string | null;
    }
  | {
      kind: "plugin";
      pluginInstallationId: string;
      pluginKey: string;
      callbackKey: string;
      callbackVersion: string;
    }
  | {
      kind: "routine";
      routineId: string;
      routineDispatchId: string;
    }
  | {
      kind: "system";
      sourceKind: SystemCreatorSourceKind;
      sourceId: string;
    };

export type ProviderSafeIssueCreator =
  | { kind: "agent-execution"; agentId: string }
  | { kind: "user/board"; userId: string | null }
  | { kind: "plugin"; pluginKey: string }
  | { kind: "routine"; routineId: string }
  | { kind: "system"; sourceKind: SystemCreatorSourceKind };

export type ProviderSafeIssueOwner =
  | { kind: "agent"; agentId: string }
  | { kind: "user"; userId: string }
  | { kind: "board" };

export interface ProviderSafeIssueProjection {
  id: string;
  identifier: string | null;
  title: string | null;
  request: string;
  status: AgentVisibleIssueStatus;
  disposition: IssueDisposition | null;
  priority: "critical" | "high" | "medium" | "low";
  creator: ProviderSafeIssueCreator;
  owner: ProviderSafeIssueOwner;
  parentId: string | null;
  directChildCount: number;
  updatedAt: string;
}

export const ISSUE_EXECUTION_REF_SOURCE_KINDS = [
  "issue_request",
  "issue_reassignment",
  "issue_reopen",
  "human_comment_mention",
  "routine_dispatch",
  "issue_update",
  "consult_mention",
  "system_nudge",
  "termination_recovery",
  "agent_liveness_followup",
] as const;

export type IssueExecutionRefSourceKind =
  (typeof ISSUE_EXECUTION_REF_SOURCE_KINDS)[number];

export const AGENT_LIVENESS_ACTION_KINDS = [
  "authenticated_human_comment",
  "issue_create_child",
  "mention_agent",
  "mention_board",
  "issue_assign",
  "issue_update",
  "creator_withdrawal",
  "board_lifecycle_command",
  "board_reopen",
] as const;

export type AgentLivenessActionKind =
  (typeof AGENT_LIVENESS_ACTION_KINDS)[number];

export const AGENT_LIVENESS_ATTENTION_REASONS = [
  "agent_no_action",
  "agent_followup_failed",
  "agent_unavailable",
] as const;

export type AgentLivenessAttentionReason =
  (typeof AGENT_LIVENESS_ATTENTION_REASONS)[number];

/**
 * Immutable actor branch for the canonical creator-withdrawal command. Agent
 * creators use relationship-derived issue runtime actions and therefore never
 * enter this board/plugin control-plane ledger.
 */
export const ISSUE_CREATOR_WITHDRAWAL_ACTOR_KINDS = [
  "user",
  "plugin",
] as const;

export type IssueCreatorWithdrawalActorKind =
  (typeof ISSUE_CREATOR_WITHDRAWAL_ACTOR_KINDS)[number];

/**
 * Closed board lifecycle mutations that can advance an existing issue without
 * being mistaken for provider output, presentation changes, or automation.
 */
export const ISSUE_BOARD_LIFECYCLE_COMMAND_SUBTYPES = [
  "execution_policy_configure",
  "execution_policy_decision",
  "tree_control_pause",
  "tree_control_resume",
  "tree_control_cancel",
  "tree_control_restore",
  "tree_control_release",
] as const;

export type IssueBoardLifecycleCommandSubtype =
  (typeof ISSUE_BOARD_LIFECYCLE_COMMAND_SUBTYPES)[number];

export const ISSUE_EXECUTION_REF_MESSAGE_KINDS = [
  "user",
  "synthetic",
] as const;

export type IssueExecutionRefMessageKind =
  (typeof ISSUE_EXECUTION_REF_MESSAGE_KINDS)[number];

export const ISSUE_EXECUTION_REF_MODES = ["owner", "consult"] as const;
export type IssueExecutionRefMode =
  (typeof ISSUE_EXECUTION_REF_MODES)[number];

export const ISSUE_EXECUTION_REF_DISPOSITIONS = [
  "active",
  "invalidated",
  "terminal",
] as const;

export type IssueExecutionRefDisposition =
  (typeof ISSUE_EXECUTION_REF_DISPOSITIONS)[number];

/**
 * Server-only durable authorization and delivery identity for one provider
 * invocation. Exact source bytes are retained independently from any composed
 * fresh-execution history.
 */
export interface IssueExecutionRef {
  id: string;
  companyId: string;
  issueId: string;
  sessionId: string;
  ownershipEpoch: number;
  previousOwnershipEpoch: number | null;
  executionScopeId: string;
  executionLineageId: string;
  mode: IssueExecutionRefMode;
  sourceKind: IssueExecutionRefSourceKind;
  sourceId: string;
  sourceRecordId: string;
  messageKind: IssueExecutionRefMessageKind;
  messageId: string;
  exactMessage: string;
  deliveryIdempotencyKey: string;
  targetAgentId: string;
  laneOrdinal: number;
  issueExecutionAuthorityId: string | null;
  consultExecutionId: string | null;
  adapterConfigRevisionId: string;
  contextEpoch: number;
  historyViewId: string;
  admissionHighWaterSeq: number;
  inputId: string | null;
  admittedSeq: number | null;
  promotedSeq: number | null;
  counterpartIssueId: string | null;
  counterpartAuthorityId: string | null;
  counterpartOwnershipEpoch: number | null;
  consultCallerRefId: string | null;
  consultChainToken: string | null;
  disposition: IssueExecutionRefDisposition;
}

export const ISSUE_BOARD_REOPEN_DISPATCH_KINDS = [
  "agent_execution",
  "board_only",
] as const;

export type IssueBoardReopenDispatchKind =
  (typeof ISSUE_BOARD_REOPEN_DISPATCH_KINDS)[number];

/** Exact public result of the sole audited terminal-to-open command. */
export type IssueBoardReopenDispatch =
  | {
      kind: "agent_execution";
      executionRef: IssueExecutionRef;
    }
  | {
      kind: "board_only";
    };

export const REMOTE_WORKSPACE_LAUNCH_KIND =
  "paperclip.remote-workspace-launch/v1" as const;

/**
 * Closed server-to-provider workspace create/resume envelope. It is never a
 * model input, provider-child environment value, or generic adapter context.
 */
export interface RemoteWorkspaceLaunch {
  kind: typeof REMOTE_WORKSPACE_LAUNCH_KIND;
  repositoryLocator: string;
  repositoryRef: string | null;
  pullRequestSelector: string | null;
}

export const PAPERCLIP_RUN_TOOLS_KIND = "paperclip.run-tools/v1" as const;

/**
 * One-run capability object. The credential is accepted only by the compiled
 * run interface and is revoked with that run/ref.
 */
export interface PaperclipRunTools {
  kind: typeof PAPERCLIP_RUN_TOOLS_KIND;
  endpoint: string;
  bearer: string;
}
