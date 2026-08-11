import { createHash } from "node:crypto";
import {
  agentAdapterConfigRevisions,
  agents,
  companies,
  executionWorkspaces,
  issueCommentProjectionSources,
  issueComments,
  issueConsultExecutions,
  issueExecutionAuthorities,
  issueExecutionHistoryViewMessages,
  issueExecutionHistoryViews,
  issueExecutionRefs,
  issueExecutionRunRefs,
  issueExecutionWorkspaceBindings,
  issues,
  issueSessionEvents,
  issueSessionContextEpochs,
  issueSessionEventSequences,
  issueSessionInputDispositions,
  issueSessionInputs,
  issueSessions,
  type Db,
} from "@paperclipai/db";
import * as IssueSession from "@paperclipai/shared/issue-session";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { evaluateAgentInvokability } from "../agent-invokability.js";
import type { IssueSessionCommentProjectionInput } from "./projector.js";
import {
  decodeStoredIssueSessionEvent,
  reserveIssueSessionEventSequence,
  type IssueSessionDbTransaction,
} from "./event-store.js";
import { publishIssueSessionEventInTx } from "./publication.js";
import {
  canonicalIssueSessionJson,
  IssueSessionInvariantError,
  IssueSessionLifecycleConflict,
} from "./store.js";
import {
  lockActiveIssueExecutionRunsForRefInTransaction,
  readIssueExecutionRun,
  readOccupiedIssueExecutionRefIds,
} from "../issue-execution-run-service.js";

export interface IssueSessionInputScope {
  companyId: string;
  issueId: string;
  sessionId: string;
  activeRefId: string;
  runId: string;
  ownershipEpoch: number;
  executionLineageId: string;
  adapterConfigRevisionId: string;
  historyViewId: string;
  contextGeneration: number;
}

export interface IssueSessionPreparedInputScope {
  companyId: string;
  issueId: string;
  sessionId: string;
  refId: string;
  ownershipEpoch: number;
  executionLineageId: string;
  adapterConfigRevisionId: string;
  historyViewId: string;
  contextGeneration: number;
}

export interface IssueSessionPendingState {
  steer: boolean;
  queue: boolean;
}

export type IssueSessionInputRecord = typeof issueSessionInputs.$inferSelect;

export interface IssueSessionInputService {
  /**
   * Promotes the held source of one freshly prepared ref before it can be
   * leased. Returns false when the locked ref needs no promotion.
   */
  promotePreparedInput(
    scope: IssueSessionPreparedInputScope,
  ): Promise<boolean>;
  /**
   * Captures the canonical event boundary for a completed provider turn.
   * Inputs admitted after this value must not be promoted at that boundary.
   */
  latestSequence(scope: IssueSessionInputScope): Promise<number>;
  hasPending(scope: IssueSessionInputScope): Promise<IssueSessionPendingState>;
  promoteSteers(
    scope: IssueSessionInputScope,
    cutoffSeq: number,
  ): Promise<IssueSessionInputRecord[]>;
  /**
   * Promotes one FIFO queue input only when no eligible steer is pending.
   * Returning null never licenses an empty provider turn.
   */
  promoteNextQueued(
    scope: IssueSessionInputScope,
  ): Promise<IssueSessionInputRecord | null>;
}

type RefRow = typeof issueExecutionRefs.$inferSelect;
type ViewRow = typeof issueExecutionHistoryViews.$inferSelect;
type DispositionRow = typeof issueSessionInputDispositions.$inferSelect;

interface ActiveExecution {
  ref: RefRow;
  view: ViewRow;
  runId: string | null;
}

interface PendingCandidate {
  inbox: IssueSessionInputRecord;
  disposition: DispositionRow;
  ref: RefRow;
  view: ViewRow;
}

