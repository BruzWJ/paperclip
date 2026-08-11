import { createHash } from "node:crypto";
import {
  agentAdapterConfigRevisions,
  agents,
  companies,
  issueCreatorEdgeReceivability,
  issueExecutionAuthorities,
  issueExecutionRefs,
  issueSessionContextEpochs,
  issueSessions,
  issues,
  plugins,
  routines,
  systemEscalationIdentities,
  type Db,
} from "@paperclipai/db";
import {
  decodeIssueCreatorEdgeTerminalReason,
  isIssueCreatorEdgeTerminalReason,
  type IssueCreatorEdgeTerminalReason,
  type SystemCreatorSourceKind,
} from "@paperclipai/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { evaluateAgentInvokability } from "./agent-invokability.js";
import {
  createIssueSessionAdmissionService,
  type IssueSessionAdmissionService,
} from "./issue-session/admission.js";
import type { IssueSessionDbTransaction } from "./issue-session/event-store.js";
import { admitIssueExecutionInTransaction } from "./issue-execution-initial-start-admission.js";
import { persistCanonicalIssueAggregateInTx } from "./canonical-issue-aggregate.js";
import {
  IssueExecutionWorkspaceReservationRejected,
} from "./execution-workspaces.js";
import { resolveIssueExecutionRunIdentityById } from "./issue-execution-run-service.js";

type IssueRow = typeof issues.$inferSelect;
type EdgeRow = typeof issueCreatorEdgeReceivability.$inferSelect;

export type SystemEscalationOwner =
  | { kind: "agent"; agentId: string }
  | { kind: "user"; userId: string }
  | { kind: "board" };

export interface EnsureSystemEscalationInput {
  companyId: string;
  affectedIssueId: string;
  affectedOwnershipEpoch: number;
  terminalCreatorEdgeId: string;
  systemSource: SystemCreatorSourceKind;
  triggeringRunId: string | null;
  causalSourceId: string;
}

export interface TerminalizeCreatorEdgeInput {
  companyId: string;
  issueId: string;
  ownershipEpoch: number;
  creatorEdgeId: string;
  reason: IssueCreatorEdgeTerminalReason;
  sourceKind: string;
  sourceId: string;
  systemSource: SystemCreatorSourceKind;
  triggeringRunId: string | null;
  endpointTombstone?: Record<string, unknown> | null;
  audit?: Record<string, unknown> | null;
}

export interface SystemEscalationTransactionResult {
  identity: typeof systemEscalationIdentities.$inferSelect;
  issue: IssueRow;
  owner: SystemEscalationOwner;
  dispatchRefId: string | null;
  created: boolean;
}

export interface PostgresSystemEscalationOptions {
  clock?: () => Date;
  dispatchRef(refId: string): Promise<void>;
}

const NONTERMINAL_STATUSES = new Set(["open", "blocked"]);
const MAX_ESCALATION_TITLE_CHARS = 180;
const MAX_ESCALATION_REQUEST_CHARS = 720;

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

async function withEscalationWorkspaceReservationErrors<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof IssueExecutionWorkspaceReservationRejected) {
      throw new PostgresSystemEscalationConflict(
        error.message,
        error.reason,
      );
    }
    throw error;
  }
}

function bounded(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  if (maximum <= 1) return value.slice(0, maximum);
  return `${value.slice(0, maximum - 1)}…`;
}

function stableAffectedLabel(issue: IssueRow): string {
  const identifier = issue.identifier?.trim() || issue.id;
  const title = issue.title?.trim();
  return title
    ? `${identifier} (${bounded(title, 160)})`
    : identifier;
}

function escalationTitle(issue: IssueRow): string {
  return bounded(
    `Escalation for ${issue.identifier?.trim() || issue.title?.trim() || issue.id}`,
    MAX_ESCALATION_TITLE_CHARS,
  );
}

function escalationRequest(
  issue: IssueRow,
  source: SystemCreatorSourceKind,
  reason: IssueCreatorEdgeTerminalReason,
): string {
  return bounded(
    `System ${source} safeguard for ${stableAffectedLabel(issue)}: the immutable creator endpoint is permanently unreceivable (${reason}). Review the affected issue and decide the next board action.`,
    MAX_ESCALATION_REQUEST_CHARS,
  );
}

function terminalReason(
  value: string | null,
): IssueCreatorEdgeTerminalReason {
  try {
    return decodeIssueCreatorEdgeTerminalReason(value);
  } catch {
    throw new PostgresSystemEscalationConflict(
      "Creator edge is not terminal for a canonical structural-loss or exhaustion reason",
      "creator_edge_reason_not_escalating",
    );
  }
}

function sourceAuthor(source: SystemCreatorSourceKind) {
  return { kind: "system" as const, source };
}

export class PostgresSystemEscalationConflict extends Error {
  readonly code = "postgres_system_escalation_conflict";

  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = "PostgresSystemEscalationConflict";
  }
}

async function loadCompanyAgents(
  tx: IssueSessionDbTransaction,
  companyId: string,
) {
  return tx
    .select()
    .from(agents)
    .where(eq(agents.companyId, companyId))
    .orderBy(asc(agents.id))
    .for("share");
}

function liveAgent(
  agentId: string | null | undefined,
  companyAgents: Awaited<ReturnType<typeof loadCompanyAgents>>,
) {
  if (!agentId) return null;
  const candidate =
    companyAgents.find((agent) => agent.id === agentId) ?? null;
  return evaluateAgentInvokability(candidate, companyAgents).invokable
    ? candidate
    : null;
}

/**
 * Resolve only the goal's issue-tree ladder. The full company agent set is
 * loaded solely to evaluate reporting-chain health; it is never an owner
 * candidate catalog.
 */
