import { createHash } from "node:crypto";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  issueCreateIdempotencyKeys,
  issueBoardReopenCommands,
  issueBoardUserComments,
  issueCommentProjectionSources,
  issueComments,
  issueCreatorEdgeReceivability,
  issueCreatorWithdrawalCommands,
  issueExecutionAuthorities,
  issueExecutionPromptCapabilities,
  issueExecutionRefs,
  issueExecutionSessions,
  issueLabels,
  issueSessionContextEpochs,
  issueSessions,
  issueUpdates,
  issues,
  labels,
  pluginWithdrawalOperations,
  plugins,
  projects,
  routines,
  systemEscalationIdentities,
  type Db,
} from "@paperclipai/db";
import type {
  IssueBoardReopenDispatch,
  IssueCreatorEdgeTerminalReason,
  IssueExecutionRefSourceKind,
} from "@paperclipai/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  InvokableIssueOwnerRejected,
  resolveInvokableIssueOwnerInTransaction,
} from "./agent-invokability.js";
import {
  createIssueSessionAdmissionService,
  type IssueSessionAdmissionResult,
  type IssueSessionExecutionActor,
  type IssueSessionExecutionSource,
  type IssueSessionProjectedCommentSource,
} from "./issue-session/admission.js";
import type { IssueSessionDbTransaction } from "./issue-session/event-store.js";
import { persistCanonicalIssueAggregateInTx } from "./canonical-issue-aggregate.js";
import {
  createIssueFormCommitRuntime,
  revokeOutgoingOwnershipEpoch,
  RuntimeIssueActionConflict,
  RuntimeIssueActionDenied,
  type CanonicalCreatorFormAuthority,
  type CanonicalOwnerFormAuthority,
  type CanonicalOwnerFormUpdate,
} from "./runtime-issue-action-port.js";
import { ensureSystemEscalationInTransaction } from "./system-escalation-postgres.js";
import {
  IssueExecutionWorkspaceReservationRejected,
  reserveIssueExecutionWorkspaceBinding,
} from "./execution-workspaces.js";
import {
  assertPluginPermittedIssueOwnerInTransaction,
} from "./plugin-issue-authorization.js";
import {
  IssueExecutionRunInvariantViolation,
  IssueExecutionSteeringRejected,
  type IssueExecutionRunService,
} from "./issue-execution-run-service.js";
import { projectPersistedIssueExecutionRef } from "./issue-execution-dispatcher-postgres.js";
import type {
  IssueExecutionCancellationActor,
  IssueExecutionCancellationService,
  RequestedScopedRunCancellations,
} from "./issue-execution-cancellation.js";
import { recordIssueLivenessActionInTransaction } from "./issue-liveness-reconciliation.js";

type IssueRow = typeof issues.$inferSelect;
type CreatorEdgeRow = typeof issueCreatorEdgeReceivability.$inferSelect;
type IssueSessionRow = typeof issueSessions.$inferSelect;
type BoardReopenCommandRow = typeof issueBoardReopenCommands.$inferSelect;
type SystemEscalationIdentityRow =
  typeof systemEscalationIdentities.$inferSelect;
type ReopenCreatorEndpointState = {
  terminalReason: IssueCreatorEdgeTerminalReason | null;
  endpointTombstone: Record<string, unknown> | null;
};

const NONTERMINAL = new Set(["open", "blocked"]);
const PRIORITIES = new Set(["critical", "high", "medium", "low"]);

async function lockIssueSessionState(
  tx: IssueSessionDbTransaction,
  companyId: string,
  issueId: string,
): Promise<{
  session: IssueSessionRow;
  contextGeneration: number;
} | null> {
  return tx
    .select({
      session: issueSessions,
      contextGeneration: issueSessionContextEpochs.generation,
    })
    .from(issueSessions)
    .innerJoin(
      issueSessionContextEpochs,
      and(
        eq(issueSessionContextEpochs.companyId, issueSessions.companyId),
        eq(issueSessionContextEpochs.issueId, issueSessions.issueId),
        eq(issueSessionContextEpochs.sessionId, issueSessions.id),
      ),
    )
    .where(
      and(
        eq(issueSessions.companyId, companyId),
        eq(issueSessions.issueId, issueId),
      ),
    )
    .for("update")
    .then((rows) => rows[0] ?? null);
}

export class OrdinaryIssueRuntimeRejected extends Error {
  readonly code = "ordinary_issue_runtime_rejected";

  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = "OrdinaryIssueRuntimeRejected";
  }
}

type PluginWithdrawalCommitOutcome =
  | {
      kind: "accepted";
      operationId: string;
      issue: IssueRow;
      escalationDispatchRefIds: readonly string[];
      cancellations: RequestedScopedRunCancellations | null;
      retried: boolean;
    }
  | {
      kind: "rejected";
      message: string;
      reason: string;
    };

const ISSUE_ROW_DATE_KEYS = [
  "monitorNextCheckAt",
  "monitorLastTriggeredAt",
  "startedAt",
  "completedAt",
  "cancelledAt",
  "hiddenAt",
  "createdAt",
  "updatedAt",
] as const satisfies ReadonlyArray<keyof IssueRow>;

function pluginWithdrawalIssueSnapshot(issue: IssueRow): Record<string, unknown> {
  const snapshot: Record<string, unknown> = { ...issue };
  for (const key of ISSUE_ROW_DATE_KEYS) {
    const value = issue[key];
    snapshot[key] = value instanceof Date ? value.toISOString() : value;
  }
  return snapshot;
}

function recordedPluginWithdrawalIssue(result: unknown): IssueRow | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const issue = (result as Record<string, unknown>).issue;
  if (!issue || typeof issue !== "object" || Array.isArray(issue)) return null;
  const snapshot = { ...(issue as Record<string, unknown>) };
  for (const key of ISSUE_ROW_DATE_KEYS) {
    const value = snapshot[key];
    if (typeof value === "string") {
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) return null;
      snapshot[key] = parsed;
    }
  }
  return snapshot as unknown as IssueRow;
}

function recordedPluginWithdrawalRejection(result: unknown): {
  message: string;
  reason: string;
} | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const record = result as Record<string, unknown>;
  return typeof record.message === "string" && typeof record.reason === "string"
    ? { message: record.message, reason: record.reason }
    : null;
}

export type OrdinaryIssueCreator =
  | {
      kind: "user/board";
      userId: string;
    }
  | {
      kind: "plugin";
      pluginInstallationId: string;
      pluginKey: string;
      callbackKey: string;
      callbackVersion: string;
      callbackRegistrationActive: true;
    }
  | {
      kind: "routine";
      routineId: string;
      routineDispatchId: string;
    };

export interface OrdinaryIssueCreateInput {
  /** Caller-reserved UUID for an atomically correlated producer row. */
  issueId?: string;
  companyId: string;
  request: string;
  ownerAgentId: string;
  creator: OrdinaryIssueCreator;
  idempotencyKey: string;
  sourceKind?: Extract<
    IssueExecutionRefSourceKind,
    "issue_request" | "routine_dispatch"
  >;
  title?: string | null;
  projectId?: string | null;
  projectWorkspaceId?: string | null;
  goalId?: string | null;
  parentId?: string | null;
  priority?: "critical" | "high" | "medium" | "low";
  labelIds?: string[];
  responsibleUserId?: string | null;
  originKind?: string | null;
  originId?: string | null;
  originRunId?: string | null;
  originFingerprint?: string | null;
  billingCode?: string | null;
  workMode?: string;
  harnessKind?: string | null;
  /**
   * Optional producer-side correlation written in the same transaction as
   * the issue, Session, authority, and initial execution ref.
   */
  correlate?: (
    tx: IssueSessionDbTransaction,
    persisted: {
      issue: IssueRow;
      sessionId: string;
      authorityId: string;
      ref: NonNullable<IssueSessionAdmissionResult["ref"]>;
    },
  ) => Promise<void>;
}

export interface OrdinaryIssueCreateResult {
  issue: IssueRow;
  sessionId: string;
  authorityId: string;
  ref: NonNullable<IssueSessionAdmissionResult["ref"]>;
  retried: boolean;
}

export interface OrdinaryIssueBoardReopenInput {
  companyId: string;
  issueId: string;
  actorUserId: string;
  reason: string;
  idempotencyKey: string;
}

export interface OrdinaryIssueUserCommentInput {
  companyId: string;
  issueId: string;
  actorUserId: string;
  message: string;
  idempotencyKey: string;
  /**
   * Dispatch is authorized only by this explicit, complete tuple. Prose is
   * never inspected for an @mention.
   */
  mention?: {
    targetAgentId: string;
    ownershipEpoch: number;
  } | null;
  /** Canonical persisted comment target; mutually exclusive with mention. */
  replyToCommentId?: string | null;
}

export interface OrdinaryIssueDirectEventInput {
  companyId: string;
  issueId: string;
  message: string;
  sourceKind: Extract<
    IssueExecutionRefSourceKind,
    "system_nudge" | "termination_recovery"
  >;
  /** Immutable recovery or liveness record that caused this delivery. */
  sourceRecordId: string;
  idempotencyKey: string;
}

export interface OrdinaryIssueReassignInput {
  companyId: string;
  issueId: string;
  ownerAgentId: string;
  idempotencyKey: string;
  creator:
    | { kind: "user/board"; userId: string }
    | {
        kind: "plugin";
        pluginInstallationId: string;
        pluginKey: string;
      };
}

export interface OrdinaryIssueBoardReassignInput {
  companyId: string;
  issueId: string;
  ownerAgentId: string;
  actorUserId: string;
  idempotencyKey: string;
}

export interface OrdinaryIssueUserWithdrawalSelfAssignmentInput {
  companyId: string;
  issueId: string;
  actorUserId: string;
  idempotencyKey: string;
}

export interface OrdinaryPluginWithdrawalPrepareInput {
  companyId: string;
  issueId: string;
  message: string;
  operationId: string;
  pluginInstallationId: string;
  pluginKey: string;
}

export interface OrdinaryPluginWithdrawalInput {
  companyId: string;
  operationId: string;
  pluginInstallationId: string;
  pluginKey: string;
}

export interface OrdinaryIssueRuntimeOptions {
  clock?: () => Date;
  issueExecutionRunService: Pick<
    IssueExecutionRunService,
    "requestSteeringInTransaction" | "continuePendingSteeringForSource"
  >;
  issueExecutionCancellation: Pick<
    IssueExecutionCancellationService,
    | "requestScopeCancellationsInTransaction"
    | "reconcileRequestedScopeCancellations"
  >;
  /**
   * The only execution trigger exposed to causal producers. Implementations
   * must prepare composition and notify the dispatcher for this persisted ref.
   */
  dispatchRef(refId: string): Promise<void>;
}