interface ValidatedExecutionScope
  extends Omit<IssueSessionInputScope, "runId"> {
  runId: string | null;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(canonicalIssueSessionJson(value))
    .digest("hex");
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

function sameNullableValue(
  left: string | number | null,
  right: string | number | null,
): boolean {
  return left === right;
}

async function validateActiveExecution(
  transaction: IssueSessionDbTransaction,
  scope: ValidatedExecutionScope,
): Promise<ActiveExecution> {
  await transaction.execute(sql`
    SELECT id
    FROM companies
    WHERE id = ${scope.companyId}
    FOR UPDATE
  `);
  const refs = await transaction
    .select()
    .from(issueExecutionRefs)
    .where(eq(issueExecutionRefs.id, scope.activeRefId))
    .limit(1)
    .for("update");
  const ref = refs[0];
  if (
    !ref ||
    ref.companyId !== scope.companyId ||
    ref.issueId !== scope.issueId ||
    ref.sessionId !== scope.sessionId ||
    ref.ownershipEpoch !== scope.ownershipEpoch ||
    ref.executionLineageId !== scope.executionLineageId ||
    ref.adapterConfigRevisionId !== scope.adapterConfigRevisionId ||
    ref.historyViewId !== scope.historyViewId ||
    ref.contextEpoch !== scope.contextGeneration ||
    ref.disposition !== "active"
  ) {
    throw new IssueSessionLifecycleConflict(
      "Issue Session input processing requires its exact eligible execution ref",
      { refId: scope.activeRefId, runId: scope.runId },
    );
  }

  const activeMembershipRows =
    await lockActiveIssueExecutionRunsForRefInTransaction(transaction, {
      companyId: scope.companyId,
      issueId: scope.issueId,
      sessionId: scope.sessionId,
      refId: scope.activeRefId,
    });
  const activeMembership = activeMembershipRows[0] ?? null;
  if (
    activeMembershipRows.length > 1 ||
    (scope.runId === null
      ? activeMembership !== null && ref.promotedSeq === null
      : !activeMembership ||
        activeMembership.runId !== scope.runId ||
        activeMembership.status !== "running" ||
        activeMembership.currentAttemptId === null ||
        activeMembership.currentLeaseId === null)
  ) {
    throw new IssueSessionLifecycleConflict(
      "Issue Session input processing requires its exact canonical run membership",
      { refId: scope.activeRefId, runId: scope.runId },
    );
  }

  const [
    companyRows,
    issueRows,
    sessionRows,
    viewRows,
    runRows,
    contextRows,
    revisionRows,
    companyAgentRows,
    workspaceRows,
  ] = await Promise.all([
    transaction
      .select()
      .from(companies)
      .where(eq(companies.id, scope.companyId))
      .limit(1),
    transaction
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, scope.companyId),
          eq(issues.id, scope.issueId),
        ),
      )
      .limit(1),
    transaction
      .select()
      .from(issueSessions)
      .where(
        and(
          eq(issueSessions.companyId, scope.companyId),
          eq(issueSessions.issueId, scope.issueId),
          eq(issueSessions.id, scope.sessionId),
        ),
      )
      .limit(1),
    transaction
      .select()
      .from(issueExecutionHistoryViews)
      .where(eq(issueExecutionHistoryViews.id, scope.historyViewId))
      .limit(1),
    scope.runId === null
      ? Promise.resolve([])
      : readIssueExecutionRun(transaction, {
          companyId: scope.companyId,
          issueId: scope.issueId,
          runId: scope.runId,
        }).then((run) => (run ? [run] : [])),
    transaction
      .select()
      .from(issueSessionContextEpochs)
      .where(eq(issueSessionContextEpochs.sessionId, scope.sessionId))
      .limit(1),
    transaction
      .select()
      .from(agentAdapterConfigRevisions)
      .where(
        and(
          eq(agentAdapterConfigRevisions.companyId, scope.companyId),
          eq(agentAdapterConfigRevisions.agentId, ref.targetAgentId),
          eq(
            agentAdapterConfigRevisions.id,
            scope.adapterConfigRevisionId,
          ),
        ),
      )
      .limit(1),
    transaction
      .select({
        id: agents.id,
        companyId: agents.companyId,
        name: agents.name,
        reportsTo: agents.reportsTo,
        status: agents.status,
        currentAdapterConfigRevisionId:
          agents.currentAdapterConfigRevisionId,
      })
      .from(agents)
      .where(eq(agents.companyId, scope.companyId)),
    transaction
      .select({
        binding: issueExecutionWorkspaceBindings,
        workspace: executionWorkspaces,
      })
      .from(issueExecutionWorkspaceBindings)
      .innerJoin(
        executionWorkspaces,
        and(
          eq(
            executionWorkspaces.id,
            issueExecutionWorkspaceBindings.executionWorkspaceId,
          ),
          eq(
            executionWorkspaces.companyId,
            issueExecutionWorkspaceBindings.companyId,
          ),
        ),
      )
      .where(
        and(
          eq(issueExecutionWorkspaceBindings.companyId, scope.companyId),
          eq(issueExecutionWorkspaceBindings.issueId, scope.issueId),
          eq(issueExecutionWorkspaceBindings.sessionId, scope.sessionId),
          eq(
            issueExecutionWorkspaceBindings.ownershipEpoch,
            scope.ownershipEpoch,
          ),
        ),
      )
      .limit(1),
  ]);
  const company = companyRows[0];
  const issue = issueRows[0];
  const session = sessionRows[0];
  const view = viewRows[0];
  const run = runRows[0];
  const context = contextRows[0];
  const revision = revisionRows[0];
  const target = companyAgentRows.find((agent) => agent.id === ref.targetAgentId);
  const invokability = evaluateAgentInvokability(target, companyAgentRows);
  const workspace = workspaceRows[0];
  if (
    !company ||
    company.status !== "active" ||
    company.sessionIntegrityState !== "ready" ||
    company.hardDeleteFencedAt !== null ||
    !issue ||
    issue.hiddenAt !== null ||
    (issue.lifecycleStatus !== "open" &&
      issue.lifecycleStatus !== "blocked") ||
    issue.ownershipEpoch !== scope.ownershipEpoch ||
    !session ||
    session.integrityState !== "ready" ||
    session.refAdmittableAt === null ||
    session.timeArchived !== null ||
    session.purgeFencedAt !== null ||
    !view ||
    view.companyId !== scope.companyId ||
    view.issueId !== scope.issueId ||
    view.sessionId !== scope.sessionId ||
    view.refId !== ref.id ||
    view.executionLineageId !== scope.executionLineageId ||
    view.contextEpoch !== scope.contextGeneration ||
    view.sourceHighWaterSeq !== ref.admissionHighWaterSeq ||
    !["empty", "current"].includes(view.state) ||
    (scope.runId !== null &&
      (!run ||
        run.companyId !== scope.companyId ||
        run.targetAgentId !== ref.targetAgentId ||
        run.kind !== "productive" ||
        run.status !== "running")) ||
    !context ||
    context.companyId !== scope.companyId ||
    context.issueId !== scope.issueId ||
    context.generation !== scope.contextGeneration ||
    !revision ||
    !invokability.invokable ||
    !workspace ||
    !workspace.binding.absoluteCwd.startsWith("/")
  ) {
    throw new IssueSessionLifecycleConflict(
      "Issue Session input processing lost its live company, issue, session, view, run, revision, workspace, or context scope",
      { refId: scope.activeRefId, runId: scope.runId },
    );
  }

  if (ref.mode === "owner") {
    if (
      ref.issueExecutionAuthorityId === null ||
      ref.consultExecutionId !== null ||
      issue.ownerKind !== "agent" ||
      issue.ownerAgentId !== ref.targetAgentId
    ) {
      throw new IssueSessionLifecycleConflict(
        "Issue Session owner input scope no longer matches the current owner",
        { refId: ref.id },
      );
    }
    const authorities = await transaction
      .select({ id: issueExecutionAuthorities.id })
      .from(issueExecutionAuthorities)
      .where(
        and(
          eq(issueExecutionAuthorities.companyId, scope.companyId),
          eq(issueExecutionAuthorities.issueId, scope.issueId),
          eq(issueExecutionAuthorities.sessionId, scope.sessionId),
          eq(
            issueExecutionAuthorities.ownershipEpoch,
            scope.ownershipEpoch,
          ),
          eq(issueExecutionAuthorities.agentId, ref.targetAgentId),
          eq(
            issueExecutionAuthorities.id,
            ref.issueExecutionAuthorityId,
          ),
          eq(issueExecutionAuthorities.state, "current"),
        ),
      )
      .limit(1);
    if (!authorities[0]) {
      throw new IssueSessionLifecycleConflict(
        "Issue Session input owner authority is revoked or stale",
        { refId: ref.id },
      );
    }
  } else if (ref.mode === "consult") {
    if (
      ref.issueExecutionAuthorityId !== null ||
      ref.consultExecutionId === null ||
      ref.consultCallerRefId === null ||
      ref.consultChainToken === null
    ) {
      throw new IssueSessionLifecycleConflict(
        "Issue Session consult input scope is incomplete",
        { refId: ref.id },
      );
    }
    const consults = await transaction
      .select({ id: issueConsultExecutions.id })
      .from(issueConsultExecutions)
      .where(
        and(
          eq(issueConsultExecutions.companyId, scope.companyId),
          eq(issueConsultExecutions.issueId, scope.issueId),
          eq(issueConsultExecutions.sessionId, scope.sessionId),
          eq(issueConsultExecutions.id, ref.consultExecutionId),
          eq(
            issueConsultExecutions.ownershipEpoch,
            scope.ownershipEpoch,
          ),
          eq(issueConsultExecutions.targetAgentId, ref.targetAgentId),
          eq(
            issueConsultExecutions.adapterConfigRevisionId,
            scope.adapterConfigRevisionId,
          ),
          eq(
            issueConsultExecutions.sourceRefId,
            ref.consultCallerRefId,
          ),
          eq(issueConsultExecutions.chainToken, ref.consultChainToken),
          eq(issueConsultExecutions.state, "active"),
        ),
      )
      .limit(1);
    if (!consults[0]) {
      throw new IssueSessionLifecycleConflict(
        "Issue Session consult input binding is closed or stale",
        { refId: ref.id },
      );
    }
  } else {
    throw new IssueSessionLifecycleConflict(
      "Issue Session input execution mode is invalid",
      { refId: ref.id, mode: ref.mode },
    );
  }

  return { ref, view, runId: scope.runId };
}