export async function resolveSystemEscalationOwnerInTransaction(
  tx: IssueSessionDbTransaction,
  affected: IssueRow,
): Promise<SystemEscalationOwner> {
  const [companyAgents, companyIssues] = await Promise.all([
    loadCompanyAgents(tx, affected.companyId),
    tx
      .select({
        id: issues.id,
        parentId: issues.parentId,
        ownerKind: issues.ownerKind,
        ownerAgentId: issues.ownerAgentId,
        creatorKind: issues.creatorKind,
        creatorUserId: issues.creatorUserId,
      })
      .from(issues)
      .where(eq(issues.companyId, affected.companyId))
      .for("share"),
  ]);

  if (
    affected.creatorKind === "agent-execution" &&
    affected.creatorAuthorityId
  ) {
    const creatorAuthority = await tx
      .select({ agentId: issueExecutionAuthorities.agentId })
      .from(issueExecutionAuthorities)
      .where(
        and(
          eq(
            issueExecutionAuthorities.companyId,
            affected.companyId,
          ),
          eq(
            issueExecutionAuthorities.id,
            affected.creatorAuthorityId,
          ),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const creatorAgent = liveAgent(
      creatorAuthority?.agentId,
      companyAgents,
    );
    if (creatorAgent) {
      return { kind: "agent", agentId: creatorAgent.id };
    }
  }

  const issueById = new Map(companyIssues.map((issue) => [issue.id, issue]));
  const visited = new Set<string>([affected.id]);
  let cursorId = affected.parentId;
  let root = issueById.get(affected.id) ?? {
    id: affected.id,
    parentId: affected.parentId,
    ownerKind: affected.ownerKind,
    ownerAgentId: affected.ownerAgentId,
    creatorKind: affected.creatorKind,
    creatorUserId: affected.creatorUserId,
  };
  while (cursorId) {
    if (visited.has(cursorId)) {
      return { kind: "board" };
    }
    visited.add(cursorId);
    const ancestor = issueById.get(cursorId);
    if (!ancestor) {
      return { kind: "board" };
    }
    root = ancestor;
    if (ancestor.ownerKind === "agent") {
      const ancestorOwner = liveAgent(
        ancestor.ownerAgentId,
        companyAgents,
      );
      if (ancestorOwner) {
        return { kind: "agent", agentId: ancestorOwner.id };
      }
    }
    cursorId = ancestor.parentId;
  }

  if (
    root.creatorKind === "user/board" &&
    root.creatorUserId?.trim()
  ) {
    return { kind: "user", userId: root.creatorUserId };
  }
  return { kind: "board" };
}

async function requireSelectedAgentRevision(
  tx: IssueSessionDbTransaction,
  companyId: string,
  agentId: string,
) {
  const companyAgents = await loadCompanyAgents(tx, companyId);
  const owner = liveAgent(agentId, companyAgents);
  if (!owner) {
    throw new PostgresSystemEscalationConflict(
      "The ladder-selected escalation owner is no longer invokable",
      "selected_owner_not_invokable",
    );
  }
  if (!owner.currentAdapterConfigRevisionId) {
    throw new PostgresSystemEscalationConflict(
      "The ladder-selected escalation owner has no current adapter revision",
      "selected_owner_revision_missing",
    );
  }
  const revision = await tx
    .select()
    .from(agentAdapterConfigRevisions)
    .where(
      and(
        eq(agentAdapterConfigRevisions.companyId, companyId),
        eq(agentAdapterConfigRevisions.agentId, owner.id),
        eq(
          agentAdapterConfigRevisions.id,
          owner.currentAdapterConfigRevisionId,
        ),
      ),
    )
    .for("share")
    .then((rows) => rows[0] ?? null);
  if (!revision) {
    throw new PostgresSystemEscalationConflict(
      "The ladder-selected escalation owner adapter revision is missing",
      "selected_owner_revision_missing",
    );
  }
  return { owner, revision };
}

async function validateTriggeringRun(
  tx: IssueSessionDbTransaction,
  companyId: string,
  triggeringRunId: string | null,
): Promise<void> {
  if (!triggeringRunId) return;
  const run = await resolveIssueExecutionRunIdentityById(tx, triggeringRunId);
  if (!run || run.companyId !== companyId) {
    throw new PostgresSystemEscalationConflict(
      "Escalation triggeringRunId must identify the persisted causal run",
      "triggering_run_missing",
    );
  }
}

async function appendAffectedCrossLink(
  sessions: IssueSessionAdmissionService,
  tx: IssueSessionDbTransaction,
  input: EnsureSystemEscalationInput,
  affected: IssueRow,
  affectedSessionId: string,
  identity: typeof systemEscalationIdentities.$inferSelect,
  escalationIssue: IssueRow,
): Promise<void> {
  const affectedLabel = affected.identifier?.trim() || affected.id;
  const escalationLabel =
    escalationIssue.identifier?.trim() || escalationIssue.id;
  await sessions.appendNonDispatchControlNotice(
    {
      companyId: input.companyId,
      issueId: affected.id,
      sessionId: affectedSessionId,
      sourceKind: "system_escalation_crosslink",
      immutableSourceKey: identity.id,
      sourceRecordId: identity.id,
      exactText: `System escalation ${escalationLabel} was opened for ${affectedLabel} because the immutable creator endpoint is permanently unreceivable (${identity.immutableSource.reason as string}).`,
      comment: {
        author: sourceAuthor(identity.systemSource),
        producingRun: null,
      },
      allowTerminal: false,
    },
    tx,
  );
}

async function appendEscalationNudge(
  sessions: IssueSessionAdmissionService,
  tx: IssueSessionDbTransaction,
  input: EnsureSystemEscalationInput,
  identity: typeof systemEscalationIdentities.$inferSelect,
  escalationIssue: IssueRow,
): Promise<string | null> {
  const sessionState = await tx
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
        eq(issueSessions.companyId, input.companyId),
        eq(issueSessions.issueId, escalationIssue.id),
      ),
    )
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!sessionState) {
    throw new PostgresSystemEscalationConflict(
      "Historical escalation identity is missing its canonical Session",
      "escalation_session_missing",
    );
  }
  const { session, contextGeneration } = sessionState;
  const reason = terminalReason(
    (identity.immutableSource.reason as string | undefined) ?? null,
  );
  const exactText = `System ${input.systemSource} nudge: the escalation for ${identity.affectedIssueId} remains active (${reason}).`;
  const sourceKey = `${identity.id}:${input.causalSourceId}`;

  if (
    escalationIssue.hiddenAt === null &&
    escalationIssue.ownerKind === "agent" &&
    escalationIssue.ownerAgentId &&
    escalationIssue.ownershipEpoch &&
    escalationIssue.lifecycleStatus &&
    NONTERMINAL_STATUSES.has(escalationIssue.lifecycleStatus)
  ) {
    const companyAgents = await loadCompanyAgents(tx, input.companyId);
    const currentOwner = liveAgent(
      escalationIssue.ownerAgentId,
      companyAgents,
    );
    if (currentOwner?.currentAdapterConfigRevisionId) {
      const [revision, authority] = await Promise.all([
        tx
          .select({ id: agentAdapterConfigRevisions.id })
          .from(agentAdapterConfigRevisions)
          .where(
            and(
              eq(
                agentAdapterConfigRevisions.companyId,
                input.companyId,
              ),
              eq(
                agentAdapterConfigRevisions.agentId,
                currentOwner.id,
              ),
              eq(
                agentAdapterConfigRevisions.id,
                currentOwner.currentAdapterConfigRevisionId,
              ),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null),
        tx
          .select()
          .from(issueExecutionAuthorities)
          .where(
            and(
              eq(
                issueExecutionAuthorities.companyId,
                input.companyId,
              ),
              eq(
                issueExecutionAuthorities.issueId,
                escalationIssue.id,
              ),
              eq(
                issueExecutionAuthorities.ownershipEpoch,
                escalationIssue.ownershipEpoch,
              ),
              eq(
                issueExecutionAuthorities.agentId,
                currentOwner.id,
              ),
              eq(issueExecutionAuthorities.state, "current"),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null),
      ]);
      if (revision && authority) {
        const admitted = await sessions.admitExecutionSource(
          {
            companyId: input.companyId,
            issueId: escalationIssue.id,
            sessionId: session.id,
            ownershipEpoch: escalationIssue.ownershipEpoch,
            targetAgentId: currentOwner.id,
            issueExecutionAuthorityId: authority.id,
            consultExecutionId: null,
            adapterConfigRevisionId: revision.id,
            contextEpoch: contextGeneration,
            mode: "owner",
            sourceKind: "system_nudge",
            actor: {
              kind: "system",
              sourceKind: input.systemSource,
              sourceId: input.causalSourceId,
            },
            immutableSourceKey: sourceKey,
            sourceRecordId: input.causalSourceId,
            exactText,
            comment: {
              author: sourceAuthor(input.systemSource),
              producingRun: null,
            },
            idempotencyKey: sourceKey,
          },
          tx,
        );
        return admitted.retried ? null : admitted.ref?.id ?? null;
      }
    }
  }

  await sessions.appendNonDispatchControlNotice(
    {
      companyId: input.companyId,
      issueId: escalationIssue.id,
      sessionId: session.id,
      sourceKind: "system_escalation_nudge",
      immutableSourceKey: sourceKey,
      sourceRecordId: input.causalSourceId,
      exactText,
      comment: {
        author: sourceAuthor(input.systemSource),
        producingRun: null,
      },
      allowTerminal: true,
    },
    tx,
  );
  return null;
}

async function loadLockedAffectedScope(
  tx: IssueSessionDbTransaction,
  input: EnsureSystemEscalationInput,
) {
  const affected = await tx
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.companyId, input.companyId),
        eq(issues.id, input.affectedIssueId),
      ),
    )
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (
    !affected ||
    affected.ownershipEpoch !== input.affectedOwnershipEpoch ||
    !affected.lifecycleStatus ||
    !NONTERMINAL_STATUSES.has(affected.lifecycleStatus)
  ) {
    throw new PostgresSystemEscalationConflict(
      "System escalation requires the current nonterminal affected issue epoch",
      "affected_issue_not_current_nonterminal",
    );
  }
  if (
    affected.creatorKind === "system" ||
    affected.escalatedFromAffectedIssueId !== null
  ) {
    throw new PostgresSystemEscalationConflict(
      "A system escalation cannot itself be escalated",
      "system_escalation_recursion",
    );
  }
  const edges = await tx
    .select()
    .from(issueCreatorEdgeReceivability)
    .where(
      and(
        eq(issueCreatorEdgeReceivability.companyId, input.companyId),
        eq(
          issueCreatorEdgeReceivability.issueId,
          input.affectedIssueId,
        ),
        eq(
          issueCreatorEdgeReceivability.ownershipEpoch,
          input.affectedOwnershipEpoch,
        ),
      ),
    )
    .for("update");
  const edge = edges[0] ?? null;
  if (
    !edge ||
    edge.id !== input.terminalCreatorEdgeId ||
    edge.state !== "terminal" ||
    edge.endpointKind === "user/board" ||
    edge.endpointKind === "system"
  ) {
    throw new PostgresSystemEscalationConflict(
      "System escalation requires the locked terminal creator edge",
      "terminal_creator_edge_not_current",
    );
  }
  terminalReason(edge.terminalReason);
  const affectedSession = await tx
    .select()
    .from(issueSessions)
    .where(
      and(
        eq(issueSessions.companyId, input.companyId),
        eq(issueSessions.issueId, affected.id),
        eq(issueSessions.id, edge.sessionId),
      ),
    )
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (
    !affectedSession ||
    affectedSession.integrityState !== "ready" ||
    affectedSession.timeArchived !== null ||
    affectedSession.purgeFencedAt !== null
  ) {
    throw new PostgresSystemEscalationConflict(
      "Affected issue Session is lifecycle-fenced",
      "affected_session_not_ready",
    );
  }
  return { affected, edge, affectedSession };
}

