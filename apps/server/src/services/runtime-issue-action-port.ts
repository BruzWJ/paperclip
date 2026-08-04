import { createHash } from "node:crypto";
import {
  agentActionGrants,
  agents,
  companies,
  creatorDeliveries,
  instanceSettings,
  issueComments,
  issueBoardMentions,
  issueCommentProjectionSources,
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
  type IssueExecutionRef,
  type PaperclipActionKey,
  isUuidLike,
  normalizeContextAccess,
} from "@paperclipai/shared";
import { and, asc, desc, eq, inArray, max, sql } from "drizzle-orm";
import {
  evaluateAgentInvokability,
  InvokableIssueOwnerRejected,
  resolveInvokableIssueOwnerInTransaction,
} from "./agent-invokability.js";
import {
  createIssueSessionAdmissionService,
  type IssueSessionAdmissionResult,
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
  type RuntimeInterfaceCompileInput,
} from "./runtime-interface-compiler.js";
import {
  promptCapabilityGenerationIdentity,
  type PromptCapabilityBinding,
} from "./prompt-capability-gateway.js";
import { lockActivePromptCapabilityBinding } from "./prompt-capability-gateway-postgres.js";
import {
  RuntimeToolArgumentsInvalid,
  type RuntimeActionInvocation,
} from "./runtime-tool-executor.js";
import { enqueueCreatorDelivery } from "./creator-delivery-enqueue.js";
import { terminalizeCreatorEdgeInTransaction } from "./system-escalation-postgres.js";
import type {
  IssueExecutionCancellationActor,
  IssueExecutionCancellationService,
  RequestedScopedRunCancellations,
} from "./issue-execution-cancellation.js";
import {
  projectPersistedIssueExecutionRef,
} from "./issue-execution-dispatcher-postgres.js";
import {
  IssueConsultChainInvalid,
  lockAndValidateIssueConsultChain,
} from "./issue-consult-chain-postgres.js";
import type {
  IssueExecutionRunService,
} from "./issue-execution-run-service.js";
import type {
  IssueExecutionSteeringResultBroker,
} from "./issue-execution-steering-results.js";
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
import { parseIssueExecutionWorkspaceSettings } from "./execution-workspace-policy.js";
import {
  resolvePluginPermittedIssueOwnerCatalogInTransaction,
} from "./plugin-issue-authorization.js";
import { recordIssueLivenessActionInTransaction } from "./issue-liveness-reconciliation.js";

const CREATE_KEYS = [
  "request",
  "title",
  "priority",
  "owner",
  "contextAccessMask",
] as const;
const ASSIGN_KEYS = ["issueId", "owner"] as const;
const OWNER_MESSAGE_KEYS = ["form", "message"] as const;
const OWNER_UPDATE_KEYS = ["form", "status", "message"] as const;
const TERMINAL_OWNER_UPDATE_KEYS = [
  "form",
  "status",
  "message",
  "structuredResult",
] as const;
const CREATOR_UPDATE_KEYS = [
  "form",
  "creatorTargetIssueId",
  "message",
] as const;
const BOARD_MENTION_KEYS = ["message", "reason"] as const;
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

