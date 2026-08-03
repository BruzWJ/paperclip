import { createHash, randomUUID } from "node:crypto";
import {
  agentContextGrants,
  agents,
  issueComments,
  issueExecutionPromptSegments,
  issueExecutionRefs,
  issueExecutionRunRefs,
  issueSessionContextEpochs,
  issueSessionInputs,
  issueSessionMessages,
  issueSessionRecoverySelectionMembers,
  issueSessionRecoverySelections,
  issueSessions,
  issues,
  type Db,
} from "@paperclipai/db";
import type { AgentContextGrantKey } from "@paperclipai/shared";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  lte,
  sql,
} from "drizzle-orm";
import {
  contextDialDigest,
  resolveContextDial,
  type ContextAttenuationMask,
  type ContextDial,
} from "./context-dial-resolver.js";
import { resolveExecutionModeContextMask } from "./execution-mode-context-mask.js";
import {
  lockIssueExecutionRunRefMembershipInTransaction,
  lockSteerableRunInTransaction,
  type SteerableIssueExecutionRun,
} from "./issue-execution-run-service.js";
import type { ResolvedIssueExecutionPrompt } from "./issue-execution-attempt-executor.js";
import {
  assembleIssueSessionRecoveryPrompt,
  createIssueSessionTargetNotFoundRecovery,
  issueSessionRecoveryAssembledContentDigest,
  issueSessionRecoveryDepthForDial,
  issueSessionRecoveryScopeForDepth,
  issueSessionRecoverySelectionIdentityDigest,
  IssueSessionRecoveryRejected,
  type IssueSessionRecoveryCheckpoint,
  type IssueSessionRecoveryComment,
  type IssueSessionRecoveryDepth,
  type IssueSessionRecoveryMember,
  type IssueSessionRecoveryRepository,
  type IssueSessionRecoverySelectionIdentity,
  type IssueSessionRecoveryTurn,
  type PinnedIssueSessionRecoverySelection,
  type PreparedIssueSessionRecovery,
} from "./issue-session-recovery.js";
import {
  decodeStoredIssueSessionMessage,
  isSettledIssueSessionMessage,
} from "./issue-session/store.js";
import {
  classifyIssueExecutionRefDelivery,
  isCanonicalIssueExecutionBaseRecoveryDelivery,
} from "./issue-execution-ref-delivery.js";
import {
  loadActiveIssueSessionPruneEffects,
  lowerIssueSessionMessageForActivePruneEffects,
  type ActiveIssueSessionPruneEffects,
  type ActiveIssueSessionPruneScope,
} from "./issue-session/active-prune-effects.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type MessageRow = typeof issueSessionMessages.$inferSelect;
type SelectionRow = typeof issueSessionRecoverySelections.$inferSelect;

export interface IssueSessionRecoveryCandidate {
  readonly prompt: ResolvedIssueExecutionPrompt;
  readonly identity: Omit<
    IssueSessionRecoverySelectionIdentity,
    | "selectedCheckpointControlId"
    | "latestFinishedAssistantMessageId"
  >;
  readonly depth: IssueSessionRecoveryDepth;
  readonly members: readonly IssueSessionRecoveryMember[];
  readonly latestFinishedAssistantMessageId: string | null;
  readonly sourceText: string;
}

export interface PreparedIssueSessionRecoveryView {
  /** Null means the authorized rows fit without a maintenance run. */
  readonly checkpoint: IssueSessionRecoveryCheckpoint | null;
  /** All rows when under limit; exact retained tail when checkpointed. */
  readonly members: readonly IssueSessionRecoveryMember[];
}

/**
 * Required recovery-only budget/compaction owner. It assesses the complete
 * candidate against the immutable selected model limits. Only an over-limit
 * true-carry target-loss may create a compaction run/checkpoint.
 */
export interface IssueSessionRecoveryCompactionBoundary {
  prepare(
    candidate: IssueSessionRecoveryCandidate,
  ): Promise<PreparedIssueSessionRecoveryView>;
  loadCheckpoint(input: {
    readonly companyId: string;
    readonly issueId: string;
    readonly sessionId: string;
    readonly checkpointControlId: string;
    readonly scopeKind: "comments-recovery" | "turns-recovery";
    readonly scopeId: string;
    readonly audience: "comments" | "turns";
    readonly sourceHighWaterSeq: number;
  }): Promise<IssueSessionRecoveryCheckpoint>;
}

export interface PostgresIssueSessionRecoveryOptions {
  readonly compaction: IssueSessionRecoveryCompactionBoundary;
  readonly idFactory?: () => string;
}