/**
 * Canonical PostgreSQL constructor. Callers that already own a transaction
 * use this function so edge terminalization, identity claim, issue creation,
 * cross-link, and owner ref commit together.
 */
export async function ensureSystemEscalationInTransaction(
  tx: IssueSessionDbTransaction,
  sessions: IssueSessionAdmissionService,
  input: EnsureSystemEscalationInput,
  clock: () => Date = () => new Date(),
): Promise<SystemEscalationTransactionResult> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${input.companyId}:system-escalation:${input.affectedIssueId}:${input.affectedOwnershipEpoch}`}, 0))`,
  );
  const { affected, edge, affectedSession } =
    await loadLockedAffectedScope(tx, input);
  await validateTriggeringRun(
    tx,
    input.companyId,
    input.triggeringRunId,
  );

  const existingIdentity = await tx
    .select()
    .from(systemEscalationIdentities)
    .where(
      and(
        eq(systemEscalationIdentities.companyId, input.companyId),
        eq(
          systemEscalationIdentities.affectedIssueId,
          input.affectedIssueId,
        ),
        eq(
          systemEscalationIdentities.affectedOwnershipEpoch,
          input.affectedOwnershipEpoch,
        ),
      ),
    )
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (existingIdentity) {
    const escalationIssue = await tx
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, input.companyId),
          eq(issues.id, existingIdentity.escalationIssueId),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!escalationIssue) {
      throw new PostgresSystemEscalationConflict(
        "Historical escalation identity lost its escalation issue",
        "escalation_issue_missing",
      );
    }
    await appendAffectedCrossLink(
      sessions,
      tx,
      input,
      affected,
      affectedSession.id,
      existingIdentity,
      escalationIssue,
    );
    const initialCausalSourceId =
      typeof existingIdentity.immutableSource.initialCausalSourceId ===
      "string"
        ? existingIdentity.immutableSource.initialCausalSourceId
        : null;
    const dispatchRefId =
      initialCausalSourceId === input.causalSourceId
        ? null
        : await appendEscalationNudge(
            sessions,
            tx,
            input,
            existingIdentity,
            escalationIssue,
          );
    return {
      identity: existingIdentity,
      issue: escalationIssue,
      owner:
        escalationIssue.ownerKind === "agent" &&
        escalationIssue.ownerAgentId
          ? { kind: "agent", agentId: escalationIssue.ownerAgentId }
          : escalationIssue.ownerKind === "user" &&
              escalationIssue.ownerUserId
            ? { kind: "user", userId: escalationIssue.ownerUserId }
            : { kind: "board" },
      dispatchRefId,
      created: false,
    };
  }

  const owner = await resolveSystemEscalationOwnerInTransaction(
    tx,
    affected,
  );
  const selectedAgent =
    owner.kind === "agent"
      ? await requireSelectedAgentRevision(
          tx,
          input.companyId,
          owner.agentId,
        )
      : null;
  const now = clock();
  const company = await tx
    .select()
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (
    !company ||
    company.status !== "active" ||
    company.sessionIntegrityState !== "ready" ||
    company.hardDeleteFencedAt !== null
  ) {
    throw new PostgresSystemEscalationConflict(
      "Company Session lifecycle is not ready",
      "company_not_ready",
    );
  }

  const identityId = deterministicUuid(
    "system-escalation-identity",
    `${input.companyId}:${input.affectedIssueId}:${input.affectedOwnershipEpoch}`,
  );
  const escalationIssueId = deterministicUuid(
    "system-escalation-issue",
    identityId,
  );
  const sessionId = stableSessionId(`system-escalation:${identityId}`);
  const request = escalationRequest(
    affected,
    input.systemSource,
    terminalReason(edge.terminalReason),
  );
  const title = escalationTitle(affected);
  const maxIssueNumber = await tx
    .select({
      value: sql<number>`coalesce(max(${issues.issueNumber}), 0)`,
    })
    .from(issues)
    .where(eq(issues.companyId, input.companyId))
    .then((rows) => rows[0]?.value ?? 0);
  const issueNumber = Math.max(company.issueCounter, maxIssueNumber) + 1;
  await tx
    .update(companies)
    .set({ issueCounter: issueNumber, updatedAt: now })
    .where(eq(companies.id, input.companyId));
  const identifier = `${company.issuePrefix}-${issueNumber}`;

  const authorityId = selectedAgent
    ? deterministicUuid(
        "system-escalation-authority",
        `${escalationIssueId}:${selectedAgent.owner.id}`,
      )
    : null;
  const aggregate = await withEscalationWorkspaceReservationErrors(() =>
    persistCanonicalIssueAggregateInTx(tx, {
      issue: {
      id: escalationIssueId,
      companyId: input.companyId,
      parentId: null,
      projectId: null,
      goalId: null,
      title,
      request,
      boardPresentationStatus: "todo",
      lifecycleStatus: "open",
      disposition: null,
      priority: "medium",
      ownerKind: owner.kind,
      ownerAgentId:
        owner.kind === "agent" ? owner.agentId : null,
      ownerUserId: owner.kind === "user" ? owner.userId : null,
      ownerAssignmentSource: null,
      ownershipEpoch: 1,
      creatorKind: "system",
      creatorSystemSourceKind: input.systemSource,
      creatorSystemSourceId: `system-escalation:${identityId}`,
      escalatedFromAffectedIssueId: affected.id,
      escalatedFromTriggeringRunId: input.triggeringRunId,
      escalatedFromReason: edge.terminalReason,
      affectedOwnershipEpoch: input.affectedOwnershipEpoch,
      issueNumber,
      identifier,
      originKind: "system_escalation",
      originId: affected.id,
      originFingerprint: `${affected.id}:${input.affectedOwnershipEpoch}`,
      requestDepth: 0,
      createdAt: now,
      updatedAt: now,
      },
      session: {
        id: sessionId,
        parentSessionId: null,
        now,
      },
      workspaceReservation: {
        provenance: {
          agentId: null,
          userId: owner.kind === "user" ? owner.userId : null,
        },
      },
      authority:
        selectedAgent && authorityId
          ? {
              id: authorityId,
              agentId: selectedAgent.owner.id,
              auditAdapterConfigRevisionId:
                selectedAgent.revision.id,
              createdAt: now,
            }
          : null,
    }),
  );
  const escalationIssue = aggregate.issue;

  const identity = await tx
    .insert(systemEscalationIdentities)
    .values({
      id: identityId,
      companyId: input.companyId,
      affectedIssueId: affected.id,
      affectedOwnershipEpoch: input.affectedOwnershipEpoch,
      escalationIssueId: escalationIssue.id,
      systemSource: input.systemSource,
      triggeringRunId: input.triggeringRunId,
      terminalCreatorEdgeId: edge.id,
      immutableSource: {
        contract: "system-escalation/v1",
        reason: edge.terminalReason,
        terminalCreatorEdgeId: edge.id,
        terminalSourceKind: edge.terminalSourceKind,
        terminalSourceId: edge.terminalSourceId,
        systemSource: input.systemSource,
        triggeringRunId: input.triggeringRunId,
        initialCausalSourceId: input.causalSourceId,
      },
      createdAt: now,
    })
    .returning()
    .then((rows) => rows[0] ?? null);
  if (!identity) {
    throw new PostgresSystemEscalationConflict(
      "System escalation identity was not claimed",
      "escalation_identity_missing",
    );
  }

  let dispatchRefId: string | null = null;
  if (selectedAgent && authorityId) {
    const admitted = await admitIssueExecutionInTransaction({
      sessionAdmission: sessions,
      transaction: tx,
      work: {
        companyId: input.companyId,
        issueId: escalationIssue.id,
        sessionId,
        ownershipEpoch: 1,
        targetAgentId: selectedAgent.owner.id,
        issueExecutionAuthorityId: authorityId,
        consultExecutionId: null,
        adapterConfigRevisionId: selectedAgent.revision.id,
        contextEpoch: 0,
        mode: "owner",
        sourceKind: "issue_request",
        actor: {
          kind: "system",
          sourceKind: input.systemSource,
          sourceId: identity.id,
        },
        immutableSourceKey: identity.id,
        sourceRecordId: escalationIssue.id,
        exactText: escalationIssue.request!,
        comment: {
          author: sourceAuthor(input.systemSource),
          producingRun: null,
        },
        idempotencyKey: identity.id,
      },
    });
    dispatchRefId = admitted.ref?.id ?? null;
    if (!dispatchRefId) {
      throw new PostgresSystemEscalationConflict(
        "Agent-owned escalation did not persist its owner execution ref",
        "escalation_ref_missing",
      );
    }
  } else {
    await sessions.appendNonDispatchControlNotice(
      {
        companyId: input.companyId,
        issueId: escalationIssue.id,
        sessionId,
        sourceKind: "system_escalation_request",
        immutableSourceKey: identity.id,
        sourceRecordId: escalationIssue.id,
        exactText: escalationIssue.request!,
        comment: {
          author: sourceAuthor(input.systemSource),
          producingRun: null,
        },
        allowTerminal: false,
      },
      tx,
    );
  }

  await appendAffectedCrossLink(
    sessions,
    tx,
    input,
    affected,
    affectedSession.id,
    identity,
    escalationIssue,
  );
  return {
    identity,
    issue: escalationIssue,
    owner,
    dispatchRefId,
    created: true,
  };
}