export type RuntimeIssueOwnerUpdateInput =
  | (RuntimeIssueOwnerUpdateBase & {
      status?: undefined;
      structuredResult?: never;
    })
  | (RuntimeIssueOwnerUpdateBase & {
      status: "open" | "blocked";
      structuredResult?: never;
    })
  | (RuntimeIssueOwnerUpdateBase & {
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
  updateOwner(input: RuntimeIssueOwnerUpdateInput): Promise<unknown>;
  updateCreator(input: {
    capability: RuntimeActionInvocation["capability"];
    invocationId: string;
    creatorTargetIssueId: string;
    message: string;
  }): Promise<unknown>;
  mention(input: {
    capability: RuntimeActionInvocation["capability"];
    invocationId: string;
    runInterfaceToolCallId: string;
    ingressOrdinal: number;
    withMentionAdmission<T>(
      targetAgentId: string,
      prepare: () => Promise<T>,
    ): Promise<T>;
    targetAgentId: string;
    message: string;
    mentionRunId?: string;
  }): Promise<unknown>;
  mentionBoard(input: {
    capability: RuntimeActionInvocation["capability"];
    invocationId: string;
    message: string;
    reason?: string;
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

export interface RuntimeMentionExecutionInput {
  companyId: string;
  issueId: string;
  sessionId: string;
  ownershipEpoch: number;
  consultExecutionId: string;
  sourceRunId: string;
  sourceRefId: string;
  targetAgentId: string;
  adapterConfigRevisionId: string;
  chainToken: string;
  ref: IssueExecutionRef;
}

export interface RuntimeMentionExecutionResult {
  runId: string;
  response: string;
}

export type RuntimeIssueScopeCancellationPort = Pick<
  IssueExecutionCancellationService,
  | "requestScopeCancellationsInTransaction"
  | "reconcileRequestedScopeCancellations"
>;

export type RuntimeIssueRunPort = Pick<
  IssueExecutionRunService,
  | "readRun"
  | "lockRun"
  | "requestSteeringInTransaction"
  | "continuePendingSteeringForSource"
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
  /**
   * Gives a committed creator-delivery intent an immediate pass through the
   * durable outbox worker. Producer code never schedules its counterpart ref
   * directly.
   */
  notifyCreatorDelivery(deliveryId: string): Promise<void>;
  /**
   * Runs the nested consult ref synchronously in the caller's active drain.
   * The executor owns provider launch/stream normalization and must return the
   * durable nested productive run id with the exact normalized final bytes.
   */
  executeMention(
    input: RuntimeMentionExecutionInput,
  ): Promise<RuntimeMentionExecutionResult>;
  /** Canonical transactional authority fence plus post-commit cancellation. */
  issueExecutionCancellation: RuntimeIssueScopeCancellationPort;
  /** Canonical run/steering authority; production action code never owns runs. */
  runService: RuntimeIssueRunPort;
  /** Worker-local synchronous result rendezvous for selector-bearing mentions. */
  issueExecutionSteeringResults: Pick<
    IssueExecutionSteeringResultBroker,
    "expect"
  >;
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

const DELIVERY_STATE_POLICY_ERROR =
  "Instance creator-delivery policy must be configured before issue updates";

async function lockIssueSessionState(
  tx: IssueSessionDbTransaction,
  companyId: string,
  issueId: string,
): Promise<{
  session: SessionRow;
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
    | "mention-board",
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

function issueRequestsWorkspaceReuse(
  issue: typeof issues.$inferSelect,
): boolean {
  return (
    issue.executionWorkspacePreference === "reuse_existing" ||
    parseIssueExecutionWorkspaceSettings(issue.executionWorkspaceSettings)
      ?.mode === "reuse_existing"
  );
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

function assertIssueNonterminal(issue: IssueRow): void {
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
  const issueRows = await tx
    .select({ id: issues.id })
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

async function lockRuntimeActionAuthority(
  tx: IssueSessionDbTransaction,
  capability: RuntimeActionInvocation["capability"],
  action: PaperclipActionKey,
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

  const grantRows = await tx
    .select({ id: agentActionGrants.id })
    .from(agentActionGrants)
    .where(
      and(
        eq(agentActionGrants.companyId, capability.companyId),
        eq(agentActionGrants.agentId, capability.targetAgentId),
        eq(agentActionGrants.key, action),
      ),
    )
    .for("update");
  if (grantRows.length !== 1) {
    throw new RuntimeIssueActionDenied(
      `Current run no longer has ${action}`,
      "action_grant_missing",
    );
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
  if (catalog.actionGrants[action] !== true) {
    throw new RuntimeIssueActionDenied(
      `Current runtime catalog no longer grants ${action}`,
      "action_grant_missing",
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

export async function loadWorkspaceBinding(
  tx: IssueSessionDbTransaction,
  input: {
    companyId: string;
    issueId: string;
    ownershipEpoch: number;
  },
) {
  await tx.execute(sql`
    SELECT id
    FROM issue_execution_workspace_bindings
    WHERE company_id = ${input.companyId}
      AND issue_id = ${input.issueId}
      AND ownership_epoch = ${input.ownershipEpoch}
    FOR UPDATE
  `);
  const binding = await tx
    .select()
    .from(issueExecutionWorkspaceBindings)
    .where(
      and(
        eq(issueExecutionWorkspaceBindings.companyId, input.companyId),
        eq(issueExecutionWorkspaceBindings.issueId, input.issueId),
        eq(
          issueExecutionWorkspaceBindings.ownershipEpoch,
          input.ownershipEpoch,
        ),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!binding) {
    throw new RuntimeIssueActionConflict(
      "The source issue execution has no immutable workspace binding",
    );
  }
  return binding;
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

async function loadCreatorDeliveryPolicy(tx: IssueSessionDbTransaction) {
  const row = await tx
    .select({ policy: instanceSettings.creatorDelivery })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, "default"))
    .for("share")
    .then((rows) => rows[0] ?? null);
  if (!row?.policy) {
    throw new RuntimeIssueActionConflict(DELIVERY_STATE_POLICY_ERROR);
  }
  return row.policy;
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
  const [comment, delivery] = await Promise.all([
    tx
      .select()
      .from(issueComments)
      .where(eq(issueComments.id, update.commentId))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    tx
      .select()
      .from(creatorDeliveries)
      .where(eq(creatorDeliveries.issueUpdateId, update.id))
      .limit(1)
      .then((rows) => rows[0] ?? null),
  ]);
  if (!comment || !delivery) {
    throw new RuntimeIssueActionConflict(
      "Accepted issue update is missing its comment or delivery ledger",
    );
  }
  const ref = delivery.counterpartRefId
    ? await tx
        .select()
        .from(issueExecutionRefs)
        .where(
          and(
            eq(issueExecutionRefs.companyId, companyId),
            eq(issueExecutionRefs.id, delivery.counterpartRefId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null)
    : null;
  if (delivery.counterpartRefId && !ref) {
    throw new RuntimeIssueActionConflict(
      "Accepted issue update is missing its counterpart ref",
    );
  }
  return { update, comment, delivery, ref, retried: true as const };
}

export type CanonicalOwnerFormUpdate =
  | {
      message: string;
      status?: undefined;
      structuredResult?: never;
    }
  | {
      message: string;
      status: "open" | "blocked";
      structuredResult?: never;
    }
  | {
      message: string;
      status: "done" | "cancelled";
      structuredResult?: unknown;
    };

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
  notifyCreatorDelivery(deliveryId: string): Promise<void>;
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
  if (!capability.issueExecutionAuthorityId) {
    throw new RuntimeIssueActionConflict(
      "Agent harness delivery requires immutable execution authority",
    );
  }
  return {
    kind: "agent-execution",
    agentId: capability.targetAgentId,
    authorityId: capability.issueExecutionAuthorityId,
  };
}

function creatorExecutionActor(
  authority: CanonicalCreatorFormAuthority,
): IssueSessionExecutionActor {
  switch (authority.kind) {
    case "agent-execution":
      return executionActorForCapability(authority.capability);
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

function ownerRecipient(issue: IssueRow): {
  recipientKind: "agent-execution" | "user/board";
  recipientRef: Record<string, unknown>;
} {
  if (issue.ownerKind === "user" && issue.ownerUserId) {
    return {
      recipientKind: "user/board",
      recipientRef: {
        userId: issue.ownerUserId,
        recipient: "named-user",
      },
    };
  }
  if (issue.ownerKind === "board") {
    return {
      recipientKind: "user/board",
      recipientRef: {
        userId: null,
        recipient: "company-board",
      },
    };
  }
  throw new RuntimeIssueActionConflict(
    "Creator-form owner recipient is invalid",
  );
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
        return retry;
      }

      if (input.status === undefined) {
        assertIssueNonterminal(issue);
      } else {
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
      const policy = await loadCreatorDeliveryPolicy(tx);
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
      const admission =
        ownerAuthority.kind === "agent-execution"
          ? await sessionAdmission.appendNonDispatchSyntheticComment(
              {
                companyId,
                issueId: issue.id,
                sessionId: ownerAuthority.capability.sessionId,
                sourceKind: "issue_update",
                immutableSourceKey: gatewayInvocationId,
                sourceRecordId: updateId,
                exactText: input.message,
                projectionKind: "issue_update",
                ownershipEpoch: ownerAuthority.capability.ownershipEpoch,
                agentId: ownerAuthority.capability.targetAgentId,
                adapterConfigRevisionId:
                  ownerAuthority.capability.adapterConfigIdentity,
                runId: ownerAuthority.capability.runId,
                comment: {
                  author: {
                    kind: "agent",
                    agentId: ownerAuthority.capability.targetAgentId,
                  },
                  producingRun: {
                    runId: ownerAuthority.capability.runId,
                    adapterConfigRevisionId:
                      ownerAuthority.capability.adapterConfigIdentity,
                  },
                },
              },
              tx,
            )
          : await sessionAdmission.appendNonDispatchControlNotice(
              {
                companyId,
                issueId: issue.id,
                sessionId: humanSessionState!.session.id,
                sourceKind: "issue_update",
                immutableSourceKey: gatewayInvocationId,
                sourceRecordId: updateId,
                exactText: input.message,
                comment: source.comment,
              },
              tx,
            );
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
          sessionId: admission.comment.sessionId,
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
      const delivery = await enqueueCreatorDelivery(tx, {
        update,
        edge,
        recipientKind: edge.endpointKind,
        recipientRef: {
          endpointId: edge.endpointId,
          ...edge.endpointSnapshot,
        },
        counterpartRefId: null,
        policy,
        now,
      });
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
      await recordIssueLivenessActionInTransaction(
        tx,
        `issue_update:${update.id}`,
      );
      return {
        issue: updatedIssue,
        update,
        comment: admission.comment,
        delivery,
        gated,
        retried: false as const,
      };
    });
    await options.notifyCreatorDelivery(committed.delivery.id);
    return committed;
  }

  async function commitCreatorFormUpdate(
    issueId: string,
    message: string,
    creatorAuthority: CanonicalCreatorFormAuthority,
  ) {
    if (!message.trim()) {
      throw new RuntimeIssueActionConflict(
        "Creator-form issue_update requires a non-empty message",
      );
    }
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
            "Target is no longer in the caller's creator-message catalog",
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
          "Creator-message target no longer exists",
          "target_issue_missing",
        );
      }
      assertIssueNonterminal(issue);
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
          "Creator-message authority does not match the immutable target creator",
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
          "Creator-message target has no canonical Session",
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
          retry.update.status !== null ||
          retry.update.disposition !== null
        ) {
          throw new RuntimeIssueActionConflict(
            "creator issue_update invocation was retried with different immutable arguments",
          );
        }
        return retry;
      }

      let admission: IssueSessionAdmissionResult;
      let recipient:
        | {
            recipientKind: "agent-execution";
            recipientRef: Record<string, unknown>;
          }
        | ReturnType<typeof ownerRecipient>;
      if (
        issue.ownerKind === "agent" &&
        issue.ownerAgentId
      ) {
        const targetRevisionId = await assertTargetAdapterRevision(
          tx,
          companyId,
          issue.ownerAgentId,
        );
        const targetAuthority = await tx
          .select()
          .from(issueExecutionAuthorities)
          .where(
            and(
              eq(issueExecutionAuthorities.companyId, companyId),
              eq(issueExecutionAuthorities.issueId, issue.id),
              eq(
                issueExecutionAuthorities.ownershipEpoch,
                issue.ownershipEpoch,
              ),
              eq(issueExecutionAuthorities.agentId, issue.ownerAgentId),
              eq(issueExecutionAuthorities.state, "current"),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!targetAuthority) {
          throw new RuntimeIssueActionConflict(
            "Creator-message target has no current owner authority",
          );
        }
        const directInput = {
          companyId,
          issueId: issue.id,
          sessionId: sessionState.session.id,
          ownershipEpoch: issue.ownershipEpoch,
          targetAgentId: issue.ownerAgentId,
          issueExecutionAuthorityId: targetAuthority.id,
          consultExecutionId: null,
          adapterConfigRevisionId: targetRevisionId,
          contextEpoch: sessionState.contextGeneration,
          mode: "owner" as const,
          counterpartIssueId:
            creatorAuthority.kind === "agent-execution"
              ? creatorAuthority.capability.issueId
              : null,
          counterpartAuthorityId: source.sourceAuthorityId,
          counterpartOwnershipEpoch:
            creatorAuthority.kind === "agent-execution"
              ? creatorAuthority.capability.ownershipEpoch
              : null,
          sourceKind: "creator_update" as const,
          immutableSourceKey: gatewayInvocationId,
          sourceRecordId: deterministicUuid(
            "issue-update",
            gatewayInvocationId,
          ),
          exactText: message,
          actor: creatorExecutionActor(creatorAuthority),
          comment: source.comment,
          idempotencyKey: gatewayInvocationId,
        };
        admission = await sessionAdmission.admitExecutionSource(
          directInput,
          tx,
        );
        if (!admission.ref) {
          throw new RuntimeIssueActionConflict(
            "Creator message did not reserve its owner ref",
          );
        }
        recipient = {
          recipientKind: "agent-execution",
          recipientRef: {
            authorityId: targetAuthority.id,
            agentId: issue.ownerAgentId,
            issueId: issue.id,
            sessionId: sessionState.session.id,
            ownershipEpoch: issue.ownershipEpoch,
            adapterConfigRevisionId: targetRevisionId,
          },
        };
      } else {
        admission =
          await sessionAdmission.appendNonDispatchControlNotice(
            {
              companyId,
              issueId: issue.id,
              sessionId: sessionState.session.id,
              sourceKind: "issue_update",
              immutableSourceKey: gatewayInvocationId,
              sourceRecordId: deterministicUuid(
                "issue-update",
                gatewayInvocationId,
              ),
              exactText: message,
              comment: source.comment,
            },
            tx,
          );
        recipient = ownerRecipient(issue);
      }
      if (!admission.comment) {
        throw new RuntimeIssueActionConflict(
          "Creator message did not persist its comment-of-record",
        );
      }
      const policy = await loadCreatorDeliveryPolicy(tx);
      const runSequence =
        source.runId === null
          ? 0
          : await nextRunUpdateSequence(tx, companyId, source.runId);
      const updateId = deterministicUuid(
        "issue-update",
        gatewayInvocationId,
      );
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
          status: null,
          disposition: null,
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
      const delivery = await enqueueCreatorDelivery(tx, {
        update,
        edge,
        recipientKind: recipient.recipientKind,
        recipientRef: recipient.recipientRef,
        counterpartRefId: admission.ref?.id ?? null,
        policy,
        now,
      });
      await recordIssueLivenessActionInTransaction(
        tx,
        `issue_update:${update.id}`,
      );
      return {
        issue,
        update,
        comment: admission.comment,
        delivery,
        ref: admission.ref,
        retried: false as const,
      };
    });
    await options.notifyCreatorDelivery(committed.delivery.id);
    return committed;
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
      const form = input.arguments.form;
      if (form === "owner") {
        if (!Object.hasOwn(input.arguments, "status")) {
          exactKeys(input.arguments, OWNER_MESSAGE_KEYS);
          return service.updateOwner({
            capability: input.capability,
            invocationId: input.invocationId,
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
        exactKeys(
          input.arguments,
          terminal ? TERMINAL_OWNER_UPDATE_KEYS : OWNER_UPDATE_KEYS,
        );
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
          return service.updateOwner({
            capability: input.capability,
            invocationId: input.invocationId,
            status: status as "done" | "cancelled",
            message: requiredString(input.arguments.message, "message"),
            ...(Object.hasOwn(input.arguments, "structuredResult")
              ? { structuredResult: input.arguments.structuredResult }
              : {}),
          });
        }
        return service.updateOwner({
          capability: input.capability,
          invocationId: input.invocationId,
          status: status as "open" | "blocked",
          message: requiredString(input.arguments.message, "message"),
        });
      }
      if (form === "creator_message") {
        exactKeys(input.arguments, CREATOR_UPDATE_KEYS);
        return service.updateCreator({
          capability: input.capability,
          invocationId: input.invocationId,
          creatorTargetIssueId: requiredString(
            input.arguments.creatorTargetIssueId,
            "creatorTargetIssueId",
          ),
          message: requiredString(input.arguments.message, "message"),
        });
      }
      throw new RuntimeToolArgumentsInvalid(
        "form must be owner or creator_message",
      );
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
        withMentionAdmission: input.withMentionAdmission,
        targetAgentId: mention.agentId,
        message: mention.message,
        ...(mention.mentionRunId === undefined
          ? {}
          : { mentionRunId: mention.mentionRunId }),
      });
    },

    async mentionBoard(input) {
      assertOwnerExecution(input);
      exactKeys(input.arguments, BOARD_MENTION_KEYS);
      return service.mentionBoard({
        capability: input.capability,
        invocationId: input.invocationId,
        message: nonBlankString(input.arguments.message, "message"),
        reason:
          input.arguments.reason === undefined
            ? undefined
            : nonBlankString(input.arguments.reason, "reason"),
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
    notifyCreatorDelivery: options.notifyCreatorDelivery,
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
              projectWorkspaceId: authorized.issue.projectWorkspaceId,
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
              executionWorkspacePreference: null,
              executionWorkspaceSettings: null,
              createdAt: now,
              updatedAt: now,
            },
            session: {
              id: sessionId,
              parentSessionId: input.capability.sessionId,
              now,
            },
            workspaceReservation: {
              explicitReusableWorkspaceId: null,
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
        const admission = await sessionAdmission.admitExecutionSource(
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
            exactText: input.request,
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
          tx,
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
            priorRef.exactMessage !== targetIssue.request
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
        const explicitReusableWorkspaceId = issueRequestsWorkspaceReuse(
          targetIssue,
        )
          ? (
              await loadWorkspaceBinding(tx, {
                companyId: input.capability.companyId,
                issueId: targetIssue.id,
                ownershipEpoch: targetIssue.ownershipEpoch,
              })
            ).executionWorkspaceId
          : null;
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
              explicitReusableWorkspaceId,
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
        const admission = await sessionAdmission.admitExecutionSource(
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
            exactText: reassigned.request!,
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
          tx,
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

    async updateOwner(input) {
      return issueForms.commitOwnerFormUpdate(
        input.capability.issueId,
        {
          message: input.message,
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(Object.hasOwn(input, "structuredResult")
            ? { structuredResult: input.structuredResult }
            : {}),
        } as CanonicalOwnerFormUpdate,
        {
          kind: "agent-execution",
          capability: input.capability,
          invocationId: input.invocationId,
        },
      );
    },

    async updateCreator(input) {
      return issueForms.commitCreatorFormUpdate(
        input.creatorTargetIssueId,
        input.message,
        {
          kind: "agent-execution",
          capability: input.capability,
          invocationId: input.invocationId,
        },
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
          { requireOwner: true },
        );
        const mentionId = deterministicUuid("issue-board-mention", key);
        const admission = await sessionAdmission.appendNonDispatchSyntheticComment(
          {
            companyId: input.capability.companyId,
            issueId: input.capability.issueId,
            sessionId: input.capability.sessionId,
            sourceKind: "mention_board",
            immutableSourceKey: key,
            sourceRecordId: mentionId,
            exactText: input.message,
            projectionKind: "issue_update",
            ownershipEpoch: input.capability.ownershipEpoch,
            agentId: input.capability.targetAgentId,
            adapterConfigRevisionId: input.capability.adapterConfigIdentity,
            runId: input.capability.runId,
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
          },
          tx,
        );
        if (!admission.comment) {
          throw new RuntimeIssueActionConflict(
            "mention_board did not persist its canonical issue comment",
          );
        }
        const inserted = await tx
          .insert(issueBoardMentions)
          .values({
            id: mentionId,
            companyId: input.capability.companyId,
            issueId: input.capability.issueId,
            ownershipEpoch: input.capability.ownershipEpoch,
            agentId: input.capability.targetAgentId,
            runId: input.capability.runId,
            idempotencyKey: key,
            reason: input.reason ?? null,
            commentId: admission.comment.id,
            createdAt: now,
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
            eq(issueBoardMentions.companyId, input.capability.companyId),
            eq(issueBoardMentions.idempotencyKey, key),
          ))
          .limit(1)
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (
          !mention ||
          mention.commentId !== admission.comment.id ||
          mention.reason !== (input.reason ?? null)
        ) {
          throw new RuntimeIssueActionConflict(
            "mention_board invocation was retried with different immutable arguments",
          );
        }
        await recordIssueLivenessActionInTransaction(
          tx,
          `issue_board_mention:${mention.id}`,
        );
        return { mention, retried: admission.retried };
      });
      return {
        id: committed.mention.id,
        commentId: committed.mention.commentId,
        retried: committed.retried,
      };
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
      if (input.mentionRunId !== undefined) {
        const mentionRunId = input.mentionRunId;
        const steering = await input.withMentionAdmission(
          input.targetAgentId,
          () => db.transaction(async (tx) => {
          const now = clock();
          const authorized = await lockRuntimeActionAuthority(
            tx,
            input.capability,
            "mention_agent",
            now,
            {
              requireOwner: false,
              additionalLaneTargetAgentId: input.targetAgentId,
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
          try {
            const chain = await lockAndValidateIssueConsultChain(tx, {
              ref: authorized.ref,
              requireLiveAncestors:
                authorized.ref.mode === "consult" &&
                authorized.ref.sourceKind === "consult_mention",
              leafState: "active",
            });
            if (chain.agentIds.has(input.targetAgentId)) {
              throw new RuntimeIssueActionDenied(
                "Mention target would loop within the active consult chain",
                "mention_chain_loop",
              );
            }
          } catch (error) {
            if (error instanceof RuntimeIssueActionDenied) throw error;
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
          const selectedRun = await options.runService.lockRun(tx, {
            companyId: input.capability.companyId,
            issueId: input.capability.issueId,
            runId: mentionRunId,
          });
          if (
            (selectedRun.kind !== "productive" &&
              selectedRun.kind !== "consult") ||
            selectedRun.status !== "running" ||
            selectedRun.sessionId !== input.capability.sessionId ||
            selectedRun.ownershipEpoch !== input.capability.ownershipEpoch ||
            selectedRun.targetAgentId !== input.targetAgentId ||
            selectedRun.terminalFinalizationId !== null ||
            selectedRun.finishedAt !== null ||
            selectedRun.runId === input.capability.runId
          ) {
            throw new RuntimeIssueActionDenied(
              "mentionRunId does not identify the exact active target-agent run",
              "mention_run_invalid",
            );
          }
          const progressRows = await tx
            .select({
              source: issueCommentProjectionSources,
              comment: issueComments,
            })
            .from(issueCommentProjectionSources)
            .innerJoin(
              issueComments,
              eq(issueComments.id, issueCommentProjectionSources.commentId),
            )
            .where(
              and(
                eq(
                  issueCommentProjectionSources.companyId,
                  input.capability.companyId,
                ),
                eq(
                  issueCommentProjectionSources.issueId,
                  input.capability.issueId,
                ),
                eq(
                  issueCommentProjectionSources.sessionId,
                  input.capability.sessionId,
                ),
                eq(issueCommentProjectionSources.sourceKind, "run_progress"),
                eq(issueCommentProjectionSources.runId, selectedRun.runId),
              ),
            )
            .limit(2)
            .for("update");
          if (
            progressRows.length !== 1 ||
            progressRows[0]!.comment.authorType !== "agent" ||
            progressRows[0]!.comment.authorAgentId !== input.targetAgentId ||
            progressRows[0]!.comment.runId !== selectedRun.runId
          ) {
            throw new RuntimeIssueActionConflict(
              "Selected run has no exact stable target-agent progress comment",
            );
          }
          const admission = await sessionAdmission.admitSteeringComment(
            {
              companyId: input.capability.companyId,
              issueId: input.capability.issueId,
              sessionId: input.capability.sessionId,
              sourceKind: "agent_active_run_steering",
              actor: executionActorForCapability(input.capability),
              immutableSourceKey: key,
              sourceRecordId: deterministicUuid("issue-steering", key),
              exactText: input.message,
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
                replyToCommentId: progressRows[0]!.comment.id,
                steeringSegment: null,
              },
            },
            tx,
          );
          if (!admission.comment || admission.input || admission.ref) {
            throw new RuntimeIssueActionConflict(
              "Agent steering did not persist its canonical synthetic Session message/comment",
            );
          }
          let resultIdentity: {
            companyId: string;
            issueId: string;
            runId: string;
            refId: string;
            refOrdinal: number;
            segmentOrdinal: number;
          };
          if (!admission.retried) {
            const requested =
              await options.runService.requestSteeringInTransaction(
              tx,
              {
                companyId: input.capability.companyId,
                issueId: input.capability.issueId,
                ownershipEpoch: input.capability.ownershipEpoch,
                runId: selectedRun.runId,
                targetAgentId: input.targetAgentId,
                exactMessage: input.message,
                sourceCommentId: admission.comment.id,
                sourceMessageId: admission.source.messageId,
                sourceInputId: null,
                actor: {
                  kind: "agent",
                  agentId: input.capability.targetAgentId,
                },
              },
            );
            resultIdentity = {
              companyId: requested.companyId,
              issueId: requested.issueId,
              runId: requested.runId,
              refId: requested.refId,
              refOrdinal: requested.refOrdinal,
              segmentOrdinal: requested.segmentOrdinal,
            };
          } else {
            const reboundSource = await tx
              .select()
              .from(issueCommentProjectionSources)
              .where(
                and(
                  eq(
                    issueCommentProjectionSources.companyId,
                    input.capability.companyId,
                  ),
                  eq(
                    issueCommentProjectionSources.issueId,
                    input.capability.issueId,
                  ),
                  eq(
                    issueCommentProjectionSources.commentId,
                    admission.comment.id,
                  ),
                ),
              )
              .limit(2)
              .for("update");
            const bound = reboundSource.length === 1
              ? reboundSource[0]!
              : null;
            if (
              !bound ||
              bound.steeringTargetRunId !== selectedRun.runId ||
              bound.refId === null ||
              bound.refOrdinal === null ||
              bound.segmentOrdinal === null ||
              bound.segmentOrdinal < 1
            ) {
              throw new RuntimeIssueActionConflict(
                "Retried agent steering lost its exact prompt segment",
              );
            }
            resultIdentity = {
              companyId: input.capability.companyId,
              issueId: input.capability.issueId,
              runId: selectedRun.runId,
              refId: bound.refId,
              refOrdinal: bound.refOrdinal,
              segmentOrdinal: bound.segmentOrdinal,
            };
          }
          return {
            runId: selectedRun.runId,
            sourceCommentId: admission.comment.id,
            resultIdentity,
            retried: admission.retried,
          };
          }),
        );
        const expectation =
          options.issueExecutionSteeringResults.expect(
            steering.resultIdentity,
          );
        try {
          const continued =
            await options.runService.continuePendingSteeringForSource({
              companyId: input.capability.companyId,
              issueId: input.capability.issueId,
              sourceCommentId: steering.sourceCommentId,
            });
          const result = continued.kind === "already_settled"
            ? continued.result
            : await expectation.result;
          if (continued.kind === "already_settled") {
            expectation.cancel();
          }
          if (result.outcome !== "succeeded") {
            throw new RuntimeIssueActionConflict(
              result.reason ??
                `mentionRunId continuation ended with ${result.outcome}`,
            );
          }
          return {
            runId: result.runId,
            response: result.response,
            retried: steering.retried,
          };
        } catch (error) {
          expectation.cancel();
          throw error;
        }
      }
      const prepared = await input.withMentionAdmission(
        input.targetAgentId,
        () => db.transaction(async (tx) => {
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
              if (
                !priorRef ||
                !priorRef.consultExecutionId ||
                priorRef.mode !== "consult" ||
                priorRef.sourceKind !== "consult_mention" ||
                priorRef.consultCallerRefId !==
                  input.capability.refId ||
                priorRef.targetAgentId !== input.targetAgentId ||
                priorRef.exactMessage !== input.message
              ) {
                throw new RuntimeIssueActionConflict(
                  "mention invocation was retried with different immutable arguments",
                );
              }
              const consult = await tx
                .select()
                .from(issueConsultExecutions)
                .where(
                  and(
                    eq(issueConsultExecutions.id, priorRef.consultExecutionId),
                    eq(
                      issueConsultExecutions.companyId,
                      input.capability.companyId,
                    ),
                    eq(issueConsultExecutions.issueId, input.capability.issueId),
                    eq(
                      issueConsultExecutions.sessionId,
                      input.capability.sessionId,
                    ),
                    eq(
                      issueConsultExecutions.ownershipEpoch,
                      input.capability.ownershipEpoch,
                    ),
                    eq(issueConsultExecutions.sourceRunId, input.capability.runId),
                    eq(
                      issueConsultExecutions.sourceRefId,
                      input.capability.refId,
                    ),
                    eq(
                      issueConsultExecutions.targetAgentId,
                      input.targetAgentId,
                    ),
                  ),
                )
                .limit(1)
                .for("update")
                .then((rows) => rows[0] ?? null);
              if (!consult) {
                throw new RuntimeIssueActionConflict(
                  "Accepted mention is missing its consult execution",
                );
              }
              if (
                priorEvent.sourceRecordId !== consult.id ||
                priorEvent.runId !== input.capability.runId ||
                priorEvent.agentId !== input.capability.targetAgentId ||
                priorEvent.adapterConfigRevisionId !==
                  input.capability.adapterConfigIdentity ||
                priorRef.consultChainToken !== consult.chainToken ||
                priorRef.adapterConfigRevisionId !==
                  consult.adapterConfigRevisionId
              ) {
                throw new RuntimeIssueActionConflict(
                  "Accepted mention no longer matches its immutable consult evidence",
                );
              }
              if (consult.state === "active") {
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
              }
              try {
                await lockAndValidateIssueConsultChain(tx, {
                  ref: priorRef,
                  requireLiveAncestors: consult.state === "active",
                  leafState: consult.state === "completed"
                    ? "active_or_completed"
                    : "active",
                });
              } catch (error) {
                if (error instanceof IssueConsultChainInvalid) {
                  if (consult.state === "active") {
                    throw new RuntimeIssueActionDenied(
                      error.message,
                      error.reason === "cycle"
                        ? "mention_chain_cycle"
                        : "mention_chain_invalid",
                    );
                  }
                  throw new RuntimeIssueActionConflict(error.message);
                }
                throw error;
              }
              const responseEvent = await tx
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
                    eq(issueSessionEvents.sourceKind, "consult_response"),
                    eq(
                      issueSessionEvents.immutableSourceKey,
                      `${key}:response`,
                    ),
                  ),
                )
                .limit(1)
                .then((rows) => rows[0] ?? null);
              if (consult.state === "completed" && responseEvent) {
                const payload = responseEvent.data as { text?: unknown };
                if (
                  typeof payload.text !== "string" ||
                  !responseEvent.runId ||
                  responseEvent.sourceRecordId !== consult.id ||
                  responseEvent.agentId !== consult.targetAgentId ||
                  responseEvent.adapterConfigRevisionId !==
                    consult.adapterConfigRevisionId
                ) {
                  throw new RuntimeIssueActionConflict(
                    "Completed mention is missing its normalized response",
                  );
                }
                return {
                  kind: "completed" as const,
                  result: {
                    consultExecutionId: consult.id,
                    runId: responseEvent.runId,
                    response: payload.text,
                    retried: true,
                  },
                };
              }
              if (consult.state !== "active") {
                throw new RuntimeIssueActionConflict(
                  `Mention consult is already ${consult.state}`,
                );
              }
              return {
                kind: "execute" as const,
                execution: {
                  companyId: consult.companyId,
                  issueId: consult.issueId,
                  sessionId: consult.sessionId,
                  ownershipEpoch: consult.ownershipEpoch,
                  consultExecutionId: consult.id,
                  sourceRunId: consult.sourceRunId,
                  sourceRefId: consult.sourceRefId,
                  targetAgentId: consult.targetAgentId,
                  adapterConfigRevisionId: consult.adapterConfigRevisionId,
                  chainToken: consult.chainToken,
                  ref: projectPersistedIssueExecutionRef(priorRef),
                } satisfies RuntimeMentionExecutionInput,
                key,
                retried: true,
              };
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
                requireLiveAncestors:
                  authorized.ref.mode === "consult" &&
                  authorized.ref.sourceKind === "consult_mention",
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
                "Mention target would loop within the active consult chain",
                "mention_chain_loop",
              );
            }
            const chainToken = chain.chainToken;

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
                chainToken,
                state: "active",
                createdAt: now,
              })
              .returning()
              .then((rows) => rows[0] ?? null);
            if (!consult) {
              throw new RuntimeIssueActionConflict(
                "Mention consult binding was not persisted",
              );
            }
            const admission =
              await sessionAdmission.admitExecutionSource(
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
                  consultChainToken: chainToken,
                  sourceKind: "consult_mention",
                  actor: executionActorForCapability(input.capability),
                  immutableSourceKey: key,
                  sourceRecordId: consult.id,
                  exactText: input.message,
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
                tx,
              );
            if (!admission.ref || !admission.comment) {
              throw new RuntimeIssueActionConflict(
                "Mention did not reserve its consult ref and request comment",
              );
            }
            return {
              kind: "execute" as const,
              execution: {
                companyId: consult.companyId,
                issueId: consult.issueId,
                sessionId: consult.sessionId,
                ownershipEpoch: consult.ownershipEpoch,
                consultExecutionId: consult.id,
                sourceRunId: consult.sourceRunId,
                sourceRefId: consult.sourceRefId,
                targetAgentId: consult.targetAgentId,
                adapterConfigRevisionId: consult.adapterConfigRevisionId,
                chainToken: consult.chainToken,
                ref: projectPersistedIssueExecutionRef(admission.ref),
              } satisfies RuntimeMentionExecutionInput,
              key,
              retried: false,
            };
        }),
      );

      if (prepared.kind === "completed") return prepared.result;

      let nested: RuntimeMentionExecutionResult;
      try {
        nested = await options.executeMention(prepared.execution);
        if (
          !nested ||
          typeof nested.runId !== "string" ||
          nested.runId.length === 0 ||
          typeof nested.response !== "string"
        ) {
          throw new RuntimeIssueActionConflict(
            "Nested mention executor returned an invalid normalized result",
          );
        }
      } catch (error) {
        const cancellations = await db.transaction(async (tx) => {
          const now = clock();
          await lockRuntimeActionHierarchy(tx, input.capability, now, {
            additionalLaneTargetAgentId:
              prepared.execution.targetAgentId,
          });
          await tx.execute(
            sql`select ${issueConsultExecutions.id} from ${issueConsultExecutions} where ${issueConsultExecutions.id} = ${prepared.execution.consultExecutionId} for update`,
          );
          await tx
            .update(issueConsultExecutions)
            .set({
              state: "cancelled",
              closeReason:
                error instanceof Error
                  ? `nested_execution_failed:${error.message}`
                  : "nested_execution_failed",
              closedAt: now,
            })
            .where(
              and(
                eq(
                  issueConsultExecutions.id,
                  prepared.execution.consultExecutionId,
                ),
                eq(issueConsultExecutions.state, "active"),
              ),
            );
          return options.issueExecutionCancellation
            .requestScopeCancellationsInTransaction(tx, {
              companyId: prepared.execution.companyId,
              issueId: prepared.execution.issueId,
              selector: {
                kind: "refs",
                refIds: [prepared.execution.ref.id],
              },
              reason: "consult_execution_failed",
              actor: {
                kind: "agent",
                agentId: input.capability.targetAgentId,
              },
              now,
            });
        });
        await options.issueExecutionCancellation
          .reconcileRequestedScopeCancellations(cancellations);
        throw error;
      }

      const nestedRun = await options.runService.readRun({
        companyId: prepared.execution.companyId,
        issueId: prepared.execution.issueId,
        runId: nested.runId,
      });
      return db.transaction(async (tx) => {
        const now = clock();
        await lockRuntimeActionHierarchy(tx, input.capability, now, {
          additionalLaneTargetAgentId: prepared.execution.targetAgentId,
        });
        await tx.execute(
          sql`select ${issueConsultExecutions.id} from ${issueConsultExecutions} where ${issueConsultExecutions.id} = ${prepared.execution.consultExecutionId} for update`,
        );
        const [consult, issue, currentRef] = await Promise.all([
          tx
            .select()
            .from(issueConsultExecutions)
            .where(
              eq(
                issueConsultExecutions.id,
                prepared.execution.consultExecutionId,
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null),
          tx
            .select()
            .from(issues)
            .where(eq(issues.id, prepared.execution.issueId))
            .limit(1)
            .then((rows) => rows[0] ?? null),
          tx
            .select()
            .from(issueExecutionRefs)
            .where(eq(issueExecutionRefs.id, prepared.execution.ref.id))
            .limit(1)
            .then((rows) => rows[0] ?? null),
        ]);
        if (
          !consult ||
          consult.state !== "active" ||
          !issue ||
          issue.companyId !== prepared.execution.companyId ||
          issue.ownershipEpoch !== prepared.execution.ownershipEpoch ||
          (issue.lifecycleStatus !== "open" &&
            issue.lifecycleStatus !== "blocked") ||
          !nestedRun ||
          nestedRun.companyId !== prepared.execution.companyId ||
          nestedRun.issueId !== prepared.execution.issueId ||
          nestedRun.sessionId !== prepared.execution.sessionId ||
          nestedRun.ownershipEpoch !== prepared.execution.ownershipEpoch ||
          nestedRun.targetAgentId !== prepared.execution.targetAgentId ||
          nestedRun.kind !== "consult" ||
          nestedRun.consultExecutionId !==
            prepared.execution.consultExecutionId ||
          nestedRun.status !== "succeeded" ||
          !currentRef ||
          currentRef.disposition !== "terminal" ||
          currentRef.consultExecutionId !==
            prepared.execution.consultExecutionId
        ) {
          throw new RuntimeIssueActionConflict(
            "Mention scope changed before its normalized response committed",
          );
        }
        const response =
          await sessionAdmission.appendNonDispatchSyntheticComment(
            {
              companyId: prepared.execution.companyId,
              issueId: prepared.execution.issueId,
              sessionId: prepared.execution.sessionId,
              sourceKind: "consult_response",
              immutableSourceKey: `${prepared.key}:response`,
              sourceRecordId: prepared.execution.consultExecutionId,
              exactText: nested.response,
              projectionKind: "harness_delivery",
              ownershipEpoch: prepared.execution.ownershipEpoch,
              agentId: prepared.execution.targetAgentId,
              adapterConfigRevisionId:
                prepared.execution.adapterConfigRevisionId,
              runId: nested.runId,
              comment: {
                author: {
                  kind: "agent",
                  agentId: prepared.execution.targetAgentId,
                },
                producingRun: {
                  runId: nested.runId,
                  adapterConfigRevisionId:
                    prepared.execution.adapterConfigRevisionId,
                },
              },
            },
            tx,
          );
        const completedConsult = await tx
          .update(issueConsultExecutions)
          .set({
            state: "completed",
            closeReason: "nested_execution_completed",
            closedAt: now,
          })
          .where(
            and(
              eq(
                issueConsultExecutions.id,
                prepared.execution.consultExecutionId,
              ),
              eq(issueConsultExecutions.state, "active"),
            ),
          )
          .returning({ id: issueConsultExecutions.id });
        if (completedConsult.length !== 1) {
          throw new RuntimeIssueActionConflict(
            "Mention consult was not active when its response committed",
          );
        }
        await recordIssueLivenessActionInTransaction(
          tx,
          `issue_consult_execution:${completedConsult[0]!.id}`,
        );
        return {
          consultExecutionId: prepared.execution.consultExecutionId,
          runId: nested.runId,
          response: nested.response,
          requestComment: null,
          responseComment: response.comment,
          retried: prepared.retried,
        };
      });
    },
  };
}