interface LockedRecoverySource {
  readonly run: SteerableIssueExecutionRun;
  readonly sourceText: string;
  readonly sourceMessageId: string;
  readonly sourceInputId: string | null;
  readonly sourceHighWaterSeq: number;
  readonly contextEpoch: number;
  readonly contextEpochBaselineSeq: number;
  readonly executionLineageId: string;
  readonly visibility: "active";
  readonly dial: ContextDial;
  readonly effectiveContextDigest: string;
  readonly existingSelection: SelectionRow | null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function contextMask(value: unknown): ContextAttenuationMask | null {
  const entries = Object.entries(record(value)).filter(
    (entry): entry is [AgentContextGrantKey, false] => entry[1] === false,
  );
  return entries.length === 0
    ? null
    : (Object.fromEntries(entries) as ContextAttenuationMask);
}

function exactPromptText(value: unknown): string | null {
  const prompt = record(value);
  if (
    typeof prompt.text !== "string" ||
    (prompt.files !== undefined &&
      (!Array.isArray(prompt.files) || prompt.files.length !== 0)) ||
    (prompt.agents !== undefined &&
      (!Array.isArray(prompt.agents) || prompt.agents.length !== 0))
  ) {
    return null;
  }
  return prompt.text;
}

function scopeId(input: {
  readonly companyId: string;
  readonly issueId: string;
  readonly ownershipEpoch: number;
  readonly targetAgentId: string;
  readonly laneKind: "owner" | "consult";
  readonly contextEpoch: number;
  readonly sourceHighWaterSeq: number;
  readonly audience: "comments" | "turns";
  readonly sourceRunId: string;
  readonly sourceRefId: string;
  readonly sourceRefOrdinal: number;
  readonly sourceSegmentOrdinal: number;
}): string {
  return `recovery:${sha256(
    JSON.stringify({
      version: "paperclip-issue-session-recovery-scope/v1",
      ...input,
    }),
  )}`;
}

async function currentDial(
  transaction: Transaction,
  input: {
    readonly companyId: string;
    readonly issueId: string;
    readonly targetAgentId: string;
  },
): Promise<ContextDial> {
  const [issueRows, grantRows, agentRows] = await Promise.all([
    transaction
      .select({
        attentionMask: issues.attentionMask,
        workMode: issues.workMode,
        harnessKind: issues.harnessKind,
        originKind: issues.originKind,
        executionPolicy: issues.executionPolicy,
        projectExecutionPolicy:
          sql<Record<string, unknown> | null>`(
            SELECT project.execution_workspace_policy
            FROM projects project
            WHERE project.id = ${issues.projectId}
              AND project.company_id = ${issues.companyId}
            LIMIT 1
          )`,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, input.companyId),
          eq(issues.id, input.issueId),
        ),
      )
      .limit(1),
    transaction
      .select({ key: agentContextGrants.key })
      .from(agentContextGrants)
      .where(
        and(
          eq(agentContextGrants.companyId, input.companyId),
          eq(agentContextGrants.agentId, input.targetAgentId),
        ),
      ),
    transaction
      .select({ governance: agents.permissions })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, input.companyId),
          eq(agents.id, input.targetAgentId),
        ),
      )
      .limit(1),
  ]);
  const issue = issueRows[0];
  if (!issue || !agentRows[0]) {
    throw new IssueSessionRecoveryRejected(
      "Recovery authorization owner is no longer current",
    );
  }
  const agent = Object.fromEntries(
    grantRows.map(({ key }) => [key, true]),
  ) as Partial<Record<AgentContextGrantKey, true>>;
  return resolveContextDial({
    agent,
    assignment: contextMask(issue.attentionMask),
    executionMode: resolveExecutionModeContextMask({
      workMode: issue.workMode,
      harnessKind: issue.harnessKind,
      originKind: issue.originKind,
      agentGovernance: agentRows[0].governance,
      issueExecutionPolicy: issue.executionPolicy,
      projectExecutionPolicy: issue.projectExecutionPolicy,
    }),
  }).effective;
}

async function lockRetryAncestorRunIds(
  transaction: Transaction,
  run: SteerableIssueExecutionRun,
  refId: string,
  currentRefOrdinal: number,
): Promise<readonly string[]> {
  const ancestors: string[] = [];
  const seen = new Set<string>();
  let lineageParentRunId: string | null | undefined;
  let cursorId: string | null = run.runId;
  for (let depth = 0; cursorId !== null && depth < 64; depth += 1) {
    if (seen.has(cursorId)) {
      throw new IssueSessionRecoveryRejected(
        "Recovery retry lineage contains a cycle",
      );
    }
    seen.add(cursorId);
    const membership =
      await lockIssueExecutionRunRefMembershipInTransaction(transaction, {
        companyId: run.companyId,
        issueId: run.issueId,
        runId: cursorId,
        refId,
      });
    if (!membership) {
      throw new IssueSessionRecoveryRejected(
        "Recovery retry lineage lost an exact run",
      );
    }
    const row = membership.run;
    const isCurrent = row.runId === run.runId;
    if (isCurrent) lineageParentRunId = row.parentRunId;
    const exactControl = isCurrent
      ? membership.refOrdinal === currentRefOrdinal &&
        membership.currentRefId === refId &&
        membership.currentOrdinal === currentRefOrdinal
      : membership.currentRefId === null &&
        membership.currentOrdinal === null;
    const exactScope =
      row.kind === run.kind &&
      row.sessionId === run.sessionId &&
      row.executionScopeId === run.executionScopeId &&
      row.ownershipEpoch === run.ownershipEpoch &&
      row.targetAgentId === run.targetAgentId &&
      row.adapterConfigRevisionId === run.adapterConfigRevisionId &&
      row.executionWorkspaceBindingId === run.executionWorkspaceBindingId &&
      row.executionMode === run.executionMode &&
      row.issueExecutionAuthorityId === run.issueExecutionAuthorityId &&
      row.consultExecutionId === run.consultExecutionId &&
      row.parentRunId === lineageParentRunId;
    if (
      !exactControl ||
      !exactScope ||
      (isCurrent
        ? row.status !== "running"
        : ![
            "succeeded",
            "interrupted",
            "failed",
            "cancelled",
            "timed_out",
          ].includes(row.status))
    ) {
      throw new IssueSessionRecoveryRejected(
        "Recovery retry lineage crossed its immutable run scope",
      );
    }
    if (!isCurrent) ancestors.push(row.runId);
    cursorId = row.retryOfRunId;
  }
  if (cursorId !== null) {
    throw new IssueSessionRecoveryRejected(
      "Recovery retry lineage exceeded its bounded depth",
    );
  }
  return Object.freeze(ancestors);
}