export async function terminalizeCreatorEdgeInTransaction(
  tx: IssueSessionDbTransaction,
  sessions: IssueSessionAdmissionService,
  input: TerminalizeCreatorEdgeInput,
  clock: () => Date = () => new Date(),
): Promise<{
  edge: EdgeRow;
  escalation: SystemEscalationTransactionResult | null;
}> {
  const affected = await tx
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
  if (!affected || affected.ownershipEpoch !== input.ownershipEpoch) {
    throw new PostgresSystemEscalationConflict(
      "Creator edge no longer belongs to the current issue epoch",
      "creator_edge_epoch_stale",
    );
  }
  if (
    affected.lifecycleStatus !== "open" &&
    affected.lifecycleStatus !== "blocked" &&
    affected.lifecycleStatus !== "done" &&
    affected.lifecycleStatus !== "cancelled"
  ) {
    throw new PostgresSystemEscalationConflict(
      "Creator-edge terminalization requires a canonical issue lifecycle status",
      "creator_edge_issue_status_invalid",
    );
  }
  const current = await tx
    .select()
    .from(issueCreatorEdgeReceivability)
    .where(
      and(
        eq(issueCreatorEdgeReceivability.id, input.creatorEdgeId),
        eq(issueCreatorEdgeReceivability.companyId, input.companyId),
        eq(issueCreatorEdgeReceivability.issueId, input.issueId),
        eq(
          issueCreatorEdgeReceivability.ownershipEpoch,
          input.ownershipEpoch,
        ),
      ),
    )
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!current) {
    throw new PostgresSystemEscalationConflict(
      "Creator edge does not belong to this issue epoch",
      "creator_edge_scope_stale",
    );
  }
  if (
    current.endpointKind === "user/board" ||
    current.endpointKind === "system"
  ) {
    throw new PostgresSystemEscalationConflict(
      "User, board, and system creator edges are permanently inbox-receivable",
      "creator_edge_not_terminalizable",
    );
  }

  const now = clock();
  const issueIsNonterminal =
    affected.lifecycleStatus === "open" ||
    affected.lifecycleStatus === "blocked";
  let edge = current;
  if (edge.state === "terminal") {
    if (edge.terminalReason !== input.reason) {
      throw new PostgresSystemEscalationConflict(
        "Creator-edge terminal reason is immutable",
        "creator_edge_terminal_reason_conflict",
      );
    }
  } else if (issueIsNonterminal) {
    edge = await tx
      .update(issueCreatorEdgeReceivability)
      .set({
        state: "terminal",
        terminalReason: input.reason,
        terminalSourceKind: input.sourceKind,
        terminalSourceId: input.sourceId,
        terminalAudit: input.audit ?? {},
        endpointTombstone: input.endpointTombstone ?? null,
        terminalizedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(issueCreatorEdgeReceivability.id, current.id),
          eq(issueCreatorEdgeReceivability.state, "receivable"),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null) as EdgeRow;
    if (!edge) {
      throw new PostgresSystemEscalationConflict(
        "Creator-edge terminalization lost its compare-and-set race",
        "creator_edge_terminalization_conflict",
      );
    }
  }

  const escalation = issueIsNonterminal
    ? await ensureSystemEscalationInTransaction(
        tx,
        sessions,
        {
          companyId: input.companyId,
          affectedIssueId: input.issueId,
          affectedOwnershipEpoch: input.ownershipEpoch,
          terminalCreatorEdgeId: edge.id,
          systemSource: input.systemSource,
          triggeringRunId: input.triggeringRunId,
          causalSourceId: input.sourceId,
        },
        clock,
      )
    : null;
  return { edge, escalation };
}

