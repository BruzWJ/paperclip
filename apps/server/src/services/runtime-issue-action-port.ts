import { createHash } from "node:crypto";
import {
  agentActionGrants,
  agents,
  companies,
  issueComments,
  issueBoardMentions,
  issueCreateIdempotencyKeys,
  issueCreatorEdgeReceivability,
  issueConsultExecutions,
  issueExecutionAuthorities,
  issueExecutionLanes,
  issueExecutionPromptCapabilities,
  issueExecutionRefs,
  issueExecutionWorkspaceBindings,
  issueSessionContextEpochs,
  issueSessionEvents,
  issueSessions,
  issueUpdates,
  issues,
  routineRuns,
  routines,
  type Db,
} from "@paperclipai/db";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  type AgentContextGrantKey,
  type AgentVisibleIssueStatus,
  type PaperclipActionKey,
  type PaperclipRuntimeActionKey,
  isUuidLike,
  normalizeContextAccess,
} from "@paperclipai/shared";
import { and, asc, desc, eq, inArray, max, or, sql } from "drizzle-orm";
import {
  evaluateAgentInvokability,
  InvokableIssueOwnerRejected,
  resolveInvokableIssueOwnerInTransaction,
} from "./agent-invokability.js";
import {
  createIssueSessionAdmissionService,
  type DispatchingExecutionSourceInput,
  type IssueSessionAdmissionService,
  type IssueSessionExecutionActor,
  type IssueSessionProjectedCommentSource,
} from "./issue-session/admission.js";
import type { IssueSessionDbTransaction } from "./issue-session/event-store.js";
import { persistCanonicalIssueAggregateInTx } from "./canonical-issue-aggregate.js";
import { type RuntimeNonAgentActionPort } from "./runtime-agent-action-port.js";
import { createPostgresRuntimeInterfaceCompiler } from "./runtime-interface-compiler-db.js";
import {
  parseRuntimeMentionArguments,
  RuntimeToolArgumentsInvalid,
  type RuntimeInterfaceCompileInput,
} from "./runtime-interface-compiler.js";
import {
  promptCapabilityGenerationIdentity,
  type PromptCapabilityBinding,
} from "./prompt-capability-gateway.js";
import { lockActivePromptCapabilityBinding } from "./prompt-capability-gateway-postgres.js";
import {
  type RuntimeActionInvocation,
} from "./runtime-tool-executor.js";
import { terminalizeCreatorEdgeInTransaction } from "./system-escalation-postgres.js";
import type {
  IssueExecutionCancellationActor,
  IssueExecutionCancellationService,
  RequestedScopedRunCancellations,
} from "./issue-execution-cancellation.js";
import {
  lockIssueExecutionRunIfPresentInTransaction,
} from "./issue-execution-run-service.js";
import {
  IssueConsultChainInvalid,
  lockAndValidateIssueConsultChain,
} from "./issue-consult-chain-postgres.js";
import {
  activeIssueTreePauseHoldExistsSql,
  lockIssueTreeExecutionGate,
} from "./issue-execution-lifecycle-gate.js";
import {
  applyIssueExecutionPolicyTransition,
  issueExecutionPolicyPersistencePatch,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
} from "./issue-execution-policy.js";
import {
  IssueExecutionWorkspaceReservationRejected,
  reserveIssueExecutionWorkspaceBinding,
} from "./execution-workspaces.js";
import {
  resolvePluginPermittedIssueOwnerCatalogInTransaction,
} from "./plugin-issue-authorization.js";
import { recordIssueLivenessActionInTransaction } from "./issue-liveness-reconciliation.js";
import {
  paperclipEnvelopeHasBody,
  renderPaperclipManagedToolPrompt,
  type PaperclipManagedToolPrompt,
  type PaperclipMessageActor,
  type PaperclipMessageAgent,
} from "./paperclip-agent-message.js";

const CREATE_KEYS = [
  "request",
  "title",
  "priority",
  "owner",
  "contextAccessMask",
] as const;
const ASSIGN_KEYS = ["issueId", "owner"] as const;
const UPDATE_MESSAGE_KEYS = ["message"] as const;
const UPDATE_KEYS = ["status", "message"] as const;
const TERMINAL_UPDATE_KEYS = [
  "status",
  "message",
  "structuredResult",
] as const;
const BOARD_MENTION_KEYS = ["message"] as const;
const PRIORITIES = new Set(["critical", "high", "medium", "low"]);
const STATUSES = new Set<AgentVisibleIssueStatus>([
  "open",
  "blocked",
  "done",
  "cancelled",
]);

export type RuntimeIssueOwnerChoice =
  { kind: "self" } | { kind: "agent"; agentId: string };

type RuntimeIssueOwnerUpdateBase = {
  capability: RuntimeActionInvocation["capability"];
  invocationId: string;
  message: string;
};

export type RuntimeIssueUpdateInput =
  | (RuntimeIssueOwnerUpdateBase & {
      /** Omitted targets the active issue; supplied targets an exact child. */
      issueId?: string;
      status?: undefined;
      structuredResult?: never;
    })
  | (RuntimeIssueOwnerUpdateBase & {
      issueId?: string;
      status: "open" | "blocked";
      structuredResult?: never;
    })
  | (RuntimeIssueOwnerUpdateBase & {
      /** Terminal disposition is restricted to the active current-owner issue. */
      issueId?: never;
      status: "done" | "cancelled";
      structuredResult?: unknown;
    });

export interface RuntimeIssueActionService {
  create(input: {
    capability: RuntimeActionInvocation["capability"];
    invocationId: string;
    request: string;
    title?: string;
    priority?: "critical" | "high" | "medium" | "low";
    owner: RuntimeIssueOwnerChoice;
    contextAccessMask?: Partial<Record<AgentContextGrantKey, false>>;
  }): Promise<unknown>;
  assign(input: {
    capability: RuntimeActionInvocation["capability"];
    invocationId: string;
    issueId: string;
    owner: RuntimeIssueOwnerChoice;
  }): Promise<unknown>;
  update(input: RuntimeIssueUpdateInput): Promise<unknown>;
  mention(input: {
    capability: RuntimeActionInvocation["capability"];
    invocationId: string;
    runInterfaceToolCallId: string;
    ingressOrdinal: number;
    commitMentionAction: RuntimeActionInvocation["commitMentionAction"];
    targetAgentId: string;
    message: string;
  }): Promise<unknown>;
  mentionBoard(input: {
    capability: RuntimeActionInvocation["capability"];
    invocationId: string;
    runInterfaceToolCallId: string;
    ingressOrdinal: number;
    commitMentionAction: RuntimeActionInvocation["commitMentionAction"];
    message: string;
  }): Promise<unknown>;
  listAgents(input: {
    capability: RuntimeActionInvocation["capability"];
    invocationId: string;
  }): Promise<unknown>;
}

export class RuntimeIssueActionDenied extends Error {
  readonly code = "runtime_issue_action_denied";

  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = "RuntimeIssueActionDenied";
  }
}

export class RuntimeIssueActionConflict extends Error {
  readonly code = "runtime_issue_action_conflict";

  constructor(message: string) {
    super(message);
    this.name = "RuntimeIssueActionConflict";
  }
}

async function withRuntimeWorkspaceReservationErrors<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof IssueExecutionWorkspaceReservationRejected) {
      throw new RuntimeIssueActionConflict(error.message);
    }
    throw error;
  }
}

export type RuntimeIssueScopeCancellationPort = Pick<
  IssueExecutionCancellationService,
  | "requestScopeCancellationsInTransaction"
  | "reconcileRequestedScopeCancellations"
>;

export interface PostgresRuntimeIssueActionServiceOptions {
  clock?: () => Date;
  /**
   * Prepares and notifies an owner ref only after its causal action
   * transaction has committed. Retrying the action supplies the same
   * persisted ref again; the composition/dispatcher boundary owns
   * idempotent preparation and drain coalescing.
   */
  dispatchPersistedRef(refId: string): Promise<void>;
  /** Canonical transactional authority fence plus post-commit cancellation. */
  issueExecutionCancellation: RuntimeIssueScopeCancellationPort;
}

type CompanyRow = typeof companies.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type IssueRow = typeof issues.$inferSelect;
type SessionRow = typeof issueSessions.$inferSelect;
type RefRow = typeof issueExecutionRefs.$inferSelect;

interface AuthorizedRuntimeAction {
  company: CompanyRow;
  companyAgents: AgentRow[];
  issue: IssueRow;
  issueSession: SessionRow;
  contextGeneration: number;
  ref: RefRow;
  catalog: RuntimeInterfaceCompileInput;
}

function messageAgent(
  companyAgents: readonly AgentRow[],
  agentId: string,
): PaperclipMessageAgent {
  const agent = companyAgents.find((candidate) => candidate.id === agentId);
  if (!agent) {
    throw new RuntimeIssueActionConflict(
      "Canonical agent message lost its company agent identity",
    );
  }
  return { id: agent.id, name: agent.name };
}

function issueUpdateMessageActor(
  authority: CanonicalOwnerFormAuthority | CanonicalCreatorFormAuthority,
  authorizedRuntime: AuthorizedRuntimeAction | null,
): PaperclipMessageActor {
  switch (authority.kind) {
    case "agent-execution":
      if (!authorizedRuntime) {
        throw new RuntimeIssueActionConflict(
          "Canonical issue update lost its agent identity",
        );
      }
      return messageAgent(
        authorizedRuntime.companyAgents,
        authority.capability.targetAgentId,
      );
    case "system-escalation-human":
    case "user-creator-withdrawal":
      return { id: authority.actorUserId, name: "Paperclip Board user" };
    case "user/board":
      return { id: authority.userId, name: "Paperclip Board user" };
    case "plugin":
      return {
        id: authority.pluginInstallationId,
        name: `Paperclip plugin ${authority.pluginKey}`,
      };
    case "routine":
      return { id: authority.routineId, name: "Paperclip routine" };
    case "system":
      return {
        id: authority.sourceId,
        name: `Paperclip system ${authority.sourceKind}`,
      };
  }
}

async function lockIssueSessionState(
  tx: IssueSessionDbTransaction,
  companyId: string,
  issueId: string,
): Promise<{
  issue: IssueRow;
  session: SessionRow;
  contextGeneration: number;
} | null> {
  return tx
    .select({
      issue: issues,
      session: issueSessions,
      contextGeneration: issueSessionContextEpochs.generation,
    })
    .from(issueSessions)
    .innerJoin(
      issues,
      and(
        eq(issues.companyId, issueSessions.companyId),
        eq(issues.id, issueSessions.issueId),
      ),
    )
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

export type AgentCounterpartTarget = {
  issueId: string;
  sessionId: string;
  ownershipEpoch: number;
  agentId: string;
  authorityId: string;
  adapterConfigRevisionId: string;
  contextGeneration: number;
};

export type IssueUpdateTarget = Pick<
  AgentCounterpartTarget,
  "issueId" | "sessionId" | "ownershipEpoch"
>;

export async function lockIssueUpdateTarget(
  tx: IssueSessionDbTransaction,
  companyId: string,
  issueId: string,
): Promise<IssueUpdateTarget> {
  const sessionState = await lockIssueSessionState(tx, companyId, issueId);
  if (!sessionState || sessionState.session.integrityState !== "ready") {
    throw new RuntimeIssueActionConflict(
      "Issue-update counterpart has no receivable canonical Session",
    );
  }
  return {
    issueId,
    sessionId: sessionState.session.id,
    ownershipEpoch: sessionState.issue.ownershipEpoch,
  };
}

export async function lockAgentCounterpartTarget(
  tx: IssueSessionDbTransaction,
  companyId: string,
  authorityId: string,
): Promise<AgentCounterpartTarget> {
  const authority = await tx
    .select()
    .from(issueExecutionAuthorities)
    .where(
      and(
        eq(issueExecutionAuthorities.companyId, companyId),
        eq(issueExecutionAuthorities.id, authorityId),
        eq(issueExecutionAuthorities.state, "current"),
      ),
    )
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!authority) {
    throw new RuntimeIssueActionConflict(
      "Issue-update counterpart has no current execution authority",
    );
  }
  const sessionState = await lockIssueSessionState(
    tx,
    companyId,
    authority.issueId,
  );
  if (
    !sessionState ||
    sessionState.session.id !== authority.sessionId ||
    sessionState.session.integrityState !== "ready"
  ) {
    throw new RuntimeIssueActionConflict(
      "Issue-update counterpart has no receivable canonical Session",
    );
  }
  return {
    issueId: authority.issueId,
    sessionId: authority.sessionId,
    ownershipEpoch: authority.ownershipEpoch,
    agentId: authority.agentId,
    authorityId: authority.id,
    adapterConfigRevisionId: authority.auditAdapterConfigRevisionId,
    contextGeneration: sessionState.contextGeneration,
  };
}

export type IssueMentionRecipient =
  | { kind: "agent"; target: AgentCounterpartTarget }
  | { kind: "board"; target: IssueUpdateTarget };