function sameOwnerCarryLineage(
  active: ActiveExecution,
  candidate: PendingCandidate,
): boolean {
  const { ref: activeRef, view: activeView } = active;
  const { ref, view } = candidate;
  return (
    activeRef.mode === "owner" &&
    ref.mode === "owner" &&
    activeRef.issueExecutionAuthorityId !== null &&
    activeRef.issueExecutionAuthorityId === ref.issueExecutionAuthorityId &&
    activeRef.companyId === ref.companyId &&
    activeRef.issueId === ref.issueId &&
    activeRef.sessionId === ref.sessionId &&
    activeRef.ownershipEpoch === ref.ownershipEpoch &&
    activeRef.targetAgentId === ref.targetAgentId &&
    activeRef.adapterConfigRevisionId === ref.adapterConfigRevisionId &&
    activeRef.contextEpoch === ref.contextEpoch &&
    activeRef.executionLineageId === ref.executionLineageId &&
    sameNullableValue(
      activeRef.counterpartIssueId,
      ref.counterpartIssueId,
    ) &&
    sameNullableValue(
      activeRef.counterpartAuthorityId,
      ref.counterpartAuthorityId,
    ) &&
    sameNullableValue(
      activeRef.counterpartOwnershipEpoch,
      ref.counterpartOwnershipEpoch,
    ) &&
    activeView.effectiveDialSnapshot?.carry_context === true &&
    view.effectiveDialSnapshot?.carry_context === true &&
    activeView.effectiveDialDigest === view.effectiveDialDigest
  );
}