export async function terminalizeAgentCreatorEdgesInTransaction(
  tx: IssueSessionDbTransaction,
  sessions: IssueSessionAdmissionService,
  input: {
    companyId: string;
    agentId: string;
    sourceId: string;
    now: Date;
  },
): Promise<SystemEscalationTransactionResult[]> {
  const authorityRows = await tx
    .select({ id: issueExecutionAuthorities.id })
    .from(issueExecutionAuthorities)
    .where(
      and(
        eq(issueExecutionAuthorities.companyId, input.companyId),
        eq(issueExecutionAuthorities.agentId, input.agentId),
      ),
    )
    .orderBy(asc(issueExecutionAuthorities.id))
    .for("update");
  const authorityIds = authorityRows.map((authority) => authority.id);
  if (authorityIds.length === 0) return [];
  const edges = await tx
    .select({ edge: issueCreatorEdgeReceivability })
    .from(issueCreatorEdgeReceivability)
    .innerJoin(
      issues,
      and(
        eq(issues.companyId, issueCreatorEdgeReceivability.companyId),
        eq(issues.id, issueCreatorEdgeReceivability.issueId),
        eq(
          issues.ownershipEpoch,
          issueCreatorEdgeReceivability.ownershipEpoch,
        ),
      ),
    )
    .where(
      and(
        eq(issueCreatorEdgeReceivability.companyId, input.companyId),
        eq(issueCreatorEdgeReceivability.endpointKind, "agent-execution"),
        inArray(issueCreatorEdgeReceivability.endpointId, authorityIds),
        eq(issueCreatorEdgeReceivability.state, "receivable"),
      ),
    )
    .orderBy(
      asc(issueCreatorEdgeReceivability.issueId),
      asc(issueCreatorEdgeReceivability.ownershipEpoch),
      asc(issueCreatorEdgeReceivability.id),
    );
  const seenIssues = new Set<string>();
  const escalations: SystemEscalationTransactionResult[] = [];
  for (const row of edges) {
    if (seenIssues.has(row.edge.issueId)) continue;
    seenIssues.add(row.edge.issueId);
    const result = await terminalizeCreatorEdgeInTransaction(
      tx,
      sessions,
      {
        companyId: input.companyId,
        issueId: row.edge.issueId,
        ownershipEpoch: row.edge.ownershipEpoch,
        creatorEdgeId: row.edge.id,
        reason: "agent_terminated",
        sourceKind: "agent_tombstone",
        sourceId: input.sourceId,
        systemSource: "recovery",
        triggeringRunId: null,
        endpointTombstone: {
          agentId: input.agentId,
          status: "terminated",
        },
        audit: {
          agentId: input.agentId,
          terminalReason: "agent_terminated",
        },
      },
      () => input.now,
    );
    if (result.escalation) escalations.push(result.escalation);
  }
  return escalations;
}