export async function lockIssueMentionRecipient(
  tx: IssueSessionDbTransaction,
  companyId: string,
  issueId: string,
): Promise<IssueMentionRecipient> {
  const sessionState = await lockIssueSessionState(tx, companyId, issueId);
  if (!sessionState || sessionState.session.integrityState !== "ready") {
    throw new RuntimeIssueActionConflict(
      "Mention target has no receivable canonical Session",
    );
  }
  const target = {
    issueId,
    sessionId: sessionState.session.id,
    ownershipEpoch: sessionState.issue.ownershipEpoch,
  };
  if (
    sessionState.issue.ownerKind !== "agent" ||
    !sessionState.issue.ownerAgentId
  ) {
    return { kind: "board", target };
  }
  const authority = await tx
    .select()
    .from(issueExecutionAuthorities)
    .where(
      and(
        eq(issueExecutionAuthorities.companyId, companyId),
        eq(issueExecutionAuthorities.issueId, issueId),
        eq(
          issueExecutionAuthorities.ownershipEpoch,
          sessionState.issue.ownershipEpoch,
        ),
        eq(
          issueExecutionAuthorities.agentId,
          sessionState.issue.ownerAgentId,
        ),
        eq(issueExecutionAuthorities.state, "current"),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!authority || authority.sessionId !== sessionState.session.id) {
    throw new RuntimeIssueActionConflict(
      "Mention target agent has no current issue authority",
    );
  }
  return {
    kind: "agent",
    target: {
      ...target,
      agentId: authority.agentId,
      authorityId: authority.id,
      adapterConfigRevisionId: authority.auditAdapterConfigRevisionId,
      contextGeneration: sessionState.contextGeneration,
    },
  };
}

async function lockOwnerUpdateRecipient(
  tx: IssueSessionDbTransaction,
  companyId: string,
  issue: IssueRow,
  creatorEdge: {
    endpointKind: string;
    endpointId: string | null;
  },
): Promise<IssueMentionRecipient> {
  if (issue.parentId) {
    return lockIssueMentionRecipient(tx, companyId, issue.parentId);
  }

  const sameIssue = await lockIssueUpdateTarget(tx, companyId, issue.id);
  if (
    creatorEdge.endpointKind === "agent-execution" &&
    creatorEdge.endpointId
  ) {
    try {
      return {
        kind: "agent",
        target: await lockAgentCounterpartTarget(
          tx,
          companyId,
          creatorEdge.endpointId,
        ),
      };
    } catch (error) {
      if (!(error instanceof RuntimeIssueActionConflict)) throw error;
    }
  }
  return { kind: "board", target: sameIssue };
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

function runtimeInvocationKey(
  kind:
    | "create"
    | "assign"
    | "owner-update"
    | "creator-update"
    | "mention"
    | "mention-board"
    | "list-agents",
  capabilityIdentity: string,
  invocationId: string,
): string {
  return `runtime:${kind}:${capabilityIdentity}:${invocationId}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function terminalStatus(status: AgentVisibleIssueStatus): boolean {
  return status === "done" || status === "cancelled";
}

function boardPresentationStatusFor(
  status: AgentVisibleIssueStatus,
): "in_progress" | "blocked" | "done" | "cancelled" {
  if (status === "open") return "in_progress";
  return status;
}

function assertLifecycleTransition(
  current: AgentVisibleIssueStatus | null,
  requested: AgentVisibleIssueStatus,
): asserts current is AgentVisibleIssueStatus {
  if (current === "done" || current === "cancelled") {
    throw new RuntimeIssueActionConflict(
      "A terminal issue rejects later owner updates",
    );
  }
  const legal =
    (current === "open" &&
      (requested === "blocked" ||
        requested === "done" ||
        requested === "cancelled")) ||
    (current === "blocked" &&
      (requested === "open" ||
        requested === "done" ||
        requested === "cancelled"));
  if (!legal) {
    throw new RuntimeIssueActionConflict(
      "Issue lifecycle transition is invalid",
    );
  }
}

function assertIssueNonterminal(
  issue: IssueRow,
): asserts issue is IssueRow & { lifecycleStatus: "open" | "blocked" } {
  if (issue.lifecycleStatus !== "open" && issue.lifecycleStatus !== "blocked") {
    throw new RuntimeIssueActionConflict(
      "The target issue is not open or blocked",
    );
  }
}

async function lockRuntimeActionHierarchy(
  tx: IssueSessionDbTransaction,
  capability: RuntimeActionInvocation["capability"],
  now: Date,
  options: { readonly additionalLaneTargetAgentId?: string },
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${capability.companyId}, 0))`,
  );
  const companyRows = await tx
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.id, capability.companyId))
    .limit(2)
    .for("update");
  if (companyRows.length !== 1) {
    throw new RuntimeIssueActionDenied(
      "Company Session lifecycle is not ready",
      "company_inactive",
    );
  }
  await lockIssueTreeExecutionGate(
    tx,
    capability.companyId,
    capability.issueId,
  );
  const issueRows = await tx
    .select({
      id: issues.id,
      lifecycleStatus: issues.lifecycleStatus,
      executionPaused: activeIssueTreePauseHoldExistsSql(
        issues.companyId,
        issues.id,
      ),
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, capability.companyId),
        eq(issues.id, capability.issueId),
      ),
    )
    .limit(2)
    .for("update");
  if (issueRows.length !== 1) {
    throw new RuntimeIssueActionDenied(
      "Issue ownership epoch has changed",
      "ownership_epoch_changed",
    );
  }
  const issue = issueRows[0]!;
  if (!["open", "blocked"].includes(issue.lifecycleStatus)) {
    throw new RuntimeIssueActionDenied(
      "Issue lifecycle is terminal",
      "issue_lifecycle_terminal",
    );
  }
  if (issue.executionPaused) {
    throw new RuntimeIssueActionDenied(
      "Issue execution is paused",
      "issue_execution_paused",
    );
  }
  const sessionRows = await tx
    .select({ id: issueSessions.id })
    .from(issueSessions)
    .where(
      and(
        eq(issueSessions.companyId, capability.companyId),
        eq(issueSessions.issueId, capability.issueId),
        eq(issueSessions.id, capability.sessionId),
      ),
    )
    .limit(2)
    .for("update");
  if (sessionRows.length !== 1) {
    throw new RuntimeIssueActionDenied(
      "Issue Session is not ready",
      "issue_session_invalid",
    );
  }
  const companyAgents = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.companyId, capability.companyId))
    .orderBy(asc(agents.id))
    .for("update");
  const laneTargetAgentIds = [...new Set([
    capability.targetAgentId,
    ...(options.additionalLaneTargetAgentId
      ? [options.additionalLaneTargetAgentId]
      : []),
  ])].sort();
  const knownAgentIds = new Set(companyAgents.map((agent) => agent.id));
  if (laneTargetAgentIds.some((agentId) => !knownAgentIds.has(agentId))) {
    throw new RuntimeIssueActionDenied(
      "Mention target is no longer in the current reach catalog",
      "mention_catalog_changed",
    );
  }
  for (const targetAgentId of laneTargetAgentIds) {
    await tx
      .insert(issueExecutionLanes)
      .values({
        companyId: capability.companyId,
        issueId: capability.issueId,
        ownershipEpoch: capability.ownershipEpoch,
        targetAgentId,
        nextOrdinal: 0,
        activeOrdinal: null,
        activeLeaseGeneration: null,
        activeLeaseId: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [
          issueExecutionLanes.companyId,
          issueExecutionLanes.issueId,
          issueExecutionLanes.ownershipEpoch,
          issueExecutionLanes.targetAgentId,
        ],
      });
  }
  for (const targetAgentId of laneTargetAgentIds) {
    const laneRows = await tx
      .select({ targetAgentId: issueExecutionLanes.targetAgentId })
      .from(issueExecutionLanes)
      .where(
        and(
          eq(issueExecutionLanes.companyId, capability.companyId),
          eq(issueExecutionLanes.issueId, capability.issueId),
          eq(
            issueExecutionLanes.ownershipEpoch,
            capability.ownershipEpoch,
          ),
          eq(issueExecutionLanes.targetAgentId, targetAgentId),
        ),
      )
      .limit(2)
      .for("update");
    if (laneRows.length !== 1) {
      throw new RuntimeIssueActionConflict(
        "Runtime action lost its exact target-agent execution lane",
      );
    }
  }
}

async function lockRuntimeActionRun(
  tx: IssueSessionDbTransaction,
  capability: RuntimeActionInvocation["capability"],
): Promise<void> {
  const run = await lockIssueExecutionRunIfPresentInTransaction(tx, {
    companyId: capability.companyId,
    issueId: capability.issueId,
    runId: capability.runId,
  });
  if (
    !run ||
    run.status !== "running" ||
    run.sessionId !== capability.sessionId ||
    run.ownershipEpoch !== capability.ownershipEpoch ||
    run.targetAgentId !== capability.targetAgentId ||
    run.executionMode !== capability.executionMode ||
    run.issueExecutionAuthorityId !== capability.issueExecutionAuthorityId ||
    run.consultExecutionId !== capability.consultExecutionId ||
    run.adapterConfigRevisionId !== capability.adapterConfigIdentity ||
    run.executionWorkspaceBindingId !== capability.workspaceIdentity ||
    run.currentAttemptId !== capability.attemptId ||
    run.currentLeaseId !== capability.leaseId ||
    run.cancellationIntentId !== null ||
    run.terminalFinalizationId !== null
  ) {
    throw new RuntimeIssueActionDenied(
      "Run is no longer active in this execution scope",
      "run_scope_changed",
    );
  }
}

const PERSISTENT_GRANT_BY_RUNTIME_ACTION = {
  issue_create: "issue_create",
  issue_assign: "issue_create",
  issue_update: null,
  mention_agent: "mention_agent",
  mention_board: "mention_board",
  agent_hire: "agent_hire",
  agent_configure: "agent_configure",
  list_agents: "list_agents",
} as const satisfies Record<PaperclipRuntimeActionKey, PaperclipActionKey | null>;

function actionRemainsAvailableInCatalog(
  catalog: RuntimeInterfaceCompileInput,
  action: PaperclipRuntimeActionKey,
  persistentGrant: PaperclipActionKey | null,
): boolean {
  if (persistentGrant) {
    return catalog.actionGrants[persistentGrant] === true;
  }
  // issue_update is emitted from relationship-derived authority, never a
  // stored action grant. Form-specific target validation happens at the
  // owner/creator commit boundary below.
  return (
    action === "issue_update" &&
    (catalog.isCurrentOwner || catalog.creatorUpdateTargets.length > 0)
  );
}