async function lockRecoverySource(
  transaction: Transaction,
  prompt: ResolvedIssueExecutionPrompt,
): Promise<LockedRecoverySource> {
  const identity = prompt.identity;
  const issueRows = await transaction
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.companyId, identity.companyId),
        eq(issues.id, identity.issueId),
      ),
    )
    .limit(1)
    .for("update");
  const issue = issueRows[0];
  if (
    !issue ||
    issue.ownershipEpoch !== identity.ownershipEpoch ||
    issue.hiddenAt !== null ||
    !["open", "blocked"].includes(issue.lifecycleStatus ?? "")
  ) {
    throw new IssueSessionRecoveryRejected(
      "Recovery issue scope is no longer active",
    );
  }
  const sessionRows = await transaction
    .select()
    .from(issueSessions)
    .where(
      and(
        eq(issueSessions.companyId, identity.companyId),
        eq(issueSessions.issueId, identity.issueId),
        eq(issueSessions.id, identity.sessionId),
      ),
    )
    .limit(1)
    .for("update");
  const session = sessionRows[0];
  if (
    !session ||
    session.integrityState !== "ready" ||
    session.timeArchived !== null ||
    session.purgeFencedAt !== null
  ) {
    throw new IssueSessionRecoveryRejected(
      "Recovery Session is not active and ready",
    );
  }
  const run = await lockSteerableRunInTransaction(
    transaction,
    {
      companyId: identity.companyId,
      issueId: identity.issueId,
      runId: identity.runId,
      ownershipEpoch: identity.ownershipEpoch,
      targetAgentId: identity.targetAgentId,
    },
  );
  if (
    run.sessionId !== identity.sessionId ||
    run.executionScopeId !== identity.executionScopeId ||
    run.kind !== identity.runKind ||
    run.currentAttemptId !== identity.attemptId ||
    run.currentLeaseId !== identity.leaseId ||
    run.adapterConfigRevisionId !== identity.adapterConfigRevisionId ||
    run.executionWorkspaceBindingId !==
      identity.executionWorkspaceBindingId ||
    run.executionMode !== identity.laneKind ||
    run.issueExecutionAuthorityId !==
      identity.issueExecutionAuthorityId ||
    run.consultExecutionId !== identity.consultExecutionId
  ) {
    throw new IssueSessionRecoveryRejected(
      "Recovery prompt no longer matches its active run envelope",
    );
  }
  const runRefRows = await transaction
    .select({ member: issueExecutionRunRefs, ref: issueExecutionRefs })
    .from(issueExecutionRunRefs)
    .innerJoin(
      issueExecutionRefs,
      eq(issueExecutionRefs.id, issueExecutionRunRefs.refId),
    )
    .where(
      and(
        eq(issueExecutionRunRefs.companyId, identity.companyId),
        eq(issueExecutionRunRefs.issueId, identity.issueId),
        eq(issueExecutionRunRefs.sessionId, identity.sessionId),
        eq(issueExecutionRunRefs.runId, identity.runId),
        eq(issueExecutionRunRefs.refId, identity.refId),
        eq(issueExecutionRunRefs.refOrdinal, identity.refOrdinal),
      ),
    )
    .limit(1)
    .for("update");
  const joined = runRefRows[0];
  if (
    !joined ||
    joined.ref.disposition !== "active" ||
    joined.ref.ownershipEpoch !== identity.ownershipEpoch ||
    joined.ref.targetAgentId !== identity.targetAgentId ||
    joined.ref.adapterConfigRevisionId !==
      identity.adapterConfigRevisionId ||
    joined.ref.executionScopeId !== identity.executionScopeId ||
    joined.ref.executionLineageId.length === 0 ||
    joined.ref.contextEpoch < 0 ||
    joined.member.protocolSettlementState !== null ||
    joined.member.batchDigest !== identity.runBatchDigest
  ) {
    throw new IssueSessionRecoveryRejected(
      "Recovery prompt no longer matches its active run-ref member",
    );
  }
  const refDelivery = classifyIssueExecutionRefDelivery(joined.ref);
  if (
    refDelivery !== "user_dispatchable" &&
    refDelivery !== "synthetic_dispatchable"
  ) {
    throw new IssueSessionRecoveryRejected(
      "Recovery run-ref is not canonically dispatchable",
    );
  }
  let sourceMessageId: string;
  let sourceInputId: string | null;
  let sourceHighWaterSeq: number;
  if (identity.segmentOrdinal === 0) {
    if (identity.promptKind !== "base") {
      throw new IssueSessionRecoveryRejected(
        "Base recovery has a non-base prompt identity",
      );
    }
    sourceInputId = joined.member.inputId;
    sourceMessageId = joined.ref.sourceMessageId;
    sourceHighWaterSeq = joined.ref.admissionHighWaterSeq;
    if (joined.ref.exactMessage !== prompt.sourceText) {
      throw new IssueSessionRecoveryRejected(
        "Base recovery source text changed after admission",
      );
    }
  } else {
    if (identity.promptKind !== "steering") {
      throw new IssueSessionRecoveryRejected(
        "Positive recovery segment has a non-steering identity",
      );
    }
    const segmentRows = await transaction
      .select()
      .from(issueExecutionPromptSegments)
      .where(
        and(
          eq(issueExecutionPromptSegments.companyId, identity.companyId),
          eq(issueExecutionPromptSegments.issueId, identity.issueId),
          eq(issueExecutionPromptSegments.sessionId, identity.sessionId),
          eq(issueExecutionPromptSegments.runId, identity.runId),
          eq(issueExecutionPromptSegments.refId, identity.refId),
          eq(issueExecutionPromptSegments.refOrdinal, identity.refOrdinal),
          eq(
            issueExecutionPromptSegments.segmentOrdinal,
            identity.segmentOrdinal,
          ),
        ),
      )
      .limit(1)
      .for("update");
    const segment = segmentRows[0];
    if (!segment || segment.protocolSettlementState !== null) {
      throw new IssueSessionRecoveryRejected(
        "Steering recovery segment is not active",
      );
    }
    sourceMessageId = segment.sourceMessageId;
    sourceInputId = segment.sourceInputId;
    const messageRows = await transaction
      .select()
      .from(issueSessionMessages)
      .where(
        and(
          eq(issueSessionMessages.companyId, identity.companyId),
          eq(issueSessionMessages.issueId, identity.issueId),
          eq(issueSessionMessages.sessionId, identity.sessionId),
          eq(issueSessionMessages.id, sourceMessageId),
        ),
      )
      .limit(1)
      .for("update");
    const steeringMessage = messageRows[0];
    if (!steeringMessage || steeringMessage.seq < 1) {
      throw new IssueSessionRecoveryRejected(
        "Steering recovery source has no source-exclusive high-water",
      );
    }
    sourceHighWaterSeq = steeringMessage.seq - 1;
  }
  const sourceMessageRows = await transaction
    .select()
    .from(issueSessionMessages)
    .where(
      and(
        eq(issueSessionMessages.companyId, identity.companyId),
        eq(issueSessionMessages.issueId, identity.issueId),
        eq(issueSessionMessages.sessionId, identity.sessionId),
        eq(issueSessionMessages.id, sourceMessageId),
      ),
    )
    .limit(1)
    .for("update");
  const sourceMessageRow = sourceMessageRows[0];
  const sourceMessage = sourceMessageRow
    ? decodeStoredIssueSessionMessage(sourceMessageRow)
    : null;
  const sourceInputRows = sourceInputId === null
    ? []
    : await transaction
        .select()
        .from(issueSessionInputs)
        .where(
          and(
            eq(issueSessionInputs.companyId, identity.companyId),
            eq(issueSessionInputs.issueId, identity.issueId),
            eq(issueSessionInputs.sessionId, identity.sessionId),
            eq(issueSessionInputs.id, sourceInputId),
          ),
        )
        .limit(1)
        .for("update");
  const sourceInput = sourceInputRows[0] ?? null;
  const baseDeliveryMatches = identity.segmentOrdinal !== 0 || (
    sourceMessage !== null &&
    (sourceMessage.type === "user" || sourceMessage.type === "synthetic") &&
    isCanonicalIssueExecutionBaseRecoveryDelivery({
      ref: joined.ref,
      memberInputId: joined.member.inputId,
      sourceMessageId: sourceMessage.id,
      sourceMessageKind: sourceMessage.type,
      sourceInput,
    })
  );
  if (
    !sourceMessage ||
    !baseDeliveryMatches ||
    (sourceMessage.type !== "user" && sourceMessage.type !== "synthetic") ||
    (sourceMessage.type === "user" &&
      (sourceInputId !== sourceMessage.id ||
        !sourceInput ||
        sourceInput.promotedSeq === null ||
        exactPromptText(sourceInput.prompt) !== sourceMessage.text ||
        (identity.segmentOrdinal === 0 && sourceInput.delivery !== "queue") ||
        (identity.segmentOrdinal > 0 && sourceInput.delivery !== "steer"))) ||
    (sourceMessage.type === "synthetic" &&
      (sourceInputId !== null || sourceInputRows.length !== 0)) ||
    sourceMessage.text !== prompt.sourceText
  ) {
    throw new IssueSessionRecoveryRejected(
      "Recovery message is not the exact persisted user or synthetic source",
    );
  }
  const epochRows = await transaction
    .select()
    .from(issueSessionContextEpochs)
    .where(
      and(
        eq(issueSessionContextEpochs.companyId, identity.companyId),
        eq(issueSessionContextEpochs.issueId, identity.issueId),
        eq(issueSessionContextEpochs.sessionId, identity.sessionId),
      ),
    )
    .limit(1)
    .for("update");
  const epoch = epochRows[0];
  if (!epoch || epoch.generation !== joined.ref.contextEpoch) {
    throw new IssueSessionRecoveryRejected(
      "Recovery context epoch changed before selection",
    );
  }
  const dial = await currentDial(transaction, {
    companyId: identity.companyId,
    issueId: identity.issueId,
    targetAgentId: identity.targetAgentId,
  });
  const effectiveContextDigest = contextDialDigest(dial);
  const selectionRunIds = [identity.runId];
  if (
    prompt.sessionOperation === "recovery_new" &&
    identity.promptKind === "base"
  ) {
    selectionRunIds.push(
      ...await lockRetryAncestorRunIds(
        transaction,
        run,
        identity.refId,
        identity.refOrdinal,
      ),
    );
  }
  const existingRows = await transaction
    .select()
    .from(issueSessionRecoverySelections)
    .where(
      and(
        eq(
          issueSessionRecoverySelections.companyId,
          identity.companyId,
        ),
        eq(issueSessionRecoverySelections.issueId, identity.issueId),
        eq(issueSessionRecoverySelections.sessionId, identity.sessionId),
        eq(
          issueSessionRecoverySelections.sourceRefId,
          identity.refId,
        ),
        inArray(issueSessionRecoverySelections.sourceRunId, selectionRunIds),
        eq(
          issueSessionRecoverySelections.sourceSegmentOrdinal,
          identity.segmentOrdinal,
        ),
      ),
    )
    .limit(2)
    .for("update");
  if (existingRows.length > 1) {
    throw new IssueSessionRecoveryRejected(
      "Recovery retry lineage has multiple immutable selections",
    );
  }
  const existingSelection = existingRows[0] ?? null;
  if (existingSelection) {
    const depth = issueSessionRecoveryDepthForDial(dial);
    const expectedScope = depth === null
      ? null
      : issueSessionRecoveryScopeForDepth(depth);
    const sourceIsCurrentRun = existingSelection.sourceRunId === identity.runId;
    if (
      expectedScope === null ||
      existingSelection.disposition !== "active" ||
      existingSelection.visibility !== "active" ||
      existingSelection.historyScopeKind !== expectedScope.scopeKind ||
      existingSelection.audience !== expectedScope.audience ||
      existingSelection.ownershipEpoch !== identity.ownershipEpoch ||
      existingSelection.targetAgentId !== identity.targetAgentId ||
      existingSelection.laneKind !== identity.laneKind ||
      existingSelection.contextEpoch !== epoch.generation ||
      existingSelection.executionLineageId !==
        joined.ref.executionLineageId ||
      existingSelection.sourceHighWaterSeq !== sourceHighWaterSeq ||
      existingSelection.effectiveContextDigest !== effectiveContextDigest ||
      existingSelection.sourceRefId !== identity.refId ||
      existingSelection.sourceSegmentOrdinal !== identity.segmentOrdinal ||
      (sourceIsCurrentRun &&
        existingSelection.sourceRefOrdinal !== identity.refOrdinal)
    ) {
      throw new IssueSessionRecoveryRejected(
        "Pinned recovery selection no longer matches current authorization or retry lineage",
      );
    }
  }
  return {
    run,
    sourceText: prompt.sourceText,
    sourceMessageId,
    sourceInputId,
    sourceHighWaterSeq,
    contextEpoch: epoch.generation,
    contextEpochBaselineSeq: epoch.baselineSeq ?? -1,
    executionLineageId: joined.ref.executionLineageId,
    visibility: "active",
    dial,
    effectiveContextDigest,
    existingSelection,
  };
}