export async function terminalizePluginCreatorEdgesInTransaction(
  tx: IssueSessionDbTransaction,
  sessions: IssueSessionAdmissionService,
  input: {
    pluginInstallationId: string;
    reason: "plugin_disabled" | "plugin_uninstalled";
    sourceId: string;
    now: Date;
  },
): Promise<SystemEscalationTransactionResult[]> {
  const edges = await tx
    .select({ edge: issueCreatorEdgeReceivability })
    .from(issueCreatorEdgeReceivability)
    .innerJoin(
      issues,
      and(
        eq(issues.companyId, issueCreatorEdgeReceivability.companyId),
        eq(issues.id, issueCreatorEdgeReceivability.issueId),
        eq(
          issues.ownershipEpoch,
          issueCreatorEdgeReceivability.ownershipEpoch,
        ),
      ),
    )
    .where(
      and(
        eq(issueCreatorEdgeReceivability.endpointKind, "plugin"),
        eq(
          issueCreatorEdgeReceivability.endpointId,
          input.pluginInstallationId,
        ),
        eq(issueCreatorEdgeReceivability.state, "receivable"),
      ),
    )
    .orderBy(
      asc(issueCreatorEdgeReceivability.companyId),
      asc(issueCreatorEdgeReceivability.issueId),
      asc(issueCreatorEdgeReceivability.ownershipEpoch),
      asc(issueCreatorEdgeReceivability.id),
    );
  const seenIssues = new Set<string>();
  const escalations: SystemEscalationTransactionResult[] = [];
  for (const row of edges) {
    const issueKey = `${row.edge.companyId}:${row.edge.issueId}`;
    if (seenIssues.has(issueKey)) continue;
    seenIssues.add(issueKey);
    const result = await terminalizeCreatorEdgeInTransaction(
      tx,
      sessions,
      {
        companyId: row.edge.companyId,
        issueId: row.edge.issueId,
        ownershipEpoch: row.edge.ownershipEpoch,
        creatorEdgeId: row.edge.id,
        reason: input.reason,
        sourceKind: "plugin_lifecycle",
        sourceId: input.sourceId,
        systemSource: "recovery",
        triggeringRunId: null,
        endpointTombstone: {
          pluginInstallationId: input.pluginInstallationId,
          status:
            input.reason === "plugin_disabled"
              ? "disabled"
              : "deleted",
        },
        audit: {
          pluginInstallationId: input.pluginInstallationId,
          terminalReason: input.reason,
        },
      },
      () => input.now,
    );
    if (result.escalation) escalations.push(result.escalation);
  }
  return escalations;
}

