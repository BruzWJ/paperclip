/**
 * Canonical, closed vocabulary for the task-execution runtime.
 *
 * Services import these atoms directly so execution state has one vocabulary.
 */

export const AGENT_CONTEXT_GRANT_KEYS = [
  "carry_context",
  "read_task_comments",
  "read_task_agent_run",
  "list_sub_tasks",
  "read_sub_task_comments",
  "read_sub_task_agent_run",
  "list_company_tasks",
  "read_company_task_comments",
  "read_company_task_agent_run",
] as const;

export type AgentContextGrantKey = (typeof AGENT_CONTEXT_GRANT_KEYS)[number];

export interface TaskDisposition {
  message: string;
  structuredResult?: unknown;
}

export function decodeTaskDisposition(value: unknown): TaskDisposition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Task disposition must be an object");
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
      "Task disposition must contain a non-empty message and only the optional structuredResult field",
    );
  }
  if (
    Object.hasOwn(record, "structuredResult") &&
    record.structuredResult === undefined
  ) {
    throw new TypeError(
      "Task disposition structuredResult must be omitted rather than undefined",
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

export const TASK_CREATOR_EDGE_TERMINAL_REASONS = [
  "creator_execution_superseded",
  "agent_terminated",
  "agent_deleted",
  "plugin_disabled",
  "plugin_uninstalled",
  "routine_deleted",
] as const;

export type TaskCreatorEdgeTerminalReason =
  (typeof TASK_CREATOR_EDGE_TERMINAL_REASONS)[number];

export function isTaskCreatorEdgeTerminalReason(
  value: unknown,
): value is TaskCreatorEdgeTerminalReason {
  return (
    typeof value === "string" &&
    (TASK_CREATOR_EDGE_TERMINAL_REASONS as readonly string[]).includes(value)
  );
}

export function decodeTaskCreatorEdgeTerminalReason(
  value: unknown,
): TaskCreatorEdgeTerminalReason {
  if (!isTaskCreatorEdgeTerminalReason(value)) {
    throw new TypeError("Creator edge has a non-canonical terminal reason");
  }
  return value;
}

/**
 * Configurable agent action grants. Relationship-derived task authority is
 * intentionally absent: creating a task permits assignment, while task
 * updates compile from the active creator/owner relationship.
 */
export const PAPERCLIP_ACTION_KEYS = [
  "task_create",
  "mention_board",
  "agent_hire",
  "agent_configure",
  "list_all_agents",
  "list_parent_agents",
] as const;

export type PaperclipActionKey = (typeof PAPERCLIP_ACTION_KEYS)[number];

/**
 * Closed runtime tool vocabulary. `task_assign` and `task_update` are
 * runtime actions, but never independently configurable grants.
 */
export const PAPERCLIP_RUNTIME_ACTION_KEYS = [
  "task_create",
  "task_assign",
  "task_update",
  "mention_agent",
  "mention_board",
  "agent_hire",
  "agent_configure",
  "list_agents",
  "agent_read",
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

export const AGENT_VISIBLE_TASK_STATUSES = [
  "open",
  "blocked",
  "done",
  "cancelled",
] as const;

export type AgentVisibleTaskStatus =
  (typeof AGENT_VISIBLE_TASK_STATUSES)[number];

export const TASK_OWNER_KINDS = ["agent", "user", "board"] as const;
export type TaskOwnerKind = (typeof TASK_OWNER_KINDS)[number];

export type TaskOwner =
  | { kind: "agent"; agentId: string }
  | { kind: "user"; userId: string }
  | { kind: "board" };

export const TASK_CREATOR_KINDS = [
  "agent-execution",
  "user/board",
  "plugin",
  "routine",
  "system",
] as const;

export type TaskCreatorKind = (typeof TASK_CREATOR_KINDS)[number];

export type TaskCreator =
  | {
      kind: "agent-execution";
      taskExecutionAuthorityId: string;
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

export type ProviderSafeTaskCreator =
  | { kind: "agent-execution"; agentId: string }
  | { kind: "user/board"; userId: string | null }
  | { kind: "plugin"; pluginKey: string }
  | { kind: "routine"; routineId: string }
  | { kind: "system"; sourceKind: SystemCreatorSourceKind };

export type ProviderSafeTaskOwner =
  | { kind: "agent"; agentId: string }
  | { kind: "user"; userId: string }
  | { kind: "board" };

export interface ProviderSafeTaskProjection {
  id: string;
  identifier: string;
  title: string | null;
  request: string;
  status: AgentVisibleTaskStatus;
  disposition: TaskDisposition | null;
  priority: "critical" | "high" | "medium" | "low";
  creator: ProviderSafeTaskCreator;
  owner: ProviderSafeTaskOwner;
  parentId: string | null;
  directChildCount: number;
  updatedAt: string;
}

export const TASK_EXECUTION_REF_SOURCE_KINDS = [
  "task_request",
  "task_reassignment",
  "task_reopen",
  "human_comment_mention",
  "routine_dispatch",
  "task_update",
  "consult_mention",
  "system_nudge",
] as const;

export type TaskExecutionRefSourceKind =
  (typeof TASK_EXECUTION_REF_SOURCE_KINDS)[number];

/**
 * Immutable actor branch for the canonical creator-withdrawal command. Agent
 * creators use relationship-derived task runtime actions and therefore never
 * enter this board/plugin control-plane ledger.
 */
export const TASK_CREATOR_WITHDRAWAL_ACTOR_KINDS = [
  "user",
  "plugin",
] as const;

export type TaskCreatorWithdrawalActorKind =
  (typeof TASK_CREATOR_WITHDRAWAL_ACTOR_KINDS)[number];

/**
 * Closed board lifecycle mutations that can advance an existing task without
 * being mistaken for provider output, presentation changes, or automation.
 */
export const TASK_BOARD_LIFECYCLE_COMMAND_SUBTYPES = [
  "execution_policy_configure",
  "execution_policy_decision",
  "tree_control_pause",
  "tree_control_resume",
  "tree_control_cancel",
  "tree_control_restore",
  "tree_control_release",
] as const;

export type TaskBoardLifecycleCommandSubtype =
  (typeof TASK_BOARD_LIFECYCLE_COMMAND_SUBTYPES)[number];

export const TASK_EXECUTION_REF_MESSAGE_KINDS = [
  "user",
  "synthetic",
] as const;

export type TaskExecutionRefMessageKind =
  (typeof TASK_EXECUTION_REF_MESSAGE_KINDS)[number];

export const TASK_EXECUTION_REF_MODES = ["owner", "consult"] as const;
export type TaskExecutionRefMode =
  (typeof TASK_EXECUTION_REF_MODES)[number];

export const TASK_EXECUTION_REF_DISPOSITIONS = [
  "active",
  "invalidated",
  "terminal",
] as const;

export type TaskExecutionRefDisposition =
  (typeof TASK_EXECUTION_REF_DISPOSITIONS)[number];

/**
 * Server-only durable authorization and delivery identity for one provider
 * invocation. Exact source bytes are retained independently from any composed
 * fresh-execution history.
 */
export interface TaskExecutionRef {
  id: string;
  companyId: string;
  taskId: string;
  sessionId: string;
  ownershipEpoch: number;
  previousOwnershipEpoch: number | null;
  executionScopeId: string;
  executionLineageId: string;
  mode: TaskExecutionRefMode;
  sourceKind: TaskExecutionRefSourceKind;
  sourceId: string;
  sourceRecordId: string;
  messageKind: TaskExecutionRefMessageKind;
  messageId: string;
  exactMessage: string;
  deliveryIdempotencyKey: string;
  targetAgentId: string;
  laneOrdinal: number;
  taskExecutionAuthorityId: string | null;
  consultExecutionId: string | null;
  adapterConfigRevisionId: string;
  contextEpoch: number;
  historyViewId: string;
  admissionHighWaterSeq: number;
  inputId: string | null;
  admittedSeq: number | null;
  promotedSeq: number | null;
  counterpartTaskId: string | null;
  counterpartAuthorityId: string | null;
  counterpartOwnershipEpoch: number | null;
  consultCallerRefId: string | null;
  consultChainToken: string | null;
  disposition: TaskExecutionRefDisposition;
}

export const TASK_BOARD_REOPEN_DISPATCH_KINDS = [
  "agent_execution",
  "board_only",
] as const;

export type TaskBoardReopenDispatchKind =
  (typeof TASK_BOARD_REOPEN_DISPATCH_KINDS)[number];

/** Exact public result of the sole audited terminal-to-open command. */
export type TaskBoardReopenDispatch =
  | {
      kind: "agent_execution";
      executionRef: TaskExecutionRef;
    }
  | {
      kind: "board_only";
    };

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