function rowEligibleForRecovery(
  row: MessageRow,
  source: LockedRecoverySource,
): boolean {
  return row.seq <= source.sourceHighWaterSeq &&
    row.modelStateSeq <= source.sourceHighWaterSeq &&
    (row.type !== "system" ||
      row.seq > source.contextEpochBaselineSeq) &&
    isSettledIssueSessionMessage(row);
}

async function loadEligibleMessageRows(
  transaction: Transaction,
  source: LockedRecoverySource,
): Promise<MessageRow[]> {
  const selected: MessageRow[] = [];
  let after = -1;
  for (;;) {
    const page = await transaction
      .select()
      .from(issueSessionMessages)
      .where(
        and(
          eq(issueSessionMessages.companyId, source.run.companyId),
          eq(issueSessionMessages.issueId, source.run.issueId),
          eq(issueSessionMessages.sessionId, source.run.sessionId),
          gt(issueSessionMessages.seq, after),
          lte(
            issueSessionMessages.seq,
            source.sourceHighWaterSeq,
          ),
        ),
      )
      .orderBy(asc(issueSessionMessages.seq), asc(issueSessionMessages.id))
      .limit(500);
    if (page.length === 0) break;
    for (const row of page) {
      if (rowEligibleForRecovery(row, source)) selected.push(row);
    }
    after = page.at(-1)!.seq;
    if (page.length < 500 || after >= source.sourceHighWaterSeq) break;
  }
  return selected;
}