export async function terminalizeRoutineCreatorEdgesInTransaction(
  tx: IssueSessionDbTransaction,
  sessions: IssueSessionAdmissionService,
  input: {
    companyId: string;
    routineId: string;
    sourceId: string;
    now: Date;
  },
): Promise<SystemEscalationTransactionResult[]> {
  const edges = await tx
    .select({ edge: issueCreatorEdgeReceivability })
    .from(issueCreatorEdgeReceivability)
    .innerJoin(
      issues,
      and(
        eq(issues.companyId, issueCreatorEdgeReceivability.companyId),
        eq(issues.id, issueCreatorEdgeReceivability.issueId),
        eq(
          issues.ownershipEpoch,
          issueCreatorEdgeReceivability.ownershipEpoch,
        ),
      ),
    )
    .where(
      and(
        eq(issueCreatorEdgeReceivability.companyId, input.companyId),
        eq(issueCreatorEdgeReceivability.endpointKind, "routine"),
        eq(issueCreatorEdgeReceivability.endpointId, input.routineId),
        eq(issueCreatorEdgeReceivability.state, "receivable"),
      ),
    )
    .orderBy(
      asc(issueCreatorEdgeReceivability.issueId),
      asc(issueCreatorEdgeReceivability.ownershipEpoch),
      asc(issueCreatorEdgeReceivability.id),
    );
  const seenIssues = new Set<string>();
  const escalations: SystemEscalationTransactionResult[] = [];
  for (const row of edges) {
    if (seenIssues.has(row.edge.issueId)) continue;
    seenIssues.add(row.edge.issueId);
    const result = await terminalizeCreatorEdgeInTransaction(
      tx,
      sessions,
      {
        companyId: row.edge.companyId,
        issueId: row.edge.issueId,
        ownershipEpoch: row.edge.ownershipEpoch,
        creatorEdgeId: row.edge.id,
        reason: "routine_deleted",
        sourceKind: "routine_lifecycle",
        sourceId: input.sourceId,
        systemSource: "recovery",
        triggeringRunId: null,
        endpointTombstone: {
          routineId: input.routineId,
          status: "archived",
        },
        audit: {
          routineId: input.routineId,
          terminalReason: "routine_deleted",
        },
      },
      () => input.now,
    );
    if (result.escalation) escalations.push(result.escalation);
  }
  return escalations;
}