function candidateMatchesScope(
  active: ActiveExecution,
  candidate: PendingCandidate,
  candidateHasActiveRun: boolean,
): boolean {
  const { inbox, disposition, ref, view } = candidate;
  const sameRef = ref.id === active.ref.id;
  const leaseable = sameRef
    ? candidateHasActiveRun === (active.runId !== null)
    : !candidateHasActiveRun;
  return (
    disposition.state === "active" &&
    disposition.sourceRefId === ref.id &&
    inbox.companyId === active.ref.companyId &&
    inbox.issueId === active.ref.issueId &&
    inbox.sessionId === active.ref.sessionId &&
    inbox.promotedSeq === null &&
    ref.inputId === inbox.id &&
    ref.admittedSeq === inbox.admittedSeq &&
    ref.promotedSeq === null &&
    ref.disposition === "active" &&
    leaseable &&
    view.id === ref.historyViewId &&
    view.companyId === inbox.companyId &&
    view.issueId === inbox.issueId &&
    view.sessionId === inbox.sessionId &&
    view.refId === ref.id &&
    view.executionLineageId === ref.executionLineageId &&
    view.contextEpoch === ref.contextEpoch &&
    view.sourceHighWaterSeq === ref.admissionHighWaterSeq &&
    view.sourceMessageId === inbox.id &&
    view.sourceInputId === inbox.id &&
    view.sourceAdmittedSeq === inbox.admittedSeq &&
    view.sourcePromotedSeq === null &&
    ["empty", "current"].includes(view.state) &&
    (sameRef || sameOwnerCarryLineage(active, candidate))
  );
}

async function loadPendingCandidates(
  transaction: IssueSessionDbTransaction,
  active: ActiveExecution,
): Promise<PendingCandidate[]> {
  const rows = await transaction
    .select({
      inbox: issueSessionInputs,
      disposition: issueSessionInputDispositions,
      ref: issueExecutionRefs,
      view: issueExecutionHistoryViews,
    })
    .from(issueSessionInputs)
    .innerJoin(
      issueSessionInputDispositions,
      eq(issueSessionInputDispositions.inputId, issueSessionInputs.id),
    )
    .innerJoin(
      issueExecutionRefs,
      eq(issueExecutionRefs.id, issueSessionInputDispositions.sourceRefId),
    )
    .innerJoin(
      issueExecutionHistoryViews,
      eq(issueExecutionHistoryViews.id, issueExecutionRefs.historyViewId),
    )
    .where(
      and(
        eq(issueSessionInputs.companyId, active.ref.companyId),
        eq(issueSessionInputs.issueId, active.ref.issueId),
        eq(issueSessionInputs.sessionId, active.ref.sessionId),
        isNull(issueSessionInputs.promotedSeq),
        eq(issueSessionInputDispositions.state, "active"),
      ),
    )
    .orderBy(asc(issueSessionInputs.admittedSeq))
    .for("update");
  const candidateRefIds = [...new Set(rows.map((row) => row.ref.id))];
  const occupiedRefIds = new Set(
    await readOccupiedIssueExecutionRefIds(transaction, {
      companyId: active.ref.companyId,
      issueId: active.ref.issueId,
      sessionId: active.ref.sessionId,
      refIds: candidateRefIds,
    }),
  );
  return rows.filter((candidate) =>
    candidateMatchesScope(
      active,
      candidate,
      occupiedRefIds.has(candidate.ref.id),
    ),
  );
}