async function lockRuntimeActionAuthority(
  tx: IssueSessionDbTransaction,
  capability: RuntimeActionInvocation["capability"],
  action: PaperclipRuntimeActionKey,
  now: Date,
  options: {
    requireOwner: boolean;
    additionalLaneTargetAgentId?: string;
    hierarchyAlreadyLocked?: boolean;
  },
): Promise<AuthorizedRuntimeAction> {
  if (options.requireOwner && capability.executionMode !== "owner") {
    throw new RuntimeIssueActionDenied(
      "This action requires an active owner execution",
      "owner_execution_required",
    );
  }

  if (!options.hierarchyAlreadyLocked) {
    await lockRuntimeActionHierarchy(tx, capability, now, {
      additionalLaneTargetAgentId: options.additionalLaneTargetAgentId,
    });
  }
  // Run transitions own their attempt and lease projections. Locking the
  // canonical run closes that race; the capability lock below rechecks the
  // exact generation and database-clock expiry.
  await lockRuntimeActionRun(tx, capability);
  try {
    await lockActivePromptCapabilityBinding(tx, capability, now);
  } catch {
    throw new RuntimeIssueActionDenied(
      "Prompt capability is inactive, expired, or no longer exact",
      "prompt_capability_invalid",
    );
  }
  await tx.execute(
    sql`select ${issueExecutionRefs.id} from ${issueExecutionRefs} where ${issueExecutionRefs.id} = ${capability.refId} for update`,
  );

  const [companyRows, companyAgents, sessionRows, refRows, issueRows] =
    await Promise.all([
      tx
        .select()
        .from(companies)
        .where(eq(companies.id, capability.companyId))
        .limit(1),
      tx
        .select()
        .from(agents)
        .where(eq(agents.companyId, capability.companyId))
        .orderBy(asc(agents.id)),
      tx
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
        .where(eq(issueSessions.id, capability.sessionId))
        .limit(1),
      tx
        .select()
        .from(issueExecutionRefs)
        .where(eq(issueExecutionRefs.id, capability.refId))
        .limit(1),
      tx
        .select()
        .from(issues)
        .where(eq(issues.id, capability.issueId))
        .limit(1),
    ]);
  const company = companyRows[0];
  const sessionState = sessionRows[0];
  const issueSession = sessionState?.session;
  const ref = refRows[0];
  const issue = issueRows[0];

  if (
    !company ||
    company.status !== "active" ||
    company.sessionIntegrityState !== "ready" ||
    company.hardDeleteFencedAt !== null
  ) {
    throw new RuntimeIssueActionDenied(
      "Company Session lifecycle is not ready",
      "company_inactive",
    );
  }
  if (
    !issueSession ||
    issueSession.companyId !== capability.companyId ||
    issueSession.issueId !== capability.issueId ||
    issueSession.integrityState !== "ready" ||
    issueSession.refAdmittableAt === null ||
    issueSession.timeArchived !== null ||
    issueSession.purgeFencedAt !== null
  ) {
    throw new RuntimeIssueActionDenied(
      "Issue Session is not ready",
      "issue_session_invalid",
    );
  }
  if (
    !ref ||
    ref.companyId !== capability.companyId ||
    ref.issueId !== capability.issueId ||
    ref.sessionId !== capability.sessionId ||
    ref.mode !== capability.executionMode ||
    ref.ownershipEpoch !== capability.ownershipEpoch ||
    ref.targetAgentId !== capability.targetAgentId ||
    ref.issueExecutionAuthorityId !== capability.issueExecutionAuthorityId ||
    ref.consultExecutionId !== capability.consultExecutionId ||
    ref.adapterConfigRevisionId !== capability.adapterConfigIdentity ||
    ref.disposition !== "active"
  ) {
    throw new RuntimeIssueActionDenied(
      "Issue-execution reference is no longer exact",
      "execution_ref_invalid",
    );
  }
  if (
    !issue ||
    issue.companyId !== capability.companyId ||
    issue.ownershipEpoch !== capability.ownershipEpoch ||
    issue.hiddenAt !== null
  ) {
    throw new RuntimeIssueActionDenied(
      "Issue ownership epoch has changed",
      "ownership_epoch_changed",
    );
  }
  if (
    capability.executionMode === "owner" &&
    (issue.ownerKind !== "agent" ||
      issue.ownerAgentId !== capability.targetAgentId)
  ) {
    throw new RuntimeIssueActionDenied(
      "Run no longer owns the issue",
      "owner_changed",
    );
  }

  if (capability.executionMode === "owner") {
    if (!capability.issueExecutionAuthorityId) {
      throw new RuntimeIssueActionDenied(
        "Owner run has no execution authority",
        "execution_authority_invalid",
      );
    }
    const authority = await tx
      .select()
      .from(issueExecutionAuthorities)
      .where(
        and(
          eq(
            issueExecutionAuthorities.id,
            capability.issueExecutionAuthorityId,
          ),
          eq(issueExecutionAuthorities.companyId, capability.companyId),
          eq(issueExecutionAuthorities.issueId, capability.issueId),
          eq(issueExecutionAuthorities.sessionId, capability.sessionId),
          eq(
            issueExecutionAuthorities.ownershipEpoch,
            capability.ownershipEpoch,
          ),
          eq(issueExecutionAuthorities.agentId, capability.targetAgentId),
          eq(issueExecutionAuthorities.state, "current"),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!authority) {
      throw new RuntimeIssueActionDenied(
        "Issue-execution authority is no longer current",
        "execution_authority_invalid",
      );
    }
  } else {
    if (!capability.consultExecutionId) {
      throw new RuntimeIssueActionDenied(
        "Consult run has no consult execution",
        "consult_execution_invalid",
      );
    }
    const consult = await tx
      .select()
      .from(issueConsultExecutions)
      .where(
        and(
          eq(issueConsultExecutions.id, capability.consultExecutionId),
          eq(issueConsultExecutions.companyId, capability.companyId),
          eq(issueConsultExecutions.issueId, capability.issueId),
          eq(issueConsultExecutions.sessionId, capability.sessionId),
          eq(
            issueConsultExecutions.ownershipEpoch,
            capability.ownershipEpoch,
          ),
          eq(
            issueConsultExecutions.targetAgentId,
            capability.targetAgentId,
          ),
          eq(
            issueConsultExecutions.adapterConfigRevisionId,
            capability.adapterConfigIdentity,
          ),
          eq(issueConsultExecutions.state, "active"),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!consult) {
      throw new RuntimeIssueActionDenied(
        "Consult execution is no longer active",
        "consult_execution_invalid",
      );
    }
  }

  const caller = companyAgents.find(
    (candidate) => candidate.id === capability.targetAgentId,
  );
  const invokability = evaluateAgentInvokability(caller, companyAgents);
  if (!invokability.invokable) {
    throw new RuntimeIssueActionDenied(
      invokability.message,
      `agent_not_invokable:${invokability.reason}`,
    );
  }

  const persistentGrant = PERSISTENT_GRANT_BY_RUNTIME_ACTION[action];
  if (persistentGrant) {
    const grantRows = await tx
      .select({ id: agentActionGrants.id })
      .from(agentActionGrants)
      .where(
        and(
          eq(agentActionGrants.companyId, capability.companyId),
          eq(agentActionGrants.agentId, capability.targetAgentId),
          eq(agentActionGrants.key, persistentGrant),
        ),
      )
      .for("update");
    if (grantRows.length !== 1) {
      throw new RuntimeIssueActionDenied(
        `Current run no longer has ${persistentGrant} required for ${action}`,
        "action_grant_missing",
      );
    }
  }

  let catalog: RuntimeInterfaceCompileInput;
  try {
    catalog = await createPostgresRuntimeInterfaceCompiler(
      tx as unknown as Db,
    ).resolve(capability);
  } catch (error) {
    throw new RuntimeIssueActionDenied(
      error instanceof Error
        ? error.message
        : "Runtime interface could not be recompiled",
      "catalog_revalidation_failed",
    );
  }
  if (!actionRemainsAvailableInCatalog(catalog, action, persistentGrant)) {
    throw new RuntimeIssueActionDenied(
      persistentGrant
        ? `Current runtime catalog no longer grants ${persistentGrant} required for ${action}`
        : `Current runtime catalog no longer exposes ${action}`,
      persistentGrant ? "action_grant_missing" : "runtime_action_unavailable",
    );
  }
  return {
    company,
    companyAgents,
    issue,
    issueSession,
    contextGeneration: sessionState.contextGeneration,
    ref,
    catalog,
  };
}
function ownerAgentId(
  owner: RuntimeIssueOwnerChoice,
  callerAgentId: string,
): string {
  return owner.kind === "self" ? callerAgentId : owner.agentId;
}

async function assertTargetAdapterRevision(
  tx: IssueSessionDbTransaction,
  companyId: string,
  targetAgentId: string,
): Promise<string> {
  try {
    const resolved = await resolveInvokableIssueOwnerInTransaction(tx, {
      companyId,
      ownerAgentId: targetAgentId,
    });
    return resolved.revisionId;
  } catch (error) {
    if (error instanceof InvokableIssueOwnerRejected) {
      const reason = error.reason.startsWith("owner_not_invokable:")
        ? `target_not_invokable:${error.reason.slice("owner_not_invokable:".length)}`
        : "target_revision_missing";
      throw new RuntimeIssueActionDenied(error.message, reason);
    }
    throw error;
  }
}

function assertCreateOwnerCatalog(
  authorized: AuthorizedRuntimeAction,
  owner: RuntimeIssueOwnerChoice,
): string {
  if (owner.kind === "self") return authorized.ref.targetAgentId;
  if (
    !authorized.catalog.issueCreateDirectChildren.some(
      (candidate) => candidate.id === owner.agentId,
    )
  ) {
    throw new RuntimeIssueActionDenied(
      "The selected owner is no longer a direct eligible child",
      "owner_catalog_changed",
    );
  }
  return owner.agentId;
}

function assertAssignOwnerCatalog(
  authorized: AuthorizedRuntimeAction,
  issueId: string,
  owner: RuntimeIssueOwnerChoice,
): string {
  const target = authorized.catalog.issueAssignTargets.find(
    (candidate) => candidate.issueId === issueId,
  );
  if (!target) {
    throw new RuntimeIssueActionDenied(
      "The issue is no longer in the caller's creator catalog",
      "creator_catalog_changed",
    );
  }
  if (owner.kind === "self") {
    if (!target.owners.some((candidate) => candidate.kind === "self")) {
      throw new RuntimeIssueActionDenied(
        "Self ownership is no longer available",
        "owner_catalog_changed",
      );
    }
    return authorized.ref.targetAgentId;
  }
  if (
    !target.owners.some(
      (candidate) =>
        candidate.kind === "agent" && candidate.id === owner.agentId,
    )
  ) {
    throw new RuntimeIssueActionDenied(
      "The selected owner is no longer in the target's owner catalog",
      "owner_catalog_changed",
    );
  }
  return owner.agentId;
}

function creatorEndpoint(issue: IssueRow): {
  endpointKind:
    "agent-execution" | "user/board" | "plugin" | "routine" | "system";
  endpointId: string | null;
  endpointSnapshot: Record<string, unknown>;
} {
  switch (issue.creatorKind) {
    case "agent-execution":
      if (!issue.creatorAuthorityId || !issue.creatorAdapterConfigRevisionId) {
        break;
      }
      return {
        endpointKind: "agent-execution",
        endpointId: issue.creatorAuthorityId,
        endpointSnapshot: {
          authorityId: issue.creatorAuthorityId,
          originatingAdapterConfigRevisionId:
            issue.creatorAdapterConfigRevisionId,
        },
      };
    case "user/board":
      return {
        endpointKind: "user/board",
        endpointId: issue.creatorUserId,
        endpointSnapshot: {
          userId: issue.creatorUserId,
          recipient: issue.creatorUserId ? "named-user" : "company-board",
        },
      };
    case "plugin":
      if (
        !issue.creatorPluginInstallationId ||
        !issue.creatorPluginKey ||
        !issue.creatorCallbackKey ||
        !issue.creatorCallbackVersion
      ) {
        break;
      }
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
    case "routine":
      if (!issue.creatorRoutineId || !issue.creatorRoutineDispatchId) break;
      return {
        endpointKind: "routine",
        endpointId: issue.creatorRoutineId,
        endpointSnapshot: {
          routineId: issue.creatorRoutineId,
          routineDispatchId: issue.creatorRoutineDispatchId,
        },
      };
    case "system":
      if (!issue.creatorSystemSourceKind || !issue.creatorSystemSourceId) break;
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
  throw new RuntimeIssueActionConflict("Issue creator endpoint is incomplete");
}

async function insertCreatorEdge(
  tx: IssueSessionDbTransaction,
  issue: IssueRow,
  now: Date,
) {
  if (!issue.ownershipEpoch) {
    throw new RuntimeIssueActionConflict("Issue ownership epoch is missing");
  }
  const endpoint = creatorEndpoint(issue);
  const rows = await tx
    .insert(issueCreatorEdgeReceivability)
    .values({
      id: deterministicUuid(
        "creator-edge",
        `${issue.companyId}:${issue.id}:${issue.ownershipEpoch}`,
      ),
      companyId: issue.companyId,
      issueId: issue.id,
      sessionId: await tx
        .select({ id: issueSessions.id })
        .from(issueSessions)
        .where(
          and(
            eq(issueSessions.companyId, issue.companyId),
            eq(issueSessions.issueId, issue.id),
          ),
        )
        .limit(1)
        .then((sessionRows) => {
          const session = sessionRows[0];
          if (!session) {
            throw new RuntimeIssueActionConflict(
              "Canonical issue Session is missing",
            );
          }
          return session.id;
        }),
      ownershipEpoch: issue.ownershipEpoch,
      creatorKind: issue.creatorKind!,
      ...endpoint,
      endpointTombstone: null,
      state: "receivable",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (rows[0]) return rows[0];
  const existing = await tx
    .select()
    .from(issueCreatorEdgeReceivability)
    .where(
      and(
        eq(issueCreatorEdgeReceivability.companyId, issue.companyId),
        eq(issueCreatorEdgeReceivability.issueId, issue.id),
        eq(issueCreatorEdgeReceivability.ownershipEpoch, issue.ownershipEpoch),
      ),
    )
    .limit(1)
    .then((existingRows) => existingRows[0] ?? null);
  if (
    !existing ||
    existing.creatorKind !== issue.creatorKind ||
    existing.endpointKind !== endpoint.endpointKind ||
    existing.endpointId !== endpoint.endpointId ||
    canonicalJson(existing.endpointSnapshot) !==
      canonicalJson(endpoint.endpointSnapshot)
  ) {
    throw new RuntimeIssueActionConflict(
      "Creator-edge identity conflicts with the immutable issue creator",
    );
  }
  return existing;
}

async function nextRunUpdateSequence(
  tx: IssueSessionDbTransaction,
  companyId: string,
  runId: string,
): Promise<number> {
  const rows = await tx
    .select({ sequence: max(issueUpdates.runSequence) })
    .from(issueUpdates)
    .where(
      and(eq(issueUpdates.companyId, companyId), eq(issueUpdates.runId, runId)),
    );
  return Number(rows[0]?.sequence ?? -1) + 1;
}

async function loadUpdateRetry(
  tx: IssueSessionDbTransaction,
  companyId: string,
  gatewayInvocationId: string,
) {
  const update = await tx
    .select()
    .from(issueUpdates)
    .where(
      and(
        eq(issueUpdates.companyId, companyId),
        eq(issueUpdates.gatewayInvocationId, gatewayInvocationId),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!update) return null;
  const comment = await tx
    .select()
    .from(issueComments)
    .where(eq(issueComments.id, update.commentId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!comment) {
    throw new RuntimeIssueActionConflict(
      "Accepted issue update is missing its canonical comment",
    );
  }
  const ref = comment.canonicalSourceId
    ? await tx
        .select()
        .from(issueExecutionRefs)
        .where(
          and(
            eq(issueExecutionRefs.companyId, companyId),
            eq(issueExecutionRefs.sessionId, comment.sessionId),
            eq(issueExecutionRefs.sourceId, comment.canonicalSourceId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null)
    : null;
  return { update, comment, ref, retried: true as const };
}

type CanonicalNonterminalFormUpdate =
  | {
      message: string;
      status?: undefined;
      structuredResult?: never;
    }
  | {
      message: string;
      status: "open" | "blocked";
      structuredResult?: never;
    };

export type CanonicalOwnerFormUpdate =
  | CanonicalNonterminalFormUpdate
  | {
      message: string;
      status: "done" | "cancelled";
      structuredResult?: unknown;
    };

/**
 * A creator update always targets an exact child. It may keep that child open
 * or blocked, but terminal disposition remains current-owner authority because
 * it ends the receiving owner's execution epoch.
 */
export type CanonicalCreatorFormUpdate = CanonicalNonterminalFormUpdate;

export type CanonicalOwnerFormAuthority =
  | {
      kind: "agent-execution";
      capability: RuntimeActionInvocation["capability"];
      invocationId: string;
    }
  | {
      kind: "system-escalation-human";
      companyId: string;
      actorUserId: string;
      gatewayInvocationId: string;
    }
  | {
      kind: "user-creator-withdrawal";
      companyId: string;
      actorUserId: string;
      gatewayInvocationId: string;
    };

export type CanonicalCreatorFormAuthority =
  | {
      kind: "agent-execution";
      capability: RuntimeActionInvocation["capability"];
      invocationId: string;
    }
  | {
      kind: "user/board";
      companyId: string;
      userId: string;
      gatewayInvocationId: string;
    }
  | {
      kind: "plugin";
      companyId: string;
      pluginInstallationId: string;
      pluginKey: string;
      gatewayInvocationId: string;
    }
  | {
      kind: "routine";
      companyId: string;
      routineId: string;
      routineDispatchId: string;
      gatewayInvocationId: string;
    }
  | {
      kind: "system";
      companyId: string;
      sourceKind: string;
      sourceId: string;
      gatewayInvocationId: string;
    };

export interface IssueFormCommitRuntimeOptions {
  clock?: () => Date;
  dispatchPersistedRef(refId: string): Promise<void>;
  issueExecutionCancellation: RuntimeIssueScopeCancellationPort;
}

function authorityCompanyId(
  authority: CanonicalOwnerFormAuthority | CanonicalCreatorFormAuthority,
): string {
  return authority.kind === "agent-execution"
    ? authority.capability.companyId
    : authority.companyId;
}

function ownerGatewayInvocationId(
  authority: CanonicalOwnerFormAuthority,
): string {
  return authority.kind === "agent-execution"
      ? runtimeInvocationKey(
        "owner-update",
        promptCapabilityGenerationIdentity(authority.capability),
        authority.invocationId,
      )
    : authority.gatewayInvocationId;
}

function creatorGatewayInvocationId(
  authority: CanonicalCreatorFormAuthority,
): string {
  return authority.kind === "agent-execution"
      ? runtimeInvocationKey(
        "creator-update",
        promptCapabilityGenerationIdentity(authority.capability),
        authority.invocationId,
      )
    : authority.gatewayInvocationId;
}

function ownerSourceIdentity(
  authority: CanonicalOwnerFormAuthority,
): {
  sourceKind: "agent-execution" | "user/board";
  sourceAuthorityId: string | null;
  sourceIdentity: Record<string, unknown>;
  runId: string | null;
  comment: IssueSessionProjectedCommentSource;
} {
  if (authority.kind === "agent-execution") {
    return {
      sourceKind: "agent-execution",
      sourceAuthorityId: authority.capability.issueExecutionAuthorityId,
      sourceIdentity: {
        authorityId: authority.capability.issueExecutionAuthorityId,
        agentId: authority.capability.targetAgentId,
        issueId: authority.capability.issueId,
        ownershipEpoch: authority.capability.ownershipEpoch,
        runId: authority.capability.runId,
        capabilityConnectionId:
          authority.capability.capabilityConnectionId,
        capabilityGeneration:
          authority.capability.capabilityGeneration,
      },
      runId: authority.capability.runId,
      comment: {
        author: {
          kind: "agent",
          agentId: authority.capability.targetAgentId,
        },
        producingRun: {
          runId: authority.capability.runId,
          adapterConfigRevisionId:
            authority.capability.adapterConfigIdentity,
        },
      },
    };
  }
  return {
    sourceKind: "user/board",
    sourceAuthorityId: null,
    sourceIdentity: {
      userId: authority.actorUserId,
      authorityKind: authority.kind,
    },
    runId: null,
    comment: {
      author: {
        kind: "user",
        userId: authority.actorUserId,
      },
      producingRun: null,
    },
  };
}

function creatorSourceIdentity(
  authority: CanonicalCreatorFormAuthority,
): {
  sourceKind:
    | "agent-execution"
    | "user/board"
    | "plugin"
    | "routine"
    | "system";
  sourceAuthorityId: string | null;
  sourceIdentity: Record<string, unknown>;
  runId: string | null;
  comment: IssueSessionProjectedCommentSource;
} {
  switch (authority.kind) {
    case "agent-execution":
      return {
        sourceKind: authority.kind,
        sourceAuthorityId: authority.capability.issueExecutionAuthorityId,
        sourceIdentity: {
          authorityId: authority.capability.issueExecutionAuthorityId,
          agentId: authority.capability.targetAgentId,
          issueId: authority.capability.issueId,
          ownershipEpoch: authority.capability.ownershipEpoch,
          runId: authority.capability.runId,
          capabilityConnectionId:
            authority.capability.capabilityConnectionId,
          capabilityGeneration:
            authority.capability.capabilityGeneration,
        },
        runId: authority.capability.runId,
        comment: {
          author: {
            kind: "agent",
            agentId: authority.capability.targetAgentId,
          },
          producingRun: {
            runId: authority.capability.runId,
            adapterConfigRevisionId:
              authority.capability.adapterConfigIdentity,
          },
        },
      };
    case "user/board":
      return {
        sourceKind: authority.kind,
        sourceAuthorityId: null,
        sourceIdentity: { userId: authority.userId },
        runId: null,
        comment: {
          author: { kind: "user", userId: authority.userId },
          producingRun: null,
        },
      };
    case "plugin":
      return {
        sourceKind: authority.kind,
        sourceAuthorityId: null,
        sourceIdentity: {
          pluginInstallationId: authority.pluginInstallationId,
          pluginKey: authority.pluginKey,
        },
        runId: null,
        comment: {
          author: {
            kind: "plugin",
            pluginInstallationId: authority.pluginInstallationId,
            pluginKey: authority.pluginKey,
          },
          producingRun: null,
        },
      };
    case "routine":
      return {
        sourceKind: authority.kind,
        sourceAuthorityId: null,
        sourceIdentity: {
          routineId: authority.routineId,
          routineDispatchId: authority.routineDispatchId,
        },
        runId: null,
        comment: {
          author: { kind: "system", source: "control" },
          producingRun: null,
        },
      };
    case "system":
      return {
        sourceKind: authority.kind,
        sourceAuthorityId: null,
        sourceIdentity: {
          sourceKind: authority.sourceKind,
          sourceId: authority.sourceId,
        },
        runId: null,
        comment: {
          author: { kind: "system", source: "control" },
          producingRun: null,
        },
      };
  }
}

function executionActorForCapability(
  capability: RuntimeActionInvocation["capability"],
): Extract<IssueSessionExecutionActor, { kind: "agent-execution" }> {
  const executionAuthorityId =
    capability.issueExecutionAuthorityId ?? capability.consultExecutionId;
  if (!executionAuthorityId) {
    throw new RuntimeIssueActionConflict(
      "Agent harness delivery requires immutable execution authority",
    );
  }
  return {
    kind: "agent-execution",
    agentId: capability.targetAgentId,
    authorityId: executionAuthorityId,
  };
}

function issueUpdateActor(
  authority: CanonicalOwnerFormAuthority | CanonicalCreatorFormAuthority,
): IssueSessionExecutionActor {
  switch (authority.kind) {
    case "agent-execution":
      return executionActorForCapability(authority.capability);
    case "system-escalation-human":
    case "user-creator-withdrawal":
      return { kind: "user/board", userId: authority.actorUserId };
    case "user/board":
      return { kind: "user/board", userId: authority.userId };
    case "plugin":
      return {
        kind: "plugin",
        pluginInstallationId: authority.pluginInstallationId,
        pluginKey: authority.pluginKey,
      };
    case "routine":
      return {
        kind: "routine",
        routineId: authority.routineId,
        routineDispatchId: authority.routineDispatchId,
      };
    case "system":
      return {
        kind: "system",
        sourceKind: authority.sourceKind,
        sourceId: authority.sourceId,
      };
  }
}

function updateCounterpart(
  authority: CanonicalOwnerFormAuthority | CanonicalCreatorFormAuthority,
): {
  counterpartIssueId: string;
  counterpartAuthorityId: string;
  counterpartOwnershipEpoch: number;
} | undefined {
  if (
    authority.kind !== "agent-execution" ||
    !authority.capability.issueExecutionAuthorityId
  ) {
    return undefined;
  }
  return {
    counterpartIssueId: authority.capability.issueId,
    counterpartAuthorityId:
      authority.capability.issueExecutionAuthorityId,
    counterpartOwnershipEpoch: authority.capability.ownershipEpoch,
  };
}

function sameIssueAgentTarget(
  sourceAgentTarget: { issueId: string; agentId: string } | null | undefined,
  target: AgentCounterpartTarget,
): boolean {
  // The only self-mention dedupe key is the exact (issueId, agentId) pair.
  return (
    sourceAgentTarget?.issueId === target.issueId &&
    sourceAgentTarget.agentId === target.agentId
  );
}

async function canDispatchAgentCounterpartTarget(
  tx: IssueSessionDbTransaction,
  companyId: string,
  target: AgentCounterpartTarget,
): Promise<boolean> {
  try {
    return (await assertTargetAdapterRevision(
      tx,
      companyId,
      target.agentId,
    )) === target.adapterConfigRevisionId;
  } catch (error) {
    if (error instanceof RuntimeIssueActionDenied) return false;
    throw error;
  }
}

async function admitAgentTextInTransaction(
  sessionAdmission: IssueSessionAdmissionService,
  tx: IssueSessionDbTransaction,
  input: DispatchingExecutionSourceInput,
) {
  const admission = await sessionAdmission.admitExecutionSource(input, tx);
  if (!admission.ref || (input.comment && !admission.comment)) {
    throw new RuntimeIssueActionConflict(
      "Canonical agent mention did not reserve its ref and comment",
    );
  }
  return admission;
}

type PaperclipManagedToolAdmissionInput =
  | (Omit<
      Extract<DispatchingExecutionSourceInput, { sourceKind: "issue_request" }>,
      "exactText"
    > & { prompt: PaperclipManagedToolPrompt<"issue_create"> })
  | (Omit<
      Extract<
        DispatchingExecutionSourceInput,
        { sourceKind: "issue_reassignment" }
      >,
      "exactText"
    > & { prompt: PaperclipManagedToolPrompt<"issue_assign"> })
  | (Omit<
      Extract<DispatchingExecutionSourceInput, { sourceKind: "issue_update" }>,
      "exactText"
    > & { prompt: PaperclipManagedToolPrompt<"issue_update"> })
  | (Omit<
      Extract<DispatchingExecutionSourceInput, { sourceKind: "consult_mention" }>,
      "exactText"
    > & { prompt: PaperclipManagedToolPrompt<"mention_agent"> });

export async function mentionAgentInTransaction(
  sessionAdmission: IssueSessionAdmissionService,
  tx: IssueSessionDbTransaction,
  input: PaperclipManagedToolAdmissionInput,
) {
  const { prompt, ...source } = input;
  return admitAgentTextInTransaction(sessionAdmission, tx, {
    ...source,
    exactText: renderPaperclipManagedToolPrompt(prompt),
  });
}

export async function mentionBoardInTransaction(
  sessionAdmission: IssueSessionAdmissionService,
  tx: IssueSessionDbTransaction,
  input: {
    companyId: string;
    target: IssueUpdateTarget;
    actor: IssueSessionExecutionActor;
    comment: IssueSessionProjectedCommentSource;
    counterpart?: {
      counterpartIssueId: string;
      counterpartAuthorityId: string;
      counterpartOwnershipEpoch: number;
    };
    sourceKind: string;
    immutableSourceKey: string;
    sourceRecordId: string;
    message: string;
  },
) {
  if (
    input.comment.author.kind !== "agent" ||
    input.comment.producingRun === null
  ) {
    throw new RuntimeIssueActionConflict(
      "Canonical Board mention requires an agent producing run",
    );
  }
  const counterpart = input.counterpart ?? {};
  const admission = await sessionAdmission.appendNonDispatchSyntheticComment(
    {
      companyId: input.companyId,
      issueId: input.target.issueId,
      sessionId: input.target.sessionId,
      sourceKind: input.sourceKind,
      projectionKind: "issue_update",
      immutableSourceKey: input.immutableSourceKey,
      sourceRecordId: input.sourceRecordId,
      exactText: input.message,
      ownershipEpoch: input.target.ownershipEpoch,
      agentId: input.comment.author.agentId,
      adapterConfigRevisionId:
        input.comment.producingRun.adapterConfigRevisionId,
      runId: input.comment.producingRun.runId,
      actor: input.actor,
      ...counterpart,
      comment: input.comment,
    },
    tx,
  );
  if (!admission.comment) {
    throw new RuntimeIssueActionConflict(
      "Canonical Board mention did not reserve its comment",
    );
  }
  const mentionId = deterministicUuid(
    "issue-board-mention",
    input.immutableSourceKey,
  );
  const inserted = await tx
    .insert(issueBoardMentions)
    .values({
      id: mentionId,
      companyId: input.companyId,
      issueId: input.target.issueId,
      ownershipEpoch: input.target.ownershipEpoch,
      agentId: input.comment.author.agentId,
      runId: input.comment.producingRun.runId,
      idempotencyKey: input.immutableSourceKey,
      commentId: admission.comment.id,
    })
    .onConflictDoNothing({
      target: [
        issueBoardMentions.companyId,
        issueBoardMentions.idempotencyKey,
      ],
    })
    .returning()
    .then((rows) => rows[0] ?? null);
  const mention = inserted ?? await tx
    .select()
    .from(issueBoardMentions)
    .where(and(
      eq(issueBoardMentions.companyId, input.companyId),
      eq(issueBoardMentions.idempotencyKey, input.immutableSourceKey),
    ))
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!mention || mention.commentId !== admission.comment.id) {
    throw new RuntimeIssueActionConflict(
      "Canonical Board mention was retried with different immutable arguments",
    );
  }
  await recordIssueLivenessActionInTransaction(
    tx,
    `issue_board_mention:${mention.id}`,
  );
  return { ...admission, boardMention: mention };
}

export async function admitCounterpartIssueUpdate(
  sessionAdmission: IssueSessionAdmissionService,
  tx: IssueSessionDbTransaction,
  input: {
    companyId: string;
    target: IssueMentionRecipient;
    actor: IssueSessionExecutionActor;
    comment: IssueSessionProjectedCommentSource;
    counterpart?: {
      counterpartIssueId: string;
      counterpartAuthorityId: string;
      counterpartOwnershipEpoch: number;
    };
    sourceAgentTarget?: { issueId: string; agentId: string } | null;
    immutableSourceKey: string;
    sourceRecordId: string;
  } & (
    | {
        sourceKind: "issue_update";
        prompt: PaperclipManagedToolPrompt<"issue_update">;
        message?: never;
      }
    | {
        sourceKind: "termination_recovery";
        prompt?: never;
        message: string;
      }
  ),
) {
  const counterpart = input.counterpart ?? {};
  const sourceKind = input.sourceKind;
  const exactMessage = input.sourceKind === "termination_recovery"
    ? input.message
    : renderPaperclipManagedToolPrompt(input.prompt);
  const selfTarget =
    input.target.kind === "agent" &&
    sameIssueAgentTarget(input.sourceAgentTarget, input.target.target);
  const dispatchTarget =
    input.target.kind === "agent" &&
    !selfTarget &&
    await canDispatchAgentCounterpartTarget(
      tx,
      input.companyId,
      input.target.target,
    );
  if (dispatchTarget && input.target.kind === "agent") {
    const target = input.target.target;
    const dispatchScope = {
      companyId: input.companyId,
      issueId: target.issueId,
      sessionId: target.sessionId,
      ownershipEpoch: target.ownershipEpoch,
      targetAgentId: target.agentId,
      issueExecutionAuthorityId: target.authorityId,
      consultExecutionId: null,
      adapterConfigRevisionId: target.adapterConfigRevisionId,
      contextEpoch: target.contextGeneration,
      mode: "owner" as const,
      ...counterpart,
      immutableSourceKey: input.immutableSourceKey,
      sourceRecordId: input.sourceRecordId,
      comment: input.comment,
      idempotencyKey: input.immutableSourceKey,
    };
    if (input.sourceKind === "termination_recovery") {
      if (input.actor.kind !== "system") {
        throw new RuntimeIssueActionConflict(
          "Termination recovery requires a system actor",
        );
      }
      return admitAgentTextInTransaction(sessionAdmission, tx, {
        ...dispatchScope,
        sourceKind: "termination_recovery",
        actor: input.actor,
        exactText: input.message,
      });
    }
    return mentionAgentInTransaction(sessionAdmission, tx, {
      ...dispatchScope,
      sourceKind: "issue_update",
      actor: input.actor,
      prompt: input.prompt,
    });
  }
  if (
    input.actor.kind === "agent-execution" &&
    (input.target.kind === "board" || !selfTarget)
  ) {
    return mentionBoardInTransaction(sessionAdmission, tx, {
      companyId: input.companyId,
      target: input.target.target,
      actor: input.actor,
      comment: input.comment,
      counterpart: input.counterpart,
      sourceKind,
      immutableSourceKey: input.immutableSourceKey,
      sourceRecordId: input.sourceRecordId,
      message: exactMessage,
    });
  }
  const target = input.target.target;
  return sessionAdmission.appendNonDispatchControlNotice(
    {
      companyId: input.companyId,
      issueId: target.issueId,
      sessionId: target.sessionId,
      sourceKind,
      actor: input.actor,
      ...counterpart,
      immutableSourceKey: input.immutableSourceKey,
      sourceRecordId: input.sourceRecordId,
      exactText: exactMessage,
      comment: input.comment,
      allowTerminal: false,
    },
    tx,
  );
}

async function lockReadyCompany(
  tx: IssueSessionDbTransaction,
  companyId: string,
): Promise<void> {
  const company = await tx
    .select()
    .from(companies)
    .where(eq(companies.id, companyId))
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (
    !company ||
    company.status !== "active" ||
    company.sessionIntegrityState !== "ready" ||
    company.hardDeleteFencedAt !== null
  ) {
    throw new RuntimeIssueActionDenied(
      "Company Session lifecycle is not ready",
      "company_inactive",
    );
  }
}

/**
 * One canonical transaction owner for both provider and documented human
 * issue forms. Human callers receive no execution authority, provider ref, or
 * generic assignment capability: their authority is re-proved against the
 * immutable issue owner/creator columns while the issue epoch is locked.
 */
export function createIssueFormCommitRuntime(
  db: Db,
  options: IssueFormCommitRuntimeOptions,
) {
  const clock = options.clock ?? (() => new Date());
  const sessionAdmission = createIssueSessionAdmissionService(db, { clock });

  async function commitOwnerFormUpdate(
    issueId: string,
    input: CanonicalOwnerFormUpdate,
    ownerAuthority: CanonicalOwnerFormAuthority,
  ) {
    if (!input.message.trim()) {
      throw new RuntimeIssueActionConflict(
        "Owner-form issue_update requires a non-empty message",
      );
    }
    if (input.status !== undefined && !STATUSES.has(input.status)) {
      throw new RuntimeIssueActionConflict(
        "Owner-form issue_update status is invalid",
      );
    }
    if (
      (input.status === undefined || !terminalStatus(input.status)) &&
      Object.hasOwn(input, "structuredResult")
    ) {
      throw new RuntimeIssueActionConflict(
        "Nonterminal owner updates cannot carry structuredResult",
      );
    }
    if (
      input.status !== undefined &&
      terminalStatus(input.status) &&
      Object.hasOwn(input, "structuredResult") &&
      input.structuredResult === undefined
    ) {
      throw new RuntimeIssueActionConflict(
        "structuredResult must be omitted rather than undefined",
      );
    }
    if (
      ownerAuthority.kind === "user-creator-withdrawal" &&
      (input.status !== "cancelled" ||
        Object.hasOwn(input, "structuredResult"))
    ) {
      throw new RuntimeIssueActionDenied(
        "A named-user withdrawal owner may only cancel with a message",
        "user_withdrawal_cancel_only",
      );
    }

    const companyId = authorityCompanyId(ownerAuthority);
    const gatewayInvocationId =
      ownerGatewayInvocationId(ownerAuthority);
    const disposition =
      input.status !== undefined && terminalStatus(input.status)
        ? {
            message: input.message,
            ...(Object.hasOwn(input, "structuredResult")
              ? { structuredResult: input.structuredResult }
              : {}),
          }
        : null;

    const committed = await db.transaction(async (tx) => {
      const now = clock();
      let issue: IssueRow;
      let authorizedRuntime: AuthorizedRuntimeAction | null = null;
      if (ownerAuthority.kind === "agent-execution") {
        authorizedRuntime = await lockRuntimeActionAuthority(
          tx,
          ownerAuthority.capability,
          "issue_update",
          now,
          { requireOwner: true },
        );
        if (
          issueId !== ownerAuthority.capability.issueId ||
          !ownerAuthority.capability.issueExecutionAuthorityId ||
          !authorizedRuntime.catalog.isCurrentOwner
        ) {
          throw new RuntimeIssueActionDenied(
            "Owner-form issue_update requires the current owner authority",
            "owner_authority_invalid",
          );
        }
        issue = authorizedRuntime.issue;
      } else {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${companyId}:${issueId}`}, 0))`,
        );
        await lockReadyCompany(tx, companyId);
        const locked = await tx
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.companyId, companyId),
              eq(issues.id, issueId),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!locked || !locked.ownershipEpoch) {
          throw new RuntimeIssueActionDenied(
            "Owner-form issue target does not exist",
            "owner_target_missing",
          );
        }
        const escalationOwner =
          locked.creatorKind === "system" &&
          locked.escalatedFromAffectedIssueId !== null &&
          ((locked.ownerKind === "user" &&
            locked.ownerUserId === ownerAuthority.actorUserId) ||
            locked.ownerKind === "board");
        const withdrawalOwner =
          locked.creatorKind === "user/board" &&
          locked.creatorUserId === ownerAuthority.actorUserId &&
          locked.ownerKind === "user" &&
          locked.ownerUserId === ownerAuthority.actorUserId &&
          locked.ownerAssignmentSource === "user_creator_withdrawal";
        if (
          (ownerAuthority.kind === "system-escalation-human" &&
            !escalationOwner) ||
          (ownerAuthority.kind === "user-creator-withdrawal" &&
            !withdrawalOwner)
        ) {
          throw new RuntimeIssueActionDenied(
            "Authenticated user is not the documented human owner",
            "owner_authority_invalid",
          );
        }
        issue = locked;
      }

      const retry = await loadUpdateRetry(
        tx,
        companyId,
        gatewayInvocationId,
      );
      const source = ownerSourceIdentity(ownerAuthority);
      if (retry) {
        if (
          retry.update.form !== "owner" ||
          retry.update.issueId !== issueId ||
          retry.update.sourceKind !== source.sourceKind ||
          retry.update.sourceAuthorityId !== source.sourceAuthorityId ||
          canonicalJson(retry.update.sourceIdentity) !==
            canonicalJson(source.sourceIdentity) ||
          retry.update.runId !== source.runId ||
          retry.update.message !== input.message ||
          retry.update.status !== (input.status ?? null) ||
          canonicalJson(retry.update.disposition) !==
            canonicalJson(disposition)
        ) {
          throw new RuntimeIssueActionConflict(
            "owner issue_update invocation was retried with different immutable arguments",
          );
        }
        return { ...retry, cancellations: null };
      }

      assertIssueNonterminal(issue);
      const previousStatus = issue.lifecycleStatus;
      if (input.status !== undefined) {
        assertLifecycleTransition(issue.lifecycleStatus, input.status);
      }
      const executionPolicyTransition =
        input.status === undefined
          ? null
          : applyIssueExecutionPolicyTransition({
              issue,
              policy: normalizeIssueExecutionPolicy(
                issue.executionPolicy,
              ),
              requestedStatus: boardPresentationStatusFor(input.status),
              requestedOwnerPatch: {},
              actor:
                ownerAuthority.kind === "agent-execution"
                  ? { agentId: ownerAuthority.capability.targetAgentId }
                  : { userId: ownerAuthority.actorUserId },
              commentBody: input.message,
            });
      const executionPolicyPatch = executionPolicyTransition
        ? issueExecutionPolicyPersistencePatch(
            executionPolicyTransition.patch,
          )
        : {};
      const nextExecutionState =
        executionPolicyTransition?.patch.executionState !== undefined
          ? parseIssueExecutionState(
              executionPolicyTransition.patch.executionState,
            )
          : parseIssueExecutionState(issue.executionState);
      const gated =
        input.status === "done" && nextExecutionState?.status === "pending";
      const edge = await tx
        .select()
        .from(issueCreatorEdgeReceivability)
        .where(
          and(
            eq(issueCreatorEdgeReceivability.companyId, companyId),
            eq(issueCreatorEdgeReceivability.issueId, issue.id),
            eq(
              issueCreatorEdgeReceivability.ownershipEpoch,
              issue.ownershipEpoch!,
            ),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!edge) {
        throw new RuntimeIssueActionConflict(
          "Current ownership epoch has no eager creator edge",
        );
      }
      const runSequence =
        source.runId === null
          ? 0
          : await nextRunUpdateSequence(tx, companyId, source.runId);
      const updateId = deterministicUuid(
        "issue-update",
        gatewayInvocationId,
      );
      const humanSessionState =
        ownerAuthority.kind === "agent-execution"
          ? null
          : await lockIssueSessionState(tx, companyId, issue.id);
      if (
        ownerAuthority.kind !== "agent-execution" &&
        !humanSessionState
      ) {
        throw new RuntimeIssueActionConflict(
          "Human owner-form target has no canonical Session",
        );
      }
      const sourceSessionId =
        ownerAuthority.kind === "agent-execution"
          ? ownerAuthority.capability.sessionId
          : humanSessionState!.session.id;
      const target = await lockOwnerUpdateRecipient(
        tx,
        companyId,
        issue,
        edge,
      );
      const updatePrompt = {
        toolName: "issue_update",
        arguments: {
          ...(input.status === undefined ? {} : { status: input.status }),
          message: input.message,
          ...(Object.hasOwn(input, "structuredResult")
            ? { structuredResult: input.structuredResult }
            : {}),
        },
        context: {
          issue,
          from: issueUpdateMessageActor(ownerAuthority, authorizedRuntime),
          sourceRole: "issue owner",
          previousStatus,
          effectiveStatus:
            input.status === undefined || gated ? previousStatus : input.status,
          ...(gated ? { pendingReview: true } : {}),
        },
      } satisfies PaperclipManagedToolPrompt<"issue_update">;
      const admission = await admitCounterpartIssueUpdate(sessionAdmission, tx, {
        companyId,
        sourceKind: "issue_update",
        target,
        actor: issueUpdateActor(ownerAuthority),
        comment: source.comment,
        counterpart: updateCounterpart(ownerAuthority),
        sourceAgentTarget:
          ownerAuthority.kind === "agent-execution"
            ? {
                issueId: ownerAuthority.capability.issueId,
                agentId: ownerAuthority.capability.targetAgentId,
              }
            : null,
        immutableSourceKey: gatewayInvocationId,
        sourceRecordId: updateId,
        prompt: updatePrompt,
      });
      if (!admission.comment) {
        throw new RuntimeIssueActionConflict(
          "Owner update projector did not create its comment-of-record",
        );
      }
      const update = await tx
        .insert(issueUpdates)
        .values({
          id: updateId,
          companyId,
          issueId: issue.id,
          sessionId: sourceSessionId,
          ownershipEpoch: issue.ownershipEpoch!,
          form: "owner",
          sourceKind: source.sourceKind,
          sourceAuthorityId: source.sourceAuthorityId,
          sourceIdentity: source.sourceIdentity,
          runId: source.runId,
          gatewayInvocationId,
          runSequence,
          message: input.message,
          status: input.status ?? null,
          disposition,
          commentId: admission.comment.id,
          creatorEdgeId: edge.id,
          createdAt: now,
        })
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!update) {
        throw new RuntimeIssueActionConflict(
          "Owner update ledger row was not persisted",
        );
      }
      const updatedIssue =
        input.status === undefined
          ? await tx
              .select()
              .from(issues)
              .where(
                and(
                  eq(issues.companyId, companyId),
                  eq(issues.id, issue.id),
                  eq(issues.ownershipEpoch, issue.ownershipEpoch!),
                  inArray(issues.lifecycleStatus, ["open", "blocked"]),
                ),
              )
              .limit(1)
              .then((rows) => rows[0] ?? null)
          : await tx
              .update(issues)
              .set({
                ...executionPolicyPatch,
                lifecycleStatus: gated
                  ? issue.lifecycleStatus
                  : input.status,
                boardPresentationStatus:
                  executionPolicyPatch.boardPresentationStatus ??
                  boardPresentationStatusFor(input.status),
                disposition: gated ? null : disposition,
                completedAt:
                  !gated && input.status === "done" ? now : null,
                cancelledAt:
                  !gated && input.status === "cancelled" ? now : null,
                updatedAt: now,
              })
              .where(
                and(
                  eq(issues.companyId, companyId),
                  eq(issues.id, issue.id),
                  eq(issues.ownershipEpoch, issue.ownershipEpoch!),
                  inArray(issues.lifecycleStatus, ["open", "blocked"]),
                ),
              )
              .returning()
              .then((rows) => rows[0] ?? null);
      if (!updatedIssue) {
        throw new RuntimeIssueActionConflict(
          "Issue lifecycle changed during owner update",
        );
      }
      const cancellations =
        !gated && input.status === "cancelled"
          ? await options.issueExecutionCancellation
              .requestScopeCancellationsInTransaction(tx, {
                companyId,
                issueId: issue.id,
                selector: {
                  kind: "ownership_epoch",
                  ownershipEpoch: issue.ownershipEpoch!,
                },
                reason: "issue_cancelled",
                actor:
                  ownerAuthority.kind === "agent-execution"
                    ? {
                        kind: "agent",
                        agentId:
                          ownerAuthority.capability.targetAgentId,
                      }
                    : {
                        kind: "user",
                        userId: ownerAuthority.actorUserId,
                      },
                now,
              })
          : null;
      await recordIssueLivenessActionInTransaction(
        tx,
        `issue_update:${update.id}`,
      );
      return {
        issue: updatedIssue,
        update,
        comment: admission.comment,
        ref: admission.ref,
        gated,
        cancellations,
        retried: false as const,
      };
    });
    if (committed.ref) {
      await options.dispatchPersistedRef(committed.ref.id);
    }
    if (committed.cancellations) {
      void options.issueExecutionCancellation
        .reconcileRequestedScopeCancellations(committed.cancellations)
        .catch(() => {
          // The durable cancellation-intent reconciler retries this signal.
        });
    }
    const { cancellations: _, ...result } = committed;
    return result;
  }

  async function commitCreatorFormUpdate(
    issueId: string,
    input: string | CanonicalCreatorFormUpdate,
    creatorAuthority: CanonicalCreatorFormAuthority,
  ) {
    const updateInput: CanonicalCreatorFormUpdate =
      typeof input === "string" ? { message: input } : input;
    const { message } = updateInput;
    if (!message.trim()) {
      throw new RuntimeIssueActionConflict(
        "Creator-form issue_update requires a non-empty message",
      );
    }
    if (
      updateInput.status !== undefined &&
      !STATUSES.has(updateInput.status)
    ) {
      throw new RuntimeIssueActionConflict(
        "Creator-form issue_update status is invalid",
      );
    }
    if (Object.hasOwn(updateInput, "structuredResult")) {
      throw new RuntimeIssueActionConflict(
        "Creator issue_update cannot carry structuredResult",
      );
    }
    if (
      updateInput.status !== undefined &&
      terminalStatus(updateInput.status)
    ) {
      throw new RuntimeIssueActionDenied(
        "Terminal done or cancelled updates require current-owner authority",
        "creator_terminal_status_forbidden",
      );
    }
    if (
      updateInput.status !== undefined &&
      creatorAuthority.kind !== "agent-execution"
    ) {
      throw new RuntimeIssueActionDenied(
        "Only an exact agent execution creator may transition issue lifecycle",
        "creator_lifecycle_agent_execution_required",
      );
    }
    const disposition = null;
    const companyId = authorityCompanyId(creatorAuthority);
    const gatewayInvocationId =
      creatorGatewayInvocationId(creatorAuthority);
    const committed = await db.transaction(async (tx) => {
      const now = clock();
      let authorizedRuntime: AuthorizedRuntimeAction | null = null;
      if (creatorAuthority.kind === "agent-execution") {
        authorizedRuntime = await lockRuntimeActionAuthority(
          tx,
          creatorAuthority.capability,
          "issue_update",
          now,
          { requireOwner: true },
        );
        if (!creatorAuthority.capability.issueExecutionAuthorityId) {
          throw new RuntimeIssueActionDenied(
            "Creator-form update requires a stable creator execution",
            "execution_authority_invalid",
          );
        }
        if (
          !authorizedRuntime.catalog.creatorUpdateTargets.some(
            (candidate) => candidate.issueId === issueId,
          )
        ) {
          throw new RuntimeIssueActionDenied(
            "Target is no longer in the caller's creator-update catalog",
            "creator_catalog_changed",
          );
        }
      } else {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${companyId}:${issueId}`}, 0))`,
        );
        if (creatorAuthority.kind === "plugin") {
          await resolvePluginPermittedIssueOwnerCatalogInTransaction(
            tx,
            {
              companyId,
              pluginInstallationId:
                creatorAuthority.pluginInstallationId,
              pluginKey: creatorAuthority.pluginKey,
              operation: "issues.update",
            },
          );
        } else if (creatorAuthority.kind === "routine") {
          const routine = await tx
            .select()
            .from(routines)
            .where(
              and(
                eq(routines.companyId, companyId),
                eq(routines.id, creatorAuthority.routineId),
              ),
            )
            .for("update")
            .then((rows) => rows[0] ?? null);
          const hook = await tx
            .select()
            .from(routineRuns)
            .where(
              and(
                eq(routineRuns.companyId, companyId),
                eq(routineRuns.id, creatorAuthority.routineDispatchId),
                eq(routineRuns.routineId, creatorAuthority.routineId),
              ),
            )
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (!routine || routine.status !== "active" || !hook) {
            throw new RuntimeIssueActionDenied(
              "Routine creator hook is not active",
              "creator_authority_mismatch",
            );
          }
        }
        await lockReadyCompany(tx, companyId);
      }

      await tx.execute(
        sql`select ${issues.id} from ${issues} where ${issues.id} = ${issueId} and ${issues.companyId} = ${companyId} for update`,
      );
      const issue = await tx
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.id, issueId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!issue || !issue.ownershipEpoch) {
        throw new RuntimeIssueActionDenied(
          "Creator-update target no longer exists",
          "target_issue_missing",
        );
      }
      const creatorMatches = (() => {
        switch (creatorAuthority.kind) {
          case "agent-execution":
            return (
              issue.parentId === creatorAuthority.capability.issueId &&
              issue.creatorKind === "agent-execution" &&
              issue.creatorAuthorityId ===
                creatorAuthority.capability.issueExecutionAuthorityId
            );
          case "user/board":
            return (
              issue.creatorKind === "user/board" &&
              issue.creatorUserId === creatorAuthority.userId
            );
          case "plugin":
            return (
              issue.creatorKind === "plugin" &&
              issue.creatorPluginInstallationId ===
                creatorAuthority.pluginInstallationId &&
              issue.creatorPluginKey === creatorAuthority.pluginKey
            );
          case "routine":
            return (
              issue.creatorKind === "routine" &&
              issue.creatorRoutineId === creatorAuthority.routineId &&
              issue.creatorRoutineDispatchId ===
                creatorAuthority.routineDispatchId
            );
          case "system":
            return (
              issue.creatorKind === "system" &&
              issue.creatorSystemSourceKind ===
                creatorAuthority.sourceKind &&
              issue.creatorSystemSourceId === creatorAuthority.sourceId
            );
        }
      })();
      if (!creatorMatches) {
        throw new RuntimeIssueActionDenied(
          "Creator-update authority does not match the immutable target creator",
          "creator_authority_mismatch",
        );
      }
      if (creatorAuthority.kind === "routine") {
        const hook = await tx
          .select({ linkedIssueId: routineRuns.linkedIssueId })
          .from(routineRuns)
          .where(eq(routineRuns.id, creatorAuthority.routineDispatchId))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (hook?.linkedIssueId !== issue.id) {
          throw new RuntimeIssueActionDenied(
            "Routine creator hook does not target this issue",
            "creator_authority_mismatch",
          );
        }
      }
      const sessionState = await lockIssueSessionState(
        tx,
        companyId,
        issue.id,
      );
      if (!sessionState) {
        throw new RuntimeIssueActionConflict(
          "Creator-update target has no canonical Session",
        );
      }
      const edge = await tx
        .select()
        .from(issueCreatorEdgeReceivability)
        .where(
          and(
            eq(issueCreatorEdgeReceivability.companyId, companyId),
            eq(issueCreatorEdgeReceivability.issueId, issue.id),
            eq(
              issueCreatorEdgeReceivability.ownershipEpoch,
              issue.ownershipEpoch,
            ),
            eq(issueCreatorEdgeReceivability.state, "receivable"),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      const expectedEndpoint = creatorEndpoint(issue);
      if (
        !edge ||
        edge.endpointKind !== expectedEndpoint.endpointKind ||
        edge.endpointId !== expectedEndpoint.endpointId ||
        canonicalJson(edge.endpointSnapshot) !==
          canonicalJson(expectedEndpoint.endpointSnapshot)
      ) {
        throw new RuntimeIssueActionDenied(
          "Immutable creator edge is no longer receivable",
          "creator_edge_terminal",
        );
      }

      const source = creatorSourceIdentity(creatorAuthority);
      const retry = await loadUpdateRetry(
        tx,
        companyId,
        gatewayInvocationId,
      );
      if (retry) {
        if (
          retry.update.form !== "creator" ||
          retry.update.issueId !== issue.id ||
          retry.update.sourceKind !== source.sourceKind ||
          retry.update.sourceAuthorityId !== source.sourceAuthorityId ||
          canonicalJson(retry.update.sourceIdentity) !==
            canonicalJson(source.sourceIdentity) ||
          retry.update.runId !== source.runId ||
          retry.update.message !== message ||
          retry.update.status !== (updateInput.status ?? null) ||
          canonicalJson(retry.update.disposition) !== canonicalJson(disposition)
        ) {
          throw new RuntimeIssueActionConflict(
            "creator issue_update invocation was retried with different immutable arguments",
          );
        }
        return { ...retry, cancellations: null };
      }

      // Idempotent retries must be recognized before checking the current
      // lifecycle state: a successful open -> blocked creator update now sees
      // the child as blocked on its exact replay.
      assertIssueNonterminal(issue);
      const previousStatus = issue.lifecycleStatus;
      if (updateInput.status !== undefined) {
        assertLifecycleTransition(issue.lifecycleStatus, updateInput.status);
      }

      const executionPolicyTransition =
        updateInput.status === undefined
          ? null
          : (() => {
              if (creatorAuthority.kind !== "agent-execution") {
                throw new RuntimeIssueActionDenied(
                  "Only an exact agent execution creator may transition issue lifecycle",
                  "creator_lifecycle_agent_execution_required",
                );
              }
              return applyIssueExecutionPolicyTransition({
                issue,
                policy: normalizeIssueExecutionPolicy(
                  issue.executionPolicy,
                ),
                requestedStatus: boardPresentationStatusFor(
                  updateInput.status,
                ),
                requestedOwnerPatch: {},
                actor: {
                  agentId: creatorAuthority.capability.targetAgentId,
                },
                commentBody: message,
              });
            })();
      const executionPolicyPatch = executionPolicyTransition
        ? issueExecutionPolicyPersistencePatch(
            executionPolicyTransition.patch,
          )
        : {};

      const target = await lockIssueMentionRecipient(
        tx,
        companyId,
        issue.id,
      );
      const updateId = deterministicUuid(
        "issue-update",
        gatewayInvocationId,
      );
      const updatePrompt = {
        toolName: "issue_update",
        arguments: {
          issueId,
          ...(updateInput.status === undefined
            ? {}
            : { status: updateInput.status }),
          message,
        },
        context: {
          issue,
          from: issueUpdateMessageActor(creatorAuthority, authorizedRuntime),
          sourceRole: "issue creator",
          previousStatus,
          effectiveStatus: updateInput.status ?? previousStatus,
        },
      } satisfies PaperclipManagedToolPrompt<"issue_update">;
      const admission = await admitCounterpartIssueUpdate(sessionAdmission, tx, {
        companyId,
        sourceKind: "issue_update",
        target,
        actor: issueUpdateActor(creatorAuthority),
        comment: source.comment,
        counterpart: updateCounterpart(creatorAuthority),
        sourceAgentTarget:
          creatorAuthority.kind === "agent-execution"
            ? {
                issueId: creatorAuthority.capability.issueId,
                agentId: creatorAuthority.capability.targetAgentId,
              }
            : null,
        immutableSourceKey: gatewayInvocationId,
        sourceRecordId: updateId,
        prompt: updatePrompt,
      });
      if (!admission.comment) {
        throw new RuntimeIssueActionConflict(
          "Creator update did not persist its canonical comment",
        );
      }
      const runSequence =
        source.runId === null
          ? 0
          : await nextRunUpdateSequence(tx, companyId, source.runId);
      const update = await tx
        .insert(issueUpdates)
        .values({
          id: updateId,
          companyId,
          issueId: issue.id,
          sessionId: sessionState.session.id,
          ownershipEpoch: issue.ownershipEpoch,
          form: "creator",
          sourceKind: source.sourceKind,
          sourceAuthorityId: source.sourceAuthorityId,
          sourceIdentity: source.sourceIdentity,
          runId: source.runId,
          gatewayInvocationId,
          runSequence,
          message,
          status: updateInput.status ?? null,
          disposition,
          commentId: admission.comment.id,
          creatorEdgeId: edge.id,
          createdAt: now,
        })
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!update) {
        throw new RuntimeIssueActionConflict(
          "Creator update ledger row was not persisted",
        );
      }
      const updatedIssue =
        updateInput.status === undefined
          ? await tx
              .select()
              .from(issues)
              .where(
                and(
                  eq(issues.companyId, companyId),
                  eq(issues.id, issue.id),
                  eq(issues.ownershipEpoch, issue.ownershipEpoch),
                  inArray(issues.lifecycleStatus, ["open", "blocked"]),
                ),
              )
              .limit(1)
              .then((rows) => rows[0] ?? null)
          : await tx
              .update(issues)
              .set({
                ...executionPolicyPatch,
                lifecycleStatus: updateInput.status,
                boardPresentationStatus:
                  executionPolicyPatch.boardPresentationStatus ??
                  boardPresentationStatusFor(updateInput.status),
                disposition: null,
                completedAt: null,
                cancelledAt: null,
                updatedAt: now,
              })
              .where(
                and(
                  eq(issues.companyId, companyId),
                  eq(issues.id, issue.id),
                  eq(issues.ownershipEpoch, issue.ownershipEpoch),
                  inArray(issues.lifecycleStatus, ["open", "blocked"]),
                ),
              )
              .returning()
              .then((rows) => rows[0] ?? null);
      if (!updatedIssue) {
        throw new RuntimeIssueActionConflict(
          "Issue lifecycle changed during creator update",
        );
      }
      await recordIssueLivenessActionInTransaction(
        tx,
        `issue_update:${update.id}`,
      );
      return {
        issue: updatedIssue,
        update,
        comment: admission.comment,
        ref: admission.ref,
        gated: false,
        cancellations: null,
        retried: false as const,
      };
    });
    if (committed.ref) {
      await options.dispatchPersistedRef(committed.ref.id);
    }
    const { cancellations: _, ...result } = committed;
    return result;
  }

  return {
    commitOwnerFormUpdate,
    commitCreatorFormUpdate,
  };
}

export interface OutgoingOwnershipEpochRevocation {
  readonly escalationDispatchRefIds: readonly string[];
  readonly cancellations: RequestedScopedRunCancellations;
}

export async function revokeOutgoingOwnershipEpoch(
  tx: IssueSessionDbTransaction,
  sessionAdmission: IssueSessionAdmissionService,
  issueExecutionCancellation: Pick<
    IssueExecutionCancellationService,
    "requestScopeCancellationsInTransaction"
  >,
  input: {
    companyId: string;
    issueId: string;
    sessionId: string;
    ownershipEpoch: number;
    authorityId: string;
    sourceAuthorityId: string;
    triggeringRunId?: string | null;
    cancellationActor: IssueExecutionCancellationActor;
    now: Date;
  },
): Promise<OutgoingOwnershipEpochRevocation> {
  await tx.execute(
    sql`select ${issueExecutionAuthorities.id} from ${issueExecutionAuthorities} where ${issueExecutionAuthorities.id} = ${input.authorityId} for update`,
  );
  const authority = await tx
    .select()
    .from(issueExecutionAuthorities)
    .where(eq(issueExecutionAuthorities.id, input.authorityId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (
    !authority ||
    authority.companyId !== input.companyId ||
    authority.issueId !== input.issueId ||
    authority.sessionId !== input.sessionId ||
    authority.ownershipEpoch !== input.ownershipEpoch ||
    authority.state !== "current"
  ) {
    throw new RuntimeIssueActionConflict(
      "Outgoing issue-execution authority is missing or already revoked",
    );
  }

  await tx
    .update(issueExecutionAuthorities)
    .set({
      state: "revoked",
      revocationReason: "ownership_epoch_advanced",
      revokedAt: input.now,
    })
    .where(eq(issueExecutionAuthorities.id, input.authorityId));
  await tx
    .update(issueExecutionPromptCapabilities)
    .set({
      state: "revoked",
      revocationReason: "ownership_epoch_advanced",
      revokedAt: input.now,
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
    );
  const cancellations =
    await issueExecutionCancellation.requestScopeCancellationsInTransaction(
      tx,
      {
        companyId: input.companyId,
        issueId: input.issueId,
        selector: {
          kind: "ownership_epoch",
          ownershipEpoch: input.ownershipEpoch,
        },
        reason: "ownership_epoch_advanced",
        actor: input.cancellationActor,
        now: input.now,
      },
    );

  const directChildren = await tx
    .select({
      id: issues.id,
      ownershipEpoch: issues.ownershipEpoch,
      lifecycleStatus: issues.lifecycleStatus,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, input.companyId),
        eq(issues.parentId, input.issueId),
        eq(issues.creatorKind, "agent-execution"),
        eq(issues.creatorAuthorityId, input.authorityId),
        inArray(issues.lifecycleStatus, ["open", "blocked"]),
      ),
    )
    .for("update");
  const dispatchRefIds: string[] = [];
  for (const child of directChildren) {
    if (!child.ownershipEpoch) continue;
    const edge = await tx
      .select()
      .from(issueCreatorEdgeReceivability)
      .where(
        and(
          eq(issueCreatorEdgeReceivability.companyId, input.companyId),
          eq(issueCreatorEdgeReceivability.issueId, child.id),
          eq(
            issueCreatorEdgeReceivability.ownershipEpoch,
            child.ownershipEpoch,
          ),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!edge) {
      throw new RuntimeIssueActionConflict(
        "Direct child lost its eager creator edge during authority revocation",
      );
    }
    const terminalized = await terminalizeCreatorEdgeInTransaction(
      tx,
      sessionAdmission,
      {
        companyId: input.companyId,
        issueId: child.id,
        ownershipEpoch: child.ownershipEpoch,
        creatorEdgeId: edge.id,
        reason: "creator_execution_superseded",
        sourceKind: "issue_reassignment",
        sourceId: input.sourceAuthorityId,
        systemSource: "recovery",
        triggeringRunId: input.triggeringRunId ?? null,
        endpointTombstone: {
          authorityId: input.authorityId,
          state: "revoked",
          reason: "ownership_epoch_advanced",
        },
        audit: {
          revokedAuthorityId: input.authorityId,
          parentIssueId: input.issueId,
          parentOwnershipEpoch: input.ownershipEpoch,
        },
      },
      () => input.now,
    );
    if (terminalized.escalation?.dispatchRefId) {
      dispatchRefIds.push(terminalized.escalation.dispatchRefId);
    }
  }
  return {
    escalationDispatchRefIds: Object.freeze(dispatchRefIds),
    cancellations,
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeToolArgumentsInvalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new RuntimeToolArgumentsInvalid(
      `Unsupported tool arguments: ${unknown.sort().join(", ")}`,
    );
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RuntimeToolArgumentsInvalid(
      `${label} must be a non-empty string`,
    );
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}

function nonBlankString(value: unknown, label: string): string {
  const parsed = requiredString(value, label);
  if (parsed.trim().length === 0) {
    throw new RuntimeToolArgumentsInvalid(`${label} must not be blank`);
  }
  return parsed;
}

function ownerChoice(value: unknown): RuntimeIssueOwnerChoice {
  const owner = object(value, "owner");
  if (owner.kind === "self") {
    exactKeys(owner, ["kind"]);
    return { kind: "self" };
  }
  if (owner.kind === "agent") {
    exactKeys(owner, ["kind", "agentId"]);
    return {
      kind: "agent",
      agentId: requiredString(owner.agentId, "owner.agentId"),
    };
  }
  throw new RuntimeToolArgumentsInvalid("owner.kind must be self or agent");
}

function contextAccessMask(
  value: unknown,
): Partial<Record<AgentContextGrantKey, false>> | undefined {
  if (value === undefined) return undefined;
  try {
    return normalizeContextAccess(value) ?? undefined;
  } catch (error) {
    throw new RuntimeToolArgumentsInvalid(
      error instanceof Error
        ? error.message
        : "Issue context access mask is invalid",
    );
  }
}

function assertOwnerExecution(input: RuntimeActionInvocation): void {
  if (input.capability.executionMode !== "owner") {
    throw new RuntimeToolArgumentsInvalid(
      "Consult executions cannot mutate issue ownership or lifecycle",
    );
  }
}

/**
 * Closed adapter for the four issue action descriptors. It accepts exactly
 * the compiler-owned ABI and leaves all catalog/authority/epoch revalidation
 * to the canonical transactional service.
 */
export function createRuntimeIssueActionPort(
  service: RuntimeIssueActionService,
): RuntimeNonAgentActionPort {
  return {
    async issueCreate(input) {
      assertOwnerExecution(input);
      exactKeys(input.arguments, CREATE_KEYS);
      const priorityValue = input.arguments.priority;
      if (
        priorityValue !== undefined &&
        (typeof priorityValue !== "string" || !PRIORITIES.has(priorityValue))
      ) {
        throw new RuntimeToolArgumentsInvalid(
          "priority must be critical, high, medium, or low",
        );
      }
      return service.create({
        capability: input.capability,
        invocationId: input.invocationId,
        request: requiredString(input.arguments.request, "request"),
        title: optionalString(input.arguments.title, "title"),
        priority: priorityValue as
          "critical" | "high" | "medium" | "low" | undefined,
        owner: ownerChoice(input.arguments.owner),
        contextAccessMask: contextAccessMask(input.arguments.contextAccessMask),
      });
    },

    async issueAssign(input) {
      assertOwnerExecution(input);
      exactKeys(input.arguments, ASSIGN_KEYS);
      return service.assign({
        capability: input.capability,
        invocationId: input.invocationId,
        issueId: requiredString(input.arguments.issueId, "issueId"),
        owner: ownerChoice(input.arguments.owner),
      });
    },

    async issueUpdate(input) {
      assertOwnerExecution(input);
      const hasTargetIssueId = Object.hasOwn(input.arguments, "issueId");
      const target = hasTargetIssueId
        ? { issueId: requiredString(input.arguments.issueId, "issueId") }
        : {};
      if (!Object.hasOwn(input.arguments, "status")) {
        exactKeys(input.arguments, [
          ...UPDATE_MESSAGE_KEYS,
          ...(hasTargetIssueId ? ["issueId"] : []),
        ]);
        return service.update({
          capability: input.capability,
          invocationId: input.invocationId,
          ...target,
          message: requiredString(input.arguments.message, "message"),
        });
      }
      const status = input.arguments.status;
      if (
        typeof status !== "string" ||
        !STATUSES.has(status as AgentVisibleIssueStatus)
      ) {
        throw new RuntimeToolArgumentsInvalid(
          "status must be open, blocked, done, or cancelled",
        );
      }
      const terminal = status === "done" || status === "cancelled";
      if (terminal && hasTargetIssueId) {
        throw new RuntimeToolArgumentsInvalid(
          "Terminal done or cancelled updates require current-owner authority; omit issueId",
        );
      }
      exactKeys(input.arguments, [
        ...(terminal ? TERMINAL_UPDATE_KEYS : UPDATE_KEYS),
        ...(hasTargetIssueId ? ["issueId"] : []),
      ]);
      if (
        terminal &&
        Object.hasOwn(input.arguments, "structuredResult") &&
        input.arguments.structuredResult === undefined
      ) {
        throw new RuntimeToolArgumentsInvalid(
          "structuredResult must be omitted rather than undefined",
        );
      }
      if (terminal) {
        return service.update({
          capability: input.capability,
          invocationId: input.invocationId,
          status: status as "done" | "cancelled",
          message: requiredString(input.arguments.message, "message"),
          ...(Object.hasOwn(input.arguments, "structuredResult")
            ? { structuredResult: input.arguments.structuredResult }
            : {}),
        });
      }
      return service.update({
        capability: input.capability,
        invocationId: input.invocationId,
        ...target,
        status: status as "open" | "blocked",
        message: requiredString(input.arguments.message, "message"),
      });
    },

    async mentionAgent(input) {
      const mention = (() => {
        try {
          return parseRuntimeMentionArguments(input.arguments);
        } catch (error) {
          throw new RuntimeToolArgumentsInvalid(
            error instanceof Error
              ? error.message
              : "Mention arguments are invalid",
          );
        }
      })();
      return service.mention({
        capability: input.capability,
        invocationId: input.invocationId,
        runInterfaceToolCallId: input.runInterfaceToolCallId,
        ingressOrdinal: input.ingressOrdinal,
        commitMentionAction: input.commitMentionAction,
        targetAgentId: mention.agentId,
        message: mention.message,
      });
    },

    async mentionBoard(input) {
      exactKeys(input.arguments, BOARD_MENTION_KEYS);
      return service.mentionBoard({
        capability: input.capability,
        invocationId: input.invocationId,
        runInterfaceToolCallId: input.runInterfaceToolCallId,
        ingressOrdinal: input.ingressOrdinal,
        commitMentionAction: input.commitMentionAction,
        message: nonBlankString(input.arguments.message, "message"),
      });
    },

    async listAgents(input) {
      exactKeys(input.arguments, []);
      return service.listAgents({
        capability: input.capability,
        invocationId: input.invocationId,
      });
    },
  };
}

/**
 * Canonical PostgreSQL implementation for the provider-visible issue actions.
 * Every method treats the bearer as a claimed binding only: the company,
 * gateway, lease, run, authority/consult, action grant, and dynamic catalog
 * are locked and re-read in the commit transaction.
 */
export function createPostgresRuntimeIssueActionService(
  db: Db,
  options: PostgresRuntimeIssueActionServiceOptions,
): RuntimeIssueActionService {
  const clock = options.clock ?? (() => new Date());
  const sessionAdmission = createIssueSessionAdmissionService(db, { clock });
  const issueForms = createIssueFormCommitRuntime(db, {
    clock,
    dispatchPersistedRef: options.dispatchPersistedRef,
    issueExecutionCancellation: options.issueExecutionCancellation,
  });

  return {
    async create(input) {
      const committed = await db.transaction(async (tx) => {
        const now = clock();
        const authorized = await lockRuntimeActionAuthority(
          tx,
          input.capability,
          "issue_create",
          now,
          { requireOwner: true },
        );
        const key = runtimeInvocationKey(
          "create",
          promptCapabilityGenerationIdentity(input.capability),
          input.invocationId,
        );
        const requestedOwnerId = ownerAgentId(
          input.owner,
          input.capability.targetAgentId,
        );
        const prior = await tx
          .select({
            key: issueCreateIdempotencyKeys,
            issue: issues,
          })
          .from(issueCreateIdempotencyKeys)
          .innerJoin(issues, eq(issues.id, issueCreateIdempotencyKeys.issueId))
          .where(
            and(
              eq(issueCreateIdempotencyKeys.companyId, input.capability.companyId),
              eq(issueCreateIdempotencyKeys.idempotencyKey, key),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (prior) {
          const expectedMask = input.contextAccessMask ?? null;
          if (
            prior.issue.parentId !== input.capability.issueId ||
            prior.issue.request !== input.request ||
            prior.issue.title !== (input.title ?? null) ||
            prior.issue.priority !== (input.priority ?? "medium") ||
            prior.issue.ownerKind !== "agent" ||
            prior.issue.ownerAgentId !== requestedOwnerId ||
            prior.issue.creatorKind !== "agent-execution" ||
            prior.issue.creatorAuthorityId !==
              input.capability.issueExecutionAuthorityId ||
            canonicalJson(prior.issue.contextAccessMask) !==
              canonicalJson(expectedMask)
          ) {
            throw new RuntimeIssueActionConflict(
              "issue_create invocation was retried with different immutable arguments",
            );
          }
          const ref = await tx
            .select()
            .from(issueExecutionRefs)
            .where(
              and(
                eq(issueExecutionRefs.companyId, input.capability.companyId),
                eq(issueExecutionRefs.deliveryIdempotencyKey, key),
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (!ref) {
            throw new RuntimeIssueActionConflict(
              "Accepted issue_create is missing its owner ref",
            );
          }
          return { issue: prior.issue, ref, retried: true };
        }

        const targetAgentId = assertCreateOwnerCatalog(authorized, input.owner);
        const targetRevisionId = await assertTargetAdapterRevision(
          tx,
          input.capability.companyId,
          targetAgentId,
        );
        if (!input.capability.issueExecutionAuthorityId) {
          throw new RuntimeIssueActionDenied(
            "issue_create requires a stable parent execution authority",
            "execution_authority_invalid",
          );
        }
        const issueCounter = authorized.company.issueCounter + 1;
        await tx
          .update(companies)
          .set({ issueCounter, updatedAt: now })
          .where(eq(companies.id, input.capability.companyId));

        const issueId = deterministicUuid("runtime-issue-create", key);
        const sessionId = stableSessionId(`runtime-issue-create:${key}`);
        const authorityId = deterministicUuid(
          "issue-execution-authority",
          `${issueId}:1:${targetAgentId}`,
        );
        const aggregate = await withRuntimeWorkspaceReservationErrors(() =>
          persistCanonicalIssueAggregateInTx(tx, {
            issue: {
              id: issueId,
              companyId: input.capability.companyId,
              projectId: authorized.issue.projectId,
              goalId: authorized.issue.goalId,
              parentId: input.capability.issueId,
              title: input.title ?? null,
              request: input.request,
              boardPresentationStatus: "todo",
              lifecycleStatus: "open",
              disposition: null,
              priority: input.priority ?? "medium",
              ownerKind: "agent",
              ownerAgentId: targetAgentId,
              ownerUserId: null,
              ownerAssignmentSource: null,
              ownershipEpoch: 1,
              creatorKind: "agent-execution",
              creatorAuthorityId: input.capability.issueExecutionAuthorityId,
              creatorAdapterConfigRevisionId:
                input.capability.adapterConfigIdentity,
              contextAccessMask: input.contextAccessMask ?? null,
              issueNumber: issueCounter,
              identifier: `${authorized.company.issuePrefix}-${issueCounter}`,
              originKind: "agent_issue_create",
              originId: input.capability.issueId,
              originRunId: input.capability.runId,
              originFingerprint: key,
              requestDepth: authorized.issue.requestDepth + 1,
              createdAt: now,
              updatedAt: now,
            },
            session: {
              id: sessionId,
              parentSessionId: input.capability.sessionId,
              now,
            },
            workspaceReservation: {
              provenance: {
                agentId: input.capability.targetAgentId,
                userId: null,
              },
            },
            authority: {
              id: authorityId,
              agentId: targetAgentId,
              auditAdapterConfigRevisionId: targetRevisionId,
              createdAt: now,
            },
            idempotency: {
              id: deterministicUuid("issue-create-idempotency", key),
              key,
            },
          }),
        );
        const created = aggregate.issue;
        const sessionRoot = aggregate.sessionRoot;
        const edge = aggregate.creatorEdge;
        if (!edge) {
          throw new RuntimeIssueActionConflict(
            "issue_create did not persist its creator edge",
          );
        }
        const admission = await mentionAgentInTransaction(
          sessionAdmission,
          tx,
          {
            companyId: created.companyId,
            issueId: created.id,
            sessionId,
            ownershipEpoch: 1,
            targetAgentId,
            issueExecutionAuthorityId: authorityId,
            consultExecutionId: null,
            adapterConfigRevisionId: targetRevisionId,
            contextEpoch: sessionRoot.contextEpoch.generation,
            mode: "owner",
            counterpartIssueId: input.capability.issueId,
            counterpartAuthorityId: input.capability.issueExecutionAuthorityId,
            counterpartOwnershipEpoch: input.capability.ownershipEpoch,
            sourceKind: "issue_request",
            actor: executionActorForCapability(input.capability),
            immutableSourceKey: key,
            sourceRecordId: created.id,
            prompt: {
              toolName: "issue_create",
              arguments: {
                request: input.request,
                ...(input.title === undefined ? {} : { title: input.title }),
                ...(input.priority === undefined
                  ? {}
                  : { priority: input.priority }),
                owner: input.owner,
              },
              context: {
                issue: created,
                from: messageAgent(
                  authorized.companyAgents,
                  input.capability.targetAgentId,
                ),
                owner: messageAgent(authorized.companyAgents, targetAgentId),
                status: "open",
              },
            },
            comment: {
              author: {
                kind: "agent",
                agentId: input.capability.targetAgentId,
              },
              producingRun: {
                runId: input.capability.runId,
                adapterConfigRevisionId:
                  input.capability.adapterConfigIdentity,
              },
            },
            idempotencyKey: key,
          },
        );
        if (!admission.ref) {
          throw new RuntimeIssueActionConflict(
            "issue_create did not reserve an owner execution ref",
          );
        }
        return {
          issue: created,
          sessionId,
          authorityId,
          creatorEdgeId: edge.id,
          ref: admission.ref,
          comment: admission.comment,
          retried: false,
        };
      });
      await options.dispatchPersistedRef(committed.ref.id);
      return committed;
    },

    async assign(input) {
      const committed = await db.transaction(async (tx) => {
        const now = clock();
        const authorized = await lockRuntimeActionAuthority(
          tx,
          input.capability,
          "issue_assign",
          now,
          { requireOwner: true },
        );
        if (!input.capability.issueExecutionAuthorityId) {
          throw new RuntimeIssueActionDenied(
            "issue_assign requires the caller's stable creator authority",
            "execution_authority_invalid",
          );
        }
        await tx.execute(
          sql`select ${issues.id} from ${issues} where ${issues.id} = ${input.issueId} and ${issues.companyId} = ${input.capability.companyId} for update`,
        );
        const targetIssue = await tx
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.companyId, input.capability.companyId),
              eq(issues.id, input.issueId),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (!targetIssue || !targetIssue.ownershipEpoch) {
          throw new RuntimeIssueActionDenied(
            "Target issue does not exist in the caller's company",
            "target_issue_missing",
          );
        }
        const targetSessionState = await lockIssueSessionState(
          tx,
          input.capability.companyId,
          input.issueId,
        );
        if (!targetSessionState) {
          throw new RuntimeIssueActionConflict(
            "Target issue has no canonical Session",
          );
        }
        const { session: targetSession } = targetSessionState;
        const key = runtimeInvocationKey(
          "assign",
          promptCapabilityGenerationIdentity(input.capability),
          input.invocationId,
        );
        const requestedOwnerId = ownerAgentId(
          input.owner,
          input.capability.targetAgentId,
        );
        const priorEvent = await tx
          .select()
          .from(issueSessionEvents)
          .where(
            and(
              eq(issueSessionEvents.sessionId, targetSession.id),
              eq(issueSessionEvents.sourceKind, "issue_reassignment"),
              eq(issueSessionEvents.immutableSourceKey, key),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (priorEvent) {
          const priorRef = await tx
            .select()
            .from(issueExecutionRefs)
            .where(
              and(
                eq(issueExecutionRefs.sessionId, targetSession.id),
                eq(issueExecutionRefs.sourceId, priorEvent.sourceId!),
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (
            priorEvent.sourceRecordId !== targetIssue.id ||
            priorEvent.data === null ||
            !priorRef ||
            priorRef.targetAgentId !== requestedOwnerId ||
            !paperclipEnvelopeHasBody(
              priorRef.exactMessage,
              "[Paperclip issue assignment]",
              targetIssue.request,
            )
          ) {
            throw new RuntimeIssueActionConflict(
              "issue_assign invocation was retried with different immutable arguments",
            );
          }
          return {
            issue: targetIssue,
            authorityId: priorRef.issueExecutionAuthorityId,
            ref: priorRef,
            escalationDispatchRefIds: [] as string[],
            cancellations: null,
            retried: true,
          };
        }

        const targetAgentId = assertAssignOwnerCatalog(
          authorized,
          input.issueId,
          input.owner,
        );
        assertIssueNonterminal(targetIssue);
        if (
          targetIssue.parentId !== input.capability.issueId ||
          targetIssue.creatorKind !== "agent-execution" ||
          targetIssue.creatorAuthorityId !==
            input.capability.issueExecutionAuthorityId ||
          targetIssue.ownerKind !== "agent" ||
          !targetIssue.ownerAgentId ||
          !targetIssue.request
        ) {
          throw new RuntimeIssueActionDenied(
            "Target is not an exact direct issue of this creator execution",
            "creator_authority_mismatch",
          );
        }
        if (
          targetSession.integrityState !== "ready" ||
          targetSession.refAdmittableAt === null ||
          targetSession.timeArchived !== null ||
          targetSession.purgeFencedAt !== null
        ) {
          throw new RuntimeIssueActionConflict(
            "Target issue Session is lifecycle-fenced",
          );
        }
        const targetRevisionId = await assertTargetAdapterRevision(
          tx,
          input.capability.companyId,
          targetAgentId,
        );
        const outgoingAuthority = await tx
          .select()
          .from(issueExecutionAuthorities)
          .where(
            and(
              eq(issueExecutionAuthorities.companyId, input.capability.companyId),
              eq(issueExecutionAuthorities.issueId, targetIssue.id),
              eq(
                issueExecutionAuthorities.ownershipEpoch,
                targetIssue.ownershipEpoch,
              ),
              eq(issueExecutionAuthorities.agentId, targetIssue.ownerAgentId),
              eq(issueExecutionAuthorities.state, "current"),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!outgoingAuthority) {
          throw new RuntimeIssueActionConflict(
            "Target issue has no current outgoing owner authority",
          );
        }
        const revocation =
          await revokeOutgoingOwnershipEpoch(
            tx,
            sessionAdmission,
            options.issueExecutionCancellation,
            {
              companyId: input.capability.companyId,
              issueId: targetIssue.id,
              sessionId: targetSession.id,
              ownershipEpoch: targetIssue.ownershipEpoch,
              authorityId: outgoingAuthority.id,
              sourceAuthorityId:
                input.capability.issueExecutionAuthorityId,
              triggeringRunId: input.capability.runId,
              cancellationActor: {
                kind: "agent",
                agentId: input.capability.targetAgentId,
              },
              now,
            },
          );

        const ownershipEpoch = targetIssue.ownershipEpoch + 1;
        const authorityId = deterministicUuid(
          "issue-execution-authority",
          `${targetIssue.id}:${ownershipEpoch}:${targetAgentId}`,
        );
        const reassigned = await tx
          .update(issues)
          .set({
            ownerKind: "agent",
            ownerAgentId: targetAgentId,
            ownerUserId: null,
            ownerAssignmentSource: null,
            ownershipEpoch,
            updatedAt: now,
          })
          .where(
            and(
              eq(issues.companyId, input.capability.companyId),
              eq(issues.id, targetIssue.id),
              eq(issues.ownershipEpoch, targetIssue.ownershipEpoch),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!reassigned) {
          throw new RuntimeIssueActionConflict(
            "Target ownership epoch changed during reassignment",
          );
        }
        const workspaceReservation =
          await withRuntimeWorkspaceReservationErrors(() =>
            reserveIssueExecutionWorkspaceBinding(tx, {
              issue: reassigned,
              session: {
                id: targetSession.id,
                now,
              },
              provenance: {
                agentId: input.capability.targetAgentId,
                userId: null,
              },
            }),
          );
        await tx.insert(issueExecutionAuthorities).values({
          id: authorityId,
          companyId: reassigned.companyId,
          issueId: reassigned.id,
          sessionId: targetSession.id,
          ownershipEpoch,
          agentId: targetAgentId,
          auditAdapterConfigRevisionId: targetRevisionId,
          state: "current",
          createdAt: now,
        });
        const edge = await insertCreatorEdge(tx, reassigned, now);
        const admission = await mentionAgentInTransaction(
          sessionAdmission,
          tx,
          {
            companyId: reassigned.companyId,
            issueId: reassigned.id,
            sessionId: targetSession.id,
            ownershipEpoch,
            targetAgentId,
            issueExecutionAuthorityId: authorityId,
            consultExecutionId: null,
            adapterConfigRevisionId: targetRevisionId,
            contextEpoch: workspaceReservation.contextEpochGeneration,
            mode: "owner",
            counterpartIssueId: input.capability.issueId,
            counterpartAuthorityId: input.capability.issueExecutionAuthorityId,
            counterpartOwnershipEpoch: input.capability.ownershipEpoch,
            sourceKind: "issue_reassignment",
            actor: executionActorForCapability(input.capability),
            previousOwnershipEpoch: targetIssue.ownershipEpoch,
            immutableSourceKey: key,
            sourceRecordId: reassigned.id,
            prompt: {
              toolName: "issue_assign",
              arguments: {
                issueId: input.issueId,
                owner: input.owner,
              },
              context: {
                issue: reassigned,
                from: messageAgent(
                  authorized.companyAgents,
                  input.capability.targetAgentId,
                ),
                owner: messageAgent(authorized.companyAgents, targetAgentId),
                status: targetIssue.lifecycleStatus,
                request: reassigned.request!,
              },
            },
            comment: {
              author: {
                kind: "agent",
                agentId: input.capability.targetAgentId,
              },
              producingRun: {
                runId: input.capability.runId,
                adapterConfigRevisionId:
                  input.capability.adapterConfigIdentity,
              },
            },
            idempotencyKey: key,
          },
        );
        if (!admission.ref) {
          throw new RuntimeIssueActionConflict(
            "issue_assign did not reserve the new owner ref",
          );
        }
        return {
          issue: reassigned,
          authorityId,
          creatorEdgeId: edge.id,
          ref: admission.ref,
          comment: admission.comment,
          escalationDispatchRefIds:
            revocation.escalationDispatchRefIds,
          cancellations: revocation.cancellations,
          retried: false,
        };
      });
      if (committed.cancellations) {
        await options.issueExecutionCancellation
          .reconcileRequestedScopeCancellations(
            committed.cancellations,
          );
      }
      for (const refId of committed.escalationDispatchRefIds) {
        await options.dispatchPersistedRef(refId);
      }
      await options.dispatchPersistedRef(committed.ref.id);
      return committed;
    },

    async update(input) {
      const authority = {
        kind: "agent-execution" as const,
        capability: input.capability,
        invocationId: input.invocationId,
      };
      // `issueId` is deliberately a relationship selector, not a generic
      // issue mutation target. The underlying creator form re-proves exact
      // parent/creator authority in the same transaction.
      if (input.issueId === undefined) {
        const ownerUpdate = {
          message: input.message,
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(Object.hasOwn(input, "structuredResult")
            ? { structuredResult: input.structuredResult }
            : {}),
        } as CanonicalOwnerFormUpdate;
        return issueForms.commitOwnerFormUpdate(
          input.capability.issueId,
          ownerUpdate,
          authority,
        );
      }
      const creatorUpdate = {
        message: input.message,
        ...(input.status === undefined ? {} : { status: input.status }),
      } as CanonicalCreatorFormUpdate;
      return issueForms.commitCreatorFormUpdate(
        input.issueId,
        creatorUpdate,
        authority,
      );
    },

    async mentionBoard(input) {
      const key = runtimeInvocationKey(
        "mention-board",
        promptCapabilityGenerationIdentity(input.capability),
        input.invocationId,
      );
      const committed = await db.transaction(async (tx) => {
        const now = clock();
        await lockRuntimeActionAuthority(
          tx,
          input.capability,
          "mention_board",
          now,
          { requireOwner: false },
        );
        const admission = await mentionBoardInTransaction(
          sessionAdmission,
          tx,
          {
            companyId: input.capability.companyId,
            target: {
              issueId: input.capability.issueId,
              sessionId: input.capability.sessionId,
              ownershipEpoch: input.capability.ownershipEpoch,
            },
            actor: executionActorForCapability(input.capability),
            comment: {
              author: {
                kind: "agent",
                agentId: input.capability.targetAgentId,
              },
              producingRun: {
                runId: input.capability.runId,
                adapterConfigRevisionId: input.capability.adapterConfigIdentity,
              },
            },
            sourceKind: "mention_board",
            immutableSourceKey: key,
            sourceRecordId: deterministicUuid("issue-board-mention", key),
            message: input.message,
          },
        );
        return input.commitMentionAction(tx, {
          accepted: true,
          id: admission.boardMention.id,
          commentId: admission.boardMention.commentId,
          retried: admission.retried,
        });
      });
      return committed;
    },

    async listAgents(input) {
      const key = runtimeInvocationKey(
        "list-agents",
        promptCapabilityGenerationIdentity(input.capability),
        input.invocationId,
      );
      return db.transaction(async (tx) => {
        const now = clock();
        await lockRuntimeActionAuthority(
          tx,
          input.capability,
          "list_agents",
          now,
          { requireOwner: false },
        );
        const rows = await tx
          .select({
            id: agents.id,
            name: agents.name,
            title: agents.title,
            capabilities: agents.capabilities,
            status: agents.status,
            reportsTo: agents.reportsTo,
          })
          .from(agents)
          .where(
            and(
              eq(agents.companyId, input.capability.companyId),
              or(
                eq(agents.status, "active"),
                eq(agents.status, "idle"),
                eq(agents.status, "running"),
                eq(agents.status, "paused"),
                eq(agents.status, "pending_approval"),
              ),
            ),
          )
          .orderBy(asc(agents.name));
        return {
          agents: rows.map((row) => ({
            id: row.id,
            name: row.name,
            title: row.title,
            capabilities: row.capabilities,
            status: row.status,
            reportsTo: row.reportsTo,
          })),
        };
      });
    },

    async mention(input) {
      if (
        input.runInterfaceToolCallId.length === 0 ||
        input.runInterfaceToolCallId !== input.runInterfaceToolCallId.trim() ||
        !isUuidLike(input.runInterfaceToolCallId)
      ) {
        throw new RuntimeIssueActionConflict(
          "Mention admission requires its exact run-interface tool-call identity",
        );
      }
      if (
        !Number.isSafeInteger(input.ingressOrdinal) ||
        input.ingressOrdinal < 0
      ) {
        throw new RuntimeIssueActionConflict(
          "Mention admission requires its immutable nonnegative ingress ordinal",
        );
      }
      const key = `${runtimeInvocationKey(
        "mention",
        promptCapabilityGenerationIdentity(input.capability),
        input.invocationId,
      )}:tool-call:${input.runInterfaceToolCallId}:ingress:${input.ingressOrdinal}`;
      const committed = await db.transaction(async (tx) => {
          const now = clock();
          await lockRuntimeActionHierarchy(tx, input.capability, now, {
            additionalLaneTargetAgentId: input.targetAgentId,
          });
          const priorEvent = await tx
            .select()
            .from(issueSessionEvents)
            .where(
              and(
                eq(issueSessionEvents.companyId, input.capability.companyId),
                eq(issueSessionEvents.issueId, input.capability.issueId),
                eq(issueSessionEvents.sessionId, input.capability.sessionId),
                eq(
                  issueSessionEvents.ownershipEpoch,
                  input.capability.ownershipEpoch,
                ),
                eq(issueSessionEvents.sourceKind, "consult_mention"),
                eq(issueSessionEvents.immutableSourceKey, key),
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (priorEvent) {
            const priorRef = await tx
              .select()
              .from(issueExecutionRefs)
              .where(
                and(
                  eq(issueExecutionRefs.companyId, input.capability.companyId),
                  eq(issueExecutionRefs.issueId, input.capability.issueId),
                  eq(issueExecutionRefs.sessionId, input.capability.sessionId),
                  eq(
                    issueExecutionRefs.ownershipEpoch,
                    input.capability.ownershipEpoch,
                  ),
                  eq(issueExecutionRefs.sourceId, priorEvent.sourceId!),
                ),
              )
              .limit(1)
              .for("update")
              .then((rows) => rows[0] ?? null);
            const consult = priorRef?.consultExecutionId
              ? await tx
                  .select()
                  .from(issueConsultExecutions)
                  .where(
                    eq(
                      issueConsultExecutions.id,
                      priorRef.consultExecutionId,
                    ),
                  )
                  .limit(1)
                  .for("update")
                  .then((rows) => rows[0] ?? null)
              : null;
            if (
              !priorRef ||
              priorRef.mode !== "consult" ||
              priorRef.sourceKind !== "consult_mention" ||
              priorRef.consultCallerRefId !== input.capability.refId ||
              priorRef.targetAgentId !== input.targetAgentId ||
              !paperclipEnvelopeHasBody(
                priorRef.exactMessage,
                "[Paperclip agent message]",
                input.message,
              ) ||
              !consult ||
              consult.state !== "active" ||
              consult.sourceRunId !== input.capability.runId ||
              consult.sourceRefId !== input.capability.refId ||
              consult.targetAgentId !== input.targetAgentId ||
              priorEvent.sourceRecordId !== consult.id
            ) {
              throw new RuntimeIssueActionConflict(
                "mention invocation was retried with different immutable arguments",
              );
            }
            return input.commitMentionAction(tx, {
              accepted: true,
              consultExecutionId: consult.id,
              refId: priorRef.id,
              commentId: null,
              retried: true,
            });
          }

          const authorized = await lockRuntimeActionAuthority(
            tx,
            input.capability,
            "mention_agent",
            now,
            {
              requireOwner: false,
              additionalLaneTargetAgentId: input.targetAgentId,
              hierarchyAlreadyLocked: true,
            },
          );
          if (
            !authorized.catalog.mentionTargets.some(
              (candidate) => candidate.id === input.targetAgentId,
            )
          ) {
            throw new RuntimeIssueActionDenied(
              "Mention target is no longer in the current reach catalog",
              "mention_catalog_changed",
            );
          }
          const targetRevisionId = await assertTargetAdapterRevision(
            tx,
            input.capability.companyId,
            input.targetAgentId,
          );
          let chain;
          try {
            chain = await lockAndValidateIssueConsultChain(tx, {
              ref: authorized.ref,
              requireLiveAncestors: false,
              leafState: "active",
            });
          } catch (error) {
            if (error instanceof IssueConsultChainInvalid) {
              throw new RuntimeIssueActionDenied(
                error.message,
                error.reason === "cycle"
                  ? "mention_chain_cycle"
                  : "mention_chain_invalid",
              );
            }
            throw error;
          }
          if (chain.agentIds.has(input.targetAgentId)) {
            throw new RuntimeIssueActionDenied(
              "Mention target would loop within its active mention chain",
              "mention_chain_loop",
            );
          }

          const consultId = deterministicUuid("issue-consult", key);
          const consult = await tx
            .insert(issueConsultExecutions)
            .values({
              id: consultId,
              companyId: input.capability.companyId,
              issueId: input.capability.issueId,
              sessionId: input.capability.sessionId,
              ownershipEpoch: input.capability.ownershipEpoch,
              sourceRunId: input.capability.runId,
              sourceRefId: input.capability.refId,
              callerExecutionScopeId: authorized.ref.executionScopeId,
              targetAgentId: input.targetAgentId,
              adapterConfigRevisionId: targetRevisionId,
              chainToken: chain.chainToken,
              state: "active",
              createdAt: now,
            })
            .returning()
            .then((rows) => rows[0] ?? null);
          if (!consult) {
            throw new RuntimeIssueActionConflict(
              "Mention execution binding was not persisted",
            );
          }
          const admission = await mentionAgentInTransaction(
            sessionAdmission,
            tx,
            {
              companyId: input.capability.companyId,
              issueId: input.capability.issueId,
              sessionId: input.capability.sessionId,
              ownershipEpoch: input.capability.ownershipEpoch,
              targetAgentId: input.targetAgentId,
              issueExecutionAuthorityId: null,
              consultExecutionId: consult.id,
              adapterConfigRevisionId: targetRevisionId,
              contextEpoch: authorized.contextGeneration,
              mode: "consult",
              executionLineageId: authorized.ref.executionLineageId,
              consultCallerRefId: authorized.ref.id,
              consultChainToken: chain.chainToken,
              sourceKind: "consult_mention",
              actor: executionActorForCapability(input.capability),
              immutableSourceKey: key,
              sourceRecordId: consult.id,
              prompt: {
                toolName: "mention_agent",
                arguments: {
                  agentId: input.targetAgentId,
                  message: input.message,
                },
                context: {
                  issue: authorized.issue,
                  from: messageAgent(
                    authorized.companyAgents,
                    input.capability.targetAgentId,
                  ),
                },
              },
              comment: {
                author: {
                  kind: "agent",
                  agentId: input.capability.targetAgentId,
                },
                producingRun: {
                  runId: input.capability.runId,
                  adapterConfigRevisionId:
                    input.capability.adapterConfigIdentity,
                },
              },
              idempotencyKey: key,
            },
          );
          if (!admission.ref || !admission.comment) {
            throw new RuntimeIssueActionConflict(
              "Mention did not reserve its canonical ref and comment",
            );
          }
          await recordIssueLivenessActionInTransaction(
            tx,
            `issue_execution_ref:${admission.ref.id}`,
          );
          return input.commitMentionAction(tx, {
            accepted: true,
            consultExecutionId: consult.id,
            refId: admission.ref.id,
            commentId: admission.comment.id,
            retried: false,
          });
      });
      await options.dispatchPersistedRef(committed.refId);
      return committed;
    },
  };
}