function latestFinishedAssistantMessageId(rows: readonly MessageRow[]): string | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.type !== "assistant") continue;
    const message = decodeStoredIssueSessionMessage(row);
    if (message.type === "assistant" && message.time.completed !== undefined) {
      return message.id;
    }
  }
  return null;
}

async function loadCandidateMembers(
  transaction: Transaction,
  source: LockedRecoverySource,
  depth: IssueSessionRecoveryDepth,
): Promise<{
  readonly members: readonly IssueSessionRecoveryMember[];
  readonly latestFinishedAssistantMessageId: string | null;
}> {
  const messages = await loadEligibleMessageRows(transaction, source);
  const latest = latestFinishedAssistantMessageId(messages);
  if (depth === "turns") {
    return {
      members: messages.map(
        (row): IssueSessionRecoveryTurn => ({
          kind: "message",
          id: row.id,
          sourceSequence: row.seq,
          selectionRole: "history",
          message: decodeStoredIssueSessionMessage(row),
        }),
      ),
      latestFinishedAssistantMessageId: latest,
    };
  }
  const eligibleMessages = new Map(messages.map((row) => [row.id, row]));
  const comments: IssueSessionRecoveryComment[] = [];
  let after = -1;
  for (;;) {
    const page = await transaction
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, source.run.companyId),
          eq(issueComments.issueId, source.run.issueId),
          gt(issueComments.projectedEventSeq, after),
          lte(
            issueComments.projectedEventSeq,
            source.sourceHighWaterSeq,
          ),
        ),
      )
      .orderBy(
        asc(issueComments.projectedEventSeq),
        asc(issueComments.id),
      )
      .limit(500);
    if (page.length === 0) break;
    for (const comment of page) {
      if (!eligibleMessages.has(comment.canonicalMessageId)) continue;
      comments.push({
        kind: "comment",
        id: comment.id,
        canonicalMessageId: comment.canonicalMessageId,
        sourceSequence: comment.projectedEventSeq,
        authorKind: comment.authorType,
        body: comment.body,
      });
    }
    after = page.at(-1)!.projectedEventSeq;
    if (page.length < 500 || after >= source.sourceHighWaterSeq) break;
  }
  return {
    members: comments,
    latestFinishedAssistantMessageId: latest,
  };
}