async function inspectEndpointTerminality(
  tx: IssueSessionDbTransaction,
  edge: EdgeRow,
): Promise<{
  reason: IssueCreatorEdgeTerminalReason;
  tombstone: Record<string, unknown>;
} | null> {
  if (edge.endpointKind === "agent-execution") {
    const authority = edge.endpointId
      ? await tx
          .select()
          .from(issueExecutionAuthorities)
          .where(
            and(
              eq(
                issueExecutionAuthorities.companyId,
                edge.companyId,
              ),
              eq(issueExecutionAuthorities.id, edge.endpointId),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : null;
    if (!authority || authority.state !== "current") {
      return {
        reason: "creator_execution_superseded",
        tombstone: {
          authorityId: edge.endpointId,
          state: authority?.state ?? "missing",
          revocationReason: authority?.revocationReason ?? null,
        },
      };
    }
    const agent = await tx
      .select({ id: agents.id, status: agents.status })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, edge.companyId),
          eq(agents.id, authority.agentId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!agent || agent.status === "terminated") {
      return {
        reason: agent ? "agent_terminated" : "agent_deleted",
        tombstone: {
          authorityId: authority.id,
          agentId: authority.agentId,
          status: agent?.status ?? "deleted",
        },
      };
    }
    return null;
  }
  if (edge.endpointKind === "plugin") {
    const plugin = edge.endpointId
      ? await tx
          .select()
          .from(plugins)
          .where(eq(plugins.id, edge.endpointId))
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : null;
    if (!plugin) {
      return {
        reason: "plugin_uninstalled",
        tombstone: {
          pluginInstallationId: edge.endpointId,
          status: "missing",
        },
      };
    }
    if (plugin.status === "disabled") {
      return {
        reason: "plugin_disabled",
        tombstone: {
          pluginInstallationId: plugin.id,
          status: plugin.status,
        },
      };
    }
    return null;
  }
  if (edge.endpointKind === "routine") {
    const routine = edge.endpointId
      ? await tx
          .select()
          .from(routines)
          .where(
            and(
              eq(routines.companyId, edge.companyId),
              eq(routines.id, edge.endpointId),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : null;
    if (!routine || routine.status === "archived") {
      return {
        reason: "routine_deleted",
        tombstone: {
          routineId: edge.endpointId,
          status: routine?.status ?? "missing",
        },
      };
    }
  }
  return null;
}

export function createPostgresSystemEscalationService(
  db: Db,
  options: PostgresSystemEscalationOptions,
) {
  const clock = options.clock ?? (() => new Date());
  const sessions = createIssueSessionAdmissionService(db, { clock });

  async function dispatch(refId: string | null): Promise<void> {
    if (refId) await options.dispatchRef(refId);
  }

  return {
    async ensure(
      input: EnsureSystemEscalationInput,
    ): Promise<SystemEscalationTransactionResult> {
      const result = await db.transaction((tx) =>
        ensureSystemEscalationInTransaction(
          tx,
          sessions,
          input,
          clock,
        ),
      );
      await dispatch(result.dispatchRefId);
      return result;
    },

    async terminalizeCreatorEdge(input: TerminalizeCreatorEdgeInput) {
      const result = await db.transaction((tx) =>
        terminalizeCreatorEdgeInTransaction(
          tx,
          sessions,
          input,
          clock,
        ),
      );
      await dispatch(result.escalation?.dispatchRefId ?? null);
      return result;
    },

    async reconcile(input: { limit?: number } = {}) {
      const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
      const candidates = await db
        .select({
          edge: issueCreatorEdgeReceivability,
          issueLifecycleStatus: issues.lifecycleStatus,
          issueOwnershipEpoch: issues.ownershipEpoch,
        })
        .from(issueCreatorEdgeReceivability)
        .innerJoin(
          issues,
          and(
            eq(issues.companyId, issueCreatorEdgeReceivability.companyId),
            eq(issues.id, issueCreatorEdgeReceivability.issueId),
            eq(
              issues.ownershipEpoch,
              issueCreatorEdgeReceivability.ownershipEpoch,
            ),
          ),
        )
        .where(
          sql`${issueCreatorEdgeReceivability.endpointKind} not in ('user/board', 'system')`,
        )
        .orderBy(
          asc(issueCreatorEdgeReceivability.companyId),
          asc(issueCreatorEdgeReceivability.issueId),
          asc(issueCreatorEdgeReceivability.ownershipEpoch),
          asc(issueCreatorEdgeReceivability.id),
        )
        .limit(limit);
      const dispatchRefIds: string[] = [];
      let terminalized = 0;
      let ensured = 0;
      for (const candidate of candidates) {
        const result = await db.transaction(async (tx) => {
          const issue = await tx
            .select()
            .from(issues)
            .where(
              and(
                eq(issues.companyId, candidate.edge.companyId),
                eq(issues.id, candidate.edge.issueId),
              ),
            )
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (
            !issue ||
            issue.ownershipEpoch !== candidate.edge.ownershipEpoch
          ) {
            return null;
          }
          const edge = await tx
            .select()
            .from(issueCreatorEdgeReceivability)
            .where(
              and(
                eq(
                  issueCreatorEdgeReceivability.id,
                  candidate.edge.id,
                ),
                eq(
                  issueCreatorEdgeReceivability.companyId,
                  issue.companyId,
                ),
                eq(
                  issueCreatorEdgeReceivability.issueId,
                  issue.id,
                ),
                eq(
                  issueCreatorEdgeReceivability.ownershipEpoch,
                  issue.ownershipEpoch,
                ),
              ),
            )
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (!edge) return null;
          if (edge.state === "terminal") {
            if (!isIssueCreatorEdgeTerminalReason(edge.terminalReason)) {
              throw new PostgresSystemEscalationConflict(
                "Terminal creator edge has no canonical terminal reason",
                "creator_edge_reason_not_escalating",
              );
            }
            const terminalizedResult = await terminalizeCreatorEdgeInTransaction(
              tx,
              sessions,
              {
                companyId: edge.companyId,
                issueId: edge.issueId,
                ownershipEpoch: edge.ownershipEpoch,
                creatorEdgeId: edge.id,
                reason: edge.terminalReason,
                sourceKind: "creator_edge_reconciler",
                sourceId: `reconcile:${edge.id}`,
                systemSource: "recovery",
                triggeringRunId: null,
                audit: { reconciled: true },
              },
              clock,
            );
            return {
              terminalized: false,
              escalation: terminalizedResult.escalation,
            };
          }
          const endpoint = await inspectEndpointTerminality(tx, edge);
          if (!endpoint) return null;
          const terminalizedResult =
            await terminalizeCreatorEdgeInTransaction(
              tx,
              sessions,
              {
                companyId: edge.companyId,
                issueId: edge.issueId,
                ownershipEpoch: edge.ownershipEpoch,
                creatorEdgeId: edge.id,
                reason: endpoint.reason,
                sourceKind: "creator_endpoint_reconciler",
                sourceId: `reconcile:${edge.id}`,
                systemSource: "recovery",
                triggeringRunId: null,
                endpointTombstone: endpoint.tombstone,
                audit: { reconciled: true },
              },
              clock,
            );
          return {
            terminalized:
              issue.lifecycleStatus === "open" ||
              issue.lifecycleStatus === "blocked",
            escalation: terminalizedResult.escalation,
          };
        });
        if (!result?.escalation) continue;
        if (result.terminalized) terminalized += 1;
        ensured += 1;
        if (result.escalation.dispatchRefId) {
          dispatchRefIds.push(result.escalation.dispatchRefId);
        }
      }
      for (const refId of dispatchRefIds) {
        await dispatch(refId);
      }
      return {
        inspected: candidates.length,
        terminalized,
        ensured,
        dispatchRefIds,
      };
    },
  };
}

export type PostgresSystemEscalationService = ReturnType<
  typeof createPostgresSystemEscalationService
>;