function deterministicUuid(namespace: string, key: string): string {
  const bytes = Buffer.from(
    createHash("sha256")
      .update(`${namespace}\0${key}`)
      .digest("hex")
      .slice(0, 32),
    "hex",
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function stableSessionId(key: string): string {
  return `ses_${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

async function withOrdinaryWorkspaceReservationErrors<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof IssueExecutionWorkspaceReservationRejected) {
      throw new OrdinaryIssueRuntimeRejected(error.message, error.reason);
    }
    throw error;
  }
}

async function withOrdinaryIssueFormErrors<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof RuntimeIssueActionDenied) {
      throw new OrdinaryIssueRuntimeRejected(error.message, error.reason);
    }
    if (error instanceof RuntimeIssueActionConflict) {
      throw new OrdinaryIssueRuntimeRejected(
        error.message,
        "issue_form_conflict",
      );
    }
    throw error;
  }
}

async function withOrdinaryHumanSteeringErrors<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof IssueExecutionSteeringRejected ||
      error instanceof IssueExecutionRunInvariantViolation
    ) {
      throw new OrdinaryIssueRuntimeRejected(
        error.message,
        error instanceof IssueExecutionSteeringRejected &&
            error.reason !== "invalid_request"
          ? "human_reply_steering_ambiguous"
          : "human_reply_run_not_steerable",
      );
    }
    throw error;
  }
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new OrdinaryIssueRuntimeRejected(`${label} is required`, `${label}_required`);
  }
  return normalized;
}

function nonBlankPreservingBytes(value: string, label: string): string {
  if (!value.trim()) {
    throw new OrdinaryIssueRuntimeRejected(
      `${label} is required`,
      `${label}_required`,
    );
  }
  return value;
}

function creatorColumns(creator: OrdinaryIssueCreator) {
  switch (creator.kind) {
    case "user/board":
      return {
        creatorKind: creator.kind,
        creatorUserId: creator.userId,
      } as const;
    case "plugin":
      return {
        creatorKind: creator.kind,
        creatorPluginInstallationId: creator.pluginInstallationId,
        creatorPluginKey: creator.pluginKey,
        creatorCallbackKey: creator.callbackKey,
        creatorCallbackVersion: creator.callbackVersion,
      } as const;
    case "routine":
      return {
        creatorKind: creator.kind,
        creatorRoutineId: creator.routineId,
        creatorRoutineDispatchId: creator.routineDispatchId,
      } as const;
  }
}

function projectedCommentSource(
  creator: OrdinaryIssueCreator,
): IssueSessionProjectedCommentSource {
  if (creator.kind === "user/board") {
    return {
      author: { kind: "user", userId: creator.userId },
      producingRun: null,
    };
  }
  if (creator.kind === "plugin") {
    return {
      author: {
        kind: "plugin",
        pluginInstallationId: creator.pluginInstallationId,
        pluginKey: creator.pluginKey,
      },
      producingRun: null,
    };
  }
  return {
    author: { kind: "system", source: "control" },
    producingRun: null,
  };
}

function executionActorForOrdinaryCreator(
  creator: OrdinaryIssueCreator,
): IssueSessionExecutionActor {
  switch (creator.kind) {
    case "user/board":
      return { kind: creator.kind, userId: creator.userId };
    case "plugin":
      return {
        kind: creator.kind,
        pluginInstallationId: creator.pluginInstallationId,
        pluginKey: creator.pluginKey,
      };
    case "routine":
      return {
        kind: creator.kind,
        routineId: creator.routineId,
        routineDispatchId: creator.routineDispatchId,
      };
  }
}

function executionSourceForOrdinaryCreate(
  input: Pick<OrdinaryIssueCreateInput, "creator" | "sourceKind">,
):
  | Extract<IssueSessionExecutionSource, { sourceKind: "issue_request" }>
  | Extract<IssueSessionExecutionSource, { sourceKind: "routine_dispatch" }> {
  const sourceKind =
    input.sourceKind ??
    (input.creator.kind === "routine"
      ? "routine_dispatch"
      : "issue_request");
  if (sourceKind === "routine_dispatch") {
    if (input.creator.kind !== "routine") {
      throw new OrdinaryIssueRuntimeRejected(
        "Routine dispatch creation requires immutable routine provenance",
        "routine_dispatch_creator_invalid",
      );
    }
    return {
      sourceKind,
      actor: {
        kind: "routine",
        routineId: input.creator.routineId,
        routineDispatchId: input.creator.routineDispatchId,
      },
    };
  }
  return {
    sourceKind: "issue_request",
    actor: executionActorForOrdinaryCreator(input.creator),
  };
}

function creatorEndpoint(issue: IssueRow): {
  endpointKind:
    | "agent-execution"
    | "user/board"
    | "plugin"
    | "routine"
    | "system";
  endpointId: string | null;
  endpointSnapshot: Record<string, unknown>;
} {
  if (
    issue.creatorKind === "agent-execution" &&
    issue.creatorAuthorityId &&
    issue.creatorAdapterConfigRevisionId
  ) {
    return {
      endpointKind: "agent-execution",
      endpointId: issue.creatorAuthorityId,
      endpointSnapshot: {
        authorityId: issue.creatorAuthorityId,
        originatingAdapterConfigRevisionId:
          issue.creatorAdapterConfigRevisionId,
      },
    };
  }
  if (issue.creatorKind === "user/board") {
    return {
      endpointKind: "user/board",
      endpointId: issue.creatorUserId,
      endpointSnapshot: {
        userId: issue.creatorUserId,
        recipient: "named-user",
      },
    };
  }
  if (
    issue.creatorKind === "plugin" &&
    issue.creatorPluginInstallationId &&
    issue.creatorPluginKey &&
    issue.creatorCallbackKey &&
    issue.creatorCallbackVersion
  ) {
    return {
      endpointKind: "plugin",
      endpointId: issue.creatorPluginInstallationId,
      endpointSnapshot: {
        pluginInstallationId: issue.creatorPluginInstallationId,
        pluginKey: issue.creatorPluginKey,
        callbackKey: issue.creatorCallbackKey,
        callbackVersion: issue.creatorCallbackVersion,
      },
    };
  }
  if (
    issue.creatorKind === "routine" &&
    issue.creatorRoutineId &&
    issue.creatorRoutineDispatchId
  ) {
    return {
      endpointKind: "routine",
      endpointId: issue.creatorRoutineId,
      endpointSnapshot: {
        routineId: issue.creatorRoutineId,
        routineDispatchId: issue.creatorRoutineDispatchId,
      },
    };
  }
  if (
    issue.creatorKind === "system" &&
    issue.creatorSystemSourceKind &&
    issue.creatorSystemSourceId
  ) {
    return {
      endpointKind: "system",
      endpointId: issue.creatorSystemSourceId,
      endpointSnapshot: {
        sourceKind: issue.creatorSystemSourceKind,
        sourceId: issue.creatorSystemSourceId,
        recipient: "company-board",
      },
    };
  }
  throw new OrdinaryIssueRuntimeRejected(
    "Issue creator endpoint is incomplete",
    "creator_endpoint_incomplete",
  );
}

async function insertCreatorEdge(
  tx: IssueSessionDbTransaction,
  issue: IssueRow,
  sessionId: string,
  now: Date,
  options: {
    terminalReason?: IssueCreatorEdgeTerminalReason | null;
    terminalSourceKind?: string | null;
    terminalSourceId?: string | null;
    terminalAudit?: Record<string, unknown> | null;
    endpointTombstone?: Record<string, unknown> | null;
  } = {},
): Promise<CreatorEdgeRow> {
  const endpoint = creatorEndpoint(issue);
  const terminalReason = options.terminalReason ?? null;
  const terminal = terminalReason !== null;
  const edge = await tx
    .insert(issueCreatorEdgeReceivability)
    .values({
      id: deterministicUuid(
        "creator-edge",
        `${issue.companyId}:${issue.id}:${issue.ownershipEpoch}`,
      ),
      companyId: issue.companyId,
      issueId: issue.id,
      sessionId,
      ownershipEpoch: issue.ownershipEpoch!,
      creatorKind: issue.creatorKind!,
      ...endpoint,
      endpointTombstone: options.endpointTombstone ?? null,
      state: terminal ? "terminal" : "receivable",
      terminalReason,
      terminalSourceKind: terminal
        ? options.terminalSourceKind ?? "board_reopen"
        : null,
      terminalSourceId: terminal
        ? options.terminalSourceId ?? issue.id
        : null,
      terminalAudit: terminal ? options.terminalAudit ?? {} : null,
      terminalizedAt: terminal ? now : null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .then((rows) => rows[0] ?? null);
  if (!edge) {
    throw new OrdinaryIssueRuntimeRejected(
      "Creator edge was not persisted",
      "creator_edge_missing",
    );
  }
  return edge;
}

async function inspectCreatorEndpoint(
  tx: IssueSessionDbTransaction,
  issue: IssueRow,
): Promise<ReopenCreatorEndpointState> {
  switch (issue.creatorKind) {
    case "agent-execution": {
      const authority = issue.creatorAuthorityId
        ? await tx
            .select()
            .from(issueExecutionAuthorities)
            .where(
              and(
                eq(
                  issueExecutionAuthorities.companyId,
                  issue.companyId,
                ),
                eq(
                  issueExecutionAuthorities.id,
                  issue.creatorAuthorityId,
                ),
              ),
            )
            .for("update")
            .then((rows) => rows[0] ?? null)
        : null;
      if (!authority || authority.state !== "current") {
        return {
          terminalReason: "creator_execution_superseded",
          endpointTombstone: {
            authorityId: issue.creatorAuthorityId,
            state: authority?.state ?? "missing",
            revocationReason: authority?.revocationReason ?? null,
            revokedAt: authority?.revokedAt ?? null,
          },
        };
      }
      const creatorAgent = await tx
        .select({ id: agents.id, status: agents.status })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, issue.companyId),
            eq(agents.id, authority.agentId),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!creatorAgent || creatorAgent.status === "terminated") {
        return {
          terminalReason: creatorAgent ? "agent_terminated" : "agent_deleted",
          endpointTombstone: {
            authorityId: authority.id,
            agentId: authority.agentId,
            status: creatorAgent?.status ?? "deleted",
          },
        };
      }
      return { terminalReason: null, endpointTombstone: null };
    }
    case "plugin": {
      const plugin = issue.creatorPluginInstallationId
        ? await tx
            .select()
            .from(plugins)
            .where(eq(plugins.id, issue.creatorPluginInstallationId))
            .for("update")
            .then((rows) => rows[0] ?? null)
        : null;
      if (
        !plugin ||
        plugin.pluginKey !== issue.creatorPluginKey
      ) {
        return {
          terminalReason: "plugin_uninstalled",
          endpointTombstone: {
            pluginInstallationId: issue.creatorPluginInstallationId,
            pluginKey: issue.creatorPluginKey,
            status: plugin?.status ?? "missing",
          },
        };
      }
      if (plugin.status === "disabled") {
        return {
          terminalReason: "plugin_disabled",
          endpointTombstone: {
            pluginInstallationId: plugin.id,
            pluginKey: plugin.pluginKey,
            status: plugin.status,
          },
        };
      }
      return { terminalReason: null, endpointTombstone: null };
    }
    case "routine": {
      const routine = issue.creatorRoutineId
        ? await tx
            .select()
            .from(routines)
            .where(
              and(
                eq(routines.companyId, issue.companyId),
                eq(routines.id, issue.creatorRoutineId),
              ),
            )
            .for("update")
            .then((rows) => rows[0] ?? null)
        : null;
      if (!routine || routine.status === "archived") {
        return {
          terminalReason: "routine_deleted",
          endpointTombstone: {
            routineId: issue.creatorRoutineId,
            status: routine?.status ?? "missing",
          },
        };
      }
      return { terminalReason: null, endpointTombstone: null };
    }
    case "user/board":
    case "system":
      return { terminalReason: null, endpointTombstone: null };
    default:
      throw new OrdinaryIssueRuntimeRejected(
        "Issue creator endpoint is incomplete",
        "creator_endpoint_incomplete",
      );
  }
}

async function lockReopenCreatorEdge(
  tx: IssueSessionDbTransaction,
  issue: IssueRow,
): Promise<CreatorEdgeRow | null> {
  const endpoint = creatorEndpoint(issue);
  const existing = await tx
    .select()
    .from(issueCreatorEdgeReceivability)
    .where(
      and(
        eq(issueCreatorEdgeReceivability.companyId, issue.companyId),
        eq(issueCreatorEdgeReceivability.issueId, issue.id),
        eq(
          issueCreatorEdgeReceivability.ownershipEpoch,
          issue.ownershipEpoch!,
        ),
      ),
    )
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (
    existing &&
    (existing.creatorKind !== issue.creatorKind ||
      existing.endpointKind !== endpoint.endpointKind ||
      existing.endpointId !== endpoint.endpointId)
  ) {
    throw new OrdinaryIssueRuntimeRejected(
      "Creator-edge identity conflicts with the immutable issue creator",
      "creator_edge_identity_conflict",
    );
  }
  return existing;
}

async function ensureReopenCreatorEdge(
  tx: IssueSessionDbTransaction,
  input: {
    issue: IssueRow;
    sessionId: string;
    existing: CreatorEdgeRow | null;
    endpointState: ReopenCreatorEndpointState;
    commandId: string;
    actorUserId: string;
    reason: string;
    now: Date;
  },
): Promise<CreatorEdgeRow> {
  const existing = input.existing;
  const endpointState = input.endpointState;
  if (existing?.state === "terminal") {
    return existing;
  }
  const terminalAudit = {
    commandId: input.commandId,
    actorUserId: input.actorUserId,
    reason: input.reason,
  };
  if (existing) {
    if (endpointState.terminalReason === null) return existing;
    const terminalized = await tx
      .update(issueCreatorEdgeReceivability)
      .set({
        state: "terminal",
        terminalReason: endpointState.terminalReason,
        terminalSourceKind: "board_reopen",
        terminalSourceId: input.commandId,
        terminalAudit,
        endpointTombstone: endpointState.endpointTombstone,
        terminalizedAt: input.now,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(issueCreatorEdgeReceivability.id, existing.id),
          eq(issueCreatorEdgeReceivability.state, "receivable"),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!terminalized) {
      throw new OrdinaryIssueRuntimeRejected(
        "Creator edge changed while reopening",
        "creator_edge_reopen_conflict",
      );
    }
    return terminalized;
  }

  return insertCreatorEdge(tx, input.issue, input.sessionId, input.now, {
    terminalReason: endpointState.terminalReason,
    terminalSourceKind: "board_reopen",
    terminalSourceId: input.commandId,
    terminalAudit,
    endpointTombstone: endpointState.endpointTombstone,
  });
}

function invalidSystemEscalationReopen(message: string): never {
  throw new OrdinaryIssueRuntimeRejected(
    message,
    "board_reopen_escalation_invalid",
  );
}

function exactSystemEscalationProvenance(
  issue: IssueRow,
  identity: SystemEscalationIdentityRow,
  terminalEdge: CreatorEdgeRow,
): void {
  const source = identity.immutableSource;
  const expectedSourceKeys = [
    "contract",
    "initialCausalSourceId",
    "reason",
    "systemSource",
    "terminalCreatorEdgeId",
    "terminalSourceId",
    "terminalSourceKind",
    "triggeringRunId",
  ];
  if (
    issue.creatorKind !== "system" ||
    issue.creatorSystemSourceKind !== identity.systemSource ||
    issue.creatorSystemSourceId !== `system-escalation:${identity.id}` ||
    issue.escalatedFromAffectedIssueId !== identity.affectedIssueId ||
    issue.affectedOwnershipEpoch !== identity.affectedOwnershipEpoch ||
    issue.escalatedFromTriggeringRunId !== identity.triggeringRunId ||
    identity.escalationIssueId !== issue.id ||
    terminalEdge.companyId !== identity.companyId ||
    terminalEdge.issueId !== identity.affectedIssueId ||
    terminalEdge.ownershipEpoch !== identity.affectedOwnershipEpoch ||
    terminalEdge.id !== identity.terminalCreatorEdgeId ||
    terminalEdge.state !== "terminal" ||
    terminalEdge.terminalReason === null ||
    !source ||
    typeof source !== "object" ||
    Array.isArray(source) ||
    Object.keys(source).sort().join("\0") !==
      expectedSourceKeys.sort().join("\0") ||
    source.contract !== "system-escalation/v1" ||
    source.reason !== terminalEdge.terminalReason ||
    source.reason !== issue.escalatedFromReason ||
    source.terminalCreatorEdgeId !== terminalEdge.id ||
    source.terminalSourceKind !== terminalEdge.terminalSourceKind ||
    source.terminalSourceId !== terminalEdge.terminalSourceId ||
    source.systemSource !== identity.systemSource ||
    source.triggeringRunId !== identity.triggeringRunId ||
    typeof source.initialCausalSourceId !== "string" ||
    source.initialCausalSourceId.trim().length === 0
  ) {
    invalidSystemEscalationReopen(
      "Board-only reopen requires exact immutable system-escalation provenance",
    );
  }
}

async function lockSystemEscalationReopenIdentity(
  tx: IssueSessionDbTransaction,
  issue: IssueRow,
): Promise<SystemEscalationIdentityRow> {
  const identities = await tx
    .select()
    .from(systemEscalationIdentities)
    .where(
      and(
        eq(systemEscalationIdentities.companyId, issue.companyId),
        eq(systemEscalationIdentities.escalationIssueId, issue.id),
      ),
    )
    .limit(2)
    .for("update");
  if (identities.length !== 1) {
    invalidSystemEscalationReopen(
      "Board-only reopen requires one exact system-escalation identity",
    );
  }
  const identity = identities[0]!;
  const terminalEdges = await tx
    .select()
    .from(issueCreatorEdgeReceivability)
    .where(
      and(
        eq(
          issueCreatorEdgeReceivability.companyId,
          identity.companyId,
        ),
        eq(
          issueCreatorEdgeReceivability.id,
          identity.terminalCreatorEdgeId,
        ),
      ),
    )
    .limit(2)
    .for("update");
  if (terminalEdges.length !== 1) {
    invalidSystemEscalationReopen(
      "System-escalation identity lost its exact terminal creator edge",
    );
  }
  exactSystemEscalationProvenance(issue, identity, terminalEdges[0]!);
  return identity;
}

async function applyBoardReopenContinuityFence(
  tx: IssueSessionDbTransaction,
  input: {
    companyId: string;
    issueId: string;
    ownershipEpoch: number;
    at: Date;
  },
): Promise<number> {
  const correlations = await tx
    .select({
      generation: issueExecutionSessions.correlationGeneration,
    })
    .from(issueExecutionSessions)
    .where(
      and(
        eq(issueExecutionSessions.companyId, input.companyId),
        eq(issueExecutionSessions.issueId, input.issueId),
        eq(
          issueExecutionSessions.ownershipEpoch,
          input.ownershipEpoch,
        ),
      ),
    )
    .for("update");
  const liveCapabilities = await tx
    .select({
      connectionId:
        issueExecutionPromptCapabilities.capabilityConnectionId,
      generation:
        issueExecutionPromptCapabilities.capabilityGeneration,
    })
    .from(issueExecutionPromptCapabilities)
    .where(
      and(
        eq(issueExecutionPromptCapabilities.companyId, input.companyId),
        eq(issueExecutionPromptCapabilities.issueId, input.issueId),
        eq(
          issueExecutionPromptCapabilities.ownershipEpoch,
          input.ownershipEpoch,
        ),
        inArray(issueExecutionPromptCapabilities.state, [
          "pending_setup",
          "active",
        ]),
      ),
    )
    .for("update");
  const priorFences = await tx
    .select({
      generation: issueBoardReopenCommands.continuityFenceGeneration,
    })
    .from(issueBoardReopenCommands)
    .where(
      and(
        eq(issueBoardReopenCommands.companyId, input.companyId),
        eq(issueBoardReopenCommands.issueId, input.issueId),
        eq(issueBoardReopenCommands.ownershipEpoch, input.ownershipEpoch),
      ),
    )
    .for("update");

  const continuityFenceGeneration =
    Math.max(
      0,
      ...correlations.map((row) => row.generation),
      ...priorFences.map((row) => row.generation),
    ) + 1;
  if (
    !Number.isSafeInteger(continuityFenceGeneration) ||
    continuityFenceGeneration > 2_147_483_647
  ) {
    throw new OrdinaryIssueRuntimeRejected(
      "Board reopen exhausted the epoch-local continuity generation",
      "board_reopen_continuity_exhausted",
    );
  }

  const revoked = await tx
    .update(issueExecutionPromptCapabilities)
    .set({
      state: "revoked",
      revocationReason: "board_reopen_terminal_continuity_fence",
      revokedAt: input.at,
    })
    .where(
      and(
        eq(issueExecutionPromptCapabilities.companyId, input.companyId),
        eq(issueExecutionPromptCapabilities.issueId, input.issueId),
        eq(
          issueExecutionPromptCapabilities.ownershipEpoch,
          input.ownershipEpoch,
        ),
        inArray(issueExecutionPromptCapabilities.state, [
          "pending_setup",
          "active",
        ]),
      ),
    )
    .returning({
      connectionId:
        issueExecutionPromptCapabilities.capabilityConnectionId,
      generation:
        issueExecutionPromptCapabilities.capabilityGeneration,
    });
  if (revoked.length !== liveCapabilities.length) {
    throw new OrdinaryIssueRuntimeRejected(
      "Board reopen lost a locked prompt-capability fence winner",
      "board_reopen_capability_conflict",
    );
  }
  return continuityFenceGeneration;
}

/**
 * The ordinary-issue boundary preserves its public rejection shape while the
 * actual owner/revision predicate is shared with every catalog and owner
 * configuration surface.
 */
async function resolveOrdinaryIssueOwner(
  tx: IssueSessionDbTransaction,
  companyId: string,
  ownerAgentId: string,
): Promise<Awaited<ReturnType<typeof resolveInvokableIssueOwnerInTransaction>>> {
  try {
    return await resolveInvokableIssueOwnerInTransaction(tx, {
      companyId,
      ownerAgentId,
    });
  } catch (error) {
    if (error instanceof InvokableIssueOwnerRejected) {
      throw new OrdinaryIssueRuntimeRejected(error.message, error.reason);
    }
    throw error;
  }
}

async function assertCreateReferences(
  tx: IssueSessionDbTransaction,
  input: OrdinaryIssueCreateInput,
): Promise<void> {
  if (input.labelIds?.length) {
    const existingLabels = await tx
      .select({ id: labels.id })
      .from(labels)
      .where(
        and(
          eq(labels.companyId, input.companyId),
          inArray(labels.id, input.labelIds),
        ),
      );
    if (existingLabels.length !== input.labelIds.length) {
      throw new OrdinaryIssueRuntimeRejected(
        "One or more labels are invalid for this company",
        "labels_invalid",
      );
    }
  }
  if (input.parentId) {
    const parent = await tx
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, input.companyId),
          eq(issues.id, input.parentId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!parent) {
      throw new OrdinaryIssueRuntimeRejected(
        "Parent issue is not in this company",
        "parent_issue_invalid",
      );
    }
  }
  if (input.projectId) {
    const project = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.companyId, input.companyId),
          eq(projects.id, input.projectId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!project) {
      throw new OrdinaryIssueRuntimeRejected(
        "Project is not in this company",
        "project_invalid",
      );
    }
  }
}

function sameCreator(
  issue: IssueRow,
  creator: OrdinaryIssueCreator,
): boolean {
  if (creator.kind === "user/board") {
    return (
      issue.creatorKind === creator.kind &&
      issue.creatorUserId === creator.userId
    );
  }
  if (creator.kind === "plugin") {
    return (
      issue.creatorKind === creator.kind &&
      issue.creatorPluginInstallationId === creator.pluginInstallationId &&
      issue.creatorPluginKey === creator.pluginKey &&
      issue.creatorCallbackKey === creator.callbackKey &&
      issue.creatorCallbackVersion === creator.callbackVersion
    );
  }
  return (
    issue.creatorKind === creator.kind &&
    issue.creatorRoutineId === creator.routineId &&
    issue.creatorRoutineDispatchId === creator.routineDispatchId
  );
}

export function createOrdinaryIssueRuntime(
  db: Db,
  options: OrdinaryIssueRuntimeOptions,
) {
  const clock = options.clock ?? (() => new Date());
  const sessions = createIssueSessionAdmissionService(db, { clock });
  const issueForms = createIssueFormCommitRuntime(db, {
    clock,
    dispatchPersistedRef: options.dispatchRef,
    issueExecutionCancellation: options.issueExecutionCancellation,
  });

  async function dispatch(refId: string): Promise<void> {
    await options.dispatchRef(refId);
  }

  async function commitAgentOwnerReassignmentInTransaction(
    tx: IssueSessionDbTransaction,
    input: {
      issue: IssueRow;
      ownerAgentId: string;
      idempotencyKey: string;
      sourceAuthorityId: string;
      cancellationActor: IssueExecutionCancellationActor;
      comment: IssueSessionProjectedCommentSource;
      sourceActor: Extract<
        IssueSessionExecutionActor,
        { kind: "user/board" | "agent-execution" | "plugin" }
      >;
      provenanceUserId: string | null;
      ownerResolution: Awaited<
        ReturnType<typeof resolveOrdinaryIssueOwner>
      >;
    },
  ) {
    const issue = input.issue;
    if (
      !issue.ownershipEpoch ||
      issue.ownerKind !== "agent" ||
      !issue.ownerAgentId ||
      !issue.request ||
      !issue.lifecycleStatus ||
      !NONTERMINAL.has(issue.lifecycleStatus)
    ) {
      throw new OrdinaryIssueRuntimeRejected(
        "Reassignment requires a nonterminal agent-owned issue",
        "reassignment_target_invalid",
      );
    }
    if (issue.ownerAgentId === input.ownerAgentId) {
      throw new OrdinaryIssueRuntimeRejected(
        "Selected owner already owns this issue",
        "reassignment_owner_unchanged",
      );
    }
    const sessionState = await lockIssueSessionState(
      tx,
      issue.companyId,
      issue.id,
    );
    if (!sessionState) {
      throw new OrdinaryIssueRuntimeRejected(
        "Reassignment target Session is missing",
        "reassignment_session_missing",
      );
    }
    const { session } = sessionState;
    const outgoingAuthority = await tx
      .select()
      .from(issueExecutionAuthorities)
      .where(
        and(
          eq(issueExecutionAuthorities.companyId, issue.companyId),
          eq(issueExecutionAuthorities.issueId, issue.id),
          eq(
            issueExecutionAuthorities.ownershipEpoch,
            issue.ownershipEpoch,
          ),
          eq(
            issueExecutionAuthorities.agentId,
            issue.ownerAgentId,
          ),
          eq(issueExecutionAuthorities.state, "current"),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!outgoingAuthority) {
      throw new OrdinaryIssueRuntimeRejected(
        "Outgoing owner authority is missing",
        "reassignment_authority_missing",
      );
    }
    const now = clock();
    const revocation =
      await revokeOutgoingOwnershipEpoch(
        tx,
        sessions,
        options.issueExecutionCancellation,
        {
          companyId: issue.companyId,
          issueId: issue.id,
          sessionId: session.id,
          ownershipEpoch: issue.ownershipEpoch,
          authorityId: outgoingAuthority.id,
          sourceAuthorityId: input.sourceAuthorityId,
          cancellationActor: input.cancellationActor,
          now,
        },
      );
    const ownershipEpoch = issue.ownershipEpoch + 1;
    const authorityId = deterministicUuid(
      "issue-execution-authority",
      `${issue.id}:${ownershipEpoch}:${input.ownerAgentId}`,
    );
    const reassigned = await tx
      .update(issues)
      .set({
        ownerKind: "agent",
        ownerAgentId: input.ownerAgentId,
        ownerUserId: null,
        ownerAssignmentSource: null,
        ownershipEpoch,
        updatedAt: now,
      })
      .where(
        and(
          eq(issues.companyId, issue.companyId),
          eq(issues.id, issue.id),
          eq(issues.ownershipEpoch, issue.ownershipEpoch),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!reassigned) {
      throw new OrdinaryIssueRuntimeRejected(
        "Ownership epoch changed during reassignment",
        "reassignment_epoch_conflict",
      );
    }
    const workspaceReservation =
      await withOrdinaryWorkspaceReservationErrors(() =>
        reserveIssueExecutionWorkspaceBinding(tx, {
          issue: reassigned,
          session: {
            id: session.id,
            now,
          },
          provenance: {
            agentId: null,
            userId: input.provenanceUserId,
          },
        }),
      );
    await tx.insert(issueExecutionAuthorities).values({
      id: authorityId,
      companyId: issue.companyId,
      issueId: issue.id,
      sessionId: session.id,
      ownershipEpoch,
      agentId: input.ownerAgentId,
      auditAdapterConfigRevisionId:
        input.ownerResolution.revisionId,
      state: "current",
      createdAt: now,
    });
    await insertCreatorEdge(tx, reassigned, session.id, now);
    const admission = await sessions.admitExecutionSource(
      {
        companyId: issue.companyId,
        issueId: issue.id,
        sessionId: session.id,
        ownershipEpoch,
        targetAgentId: input.ownerAgentId,
        issueExecutionAuthorityId: authorityId,
        consultExecutionId: null,
        adapterConfigRevisionId:
          input.ownerResolution.revisionId,
        contextEpoch:
          workspaceReservation.contextEpochGeneration,
        mode: "owner",
        sourceKind: "issue_reassignment",
        actor: input.sourceActor,
        previousOwnershipEpoch: issue.ownershipEpoch,
        immutableSourceKey: input.idempotencyKey,
        sourceRecordId: issue.id,
        exactText: issue.request,
        comment: input.comment,
        idempotencyKey: input.idempotencyKey,
      },
      tx,
    );
    if (!admission.ref) {
      throw new OrdinaryIssueRuntimeRejected(
        "Reassignment did not persist an owner execution ref",
        "reassignment_ref_missing",
      );
    }
    await recordIssueLivenessActionInTransaction(
      tx,
      `issue_execution_ref:${admission.ref.id}`,
    );
    return {
      issue: reassigned,
      ref: admission.ref,
      escalationDispatchRefIds:
        revocation.escalationDispatchRefIds,
      cancellations: revocation.cancellations,
      retried: false as const,
    };
  }

  return {
    dispatchRef: dispatch,
    async create(
      rawInput: OrdinaryIssueCreateInput,
    ): Promise<OrdinaryIssueCreateResult> {
      const input = {
        ...rawInput,
        request: nonBlankPreservingBytes(rawInput.request, "request"),
        ownerAgentId: nonEmpty(rawInput.ownerAgentId, "ownerAgentId"),
        idempotencyKey: nonEmpty(rawInput.idempotencyKey, "idempotencyKey"),
        labelIds: [...new Set(rawInput.labelIds ?? [])],
      };
      if (input.priority && !PRIORITIES.has(input.priority)) {
        throw new OrdinaryIssueRuntimeRejected(
          "Issue priority is invalid",
          "priority_invalid",
        );
      }
      const key = `ordinary-issue-create:${input.companyId}:${input.idempotencyKey}`;
      const issueId = input.issueId?.trim() || deterministicUuid("ordinary-issue", key);
      const sessionId = stableSessionId(key);

      const result = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
        );
        const pluginOwnerResolution =
          input.creator.kind === "plugin"
            ? await assertPluginPermittedIssueOwnerInTransaction(tx, {
                companyId: input.companyId,
                pluginInstallationId:
                  input.creator.pluginInstallationId,
                pluginKey: input.creator.pluginKey,
                operation: "issues.create",
                ownerAgentId: input.ownerAgentId,
              })
            : null;
        const existing = await tx
          .select({ issue: issues })
          .from(issueCreateIdempotencyKeys)
          .innerJoin(
            issues,
            eq(issues.id, issueCreateIdempotencyKeys.issueId),
          )
          .where(
            and(
              eq(issueCreateIdempotencyKeys.companyId, input.companyId),
              eq(issueCreateIdempotencyKeys.idempotencyKey, key),
            ),
          )
          .limit(1)
          .then((rows) => rows[0]?.issue ?? null);
        if (existing) {
          if (
            existing.id !== issueId ||
            existing.request !== input.request ||
            existing.ownerAgentId !== input.ownerAgentId ||
            existing.title !== (input.title ?? null) ||
            existing.projectId !== (input.projectId ?? null) ||
            (input.projectWorkspaceId != null &&
              existing.projectWorkspaceId !== input.projectWorkspaceId) ||
            existing.goalId !== (input.goalId ?? null) ||
            existing.parentId !== (input.parentId ?? null) ||
            existing.priority !== (input.priority ?? "medium") ||
            existing.responsibleUserId !==
              (input.responsibleUserId ?? null) ||
            existing.originKind !== (input.originKind ?? "manual") ||
            existing.originId !== (input.originId ?? null) ||
            existing.originRunId !== (input.originRunId ?? null) ||
            existing.originFingerprint !==
              (input.originFingerprint ?? key) ||
            existing.billingCode !== (input.billingCode ?? null) ||
            !sameCreator(existing, input.creator)
          ) {
            throw new OrdinaryIssueRuntimeRejected(
              "Issue creation idempotency key was retried with different immutable input",
              "create_idempotency_conflict",
            );
          }
          const [session, authority, ref] = await Promise.all([
            tx
              .select()
              .from(issueSessions)
              .where(eq(issueSessions.issueId, existing.id))
              .then((rows) => rows[0] ?? null),
            tx
              .select()
              .from(issueExecutionAuthorities)
              .where(
                and(
                  eq(issueExecutionAuthorities.issueId, existing.id),
                  eq(issueExecutionAuthorities.ownershipEpoch, 1),
                ),
              )
              .then((rows) => rows[0] ?? null),
            tx
              .select()
              .from(issueExecutionRefs)
              .where(
                and(
                  eq(issueExecutionRefs.companyId, input.companyId),
                  eq(issueExecutionRefs.deliveryIdempotencyKey, key),
                ),
              )
              .then((rows) => rows[0] ?? null),
          ]);
          if (!session || !authority || !ref) {
            throw new OrdinaryIssueRuntimeRejected(
              "Accepted issue creation is missing canonical runtime records",
              "canonical_create_incomplete",
            );
          }
          return {
            issue: existing,
            sessionId: session.id,
            authorityId: authority.id,
            ref,
            retried: true,
          };
        }

        await tx.execute(
          sql`select ${companies.id} from ${companies} where ${companies.id} = ${input.companyId} for update`,
        );
        const company = await tx
          .select()
          .from(companies)
          .where(eq(companies.id, input.companyId))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (
          !company ||
          company.status !== "active" ||
          company.sessionIntegrityState !== "ready" ||
          company.hardDeleteFencedAt !== null
        ) {
          throw new OrdinaryIssueRuntimeRejected(
            "Company Session lifecycle is not ready",
            "company_inactive",
          );
        }
        if (input.creator.kind === "plugin") {
          if (input.creator.callbackRegistrationActive !== true) {
            throw new OrdinaryIssueRuntimeRejected(
              "Plugin creator callback is not registered",
              "plugin_callback_missing",
            );
          }
        }
        await assertCreateReferences(tx, input);
        const { owner, revisionId } =
          input.creator.kind === "plugin"
            ? pluginOwnerResolution!
            : await resolveOrdinaryIssueOwner(
                tx,
                input.companyId,
                input.ownerAgentId,
              );
        const now = clock();
        const maxIssueNumber = await tx
          .select({
            value: sql<number>`coalesce(max(${issues.issueNumber}), 0)`,
          })
          .from(issues)
          .where(eq(issues.companyId, input.companyId))
          .then((rows) => rows[0]?.value ?? 0);
        const issueNumber =
          Math.max(company.issueCounter, maxIssueNumber) + 1;
        await tx
          .update(companies)
          .set({ issueCounter: issueNumber, updatedAt: now })
          .where(eq(companies.id, input.companyId));
        const identifier = `${company.issuePrefix}-${issueNumber}`;
        const authorityId = deterministicUuid(
          "issue-execution-authority",
          `${issueId}:1:${owner.id}`,
        );
        const aggregate =
          await withOrdinaryWorkspaceReservationErrors(() =>
            persistCanonicalIssueAggregateInTx(tx, {
            issue: {
            id: issueId,
            companyId: input.companyId,
            projectId: input.projectId ?? null,
            projectWorkspaceId: input.projectWorkspaceId ?? null,
            goalId: input.goalId ?? null,
            parentId: input.parentId ?? null,
            title: input.title?.trim() || null,
            request: input.request,
            boardPresentationStatus: "todo",
            lifecycleStatus: "open",
            disposition: null,
            workMode: input.workMode ?? "standard",
            harnessKind: input.harnessKind ?? null,
            priority: input.priority ?? "medium",
            ownerKind: "agent",
            ownerAgentId: owner.id,
            ownerUserId: null,
            ownerAssignmentSource: null,
            ownershipEpoch: 1,
            ...creatorColumns(input.creator),
            responsibleUserId: input.responsibleUserId ?? null,
            issueNumber,
            identifier,
            originKind: input.originKind ?? "manual",
            originId: input.originId ?? null,
            originRunId: input.originRunId ?? null,
            originFingerprint: input.originFingerprint ?? key,
            billingCode: input.billingCode ?? null,
            requestDepth: input.parentId ? 1 : 0,
            createdAt: now,
            updatedAt: now,
            },
            session: {
              id: sessionId,
              now,
            },
            workspaceReservation: {
              provenance: {
                agentId: null,
                userId:
                input.creator.kind === "user/board"
                  ? input.creator.userId
                  : null,
              },
            },
            authority: {
              id: authorityId,
              agentId: owner.id,
              auditAdapterConfigRevisionId: revisionId,
              createdAt: now,
            },
            idempotency: { key },
            }),
          );
        const created = aggregate.issue;
        if (input.labelIds.length > 0) {
          await tx.insert(issueLabels).values(
            input.labelIds.map((labelId) => ({
              issueId: created.id,
              labelId,
              companyId: input.companyId,
            })),
          );
        }
        const sessionRoot = aggregate.sessionRoot;
        const executionSource = executionSourceForOrdinaryCreate(input);
        const admission = await sessions.admitExecutionSource(
          {
            companyId: created.companyId,
            issueId: created.id,
            sessionId,
            ownershipEpoch: 1,
            targetAgentId: owner.id,
            issueExecutionAuthorityId: authorityId,
            consultExecutionId: null,
            adapterConfigRevisionId: revisionId,
            contextEpoch: sessionRoot.contextEpoch.generation,
            mode: "owner",
            ...executionSource,
            immutableSourceKey: key,
            sourceRecordId: created.id,
            exactText: input.request,
            comment: projectedCommentSource(input.creator),
            idempotencyKey: key,
          },
          tx,
        );
        if (!admission.ref) {
          throw new OrdinaryIssueRuntimeRejected(
            "Initial owner execution ref was not persisted",
            "initial_ref_missing",
          );
        }
        await input.correlate?.(tx, {
          issue: created,
          sessionId,
          authorityId,
          ref: admission.ref,
        });
        return {
          issue: created,
          sessionId,
          authorityId,
          ref: admission.ref,
          retried: false,
        };
      });
      await dispatch(result.ref.id);
      return result;
    },

    async boardReopen(input: OrdinaryIssueBoardReopenInput) {
      const actorUserId = nonEmpty(input.actorUserId, "actorUserId");
      const reason = nonBlankPreservingBytes(input.reason, "reason");
      const idempotencyKey = nonEmpty(
        input.idempotencyKey,
        "idempotencyKey",
      );
      const commandId = deterministicUuid(
        "board-reopen-command",
        `${input.companyId}:${idempotencyKey}`,
      );
      const identityDigest = createHash("sha256")
        .update(
          canonicalJson({
            contract: "ordinary-board-reopen/v2",
            companyId: input.companyId,
            issueId: input.issueId,
            actorUserId,
            reason,
            idempotencyKey,
          }),
        )
        .digest("hex");
      const result = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${input.companyId}:board-reopen:${idempotencyKey}`}, 0))`,
        );
        const actor = await tx
          .select({ id: authUsers.id })
          .from(authUsers)
          .where(eq(authUsers.id, actorUserId))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (!actor) {
          throw new OrdinaryIssueRuntimeRejected(
            "Board reopen requires an authenticated named board user",
            "board_reopen_actor_invalid",
          );
        }
        const priorCommands = await tx
          .select()
          .from(issueBoardReopenCommands)
          .where(
            and(
              eq(issueBoardReopenCommands.companyId, input.companyId),
              eq(
                issueBoardReopenCommands.idempotencyKey,
                idempotencyKey,
              ),
            ),
          )
          .limit(2)
          .for("update");
        if (priorCommands.length > 1) {
          throw new OrdinaryIssueRuntimeRejected(
            "Board reopen idempotency identity is ambiguous",
            "board_reopen_incomplete",
          );
        }
        const priorCommand = priorCommands[0] ?? null;
        if (priorCommand) {
          if (
            priorCommand.identityDigest !== identityDigest ||
            priorCommand.issueId !== input.issueId ||
            priorCommand.actorUserId !== actorUserId ||
            priorCommand.reason !== reason
          ) {
            throw new OrdinaryIssueRuntimeRejected(
              "Board reopen idempotency key changed immutable input",
              "board_reopen_idempotency_conflict",
            );
          }
          const issueRows = await tx
            .select()
            .from(issues)
            .where(
              and(
                eq(issues.companyId, input.companyId),
                eq(issues.id, priorCommand.issueId),
              ),
            )
            .limit(2)
            .for("update");
          const edgeRows = await tx
            .select()
            .from(issueCreatorEdgeReceivability)
            .where(
              and(
                eq(
                  issueCreatorEdgeReceivability.companyId,
                  input.companyId,
                ),
                eq(
                  issueCreatorEdgeReceivability.issueId,
                  priorCommand.issueId,
                ),
                eq(
                  issueCreatorEdgeReceivability.ownershipEpoch,
                  priorCommand.ownershipEpoch,
                ),
                eq(
                  issueCreatorEdgeReceivability.id,
                  priorCommand.creatorEdgeId,
                ),
              ),
            )
            .limit(2)
            .for("update");
          if (
            issueRows.length !== 1 ||
            edgeRows.length !== 1 ||
            priorCommand.continuityFenceGeneration <= 0
          ) {
            throw new OrdinaryIssueRuntimeRejected(
              "Accepted board reopen is missing canonical records",
              "board_reopen_incomplete",
            );
          }
          const issue = issueRows[0]!;
          const edge = edgeRows[0]!;
          if (priorCommand.branch === "agent_execution") {
            if (
              priorCommand.preservedOwnerKind !== "agent" ||
              !priorCommand.executionRefId ||
              priorCommand.systemEscalationIdentityId !== null
            ) {
              throw new OrdinaryIssueRuntimeRejected(
                "Accepted agent board reopen has an invalid checked branch",
                "board_reopen_incomplete",
              );
            }
            const refs = await tx
              .select()
              .from(issueExecutionRefs)
              .where(
                and(
                  eq(issueExecutionRefs.companyId, input.companyId),
                  eq(issueExecutionRefs.issueId, priorCommand.issueId),
                  eq(issueExecutionRefs.id, priorCommand.executionRefId),
                ),
              )
              .limit(2)
              .for("update");
            const executionRef = refs[0] ?? null;
            if (
              refs.length !== 1 ||
              !executionRef ||
              executionRef.ownershipEpoch !== priorCommand.ownershipEpoch ||
              executionRef.mode !== "owner" ||
              executionRef.sourceKind !== "issue_reopen" ||
              executionRef.sourceRecordId !== priorCommand.id ||
              executionRef.exactMessage !== issue.request ||
              executionRef.deliveryIdempotencyKey !==
                `board-reopen:${input.companyId}:${idempotencyKey}` ||
              executionRef.issueExecutionAuthorityId === null
            ) {
              throw new OrdinaryIssueRuntimeRejected(
                "Accepted agent board reopen lost its exact execution ref",
                "board_reopen_incomplete",
              );
            }
            return {
              issue,
              edge,
              command: priorCommand,
              dispatch: {
                kind: "agent_execution",
                executionRef:
                  projectPersistedIssueExecutionRef(executionRef),
              } satisfies IssueBoardReopenDispatch,
              escalationDispatchRefId: null,
              cancellations: null,
              retried: true as const,
            };
          }
          if (
            priorCommand.branch !== "board_only" ||
            !["user", "board"].includes(
              priorCommand.preservedOwnerKind,
            ) ||
            priorCommand.executionRefId !== null ||
            !priorCommand.systemEscalationIdentityId
          ) {
            throw new OrdinaryIssueRuntimeRejected(
              "Accepted board-only reopen has an invalid checked branch",
              "board_reopen_incomplete",
            );
          }
          const escalationIdentity =
            await lockSystemEscalationReopenIdentity(tx, issue);
          if (
            escalationIdentity.id !==
            priorCommand.systemEscalationIdentityId
          ) {
            throw new OrdinaryIssueRuntimeRejected(
              "Accepted board-only reopen lost its exact escalation identity",
              "board_reopen_incomplete",
            );
          }
          return {
            issue,
            edge,
            command: priorCommand,
            dispatch: { kind: "board_only" } satisfies IssueBoardReopenDispatch,
            escalationDispatchRefId: null,
            cancellations: null,
            retried: true as const,
          };
        }

        const issue = await tx
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.companyId, input.companyId),
              eq(issues.id, input.issueId),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (
          !issue ||
          !Number.isInteger(issue.ownershipEpoch) ||
          issue.ownershipEpoch <= 0 ||
          (issue.lifecycleStatus !== "done" &&
            issue.lifecycleStatus !== "cancelled") ||
          !issue.disposition
        ) {
          throw new OrdinaryIssueRuntimeRejected(
            "Board reopen requires a terminal issue with a disposition",
            "board_reopen_target_invalid",
          );
        }
        const priorStatus = issue.lifecycleStatus;
        const priorDisposition = issue.disposition;
        const sessionState = await lockIssueSessionState(
          tx,
          input.companyId,
          issue.id,
        );
        if (
          !sessionState ||
          sessionState.session.integrityState !== "ready" ||
          sessionState.session.timeArchived !== null ||
          sessionState.session.purgeFencedAt !== null
        ) {
          throw new OrdinaryIssueRuntimeRejected(
            "Board reopen target Session is lifecycle-fenced",
            "board_reopen_session_invalid",
          );
        }
        const { session, contextGeneration } = sessionState;
        const existingEdge = await lockReopenCreatorEdge(tx, issue);
        const endpointState = await inspectCreatorEndpoint(tx, issue);

        let branch: "agent_execution" | "board_only";
        let preservedOwnerKind: "agent" | "user" | "board";
        let authority: typeof issueExecutionAuthorities.$inferSelect | null =
          null;
        let revisionId: string | null = null;
        let ownerAgentId: string | null = null;
        let escalationIdentity: SystemEscalationIdentityRow | null = null;
        if (issue.ownerKind === "agent" && issue.ownerAgentId) {
          const resolution = await resolveOrdinaryIssueOwner(
            tx,
            input.companyId,
            issue.ownerAgentId,
          );
          const authorities = await tx
            .select()
            .from(issueExecutionAuthorities)
            .where(
              and(
                eq(issueExecutionAuthorities.companyId, input.companyId),
                eq(issueExecutionAuthorities.issueId, issue.id),
                eq(
                  issueExecutionAuthorities.ownershipEpoch,
                  issue.ownershipEpoch,
                ),
                eq(
                  issueExecutionAuthorities.agentId,
                  issue.ownerAgentId,
                ),
                eq(issueExecutionAuthorities.state, "current"),
              ),
            )
            .limit(2)
            .for("update");
          if (
            authorities.length !== 1 ||
            authorities[0]!.sessionId !== session.id
          ) {
            throw new OrdinaryIssueRuntimeRejected(
              "Board reopen owner authority is missing",
              "board_reopen_authority_missing",
            );
          }
          branch = "agent_execution";
          preservedOwnerKind = "agent";
          authority = authorities[0]!;
          revisionId = resolution.revisionId;
          ownerAgentId = issue.ownerAgentId;
        } else if (
          issue.ownerKind === "user" &&
          issue.ownerAssignmentSource === "user_creator_withdrawal"
        ) {
          throw new OrdinaryIssueRuntimeRejected(
            "A named-user creator withdrawal cannot be reopened",
            "board_reopen_target_invalid",
          );
        } else if (
          (issue.ownerKind === "user" && issue.ownerUserId) ||
          issue.ownerKind === "board"
        ) {
          if (
            issue.ownerAssignmentSource !== null ||
            issue.creatorKind !== "system"
          ) {
            throw new OrdinaryIssueRuntimeRejected(
              "Only a valid named-user or collective-board system escalation reopens without execution",
              "board_reopen_target_invalid",
            );
          }
          escalationIdentity =
            await lockSystemEscalationReopenIdentity(tx, issue);
          branch = "board_only";
          preservedOwnerKind = issue.ownerKind;
        } else {
          throw new OrdinaryIssueRuntimeRejected(
            "Board reopen owner is outside the two canonical branches",
            "board_reopen_target_invalid",
          );
        }

        const now = clock();
        const cancellations =
          await options.issueExecutionCancellation
            .requestScopeCancellationsInTransaction(tx, {
              companyId: input.companyId,
              issueId: issue.id,
              selector: {
                kind: "ownership_epoch",
                ownershipEpoch: issue.ownershipEpoch,
              },
              reason: "board_reopen_continuity_fence",
              actor: { kind: "user", userId: actorUserId },
              now,
            });
        const continuityFenceGeneration =
          await applyBoardReopenContinuityFence(tx, {
            companyId: input.companyId,
            issueId: issue.id,
            ownershipEpoch: issue.ownershipEpoch,
            at: now,
          });
        const reopened = await tx
          .update(issues)
          .set({
            lifecycleStatus: "open",
            disposition: null,
            completedAt: null,
            cancelledAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(issues.companyId, input.companyId),
              eq(issues.id, issue.id),
              eq(issues.ownershipEpoch, issue.ownershipEpoch),
              eq(issues.lifecycleStatus, priorStatus),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!reopened) {
          throw new OrdinaryIssueRuntimeRejected(
            "Issue changed while reopening",
            "board_reopen_lifecycle_conflict",
          );
        }
        const edge = await ensureReopenCreatorEdge(tx, {
          issue: reopened,
          sessionId: session.id,
          existing: existingEdge,
          endpointState,
          commandId,
          actorUserId,
          reason,
          now,
        });
        let executionRef: typeof issueExecutionRefs.$inferSelect | null = null;
        if (branch === "agent_execution") {
          if (!authority || !revisionId || !ownerAgentId) {
            throw new OrdinaryIssueRuntimeRejected(
              "Agent board reopen lost its locked owner authority",
              "board_reopen_authority_missing",
            );
          }
          const sourceKey =
            `board-reopen:${input.companyId}:${idempotencyKey}`;
          const admission = await sessions.admitExecutionSource(
            {
              companyId: input.companyId,
              issueId: issue.id,
              sessionId: session.id,
              ownershipEpoch: issue.ownershipEpoch,
              targetAgentId: ownerAgentId,
              issueExecutionAuthorityId: authority.id,
              consultExecutionId: null,
              adapterConfigRevisionId: revisionId,
              contextEpoch: contextGeneration,
              mode: "owner",
              sourceKind: "issue_reopen",
              actor: { kind: "user/board", userId: actorUserId },
              immutableSourceKey: sourceKey,
              sourceRecordId: commandId,
              exactText: issue.request,
              comment: {
                author: { kind: "user", userId: actorUserId },
                producingRun: null,
              },
              idempotencyKey: sourceKey,
            },
            tx,
          );
          if (!admission.ref) {
            throw new OrdinaryIssueRuntimeRejected(
              "Board reopen did not persist an execution ref",
              "board_reopen_ref_missing",
            );
          }
          executionRef = admission.ref;
        }
        const command = await tx
          .insert(issueBoardReopenCommands)
          .values({
            id: commandId,
            companyId: input.companyId,
            issueId: issue.id,
            actorUserId,
            reason,
            idempotencyKey,
            identityDigest,
            priorStatus,
            priorDisposition,
            ownershipEpoch: issue.ownershipEpoch,
            branch,
            preservedOwnerKind,
            continuityFenceGeneration,
            creatorEdgeId: edge.id,
            executionRefId: executionRef?.id ?? null,
            systemEscalationIdentityId: escalationIdentity?.id ?? null,
            createdAt: now,
          })
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!command) {
          throw new OrdinaryIssueRuntimeRejected(
            "Board reopen audit command was not persisted",
            "board_reopen_audit_missing",
          );
        }
        await recordIssueLivenessActionInTransaction(
          tx,
          `issue_board_reopen_command:${command.id}`,
        );
        const escalation =
          edge.state === "terminal" && reopened.creatorKind !== "system"
            ? await ensureSystemEscalationInTransaction(
                tx,
                sessions,
                {
                  companyId: input.companyId,
                  affectedIssueId: reopened.id,
                  affectedOwnershipEpoch: reopened.ownershipEpoch,
                  terminalCreatorEdgeId: edge.id,
                  systemSource: "recovery",
                  triggeringRunId: null,
                  causalSourceId: command.id,
                },
                clock,
              )
            : null;
        if (branch === "agent_execution") {
          if (!executionRef) {
            throw new OrdinaryIssueRuntimeRejected(
              "Agent board reopen lost its checked execution ref",
              "board_reopen_ref_missing",
            );
          }
          return {
            issue: reopened,
            edge,
            command,
            dispatch: {
              kind: "agent_execution",
              executionRef:
                projectPersistedIssueExecutionRef(executionRef),
            } satisfies IssueBoardReopenDispatch,
            escalationDispatchRefId: escalation?.dispatchRefId ?? null,
            cancellations,
            retried: false as const,
          };
        }
        return {
          issue: reopened,
          edge,
          command,
          dispatch: { kind: "board_only" } satisfies IssueBoardReopenDispatch,
          escalationDispatchRefId: escalation?.dispatchRefId ?? null,
          cancellations,
          retried: false as const,
        };
      });
      if (result.cancellations) {
        void options.issueExecutionCancellation
          .reconcileRequestedScopeCancellations(result.cancellations)
          .catch(() => {
            // The committed lifecycle fence keeps the prior refs ineligible.
          });
      }
      if (result.dispatch.kind === "agent_execution") {
        await dispatch(result.dispatch.executionRef.id);
      }
      if (result.escalationDispatchRefId) {
        await dispatch(result.escalationDispatchRefId);
      }
      const {
        escalationDispatchRefId: _,
        cancellations: __,
        ...publicResult
      } = result;
      return publicResult;
    },

    async userComment(input: OrdinaryIssueUserCommentInput) {
      const actorUserId = nonEmpty(input.actorUserId, "actorUserId");
      const message = nonBlankPreservingBytes(input.message, "message");
      const idempotencyKey = nonEmpty(
        input.idempotencyKey,
        "idempotencyKey",
      );
      const mention =
        input.mention == null
          ? null
          : {
              targetAgentId: nonEmpty(
                input.mention.targetAgentId,
                "mention.targetAgentId",
              ),
              ownershipEpoch: input.mention.ownershipEpoch,
            };
      const replyToCommentId = input.replyToCommentId == null
        ? null
        : nonEmpty(input.replyToCommentId, "replyToCommentId");
      if (mention && replyToCommentId) {
        throw new OrdinaryIssueRuntimeRejected(
          "A board comment cannot mention an agent and reply to a comment at the same time",
          "human_comment_target_conflict",
        );
      }
      if (
        mention &&
        (!Number.isInteger(mention.ownershipEpoch) ||
          mention.ownershipEpoch <= 0)
      ) {
        throw new OrdinaryIssueRuntimeRejected(
          "Mention ownership epoch must be a positive integer",
          "human_mention_epoch_invalid",
        );
      }
      const commandId = deterministicUuid(
        "board-user-comment",
        `${input.companyId}:${idempotencyKey}`,
      );
      const identityDigest = createHash("sha256")
        .update(
          canonicalJson({
            contract: "ordinary-board-user-comment/v2",
            companyId: input.companyId,
            issueId: input.issueId,
            actorUserId,
            message,
            idempotencyKey,
            mention,
            replyToCommentId,
          }),
        )
        .digest("hex");
      const result = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${input.companyId}:board-user-comment:${idempotencyKey}`}, 0))`,
        );
        const priorCommand = await tx
          .select()
          .from(issueBoardUserComments)
          .where(
            and(
              eq(issueBoardUserComments.companyId, input.companyId),
              eq(issueBoardUserComments.idempotencyKey, idempotencyKey),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (priorCommand) {
          if (
            priorCommand.identityDigest !== identityDigest ||
            priorCommand.issueId !== input.issueId ||
            priorCommand.actorUserId !== actorUserId
          ) {
            throw new OrdinaryIssueRuntimeRejected(
              "Board comment idempotency key changed immutable input",
              "board_comment_idempotency_conflict",
            );
          }
          const [issue, comment, ref, commentSource] = await Promise.all([
            tx
              .select()
              .from(issues)
              .where(
                and(
                  eq(issues.companyId, input.companyId),
                  eq(issues.id, priorCommand.issueId),
                ),
              )
              .then((rows) => rows[0] ?? null),
            tx
              .select()
              .from(issueComments)
              .where(eq(issueComments.id, priorCommand.commentId))
              .then((rows) => rows[0] ?? null),
            priorCommand.executionRefId
              ? tx
                  .select()
                  .from(issueExecutionRefs)
                  .where(
                    eq(
                      issueExecutionRefs.id,
                      priorCommand.executionRefId,
                    ),
                  )
                  .then((rows) => rows[0] ?? null)
              : Promise.resolve(null),
            tx
              .select()
              .from(issueCommentProjectionSources)
              .where(
                eq(
                  issueCommentProjectionSources.commentId,
                  priorCommand.commentId,
                ),
              )
              .limit(1)
              .then((rows) => rows[0] ?? null),
          ]);
          if (
            !issue ||
            !comment ||
            !commentSource ||
            (priorCommand.executionRefId !== null && !ref)
          ) {
            throw new OrdinaryIssueRuntimeRejected(
              "Accepted board comment is missing canonical records",
              "board_comment_incomplete",
            );
          }
          return {
            issue,
            comment,
            ref,
            command: priorCommand,
            steeringSourceCommentId:
              commentSource.steeringTargetRunId === null
                ? null
                : comment.id,
            retried: true,
          };
        }

        const issue = await tx
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.companyId, input.companyId),
              eq(issues.id, input.issueId),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!issue || !issue.lifecycleStatus || !issue.ownershipEpoch) {
          throw new OrdinaryIssueRuntimeRejected(
            "Board comments require a canonical ordinary issue",
            "board_comment_target_invalid",
          );
        }
        const sessionState = await lockIssueSessionState(
          tx,
          input.companyId,
          issue.id,
        );
        if (!sessionState) {
          throw new OrdinaryIssueRuntimeRejected(
            "Board comment target Session is missing",
            "board_comment_session_missing",
          );
        }
        const { session, contextGeneration } = sessionState;
        const replyParent = replyToCommentId
          ? await tx
              .select()
              .from(issueComments)
              .where(
                and(
                  eq(issueComments.companyId, input.companyId),
                  eq(issueComments.issueId, issue.id),
                  eq(issueComments.id, replyToCommentId),
                ),
              )
              .for("update")
              .then((rows) => rows[0] ?? null)
          : null;
        if (replyToCommentId && !replyParent) {
          throw new OrdinaryIssueRuntimeRejected(
            "Reply target is not a persisted comment on this issue",
            "human_reply_parent_missing",
          );
        }
        const sourceKey = `board-user-comment:${input.companyId}:${idempotencyKey}`;
        let admission: IssueSessionAdmissionResult;
        let steeringRequested = false;
        if (mention) {
          if (
            !NONTERMINAL.has(issue.lifecycleStatus) ||
            issue.ownerKind !== "agent" ||
            !issue.ownerAgentId ||
            issue.ownerAgentId !== mention.targetAgentId ||
            issue.ownershipEpoch !== mention.ownershipEpoch
          ) {
            throw new OrdinaryIssueRuntimeRejected(
              "Mention target must be the exact current owner and ownership epoch",
              "human_mention_scope_invalid",
            );
          }
          const { revisionId } = await resolveOrdinaryIssueOwner(
            tx,
            input.companyId,
            issue.ownerAgentId,
          );
          const authority = await tx
            .select()
            .from(issueExecutionAuthorities)
            .where(
              and(
                eq(
                  issueExecutionAuthorities.companyId,
                  input.companyId,
                ),
                eq(issueExecutionAuthorities.issueId, issue.id),
                eq(
                  issueExecutionAuthorities.ownershipEpoch,
                  mention.ownershipEpoch,
                ),
                eq(
                  issueExecutionAuthorities.agentId,
                  mention.targetAgentId,
                ),
                eq(issueExecutionAuthorities.state, "current"),
              ),
            )
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (!authority) {
            throw new OrdinaryIssueRuntimeRejected(
              "Mention target authority is missing",
              "human_mention_authority_missing",
            );
          }
          admission = await sessions.admitExecutionSource(
            {
              companyId: input.companyId,
              issueId: issue.id,
              sessionId: session.id,
              ownershipEpoch: mention.ownershipEpoch,
              targetAgentId: mention.targetAgentId,
              issueExecutionAuthorityId: authority.id,
              consultExecutionId: null,
              adapterConfigRevisionId: revisionId,
              contextEpoch: contextGeneration,
              mode: "owner",
              sourceKind: "human_comment_mention",
              actor: { kind: "user/board", userId: actorUserId },
              immutableSourceKey: sourceKey,
              sourceRecordId: commandId,
              exactText: message,
              comment: {
                author: { kind: "user", userId: actorUserId },
                producingRun: null,
              },
              idempotencyKey: sourceKey,
            },
            tx,
          );
        } else if (replyParent?.runId) {
          if (!replyParent.authorAgentId) {
            throw new OrdinaryIssueRuntimeRejected(
              "A run-attributed reply target must have one canonical producing agent",
              "human_reply_run_not_steerable",
            );
          }
          admission = await sessions.admitSteeringComment(
            {
              companyId: input.companyId,
              issueId: issue.id,
              sessionId: session.id,
              sourceKind: "human_active_run_steering",
              actor: { kind: "user/board", userId: actorUserId },
              immutableSourceKey: sourceKey,
              sourceRecordId: commandId,
              exactText: message,
              comment: {
                author: { kind: "user", userId: actorUserId },
                producingRun: null,
                replyToCommentId,
              },
            },
            tx,
          );
          if (!admission.comment || !admission.input || admission.ref) {
            throw new OrdinaryIssueRuntimeRejected(
              "Run steering did not persist its canonical comment and Session input",
              "board_comment_projection_missing",
            );
          }
          await withOrdinaryHumanSteeringErrors(() =>
            options.issueExecutionRunService.requestSteeringInTransaction(
              tx,
              {
                companyId: input.companyId,
                issueId: issue.id,
                ownershipEpoch: issue.ownershipEpoch,
                runId: replyParent.runId!,
                targetAgentId: replyParent.authorAgentId!,
                exactMessage: message,
                sourceCommentId: admission.comment!.id,
                sourceMessageId: admission.source.messageId,
                sourceInputId: admission.input!.id,
                actor: { kind: "user", userId: actorUserId },
              },
            ),
          );
          steeringRequested = true;
        } else {
          admission = await sessions.appendNonDispatchUserComment(
            {
              companyId: input.companyId,
              issueId: issue.id,
              sessionId: session.id,
              sourceKind: "human_comment",
              immutableSourceKey: sourceKey,
              sourceRecordId: commandId,
              exactText: message,
              delivery: "queue",
              comment: {
                author: { kind: "user", userId: actorUserId },
                producingRun: null,
                replyToCommentId,
              },
            },
            tx,
          );
        }
        if (
          !admission.comment ||
          (mention !== null && !admission.ref) ||
          (steeringRequested && (!admission.input || admission.ref !== null))
        ) {
          throw new OrdinaryIssueRuntimeRejected(
            "Board comment did not persist its canonical projection",
            "board_comment_projection_missing",
          );
        }
        const now = clock();
        const command = await tx
          .insert(issueBoardUserComments)
          .values({
            id: commandId,
            companyId: input.companyId,
            issueId: issue.id,
            ownershipEpoch: issue.ownershipEpoch,
            actorUserId,
            idempotencyKey,
            identityDigest,
            mentionTargetAgentId: mention?.targetAgentId ?? null,
            commentId: admission.comment.id,
            executionRefId: admission.ref?.id ?? null,
            createdAt: now,
          })
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!command) {
          throw new OrdinaryIssueRuntimeRejected(
            "Board comment command was not persisted",
            "board_comment_audit_missing",
          );
        }
        await recordIssueLivenessActionInTransaction(
          tx,
          `issue_board_user_comment:${command.id}`,
        );
        return {
          issue,
          comment: admission.comment,
          ref: admission.ref,
          command,
          steeringSourceCommentId: steeringRequested
            ? admission.comment.id
            : null,
          retried: false,
        };
      });
      if (result.ref) {
        await dispatch(result.ref.id);
      }
      if (result.steeringSourceCommentId) {
        await withOrdinaryHumanSteeringErrors(() =>
          options.issueExecutionRunService.continuePendingSteeringForSource({
            companyId: result.issue.companyId,
            issueId: result.issue.id,
            sourceCommentId: result.steeringSourceCommentId!,
          }),
        );
      }
      return result;
    },

    async commitOwnerFormUpdate(
      issueId: string,
      input: CanonicalOwnerFormUpdate,
      ownerAuthority: CanonicalOwnerFormAuthority,
    ) {
      return withOrdinaryIssueFormErrors(() =>
        issueForms.commitOwnerFormUpdate(
          issueId,
          input,
          ownerAuthority,
        ),
      );
    },

    async commitCreatorFormUpdate(
      issueId: string,
      message: string,
      creatorAuthority: CanonicalCreatorFormAuthority,
    ) {
      return withOrdinaryIssueFormErrors(() =>
        issueForms.commitCreatorFormUpdate(
          issueId,
          message,
          creatorAuthority,
        ),
      );
    },

    async reassign(input: OrdinaryIssueReassignInput) {
      const ownerAgentId = nonEmpty(input.ownerAgentId, "ownerAgentId");
      const idempotencyKey = nonEmpty(
        input.idempotencyKey,
        "idempotencyKey",
      );
      const result = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${input.companyId}:${input.issueId}`}, 0))`,
        );
        const pluginOwnerResolution =
          input.creator.kind === "plugin"
            ? await assertPluginPermittedIssueOwnerInTransaction(tx, {
                companyId: input.companyId,
                pluginInstallationId:
                  input.creator.pluginInstallationId,
                pluginKey: input.creator.pluginKey,
                operation: "issues.update",
                ownerAgentId,
              })
            : null;
        const priorRef = await tx
          .select()
          .from(issueExecutionRefs)
          .where(
            and(
              eq(issueExecutionRefs.companyId, input.companyId),
              eq(issueExecutionRefs.sourceKind, "issue_reassignment"),
              eq(
                issueExecutionRefs.deliveryIdempotencyKey,
                idempotencyKey,
              ),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (priorRef) {
          if (
            priorRef.issueId !== input.issueId ||
            priorRef.targetAgentId !== ownerAgentId
          ) {
            throw new OrdinaryIssueRuntimeRejected(
              "Reassignment idempotency key changed immutable input",
              "reassignment_idempotency_conflict",
            );
          }
          const issue = await tx
            .select()
            .from(issues)
            .where(eq(issues.id, input.issueId))
            .then((rows) => rows[0] ?? null);
          return {
            issue,
            ref: priorRef,
            escalationDispatchRefIds: [] as string[],
            cancellations: null,
            retried: true,
          };
        }
        const issue = await tx
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.companyId, input.companyId),
              eq(issues.id, input.issueId),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (
          !issue ||
          !issue.ownershipEpoch ||
          issue.ownerKind !== "agent" ||
          !issue.ownerAgentId ||
          !issue.request ||
          !issue.lifecycleStatus ||
          !NONTERMINAL.has(issue.lifecycleStatus)
        ) {
          throw new OrdinaryIssueRuntimeRejected(
            "Reassignment requires a nonterminal agent-owned issue",
            "reassignment_target_invalid",
          );
        }
        const creatorMatches =
          input.creator.kind === "user/board"
            ? issue.creatorKind === "user/board" &&
              issue.creatorUserId === input.creator.userId
            : issue.creatorKind === "plugin" &&
              issue.creatorPluginInstallationId ===
                input.creator.pluginInstallationId &&
              issue.creatorPluginKey === input.creator.pluginKey;
        if (!creatorMatches) {
          throw new OrdinaryIssueRuntimeRejected(
            "Creator identity does not match this issue",
            "creator_authority_mismatch",
          );
        }
        const ownerResolution =
          input.creator.kind === "plugin"
            ? pluginOwnerResolution!
            : await resolveOrdinaryIssueOwner(
                tx,
                input.companyId,
                ownerAgentId,
              );
        return commitAgentOwnerReassignmentInTransaction(tx, {
          issue,
          ownerAgentId,
          idempotencyKey,
          sourceAuthorityId:
            input.creator.kind === "plugin"
              ? input.creator.pluginInstallationId
              : input.creator.userId,
          cancellationActor:
            input.creator.kind === "user/board"
              ? {
                  kind: "user",
                  userId: input.creator.userId,
                }
              : { kind: "system" },
          comment:
            input.creator.kind === "plugin"
              ? {
                  author: {
                    kind: "plugin",
                    pluginInstallationId:
                      input.creator.pluginInstallationId,
                    pluginKey: input.creator.pluginKey,
                  },
                  producingRun: null,
                }
              : {
                  author: {
                    kind: "user",
                    userId: input.creator.userId,
                  },
                  producingRun: null,
                },
          provenanceUserId:
            input.creator.kind === "user/board"
              ? input.creator.userId
              : null,
          sourceActor:
            input.creator.kind === "user/board"
              ? {
                  kind: "user/board",
                  userId: input.creator.userId,
                }
              : {
                  kind: "plugin",
                  pluginInstallationId:
                    input.creator.pluginInstallationId,
                  pluginKey: input.creator.pluginKey,
                },
          ownerResolution,
        });
      });
      if (result.cancellations) {
        await options.issueExecutionCancellation
          .reconcileRequestedScopeCancellations(
            result.cancellations,
          );
      }
      for (const refId of result.escalationDispatchRefIds) {
        await dispatch(refId);
      }
      await dispatch(result.ref.id);
      return result;
    },

    async boardReassign(input: OrdinaryIssueBoardReassignInput) {
      const ownerAgentId = nonEmpty(input.ownerAgentId, "ownerAgentId");
      const actorUserId = nonEmpty(input.actorUserId, "actorUserId");
      const idempotencyKey = nonEmpty(
        input.idempotencyKey,
        "idempotencyKey",
      );
      const auditId = deterministicUuid(
        "board-issue-reassignment-audit",
        `${input.companyId}:${idempotencyKey}`,
      );
      const result = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${input.companyId}:board-reassign:${idempotencyKey}`}, 0))`,
        );
        const priorRef = await tx
          .select()
          .from(issueExecutionRefs)
          .where(
            and(
              eq(issueExecutionRefs.companyId, input.companyId),
              eq(issueExecutionRefs.sourceKind, "issue_reassignment"),
              eq(
                issueExecutionRefs.deliveryIdempotencyKey,
                idempotencyKey,
              ),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (priorRef) {
          if (
            priorRef.issueId !== input.issueId ||
            priorRef.targetAgentId !== ownerAgentId
          ) {
            throw new OrdinaryIssueRuntimeRejected(
              "Board reassignment idempotency key changed immutable input",
              "reassignment_idempotency_conflict",
            );
          }
          const [issue, audit] = await Promise.all([
            tx
              .select()
              .from(issues)
              .where(
                and(
                  eq(issues.companyId, input.companyId),
                  eq(issues.id, input.issueId),
                ),
              )
              .then((rows) => rows[0] ?? null),
            tx
              .select()
              .from(activityLog)
              .where(eq(activityLog.id, auditId))
              .then((rows) => rows[0] ?? null),
          ]);
          if (
            !issue ||
            !audit ||
            audit.actorId !== actorUserId ||
            audit.action !== "issue.board_reassigned"
          ) {
            throw new OrdinaryIssueRuntimeRejected(
              "Accepted board reassignment is missing its audit record",
              "reassignment_audit_missing",
            );
          }
          return {
            issue,
            ref: priorRef,
            auditId,
            escalationDispatchRefIds: [] as string[],
            cancellations: null,
            retried: true as const,
          };
        }
        const issue = await tx
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.companyId, input.companyId),
              eq(issues.id, input.issueId),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!issue) {
          throw new OrdinaryIssueRuntimeRejected(
            "Board reassignment target does not exist",
            "reassignment_target_invalid",
          );
        }
        const ownerResolution = await resolveOrdinaryIssueOwner(
          tx,
          input.companyId,
          ownerAgentId,
        );
        const previousOwnerAgentId = issue.ownerAgentId;
        const previousOwnershipEpoch = issue.ownershipEpoch;
        const reassigned =
          await commitAgentOwnerReassignmentInTransaction(tx, {
            issue,
            ownerAgentId,
            idempotencyKey,
            sourceAuthorityId: actorUserId,
            cancellationActor: {
              kind: "user",
              userId: actorUserId,
            },
            comment: {
              author: { kind: "user", userId: actorUserId },
              producingRun: null,
            },
            sourceActor: {
              kind: "user/board",
              userId: actorUserId,
            },
            provenanceUserId: actorUserId,
            ownerResolution,
          });
        await tx.insert(activityLog).values({
          id: auditId,
          companyId: input.companyId,
          actorType: "user",
          actorId: actorUserId,
          action: "issue.board_reassigned",
          entityType: "issue",
          entityId: issue.id,
          responsibleUserId: actorUserId,
          details: {
            contract: "board-issue-reassignment/v1",
            idempotencyKey,
            previousOwnerAgentId,
            previousOwnershipEpoch,
            ownerAgentId,
            ownershipEpoch: reassigned.issue.ownershipEpoch,
            executionRefId: reassigned.ref.id,
          },
          createdAt: clock(),
        });
        return { ...reassigned, auditId };
      });
      if (result.cancellations) {
        await options.issueExecutionCancellation
          .reconcileRequestedScopeCancellations(
            result.cancellations,
          );
      }
      for (const refId of result.escalationDispatchRefIds) {
        await dispatch(refId);
      }
      await dispatch(result.ref.id);
      return result;
    },

    async userCreatorWithdrawalSelfAssign(
      input: OrdinaryIssueUserWithdrawalSelfAssignmentInput,
    ) {
      const actorUserId = nonEmpty(input.actorUserId, "actorUserId");
      const idempotencyKey = nonEmpty(
        input.idempotencyKey,
        "idempotencyKey",
      );
      const auditId = deterministicUuid(
        "user-creator-withdrawal-self-assignment",
        `${input.companyId}:${idempotencyKey}`,
      );
      const withdrawalCommandId = deterministicUuid(
        "user-creator-withdrawal-command",
        `${input.companyId}:${idempotencyKey}`,
      );
      const committed = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${input.companyId}:user-creator-withdrawal:${idempotencyKey}`}, 0))`,
        );
        const priorAudit = await tx
          .select()
          .from(activityLog)
          .where(eq(activityLog.id, auditId))
          .then((rows) => rows[0] ?? null);
        if (priorAudit) {
          if (
            priorAudit.companyId !== input.companyId ||
            priorAudit.entityId !== input.issueId ||
            priorAudit.actorId !== actorUserId ||
            priorAudit.action !==
              "issue.user_creator_withdrawal_self_assigned"
          ) {
            throw new OrdinaryIssueRuntimeRejected(
              "Withdrawal self-assignment idempotency key changed immutable input",
              "withdrawal_self_assignment_idempotency_conflict",
            );
          }
          const [issue, command] = await Promise.all([
            tx
              .select()
              .from(issues)
              .where(
                and(
                  eq(issues.companyId, input.companyId),
                  eq(issues.id, input.issueId),
                ),
              )
              .then((rows) => rows[0] ?? null),
            tx
              .select()
              .from(issueCreatorWithdrawalCommands)
              .where(
                eq(
                  issueCreatorWithdrawalCommands.id,
                  withdrawalCommandId,
                ),
              )
              .limit(1)
              .then((rows) => rows[0] ?? null),
          ]);
          if (
            !issue ||
            !command ||
            command.companyId !== input.companyId ||
            command.issueId !== input.issueId ||
            command.actorKind !== "user" ||
            command.actorUserId !== actorUserId ||
            command.resultingCreatorEdgeId === null ||
            command.resultingOwnershipEpoch !== issue.ownershipEpoch ||
            command.outgoingOwnershipEpoch + 1 !==
              command.resultingOwnershipEpoch
          ) {
            throw new OrdinaryIssueRuntimeRejected(
              "Accepted withdrawal self-assignment lost its canonical command",
              "withdrawal_self_assignment_incomplete",
            );
          }
          return {
            issue,
            auditId,
            command,
            escalationDispatchRefIds: [] as string[],
            cancellations: null,
            retried: true as const,
          };
        }
        const issue = await tx
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.companyId, input.companyId),
              eq(issues.id, input.issueId),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (
          !issue ||
          !issue.ownershipEpoch ||
          !issue.lifecycleStatus ||
          !NONTERMINAL.has(issue.lifecycleStatus) ||
          issue.creatorKind !== "user/board" ||
          issue.creatorUserId !== actorUserId ||
          issue.ownerKind !== "agent" ||
          !issue.ownerAgentId
        ) {
          throw new OrdinaryIssueRuntimeRejected(
            "Only the exact named-user creator may self-assign a nonterminal agent-owned issue for withdrawal",
            "withdrawal_self_assignment_target_invalid",
          );
        }
        const sessionState = await lockIssueSessionState(
          tx,
          input.companyId,
          issue.id,
        );
        if (!sessionState) {
          throw new OrdinaryIssueRuntimeRejected(
            "Withdrawal self-assignment target Session is missing",
            "withdrawal_self_assignment_session_missing",
          );
        }
        const outgoingAuthority = await tx
          .select()
          .from(issueExecutionAuthorities)
          .where(
            and(
              eq(issueExecutionAuthorities.companyId, input.companyId),
              eq(issueExecutionAuthorities.issueId, issue.id),
              eq(
                issueExecutionAuthorities.ownershipEpoch,
                issue.ownershipEpoch,
              ),
              eq(
                issueExecutionAuthorities.agentId,
                issue.ownerAgentId,
              ),
              eq(issueExecutionAuthorities.state, "current"),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!outgoingAuthority) {
          throw new OrdinaryIssueRuntimeRejected(
            "Withdrawal self-assignment has no outgoing owner authority",
            "withdrawal_self_assignment_authority_missing",
          );
        }
        const now = clock();
        const revocation =
          await revokeOutgoingOwnershipEpoch(
            tx,
            sessions,
            options.issueExecutionCancellation,
            {
              companyId: input.companyId,
              issueId: issue.id,
              sessionId: sessionState.session.id,
              ownershipEpoch: issue.ownershipEpoch,
              authorityId: outgoingAuthority.id,
              sourceAuthorityId: actorUserId,
              cancellationActor: {
                kind: "user",
                userId: actorUserId,
              },
              now,
            },
          );
        const ownershipEpoch = issue.ownershipEpoch + 1;
        const reassigned = await tx
          .update(issues)
          .set({
            ownerKind: "user",
            ownerAgentId: null,
            ownerUserId: actorUserId,
            ownerAssignmentSource: "user_creator_withdrawal",
            ownershipEpoch,
            updatedAt: now,
          })
          .where(
            and(
              eq(issues.companyId, input.companyId),
              eq(issues.id, issue.id),
              eq(issues.ownershipEpoch, issue.ownershipEpoch),
              inArray(issues.lifecycleStatus, ["open", "blocked"]),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!reassigned) {
          throw new OrdinaryIssueRuntimeRejected(
            "Ownership epoch changed during withdrawal self-assignment",
            "withdrawal_self_assignment_epoch_conflict",
          );
        }
        await withOrdinaryWorkspaceReservationErrors(() =>
          reserveIssueExecutionWorkspaceBinding(tx, {
            issue: reassigned,
            session: {
              id: sessionState.session.id,
              now,
            },
            provenance: {
              agentId: null,
              userId: actorUserId,
            },
          }),
        );
        const resultingEdge = await insertCreatorEdge(
          tx,
          reassigned,
          sessionState.session.id,
          now,
        );
        const command = await tx
          .insert(issueCreatorWithdrawalCommands)
          .values({
            id: withdrawalCommandId,
            companyId: input.companyId,
            issueId: issue.id,
            outgoingOwnershipEpoch: issue.ownershipEpoch,
            resultingOwnershipEpoch: ownershipEpoch,
            resultingCreatorEdgeId: resultingEdge.id,
            actorKind: "user",
            actorUserId,
            actorPluginInstallationId: null,
            actorPluginKey: null,
            pluginWithdrawalOperationId: null,
            issueUpdateId: null,
            acceptedAt: now,
          })
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!command) {
          throw new OrdinaryIssueRuntimeRejected(
            "Withdrawal self-assignment command was not persisted",
            "withdrawal_self_assignment_command_missing",
          );
        }
        await recordIssueLivenessActionInTransaction(
          tx,
          `issue_creator_withdrawal_command:${command.id}`,
        );
        await tx.insert(activityLog).values({
          id: auditId,
          companyId: input.companyId,
          actorType: "user",
          actorId: actorUserId,
          action: "issue.user_creator_withdrawal_self_assigned",
          entityType: "issue",
          entityId: issue.id,
          responsibleUserId: actorUserId,
          details: {
            contract: "user-creator-withdrawal-self-assignment/v1",
            idempotencyKey,
            outgoingOwnerAgentId: issue.ownerAgentId,
            outgoingOwnershipEpoch: issue.ownershipEpoch,
            ownershipEpoch,
            ownerAssignmentSource: "user_creator_withdrawal",
          },
          createdAt: now,
        });
        return {
          issue: reassigned,
          auditId,
          command,
          escalationDispatchRefIds:
            revocation.escalationDispatchRefIds,
          cancellations: revocation.cancellations,
          retried: false as const,
        };
      });
      if (committed.cancellations) {
        await options.issueExecutionCancellation
          .reconcileRequestedScopeCancellations(
            committed.cancellations,
          );
      }
      for (const refId of committed.escalationDispatchRefIds) {
        await dispatch(refId);
      }
      return committed;
    },

    async preparePluginWithdrawal(
      input: OrdinaryPluginWithdrawalPrepareInput,
    ) {
      const message = nonBlankPreservingBytes(input.message, "message");
      const operationId = nonEmpty(input.operationId, "operationId");
      const identityDigest = createHash("sha256")
        .update(
          canonicalJson({
            companyId: input.companyId,
            issueId: input.issueId,
            message,
            operationId,
            pluginInstallationId: input.pluginInstallationId,
            pluginKey: input.pluginKey,
          }),
        )
        .digest("hex");
      const inserted = await db
        .insert(pluginWithdrawalOperations)
        .values({
          companyId: input.companyId,
          pluginInstallationId: input.pluginInstallationId,
          pluginKey: input.pluginKey,
          hostRpcOperationId: operationId,
          identityDigest,
          issueId: input.issueId,
          message,
          state: "pending",
          result: null,
          issueUpdateId: null,
          mutationCommentId: null,
        })
        .onConflictDoNothing()
        .returning()
        .then((rows) => rows[0] ?? null);
      const operation =
        inserted ??
        (await db
          .select()
          .from(pluginWithdrawalOperations)
          .where(
            and(
              eq(
                pluginWithdrawalOperations.pluginInstallationId,
                input.pluginInstallationId,
              ),
              eq(
                pluginWithdrawalOperations.hostRpcOperationId,
                operationId,
              ),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null));
      if (
        !operation ||
        operation.identityDigest !== identityDigest ||
        operation.companyId !== input.companyId ||
        operation.issueId !== input.issueId ||
        operation.pluginKey !== input.pluginKey ||
        operation.message !== message
      ) {
        throw new OrdinaryIssueRuntimeRejected(
          "Plugin withdrawal operation changed immutable input",
          "plugin_withdrawal_idempotency_conflict",
        );
      }
      return { operationId };
    },

    async withdrawPluginIssue(input: OrdinaryPluginWithdrawalInput) {
      const operationId = nonEmpty(input.operationId, "operationId");
      const outcome: PluginWithdrawalCommitOutcome = await db.transaction(
        async (tx): Promise<PluginWithdrawalCommitOutcome> => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${input.pluginInstallationId}:${operationId}`}, 0))`,
        );
        const operation = await tx
          .select()
          .from(pluginWithdrawalOperations)
          .where(
            and(
              eq(
                pluginWithdrawalOperations.pluginInstallationId,
                input.pluginInstallationId,
              ),
              eq(
                pluginWithdrawalOperations.hostRpcOperationId,
                operationId,
              ),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (
          !operation ||
          operation.companyId !== input.companyId ||
          operation.pluginKey !== input.pluginKey
        ) {
          throw new OrdinaryIssueRuntimeRejected(
            "Plugin withdrawal operation was not prepared by this installation",
            "plugin_withdrawal_not_prepared",
          );
        }
        const withdrawalCommandId = deterministicUuid(
          "plugin-creator-withdrawal-command",
          operation.id,
        );
        if (operation.state === "accepted") {
          const issue = recordedPluginWithdrawalIssue(operation.result);
          const command = await tx
            .select()
            .from(issueCreatorWithdrawalCommands)
            .where(
              eq(
                issueCreatorWithdrawalCommands.id,
                withdrawalCommandId,
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (
            !issue ||
            !command ||
            command.companyId !== input.companyId ||
            command.issueId !== operation.issueId ||
            command.actorKind !== "plugin" ||
            command.actorUserId !== null ||
            command.actorPluginInstallationId !==
              input.pluginInstallationId ||
            command.actorPluginKey !== input.pluginKey ||
            command.pluginWithdrawalOperationId !== operation.id ||
            command.issueUpdateId !== operation.issueUpdateId ||
            command.resultingCreatorEdgeId !== null ||
            command.resultingOwnershipEpoch !== issue.ownershipEpoch ||
            command.outgoingOwnershipEpoch + 1 !==
              command.resultingOwnershipEpoch
          ) {
            throw new OrdinaryIssueRuntimeRejected(
              "Accepted plugin withdrawal is missing its canonical command",
              "plugin_withdrawal_result_missing",
            );
          }
          return {
            kind: "accepted",
            operationId,
            issue,
            escalationDispatchRefIds: [] as string[],
            cancellations: null,
            retried: true,
          };
        }
        if (operation.state === "rejected") {
          const rejection = recordedPluginWithdrawalRejection(operation.result);
          if (!rejection) {
            throw new OrdinaryIssueRuntimeRejected(
              "Rejected plugin withdrawal is missing its recorded result",
              "plugin_withdrawal_result_missing",
            );
          }
          return { kind: "rejected", ...rejection };
        }
        const issue = await tx
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.companyId, input.companyId),
              eq(issues.id, operation.issueId),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (
          !issue ||
          !issue.ownershipEpoch ||
          issue.creatorKind !== "plugin" ||
          issue.creatorPluginInstallationId !==
            input.pluginInstallationId ||
          issue.creatorPluginKey !== input.pluginKey ||
          issue.ownerKind !== "agent" ||
          !issue.ownerAgentId ||
          !issue.lifecycleStatus ||
          !NONTERMINAL.has(issue.lifecycleStatus)
        ) {
          const now = clock();
          const rejection = {
            message:
              "Issue is not a matching nonterminal plugin-created issue",
            reason: "plugin_withdrawal_target_invalid",
          };
          await tx
            .update(pluginWithdrawalOperations)
            .set({
              state: "rejected",
              result: { kind: "rejected", ...rejection },
              completedAt: now,
              updatedAt: now,
            })
            .where(eq(pluginWithdrawalOperations.id, operation.id));
          return { kind: "rejected", ...rejection };
        }
        const session = await tx
          .select()
          .from(issueSessions)
          .where(
            and(
              eq(issueSessions.companyId, input.companyId),
              eq(issueSessions.issueId, issue.id),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        const authority = await tx
          .select()
          .from(issueExecutionAuthorities)
          .where(
            and(
              eq(issueExecutionAuthorities.companyId, input.companyId),
              eq(issueExecutionAuthorities.issueId, issue.id),
              eq(
                issueExecutionAuthorities.ownershipEpoch,
                issue.ownershipEpoch,
              ),
              eq(
                issueExecutionAuthorities.agentId,
                issue.ownerAgentId,
              ),
              eq(issueExecutionAuthorities.state, "current"),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!session || !authority) {
          throw new OrdinaryIssueRuntimeRejected(
            "Plugin withdrawal target has no current Session authority",
            "plugin_withdrawal_authority_missing",
          );
        }
        const now = clock();
        const revocation =
          await revokeOutgoingOwnershipEpoch(
            tx,
            sessions,
            options.issueExecutionCancellation,
            {
              companyId: input.companyId,
              issueId: issue.id,
              sessionId: session.id,
              ownershipEpoch: issue.ownershipEpoch,
              authorityId: authority.id,
              sourceAuthorityId: input.pluginInstallationId,
              cancellationActor: { kind: "system" },
              now,
            },
          );
        const ownershipEpoch = issue.ownershipEpoch + 1;
        const withdrawn = await tx
          .update(issues)
          .set({
            boardPresentationStatus: "cancelled",
            lifecycleStatus: "cancelled",
            disposition: {
              message: operation.message,
              structuredResult: {
                reason: "plugin_creator_withdrawal",
                outgoingOwnershipEpoch: issue.ownershipEpoch,
              },
            },
            ownershipEpoch,
            cancelledAt: now,
            completedAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(issues.id, issue.id),
              eq(issues.ownershipEpoch, issue.ownershipEpoch),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!withdrawn) {
          throw new OrdinaryIssueRuntimeRejected(
            "Ownership epoch changed during plugin withdrawal",
            "plugin_withdrawal_epoch_conflict",
          );
        }
        await withOrdinaryWorkspaceReservationErrors(() =>
          reserveIssueExecutionWorkspaceBinding(tx, {
            issue: withdrawn,
            session: {
              id: session.id,
              now,
            },
          }),
        );
        const comment = await sessions.appendNonDispatchControlNotice(
          {
            companyId: input.companyId,
            issueId: issue.id,
            sessionId: session.id,
            sourceKind: "plugin_withdrawal",
            immutableSourceKey: operation.id,
            sourceRecordId: operation.id,
            exactText: operation.message,
            comment: {
              author: {
                kind: "plugin",
                pluginInstallationId: input.pluginInstallationId,
                pluginKey: input.pluginKey,
              },
              producingRun: null,
            },
            allowTerminal: true,
          },
          tx,
        );
        if (!comment.comment) {
          throw new OrdinaryIssueRuntimeRejected(
            "Plugin withdrawal comment was not persisted",
            "plugin_withdrawal_comment_missing",
          );
        }
        const update = await tx
          .insert(issueUpdates)
          .values({
            id: deterministicUuid(
              "plugin-withdrawal-update",
              operation.id,
            ),
            companyId: input.companyId,
            issueId: issue.id,
            sessionId: session.id,
            ownershipEpoch,
            form: "owner",
            sourceKind: "plugin",
            sourceAuthorityId: null,
            sourceIdentity: {
              pluginInstallationId: input.pluginInstallationId,
              pluginKey: input.pluginKey,
              withdrawalOperationId: operation.id,
            },
            runId: null,
            gatewayInvocationId: `plugin-withdrawal:${operation.id}`,
            runSequence: 0,
            message: operation.message,
            status: "cancelled",
            disposition: withdrawn.disposition,
            commentId: comment.comment.id,
            creatorEdgeId: null,
            createdAt: now,
          })
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!update) {
          throw new OrdinaryIssueRuntimeRejected(
            "Plugin withdrawal update was not persisted",
            "plugin_withdrawal_update_missing",
          );
        }
        const acceptedOperation = await tx
          .update(pluginWithdrawalOperations)
          .set({
            state: "accepted",
            result: {
              kind: "accepted",
              operationId,
              issueId: issue.id,
              ownershipEpoch,
              status: "cancelled",
              issue: pluginWithdrawalIssueSnapshot(withdrawn),
            },
            issueUpdateId: update.id,
            mutationCommentId: comment.comment.id,
            completedAt: now,
            updatedAt: now,
          })
          .where(eq(pluginWithdrawalOperations.id, operation.id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!acceptedOperation) {
          throw new OrdinaryIssueRuntimeRejected(
            "Plugin withdrawal operation was not accepted",
            "plugin_withdrawal_operation_missing",
          );
        }
        const command = await tx
          .insert(issueCreatorWithdrawalCommands)
          .values({
            id: withdrawalCommandId,
            companyId: input.companyId,
            issueId: issue.id,
            outgoingOwnershipEpoch: issue.ownershipEpoch,
            resultingOwnershipEpoch: ownershipEpoch,
            resultingCreatorEdgeId: null,
            actorKind: "plugin",
            actorUserId: null,
            actorPluginInstallationId: input.pluginInstallationId,
            actorPluginKey: input.pluginKey,
            pluginWithdrawalOperationId: operation.id,
            issueUpdateId: update.id,
            acceptedAt: now,
          })
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!command) {
          throw new OrdinaryIssueRuntimeRejected(
            "Plugin withdrawal command was not persisted",
            "plugin_withdrawal_command_missing",
          );
        }
        await recordIssueLivenessActionInTransaction(
          tx,
          `issue_creator_withdrawal_command:${command.id}`,
        );
        return {
          kind: "accepted",
          operationId,
          issue: withdrawn,
          escalationDispatchRefIds:
            revocation.escalationDispatchRefIds,
          cancellations: revocation.cancellations,
          retried: false,
        };
        },
      );
      if (outcome.kind === "rejected") {
        throw new OrdinaryIssueRuntimeRejected(
          outcome.message,
          outcome.reason,
        );
      }
      if (outcome.cancellations) {
        await options.issueExecutionCancellation
          .reconcileRequestedScopeCancellations(
            outcome.cancellations,
          );
      }
      for (const refId of outcome.escalationDispatchRefIds) {
        await dispatch(refId);
      }
      return {
        operationId: outcome.operationId,
        issue: outcome.issue,
        retried: outcome.retried,
      };
    },

    async dispatchDirectEvent(input: OrdinaryIssueDirectEventInput) {
      const message = nonBlankPreservingBytes(input.message, "message");
      const sourceRecordId = nonEmpty(
        input.sourceRecordId,
        "sourceRecordId",
      );
      const idempotencyKey = nonEmpty(
        input.idempotencyKey,
        "idempotencyKey",
      );
      const result = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${input.companyId}:${input.issueId}`}, 0))`,
        );
        const issue = await tx
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.companyId, input.companyId),
              eq(issues.id, input.issueId),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (
          !issue ||
          !issue.ownershipEpoch ||
          issue.ownerKind !== "agent" ||
          !issue.ownerAgentId ||
          !issue.lifecycleStatus ||
          !NONTERMINAL.has(issue.lifecycleStatus)
        ) {
          throw new OrdinaryIssueRuntimeRejected(
            "Direct events require a nonterminal agent-owned issue",
            "direct_event_target_invalid",
          );
        }
        const sessionState = await lockIssueSessionState(
          tx,
          input.companyId,
          issue.id,
        );
        if (!sessionState) {
          throw new OrdinaryIssueRuntimeRejected(
            "Direct-event target Session is missing",
            "direct_event_session_missing",
          );
        }
        const { session, contextGeneration } = sessionState;
        const { revisionId } = await resolveOrdinaryIssueOwner(
          tx,
          input.companyId,
          issue.ownerAgentId,
        );
        const authority = await tx
          .select()
          .from(issueExecutionAuthorities)
          .where(
            and(
              eq(issueExecutionAuthorities.companyId, input.companyId),
              eq(issueExecutionAuthorities.issueId, issue.id),
              eq(
                issueExecutionAuthorities.ownershipEpoch,
                issue.ownershipEpoch,
              ),
              eq(
                issueExecutionAuthorities.agentId,
                issue.ownerAgentId,
              ),
              eq(issueExecutionAuthorities.state, "current"),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!authority) {
          throw new OrdinaryIssueRuntimeRejected(
            "Direct-event target authority is missing",
            "direct_event_authority_missing",
          );
        }
        const admission = await sessions.admitExecutionSource(
          {
            companyId: input.companyId,
            issueId: issue.id,
            sessionId: session.id,
            ownershipEpoch: issue.ownershipEpoch,
            targetAgentId: issue.ownerAgentId,
            issueExecutionAuthorityId: authority.id,
            consultExecutionId: null,
            adapterConfigRevisionId: revisionId,
            contextEpoch: contextGeneration,
            mode: "owner",
            sourceKind: input.sourceKind,
            actor: {
              kind: "system",
              sourceKind: input.sourceKind,
              sourceId: sourceRecordId,
            },
            immutableSourceKey: idempotencyKey,
            sourceRecordId,
            exactText: message,
            comment: {
              author: { kind: "system", source: "control" },
              producingRun: null,
            },
            idempotencyKey,
          },
          tx,
        );
        if (!admission.ref) {
          throw new OrdinaryIssueRuntimeRejected(
            "Direct event did not persist an execution ref",
            "direct_event_ref_missing",
          );
        }
        return { issue, ref: admission.ref, retried: admission.retried };
      });
      await dispatch(result.ref.id);
      return result;
    },
  };
}

export type OrdinaryIssueRuntime = ReturnType<
  typeof createOrdinaryIssueRuntime
>;