function assertPreparedMembers(
  candidate: readonly IssueSessionRecoveryMember[],
  prepared: PreparedIssueSessionRecoveryView,
  sourceHighWaterSeq: number,
): void {
  const candidates = new Map(
    candidate.map((member) => [`${member.kind}:${member.id}`, member]),
  );
  let prior = -1;
  for (const member of prepared.members) {
    const original = candidates.get(`${member.kind}:${member.id}`);
    const unchanged =
      original?.kind === "message" && member.kind === "message"
        ? original.sourceSequence === member.sourceSequence &&
          JSON.stringify(original.message) === JSON.stringify(member.message)
        : original?.kind === "comment" && member.kind === "comment"
          ? JSON.stringify(original) === JSON.stringify(member)
          : false;
    if (
      !original ||
      member.sourceSequence > sourceHighWaterSeq ||
      member.sourceSequence <= prior ||
      !unchanged
    ) {
      throw new IssueSessionRecoveryRejected(
        "Recovery compaction returned a foreign, changed, or unordered retained member",
      );
    }
    prior = member.sourceSequence;
  }
  if (prepared.checkpoint === null && prepared.members.length === 0) {
    throw new IssueSessionRecoveryRejected(
      "Recovery compaction removed all history without a checkpoint",
    );
  }
}

export function lowerIssueSessionRecoveryMembersForActivePruneEffects(
  members: readonly IssueSessionRecoveryMember[],
  effects: ActiveIssueSessionPruneEffects,
): readonly IssueSessionRecoveryMember[] {
  if (effects.size === 0) return members;
  return Object.freeze(
    members.map((member): IssueSessionRecoveryMember => {
      if (member.kind !== "message") {
        throw new IssueSessionRecoveryRejected(
          "Turns recovery contains a non-message prune candidate",
        );
      }
      return Object.freeze({
        ...member,
        message: lowerIssueSessionMessageForActivePruneEffects(
          member.message,
          effects,
        ),
      });
    }),
  );
}

async function loadAndLowerRecoveryMembersForActivePruneEffects(
  db: Db,
  scope: ActiveIssueSessionPruneScope,
  members: readonly IssueSessionRecoveryMember[],
): Promise<readonly IssueSessionRecoveryMember[]> {
  if (scope.audience !== "turns") return members;
  const effects = await loadActiveIssueSessionPruneEffects(db, scope);
  return lowerIssueSessionRecoveryMembersForActivePruneEffects(
    members,
    effects,
  );
}

function identityFromRow(
  row: SelectionRow,
): IssueSessionRecoverySelectionIdentity {
  return {
    companyId: row.companyId,
    issueId: row.issueId,
    sessionId: row.sessionId,
    visibility: row.visibility,
    scopeKind: row.historyScopeKind,
    scopeId: row.historyScopeId,
    audience: row.audience,
    ownershipEpoch: row.ownershipEpoch,
    targetAgentId: row.targetAgentId,
    laneKind: row.laneKind,
    contextEpoch: row.contextEpoch,
    executionLineageId: row.executionLineageId,
    sourceHighWaterSeq: row.sourceHighWaterSeq,
    effectiveContextDigest: row.effectiveContextDigest,
    selectedCheckpointControlId: row.selectedCheckpointControlId,
    latestFinishedAssistantMessageId:
      row.latestFinishedAssistantMessageId,
    sourceRunId: row.sourceRunId,
    sourceRefId: row.sourceRefId,
    sourceRefOrdinal: row.sourceRefOrdinal,
    sourceSegmentOrdinal: row.sourceSegmentOrdinal,
  };
}