async function promoteCandidate(
  transaction: IssueSessionDbTransaction,
  candidate: PendingCandidate,
  now: Date,
): Promise<IssueSessionInputRecord> {
  const { inbox, ref, view } = candidate;
  const comments = await transaction
    .select({
      comment: issueComments,
      source: issueCommentProjectionSources,
    })
    .from(issueComments)
    .innerJoin(
      issueCommentProjectionSources,
      eq(issueCommentProjectionSources.commentId, issueComments.id),
    )
    .where(
      and(
        eq(issueComments.companyId, inbox.companyId),
        eq(issueComments.issueId, inbox.issueId),
        eq(issueComments.sessionId, inbox.sessionId),
        eq(issueComments.canonicalMessageId, inbox.id),
      ),
    )
    .limit(1);
  const comment = comments[0]?.comment;
  const commentSource = comments[0]?.source;
  if (
    !comment ||
    !commentSource ||
    commentSource.sourceKind !== comment.canonicalSourceKind ||
    commentSource.sourceId !== comment.canonicalSourceId ||
    commentSource.messageId !== inbox.id
  ) {
    throw new IssueSessionInvariantError(
      `Admitted input ${inbox.id} has no stable projected comment`,
    );
  }
  const admittedEvent = await transaction
    .select()
    .from(issueSessionEvents)
    .where(
      and(
        eq(issueSessionEvents.companyId, inbox.companyId),
        eq(issueSessionEvents.issueId, inbox.issueId),
        eq(issueSessionEvents.sessionId, inbox.sessionId),
        eq(issueSessionEvents.seq, inbox.admittedSeq),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const admitted =
    admittedEvent ? decodeStoredIssueSessionEvent(admittedEvent) : null;
  if (
    !admittedEvent ||
    admitted?.event.type !== IssueSession.Event.PromptAdmitted.type ||
    (admitted.event.data as { messageID?: unknown }).messageID !== inbox.id ||
    admittedEvent.sourceKind !== ref.sourceKind ||
    admittedEvent.sourceId !== ref.sourceId ||
    admittedEvent.runId !== comment.runId ||
    (comment.authorType === "agent" &&
      (admittedEvent.runId === null ||
        admittedEvent.agentId !== comment.authorAgentId ||
        admittedEvent.adapterConfigRevisionId === null)) ||
    (comment.authorType !== "agent" && admittedEvent.runId !== null)
  ) {
    throw new IssueSessionInvariantError(
      `Admitted input ${inbox.id} lost its immutable producer envelope`,
    );
  }

  const { seq } = await reserveIssueSessionEventSequence(transaction, {
    companyId: inbox.companyId,
    issueId: inbox.issueId,
    sessionId: inbox.sessionId,
  });
  const eventId = `evt_${digest({
    transition: "prompted",
    sessionId: inbox.sessionId,
    inputId: inbox.id,
  }).slice(0, 40)}`;
  await publishIssueSessionEventInTx(transaction, {
    event: {
      id: eventId,
      sessionId: inbox.sessionId,
      seq,
      type: IssueSession.Event.Prompted.type,
      data: {
        sessionID: inbox.sessionId,
        messageID: inbox.id,
        timestamp: inbox.timeCreated.getTime(),
        prompt: inbox.prompt,
        delivery: inbox.delivery,
      },
    },
    envelope: {
      companyId: inbox.companyId,
      issueId: inbox.issueId,
      runId: admittedEvent.runId,
      ownershipEpoch: ref.ownershipEpoch,
      agentId: admittedEvent.agentId,
      adapterConfigRevisionId:
        admittedEvent.adapterConfigRevisionId,
      sourceKind: "input_promotion",
      sourceId: ref.sourceId,
      immutableSourceKey: `${ref.id}:prompted`,
      sourceRecordId: ref.id,
      sourceIdentityDigest: digest({
        kind: "input_promotion",
        refId: ref.id,
        inputId: inbox.id,
        admittedSeq: inbox.admittedSeq,
      }),
      createdAt: now,
    },
    projection: {
      comment: {
        phase: "promoted",
        sourceKind:
          comment.canonicalSourceKind as IssueSessionCommentProjectionInput["sourceKind"],
        sourceId: comment.canonicalSourceId,
        messageId: inbox.id,
        ...(commentSource.refId === null
          ? {}
          : {
              steeringSegment: {
                steeringTargetRunId:
                  commentSource.steeringTargetRunId!,
                refId: commentSource.refId,
                refOrdinal: commentSource.refOrdinal!,
                segmentOrdinal: commentSource.segmentOrdinal!,
              },
            }),
        comment: {
          id: comment.id,
          body: comment.body,
          authorAgentId: comment.authorAgentId,
          authorUserId: comment.authorUserId,
          authorPluginInstallationId:
            comment.authorPluginInstallationId,
          authorPluginKey: comment.authorPluginKey,
          authorType: comment.authorType,
          replyToCommentId: comment.replyToCommentId,
          replyToProjectedEventSeq:
            comment.replyToProjectedEventSeq,
          threadRootCommentId: comment.threadRootCommentId,
          threadRootProjectedEventSeq:
            comment.threadRootProjectedEventSeq,
          presentation: comment.presentation,
          metadata: comment.metadata,
          sourceTrust: comment.sourceTrust,
        },
      },
    },
  });

  const [updatedRefs, updatedViews] = await Promise.all([
    transaction
      .update(issueExecutionRefs)
      .set({ promotedSeq: seq, updatedAt: now })
      .where(
        and(
          eq(issueExecutionRefs.id, ref.id),
          isNull(issueExecutionRefs.promotedSeq),
          eq(issueExecutionRefs.disposition, "active"),
        ),
      )
      .returning({ id: issueExecutionRefs.id }),
    transaction
      .update(issueExecutionHistoryViews)
      .set({ sourcePromotedSeq: seq, updatedAt: now })
      .where(
        and(
          eq(issueExecutionHistoryViews.id, view.id),
          isNull(issueExecutionHistoryViews.sourcePromotedSeq),
          inArray(issueExecutionHistoryViews.state, ["empty", "current"]),
        ),
      )
      .returning({ id: issueExecutionHistoryViews.id }),
  ]);
  if (!updatedRefs[0] || !updatedViews[0]) {
    throw new IssueSessionLifecycleConflict(
      "Issue Session input promotion lost its ref or history-view lifecycle race",
      { inputId: inbox.id, refId: ref.id, historyViewId: view.id },
    );
  }

  const orderRows = Array.from(
    await transaction.execute(sql<{ lowerOrder: number | null }>`
      SELECT max(lower_order)::integer AS "lowerOrder"
      FROM issue_execution_history_view_messages
      WHERE history_view_id = ${view.id}
    `),
  );
  const lowerOrder = Number(orderRows[0]?.lowerOrder ?? -1) + 1;
  await transaction
    .insert(issueExecutionHistoryViewMessages)
    .values({
      id: deterministicUuid(
        "history-view-message",
        `${view.id}\0${inbox.id}`,
      ),
      companyId: inbox.companyId,
      issueId: inbox.issueId,
      sessionId: inbox.sessionId,
      historyViewId: view.id,
      messageId: inbox.id,
      lowerOrder,
      membershipKind: "source",
    })
    .onConflictDoNothing();
  const memberships = await transaction
    .select()
    .from(issueExecutionHistoryViewMessages)
    .where(
      and(
        eq(issueExecutionHistoryViewMessages.historyViewId, view.id),
        eq(issueExecutionHistoryViewMessages.messageId, inbox.id),
      ),
    )
    .limit(1);
  const membership = memberships[0];
  if (
    !membership ||
    membership.companyId !== inbox.companyId ||
    membership.issueId !== inbox.issueId ||
    membership.sessionId !== inbox.sessionId ||
    membership.lowerOrder !== lowerOrder ||
    membership.membershipKind !== "source"
  ) {
    throw new IssueSessionLifecycleConflict(
      "Issue Session source membership diverged during input promotion",
      { inputId: inbox.id, historyViewId: view.id },
    );
  }

  const promoted = await transaction
    .select()
    .from(issueSessionInputs)
    .where(eq(issueSessionInputs.id, inbox.id))
    .limit(1);
  if (!promoted[0] || promoted[0].promotedSeq !== seq) {
    throw new IssueSessionInvariantError(
      `Issue Session projector did not promote input ${inbox.id}`,
    );
  }
  return promoted[0];
}

function exactTextOnlyPrompt(
  value: unknown,
): value is {
  readonly text: string;
  readonly files?: readonly never[];
  readonly agents?: readonly never[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prompt = value as Record<string, unknown>;
  return typeof prompt.text === "string" &&
    (prompt.files === undefined ||
      (Array.isArray(prompt.files) && prompt.files.length === 0)) &&
    (prompt.agents === undefined ||
      (Array.isArray(prompt.agents) && prompt.agents.length === 0));
}

/**
 * Materializes one admitted human active-run steer as its canonical User
 * message before the positive segment takes a source-message FK. Unlike the
 * ordinary ref promotion path, this input deliberately has no ref/view; the
 * run repository binds its projected comment to the new segment immediately
 * after this transition in the same transaction.
 */
export async function promoteActiveRunSteeringInputInTransaction(
  transaction: IssueSessionDbTransaction,
  input: {
    readonly companyId: string;
    readonly issueId: string;
    readonly sessionId: string;
    readonly sourceCommentId: string;
    readonly sourceMessageId: string;
    readonly sourceInputId: string;
    readonly actorUserId: string;
    readonly exactMessage: string;
    readonly at: Date;
  },
): Promise<IssueSessionInputRecord> {
  if (
    input.sourceMessageId !== input.sourceInputId ||
    input.exactMessage.length === 0
  ) {
    throw new IssueSessionLifecycleConflict(
      "Human active-run steering requires one exact source message/input identity",
      { sourceMessageId: input.sourceMessageId },
    );
  }
  const sourceInput = await transaction
    .select()
    .from(issueSessionInputs)
    .where(
      and(
        eq(issueSessionInputs.companyId, input.companyId),
        eq(issueSessionInputs.issueId, input.issueId),
        eq(issueSessionInputs.sessionId, input.sessionId),
        eq(issueSessionInputs.id, input.sourceInputId),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  const disposition = await transaction
    .select()
    .from(issueSessionInputDispositions)
    .where(
      and(
        eq(issueSessionInputDispositions.companyId, input.companyId),
        eq(issueSessionInputDispositions.issueId, input.issueId),
        eq(issueSessionInputDispositions.sessionId, input.sessionId),
        eq(issueSessionInputDispositions.inputId, input.sourceInputId),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  const projected = await transaction
    .select({
      comment: issueComments,
      source: issueCommentProjectionSources,
    })
    .from(issueComments)
    .innerJoin(
      issueCommentProjectionSources,
      eq(issueCommentProjectionSources.commentId, issueComments.id),
    )
    .where(
      and(
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, input.issueId),
        eq(issueComments.sessionId, input.sessionId),
        eq(issueComments.id, input.sourceCommentId),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (
    !sourceInput ||
    !disposition ||
    !projected ||
    sourceInput.delivery !== "steer" ||
    sourceInput.promotedSeq !== null ||
    !exactTextOnlyPrompt(sourceInput.prompt) ||
    sourceInput.prompt.text !== input.exactMessage ||
    disposition.sourceRefId !== null ||
    disposition.state !== "active" ||
    projected.comment.canonicalMessageId !== input.sourceMessageId ||
    projected.comment.canonicalSourceKind !== "human_comment" ||
    projected.comment.body !== input.exactMessage ||
    projected.comment.authorType !== "user" ||
    projected.comment.authorUserId !== input.actorUserId ||
    projected.comment.runId !== null ||
    projected.source.sourceKind !== "human_comment" ||
    projected.source.messageId !== input.sourceMessageId ||
    projected.source.admittedEventSeq !== sourceInput.admittedSeq ||
    projected.source.promotedEventSeq !== null ||
    projected.source.steeringTargetRunId !== null ||
    projected.source.refId !== null ||
    projected.source.refOrdinal !== null ||
    projected.source.segmentOrdinal !== null
  ) {
    throw new IssueSessionLifecycleConflict(
      "Human active-run steering lost its exact admitted input/comment identity",
      { sourceInputId: input.sourceInputId },
    );
  }
  const admittedRow = await transaction
    .select()
    .from(issueSessionEvents)
    .where(
      and(
        eq(issueSessionEvents.companyId, input.companyId),
        eq(issueSessionEvents.issueId, input.issueId),
        eq(issueSessionEvents.sessionId, input.sessionId),
        eq(issueSessionEvents.seq, sourceInput.admittedSeq),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  const admitted = admittedRow
    ? decodeStoredIssueSessionEvent(admittedRow)
    : null;
  if (
    !admittedRow ||
    admittedRow.sourceKind !== "human_comment" ||
    admittedRow.sourceId !== projected.source.sourceId ||
    admittedRow.runId !== null ||
    admittedRow.agentId !== null ||
    admittedRow.adapterConfigRevisionId !== null ||
    admitted?.event.type !== IssueSession.Event.PromptAdmitted.type ||
    (admitted.event.data as { messageID?: unknown }).messageID !==
      input.sourceMessageId ||
    (admitted.event.data as { delivery?: unknown }).delivery !== "steer" ||
    !exactTextOnlyPrompt(
      (admitted.event.data as { prompt?: unknown }).prompt,
    ) ||
    (admitted.event.data as { prompt: { text: string } }).prompt.text !==
      input.exactMessage
  ) {
    throw new IssueSessionInvariantError(
      `Admitted active-run steering input ${input.sourceInputId} lost its immutable event`,
    );
  }
  const { seq } = await reserveIssueSessionEventSequence(transaction, input);
  const eventId = `evt_${digest({
    transition: "prompted",
    sessionId: input.sessionId,
    inputId: input.sourceInputId,
  }).slice(0, 40)}`;
  await publishIssueSessionEventInTx(transaction, {
    event: {
      id: eventId,
      sessionId: input.sessionId,
      seq,
      type: IssueSession.Event.Prompted.type,
      data: {
        sessionID: input.sessionId,
        messageID: input.sourceMessageId,
        timestamp: sourceInput.timeCreated.getTime(),
        prompt: sourceInput.prompt,
        delivery: "steer",
      },
    },
    envelope: {
      companyId: input.companyId,
      issueId: input.issueId,
      runId: null,
      ownershipEpoch: null,
      agentId: null,
      adapterConfigRevisionId: null,
      sourceKind: "input_promotion",
      sourceId: admittedRow.sourceId,
      immutableSourceKey: `${admittedRow.immutableSourceKey}:prompted`,
      sourceRecordId: admittedRow.sourceRecordId,
      sourceIdentityDigest: digest({
        kind: "input_promotion",
        sourceKind: admittedRow.sourceKind,
        sourceId: admittedRow.sourceId,
        sourceInputId: input.sourceInputId,
        admittedSeq: sourceInput.admittedSeq,
      }),
      createdAt: input.at,
    },
    projection: {
      comment: {
        phase: "promoted",
        sourceKind: "human_comment",
        sourceId: projected.source.sourceId,
        messageId: input.sourceMessageId,
        comment: {
          id: projected.comment.id,
          body: projected.comment.body,
          authorAgentId: projected.comment.authorAgentId,
          authorUserId: projected.comment.authorUserId,
          authorPluginInstallationId:
            projected.comment.authorPluginInstallationId,
          authorPluginKey: projected.comment.authorPluginKey,
          authorType: projected.comment.authorType,
          replyToCommentId: projected.comment.replyToCommentId,
          replyToProjectedEventSeq:
            projected.comment.replyToProjectedEventSeq,
          threadRootCommentId: projected.comment.threadRootCommentId,
          threadRootProjectedEventSeq:
            projected.comment.threadRootProjectedEventSeq,
          presentation: projected.comment.presentation,
          metadata: projected.comment.metadata,
          sourceTrust: projected.comment.sourceTrust,
        },
      },
    },
  });
  const promoted = await transaction
    .select()
    .from(issueSessionInputs)
    .where(eq(issueSessionInputs.id, input.sourceInputId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!promoted || promoted.promotedSeq !== seq) {
    throw new IssueSessionInvariantError(
      `Issue Session projector did not promote active-run steering input ${input.sourceInputId}`,
    );
  }
  return promoted;
}

export function createIssueSessionInputService(
  db: Db,
  options: { clock?: () => Date } = {},
): IssueSessionInputService {
  const clock = options.clock ?? (() => new Date());
  return {
    promotePreparedInput(scope) {
      return db.transaction(async (transaction) => {
        const active = await validateActiveExecution(transaction, {
          ...scope,
          activeRefId: scope.refId,
          runId: null,
        });
        if (active.ref.inputId === null || active.ref.promotedSeq !== null) {
          return false;
        }
        const rows = await transaction
          .select({
            inbox: issueSessionInputs,
            disposition: issueSessionInputDispositions,
            ref: issueExecutionRefs,
            view: issueExecutionHistoryViews,
          })
          .from(issueSessionInputs)
          .innerJoin(
            issueSessionInputDispositions,
            eq(
              issueSessionInputDispositions.inputId,
              issueSessionInputs.id,
            ),
          )
          .innerJoin(
            issueExecutionRefs,
            eq(
              issueExecutionRefs.id,
              issueSessionInputDispositions.sourceRefId,
            ),
          )
          .innerJoin(
            issueExecutionHistoryViews,
            eq(
              issueExecutionHistoryViews.id,
              issueExecutionRefs.historyViewId,
            ),
          )
          .where(
            and(
              eq(issueSessionInputs.id, active.ref.inputId),
              isNull(issueSessionInputs.promotedSeq),
            ),
          )
          .limit(1)
          .for("update");
        const candidate = rows[0];
        if (!candidate) {
          throw new IssueSessionInvariantError(
            `Prepared Issue Session input ${active.ref.inputId} disappeared before promotion`,
          );
        }
        if (!candidateMatchesScope(active, candidate, false)) {
          throw new IssueSessionLifecycleConflict(
            "Prepared Issue Session input no longer matches its exact ref and history view",
            { refId: scope.refId, inputId: active.ref.inputId },
          );
        }
        await promoteCandidate(transaction, candidate, clock());
        return true;
      });
    },

    latestSequence(scope) {
      return db.transaction(async (transaction) => {
        await validateActiveExecution(transaction, scope);
        const rows = await transaction
          .select({ seq: issueSessionEventSequences.seq })
          .from(issueSessionEventSequences)
          .where(
            and(
              eq(issueSessionEventSequences.companyId, scope.companyId),
              eq(issueSessionEventSequences.issueId, scope.issueId),
              eq(issueSessionEventSequences.sessionId, scope.sessionId),
            ),
          )
          .limit(1);
        const seq = rows[0]?.seq;
        if (seq === undefined) {
          throw new IssueSessionInvariantError(
            `Issue Session ${scope.sessionId} has no event sequence`,
          );
        }
        return seq;
      });
    },

    hasPending(scope) {
      return db.transaction(async (transaction) => {
        const active = await validateActiveExecution(transaction, scope);
        const candidates = await loadPendingCandidates(transaction, active);
        return {
          steer: candidates.some(
            (candidate) => candidate.inbox.delivery === "steer",
          ),
          queue: candidates.some(
            (candidate) => candidate.inbox.delivery === "queue",
          ),
        };
      });
    },

    promoteSteers(scope, cutoffSeq) {
      if (!Number.isSafeInteger(cutoffSeq) || cutoffSeq < -1) {
        throw new TypeError(
          "Issue Session steer cutoff must be a safe event sequence",
        );
      }
      return db.transaction(async (transaction) => {
        const active = await validateActiveExecution(transaction, scope);
        const sequenceRows = await transaction
          .select({ seq: issueSessionEventSequences.seq })
          .from(issueSessionEventSequences)
          .where(
            and(
              eq(issueSessionEventSequences.companyId, scope.companyId),
              eq(issueSessionEventSequences.issueId, scope.issueId),
              eq(issueSessionEventSequences.sessionId, scope.sessionId),
            ),
          )
          .limit(1);
        if (
          sequenceRows[0] === undefined ||
          cutoffSeq > sequenceRows[0].seq
        ) {
          throw new IssueSessionLifecycleConflict(
            "Issue Session steer cutoff is ahead of its durable event sequence",
            { sessionId: scope.sessionId, cutoffSeq },
          );
        }
        const candidates = (
          await loadPendingCandidates(transaction, active)
        ).filter(
          (candidate) =>
            candidate.inbox.delivery === "steer" &&
            candidate.inbox.admittedSeq <= cutoffSeq,
        );
        const promoted: IssueSessionInputRecord[] = [];
        for (const candidate of candidates) {
          promoted.push(
            await promoteCandidate(transaction, candidate, clock()),
          );
        }
        return promoted;
      });
    },

    promoteNextQueued(scope) {
      return db.transaction(async (transaction) => {
        const active = await validateActiveExecution(transaction, scope);
        const candidates = await loadPendingCandidates(transaction, active);
        if (
          candidates.some(
            (candidate) => candidate.inbox.delivery === "steer",
          )
        ) {
          return null;
        }
        const queued = candidates.find(
          (candidate) => candidate.inbox.delivery === "queue",
        );
        return queued
          ? promoteCandidate(transaction, queued, clock())
          : null;
      });
    },
  };
}