function createPostgresIssueSessionRecoveryRepository(
  db: Db,
  options: PostgresIssueSessionRecoveryOptions,
): IssueSessionRecoveryRepository {
  const idFactory = options.idFactory ?? randomUUID;

  async function hydrateSelection(
    row: SelectionRow,
    sourceText: string,
  ): Promise<PinnedIssueSessionRecoverySelection> {
    const memberRows = await db
      .select()
      .from(issueSessionRecoverySelectionMembers)
      .where(
        and(
          eq(
            issueSessionRecoverySelectionMembers.companyId,
            row.companyId,
          ),
          eq(
            issueSessionRecoverySelectionMembers.issueId,
            row.issueId,
          ),
          eq(
            issueSessionRecoverySelectionMembers.sessionId,
            row.sessionId,
          ),
          eq(
            issueSessionRecoverySelectionMembers.selectionId,
            row.id,
          ),
        ),
      )
      .orderBy(
        asc(issueSessionRecoverySelectionMembers.memberOrdinal),
      );
    if (
      memberRows.some(
        (member, index) => member.memberOrdinal !== index,
      )
    ) {
      throw new IssueSessionRecoveryRejected(
        "Pinned recovery membership is not contiguous",
      );
    }
    const messageIds = memberRows.flatMap((member) =>
      member.memberKind === "message" && member.messageId
        ? [member.messageId]
        : [],
    );
    const commentIds = memberRows.flatMap((member) =>
      member.memberKind === "comment" && member.commentId
        ? [member.commentId]
        : [],
    );
    const [messageRows, commentRows] = await Promise.all([
      messageIds.length === 0
        ? Promise.resolve([] as MessageRow[])
        : db
            .select()
            .from(issueSessionMessages)
            .where(
              and(
                eq(issueSessionMessages.companyId, row.companyId),
                eq(issueSessionMessages.issueId, row.issueId),
                eq(issueSessionMessages.sessionId, row.sessionId),
                inArray(issueSessionMessages.id, messageIds),
              ),
            ),
      commentIds.length === 0
        ? Promise.resolve(
            [] as Array<typeof issueComments.$inferSelect>,
          )
        : db
            .select()
            .from(issueComments)
            .where(
              and(
                eq(issueComments.companyId, row.companyId),
                eq(issueComments.issueId, row.issueId),
                inArray(issueComments.id, commentIds),
              ),
            ),
    ]);
    const messages = new Map(messageRows.map((item) => [item.id, item]));
    const comments = new Map(commentRows.map((item) => [item.id, item]));
    const hydratedMembers = memberRows.map(
      (member): IssueSessionRecoveryMember => {
      if (member.memberKind === "message" && member.messageId) {
        const message = messages.get(member.messageId);
        if (!message || message.seq !== member.sourceSequence) {
          throw new IssueSessionRecoveryRejected(
            "Pinned recovery message identity changed",
          );
        }
        return {
          kind: "message",
          id: message.id,
          sourceSequence: member.sourceSequence,
          selectionRole: member.selectionRole,
          message: decodeStoredIssueSessionMessage(message),
        };
      }
      if (member.memberKind === "comment" && member.commentId) {
        const comment = comments.get(member.commentId);
        if (
          !comment ||
          comment.projectedEventSeq !== member.sourceSequence ||
          comment.projectedEventSeq !== member.commentProjectedEventSeq
        ) {
          throw new IssueSessionRecoveryRejected(
            "Pinned recovery comment identity changed",
          );
        }
        return {
          kind: "comment",
          id: comment.id,
          canonicalMessageId: comment.canonicalMessageId,
          sourceSequence: member.sourceSequence,
          authorKind: comment.authorType,
          body: comment.body,
        };
      }
      throw new IssueSessionRecoveryRejected(
        "Pinned recovery member has an invalid discriminated identity",
      );
      },
    );
    const members = await loadAndLowerRecoveryMembersForActivePruneEffects(
      db,
      {
        companyId: row.companyId,
        issueId: row.issueId,
        sessionId: row.sessionId,
        historyScopeKind: row.historyScopeKind,
        historyScopeId: row.historyScopeId,
        audience: row.audience,
        sourceHighWaterSeq: row.sourceHighWaterSeq,
      },
      hydratedMembers,
    );
    const checkpoint = row.selectedCheckpointControlId
      ? await options.compaction.loadCheckpoint({
          companyId: row.companyId,
          issueId: row.issueId,
          sessionId: row.sessionId,
          checkpointControlId: row.selectedCheckpointControlId,
          scopeKind: row.historyScopeKind,
          scopeId: row.historyScopeId,
          audience: row.audience,
          sourceHighWaterSeq: row.sourceHighWaterSeq,
        })
      : null;
    const depth = row.audience === "turns" ? "turns" : "thread";
    const selection: PinnedIssueSessionRecoverySelection = {
      id: row.id,
      ...identityFromRow(row),
      depth,
      checkpoint,
      members,
      selectionIdentityDigest: row.selectionIdentityDigest,
      expectedAssembledContentDigest:
        row.expectedAssembledContentDigest,
    };
    const assembled = assembleIssueSessionRecoveryPrompt({
      depth,
      checkpoint,
      members,
      sourceText,
    });
    if (
      issueSessionRecoveryAssembledContentDigest(assembled) !==
      row.expectedAssembledContentDigest
    ) {
      throw new IssueSessionRecoveryRejected(
        "Pinned recovery rows no longer rebuild their expected prompt",
      );
    }
    return selection;
  }

  return {
    async prepare(prompt): Promise<PreparedIssueSessionRecovery> {
      if (!prompt.carryContext) {
        throw new IssueSessionRecoveryRejected(
          "False-carry prompt entered the PostgreSQL recovery owner",
        );
      }
      const source = await db.transaction((transaction) =>
        lockRecoverySource(transaction, prompt),
      );
      if (source.existingSelection) {
        return {
          kind: "selected",
          sourceText: source.sourceText,
          selection: await hydrateSelection(
            source.existingSelection,
            source.sourceText,
          ),
        };
      }
      const depth = issueSessionRecoveryDepthForDial(source.dial);
      if (depth === null) {
        return { kind: "no_context", sourceText: source.sourceText };
      }
      const candidateRows = await db.transaction((transaction) =>
        loadCandidateMembers(transaction, source, depth),
      );
      if (candidateRows.members.length === 0) {
        return { kind: "no_context", sourceText: source.sourceText };
      }
      const scope = issueSessionRecoveryScopeForDepth(depth);
      const baseIdentity = {
        companyId: source.run.companyId,
        issueId: source.run.issueId,
        sessionId: source.run.sessionId,
        visibility: source.visibility,
        scopeKind: scope.scopeKind,
        scopeId: scopeId({
          companyId: source.run.companyId,
          issueId: source.run.issueId,
          ownershipEpoch: source.run.ownershipEpoch,
          targetAgentId: source.run.targetAgentId,
          laneKind: source.run.executionMode,
          contextEpoch: source.contextEpoch,
          sourceHighWaterSeq: source.sourceHighWaterSeq,
          audience: scope.audience,
          sourceRunId: prompt.identity.runId,
          sourceRefId: prompt.identity.refId,
          sourceRefOrdinal: prompt.identity.refOrdinal,
          sourceSegmentOrdinal: prompt.identity.segmentOrdinal,
        }),
        audience: scope.audience,
        ownershipEpoch: source.run.ownershipEpoch,
        targetAgentId: source.run.targetAgentId,
        laneKind: source.run.executionMode,
        contextEpoch: source.contextEpoch,
        executionLineageId: source.executionLineageId,
        sourceHighWaterSeq: source.sourceHighWaterSeq,
        effectiveContextDigest: source.effectiveContextDigest,
        sourceRunId: prompt.identity.runId,
        sourceRefId: prompt.identity.refId,
        sourceRefOrdinal: prompt.identity.refOrdinal,
        sourceSegmentOrdinal: prompt.identity.segmentOrdinal,
      } satisfies Omit<
        IssueSessionRecoverySelectionIdentity,
        | "selectedCheckpointControlId"
        | "latestFinishedAssistantMessageId"
      >;
      const prepared = await options.compaction.prepare({
        prompt,
        identity: baseIdentity,
        depth,
        members: candidateRows.members,
        latestFinishedAssistantMessageId:
          candidateRows.latestFinishedAssistantMessageId,
        sourceText: source.sourceText,
      });
      assertPreparedMembers(
        candidateRows.members,
        prepared,
        source.sourceHighWaterSeq,
      );
      const preparedMembers =
        await loadAndLowerRecoveryMembersForActivePruneEffects(
          db,
          {
            companyId: baseIdentity.companyId,
            issueId: baseIdentity.issueId,
            sessionId: baseIdentity.sessionId,
            historyScopeKind: baseIdentity.scopeKind,
            historyScopeId: baseIdentity.scopeId,
            audience: baseIdentity.audience,
            sourceHighWaterSeq: baseIdentity.sourceHighWaterSeq,
          },
          prepared.members,
        );
      const identity: IssueSessionRecoverySelectionIdentity = {
        ...baseIdentity,
        selectedCheckpointControlId: prepared.checkpoint?.id ?? null,
        latestFinishedAssistantMessageId:
          candidateRows.latestFinishedAssistantMessageId,
      };
      const selectionIdentityDigest =
        issueSessionRecoverySelectionIdentityDigest({
          identity,
          members: preparedMembers,
        });
      const assembled = assembleIssueSessionRecoveryPrompt({
        depth,
        checkpoint: prepared.checkpoint,
        members: preparedMembers,
        sourceText: source.sourceText,
      });
      const expectedAssembledContentDigest =
        issueSessionRecoveryAssembledContentDigest(assembled);
      const selectionId = idFactory();
      const inserted = await db.transaction(async (transaction) => {
        const current = await lockRecoverySource(transaction, prompt);
        if (current.existingSelection) return current.existingSelection;
        if (
          current.sourceHighWaterSeq !== source.sourceHighWaterSeq ||
          current.contextEpoch !== source.contextEpoch ||
          current.executionLineageId !== source.executionLineageId ||
          current.effectiveContextDigest !==
            source.effectiveContextDigest ||
          issueSessionRecoveryDepthForDial(current.dial) !== depth
        ) {
          throw new IssueSessionRecoveryRejected(
            "Recovery authorization changed before selection commit",
          );
        }
        const rows = await transaction
          .insert(issueSessionRecoverySelections)
          .values({
            id: selectionId,
            companyId: identity.companyId,
            issueId: identity.issueId,
            sessionId: identity.sessionId,
            visibility: identity.visibility,
            historyScopeKind: identity.scopeKind,
            historyScopeId: identity.scopeId,
            audience: identity.audience,
            ownershipEpoch: identity.ownershipEpoch,
            targetAgentId: identity.targetAgentId,
            laneKind: identity.laneKind,
            contextEpoch: identity.contextEpoch,
            executionLineageId: identity.executionLineageId,
            sourceHighWaterSeq: identity.sourceHighWaterSeq,
            effectiveContextDigest: identity.effectiveContextDigest,
            selectedCheckpointControlId:
              identity.selectedCheckpointControlId,
            latestFinishedAssistantMessageId:
              identity.latestFinishedAssistantMessageId,
            sourceRunId: identity.sourceRunId,
            sourceRefId: identity.sourceRefId,
            sourceRefOrdinal: identity.sourceRefOrdinal,
            sourceSegmentOrdinal: identity.sourceSegmentOrdinal,
            selectionIdentityDigest,
            expectedAssembledContentDigest,
            disposition: "active",
          })
          .returning();
        const row = rows[0];
        if (!row) {
          throw new IssueSessionRecoveryRejected(
            "Recovery selection did not commit",
          );
        }
        if (preparedMembers.length > 0) {
          await transaction
            .insert(issueSessionRecoverySelectionMembers)
            .values(
              preparedMembers.map((member, memberOrdinal) => ({
                companyId: identity.companyId,
                issueId: identity.issueId,
                sessionId: identity.sessionId,
                selectionId,
                memberOrdinal,
                memberKind: member.kind,
                selectionRole:
                  member.kind === "message"
                    ? member.selectionRole
                    : "history",
                sourceSequence: member.sourceSequence,
                messageId:
                  member.kind === "message" ? member.id : null,
                commentId:
                  member.kind === "comment" ? member.id : null,
                commentProjectedEventSeq:
                  member.kind === "comment"
                    ? member.sourceSequence
                    : null,
              })),
            );
        }
        return row;
      });
      return {
        kind: "selected",
        sourceText: source.sourceText,
        selection: await hydrateSelection(inserted, source.sourceText),
      };
    },
  };
}

export function createPostgresIssueSessionTargetNotFoundRecovery(
  db: Db,
  options: PostgresIssueSessionRecoveryOptions,
) {
  return createIssueSessionTargetNotFoundRecovery({
    repository: createPostgresIssueSessionRecoveryRepository(db, options),
  });
}
