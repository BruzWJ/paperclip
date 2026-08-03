import { randomUUID } from "node:crypto";
import {
  agentAdapterConfigRevisions,
  agents,
  issueBoardLifecycleCommands,
  companies,
  issueBoardReopenCommands,
  issueBoardUserComments,
  issueComments,
  issueConsultExecutions,
  issueCreatorWithdrawalCommands,
  issueCreatorEdgeReceivability,
  issueExecutionAuthorities,
  issueExecutionFinalizations,
  issueExecutionFinalizationStaleCheckOutbox,
  issueExecutionLanes,
  issueExecutionRefs,
  issueExecutionRunRefs,
  issueLivenessReconciliations,
  issueSessionContextEpochs,
  issueSessionEvents,
  issues,
  issueUpdates,
  type Db,
} from "@paperclipai/db";
import {
  type AgentLivenessActionKind,
  type AgentLivenessAttentionReason,
} from "@paperclipai/shared";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  or,
} from "drizzle-orm";
import { isServerAdapterImplementationAvailable } from "../adapters/registry.js";
import { evaluateAgentInvokability } from "./agent-invokability.js";
import { createIssueSessionAdmissionService } from "./issue-session/admission.js";
import type { IssueSessionDbTransaction } from "./issue-session/event-store.js";
import {
  lockIssueExecutionRetrySuccessorInTransaction,
  lockIssueExecutionRunInTransaction,
  lockResumedAgentSteeringLivenessSourceInTransaction,
  type IssueExecutionRunEnvelope,
  type IssueExecutionRunService,
} from "./issue-execution-run-service.js";

export const ISSUE_LIVENESS_FOLLOWUP_TEXT =
  "This issue is still active but no work is queued. Explicitly mention the agent who should continue. If you own the issue and no further work should continue, use issue_update to set its lifecycle state.";

type ReconciliationRow = typeof issueLivenessReconciliations.$inferSelect;
type RefRow = typeof issueExecutionRefs.$inferSelect;
type ConsultRow = typeof issueConsultExecutions.$inferSelect;
type RunRefRow = typeof issueExecutionRunRefs.$inferSelect;

export interface IssueLivenessFinalizationIdentity {
  readonly companyId: string;
  readonly issueId: string;
  readonly ownershipEpoch: number;
  readonly runId: string;
  readonly finalizationId: string;
}

export type IssueLivenessPostCommitWork =
  | {
      readonly kind: "owner_followup";
      readonly reconciliationId: string;
      readonly refId: string;
    }
  | {
      readonly kind: "consult_followup";
      readonly reconciliationId: string;
      readonly ref: RefRow;
      readonly consult: ConsultRow;
    }
  | {
      readonly kind: "attention";
      readonly reconciliationId: string;
      readonly companyId: string;
      readonly issueId: string;
      readonly ownershipEpoch: number;
      readonly frontierFinalizationId: string;
      readonly reason: AgentLivenessAttentionReason;
    }
  | { readonly kind: "none" };

export interface IssueLivenessPostCommitPort {
  dispatchFollowup(
    work: Extract<
      IssueLivenessPostCommitWork,
      { kind: "owner_followup" | "consult_followup" }
    >,
  ): Promise<void>;
  notifyAttention(
    work: Extract<IssueLivenessPostCommitWork, { kind: "attention" }>,
  ): Promise<void>;
}

export type IssueLivenessActionReference =
  | `issue_board_user_comment:${string}`
  | `issue:${string}`
  | `issue_consult_execution:${string}`
  | `issue_execution_prompt_segment:${string}:${string}:${number}`
  | `issue_execution_ref:${string}`
  | `issue_update:${string}`
  | `issue_creator_withdrawal_command:${string}`
  | `issue_board_lifecycle_command:${string}`
  | `issue_board_reopen_command:${string}`;

export interface IssueLivenessActionSettlement {
  readonly kind: "accepted" | "exit";
  readonly reconciliationId: string;
}

export class IssueLivenessReconciliationRejected extends Error {
  readonly code = "issue_liveness_reconciliation_rejected";

  constructor(message: string) {
    super(message);
    this.name = "IssueLivenessReconciliationRejected";
  }
}

function reject(message: string): never {
  throw new IssueLivenessReconciliationRejected(message);
}

function exactlyOne<T>(rows: readonly T[], message: string): T {
  if (rows.length !== 1) reject(message);
  return rows[0]!;
}

function exactIdentifier(value: string, label: string): void {
  if (value.length === 0 || value !== value.trim()) {
    reject(`${label} must be exact and non-empty`);
  }
}

function exactDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    reject(`${label} must be a valid timestamp`);
  }
  return value;
}

export function decideIssueLivenessActionSettlement(
  row: Pick<
    ReconciliationRow,
    | "id"
    | "admittedAt"
    | "acceptedActionKind"
    | "supersededBeforeAttentionAt"
    | "boardAttentionEmittedAt"
    | "exitActionKind"
  >,
  committedAt: Date,
): "accepted" | "exit" | null {
  if (committedAt <= row.admittedAt) return null;
  if (
    row.acceptedActionKind === null &&
    row.supersededBeforeAttentionAt === null &&
    row.boardAttentionEmittedAt === null
  ) {
    return "accepted";
  }
  if (
    row.boardAttentionEmittedAt !== null &&
    row.exitActionKind === null &&
    committedAt > row.boardAttentionEmittedAt
  ) {
    return "exit";
  }
  return null;
}

export function classifyIssueLivenessFollowupWithoutAction(input: {
  readonly terminalClassification:
    | "succeeded"
    | "interrupted"
    | "failed"
    | "cancelled"
    | "timed_out";
  readonly finalizationAction:
    | "comment_only"
    | "updates_committed"
    | "no_conversational_output";
}): AgentLivenessAttentionReason {
  return input.terminalClassification === "succeeded" &&
      input.finalizationAction !== "no_conversational_output"
    ? "agent_no_action"
    : "agent_followup_failed";
}

export function decideIssueLivenessFollowupFinalizationAuthority(input: {
  readonly authoritativeRunId: string;
  readonly finalizedRunId: string;
  readonly finalizedRunIsRetryAncestor: boolean;
  readonly directRetrySuccessorCount: number;
}): "consume_retry_source" | "settle_terminal_owner" {
  exactIdentifier(input.authoritativeRunId, "authoritative liveness run id");
  exactIdentifier(input.finalizedRunId, "finalized liveness run id");
  if (
    !Number.isSafeInteger(input.directRetrySuccessorCount) ||
    input.directRetrySuccessorCount < 0
  ) {
    reject("Liveness retry-successor cardinality is invalid");
  }
  if (input.authoritativeRunId !== input.finalizedRunId) {
    if (!input.finalizedRunIsRetryAncestor) {
      reject("Tagged liveness finalization is outside its exact retry chain");
    }
    return "consume_retry_source";
  }
  if (input.directRetrySuccessorCount !== 0) {
    reject(
      "A liveness retry successor must receive authority before its source finalization is consumed",
    );
  }
  return "settle_terminal_owner";
}

export function shouldClaimIssueLivenessFrontier(input: {
  readonly issueCurrentAndNonterminal: boolean;
  readonly creatorEdgeReceivable: boolean;
  readonly queuedRefExists: boolean;
  readonly activeAgentRunExists: boolean;
  readonly explicitSourceActionExists: boolean;
  readonly reconciliationExists: boolean;
}): boolean {
  return input.issueCurrentAndNonterminal &&
    input.creatorEdgeReceivable &&
    !input.queuedRefExists &&
    !input.activeAgentRunExists &&
    !input.explicitSourceActionExists &&
    !input.reconciliationExists;
}

interface CanonicalIssueLivenessActionSource {
  readonly companyId: string;
  readonly issueId: string;
  readonly kind: AgentLivenessActionKind;
  readonly referenceId: IssueLivenessActionReference;
  readonly committedAt: Date;
  /** The reconciliation epoch affected by this action. */
  readonly ownershipEpoch: number;
  /** The issue epoch that must be visible after the source row commits. */
  readonly resultingOwnershipEpoch: number;
}

type IssueLivenessRunService = Pick<
  IssueExecutionRunService,
  | "lockRun"
  | "lockActiveAgentRunsForIssueEpochInTransaction"
  | "listResumedAgentSteeringLivenessActionsInTransaction"
>;

type ParsedIssueLivenessActionReference =
  | {
      readonly source:
        | "issue_board_user_comment"
        | "issue"
        | "issue_consult_execution"
        | "issue_execution_ref"
        | "issue_update"
        | "issue_creator_withdrawal_command"
        | "issue_board_lifecycle_command"
        | "issue_board_reopen_command";
      readonly sourceId: string;
    }
  | {
      readonly source: "issue_execution_prompt_segment";
      readonly runId: string;
      readonly refId: string;
      readonly segmentOrdinal: number;
    };

function parseIssueLivenessActionReference(
  reference: string,
): ParsedIssueLivenessActionReference {
  const parts = reference.split(":");
  if (parts[0] === "issue_execution_prompt_segment") {
    if (parts.length !== 4) {
      reject("Prompt-segment liveness reference has an invalid shape");
    }
    exactIdentifier(parts[1]!, "liveness prompt-segment run id");
    exactIdentifier(parts[2]!, "liveness prompt-segment ref id");
    const segmentOrdinal = Number(parts[3]);
    if (!Number.isSafeInteger(segmentOrdinal) || segmentOrdinal <= 0) {
      reject("Liveness prompt-segment ordinal must be positive");
    }
    return {
      source: "issue_execution_prompt_segment",
      runId: parts[1]!,
      refId: parts[2]!,
      segmentOrdinal,
    };
  }
  const simpleSources = new Set([
    "issue_board_user_comment",
    "issue",
    "issue_consult_execution",
    "issue_execution_ref",
    "issue_update",
    "issue_creator_withdrawal_command",
    "issue_board_lifecycle_command",
    "issue_board_reopen_command",
  ] as const);
  if (
    parts.length !== 2 ||
    !simpleSources.has(parts[0] as never)
  ) {
    reject("Liveness action reference is not a closed typed source");
  }
  exactIdentifier(parts[1]!, "liveness action source id");
  return {
    source: parts[0] as Exclude<
      ParsedIssueLivenessActionReference["source"],
      "issue_execution_prompt_segment"
    >,
    sourceId: parts[1]!,
  };
}

async function resolveIssueLivenessActionSourceInTransaction(
  transaction: IssueSessionDbTransaction,
  sourceReference: IssueLivenessActionReference,
): Promise<CanonicalIssueLivenessActionSource> {
  const reference = parseIssueLivenessActionReference(sourceReference);
  switch (reference.source) {
    case "issue_board_user_comment": {
      const source = exactlyOne(
        await transaction
          .select({
            id: issueBoardUserComments.id,
            companyId: issueBoardUserComments.companyId,
            issueId: issueBoardUserComments.issueId,
            ownershipEpoch: issueBoardUserComments.ownershipEpoch,
            createdAt: issueBoardUserComments.createdAt,
          })
          .from(issueBoardUserComments)
          .innerJoin(
            issueComments,
            eq(issueComments.id, issueBoardUserComments.commentId),
          )
          .where(
            and(
              eq(issueBoardUserComments.id, reference.sourceId),
              eq(
                issueComments.companyId,
                issueBoardUserComments.companyId,
              ),
              eq(issueComments.issueId, issueBoardUserComments.issueId),
              eq(issueComments.authorType, "user"),
            ),
          )
          .limit(2)
          .for("update"),
        "Authenticated-human liveness action has no exact comment command",
      );
      return {
        companyId: source.companyId,
        issueId: source.issueId,
        kind: "authenticated_human_comment",
        referenceId: sourceReference,
        committedAt: source.createdAt,
        ownershipEpoch: source.ownershipEpoch,
        resultingOwnershipEpoch: source.ownershipEpoch,
      };
    }

    case "issue": {
      const source = exactlyOne(
        await transaction
          .select({
            id: issues.id,
            companyId: issues.companyId,
            parentId: issues.parentId,
            parentOwnershipEpoch: issues.parentOwnershipEpoch,
            createdAt: issues.createdAt,
          })
          .from(issues)
          .where(
            and(
              eq(issues.id, reference.sourceId),
              isNotNull(issues.parentId),
              isNotNull(issues.parentOwnershipEpoch),
            ),
          )
          .limit(2)
          .for("update"),
        "Child-creation liveness action has no exact direct child issue",
      );
      if (!source.parentId || source.parentOwnershipEpoch === null) {
        reject("Child-creation liveness source lost its parent epoch");
      }
      return {
        companyId: source.companyId,
        issueId: source.parentId,
        kind: "issue_create_child",
        referenceId: sourceReference,
        committedAt: source.createdAt,
        ownershipEpoch: source.parentOwnershipEpoch,
        resultingOwnershipEpoch: source.parentOwnershipEpoch,
      };
    }

    case "issue_consult_execution": {
      const source = exactlyOne(
        await transaction
          .select({
            id: issueConsultExecutions.id,
            companyId: issueConsultExecutions.companyId,
            issueId: issueConsultExecutions.issueId,
            ownershipEpoch: issueConsultExecutions.ownershipEpoch,
            committedAt: issueConsultExecutions.closedAt,
          })
          .from(issueConsultExecutions)
          .innerJoin(
            issueSessionEvents,
            and(
              eq(
                issueSessionEvents.companyId,
                issueConsultExecutions.companyId,
              ),
              eq(issueSessionEvents.issueId, issueConsultExecutions.issueId),
              eq(
                issueSessionEvents.sessionId,
                issueConsultExecutions.sessionId,
              ),
              eq(
                issueSessionEvents.ownershipEpoch,
                issueConsultExecutions.ownershipEpoch,
              ),
              eq(issueSessionEvents.sourceKind, "consult_response"),
              eq(
                issueSessionEvents.sourceRecordId,
                issueConsultExecutions.id,
              ),
            ),
          )
          .where(
            and(
              eq(issueConsultExecutions.id, reference.sourceId),
              eq(issueConsultExecutions.state, "completed"),
              eq(
                issueConsultExecutions.closeReason,
                "nested_execution_completed",
              ),
              isNotNull(issueConsultExecutions.closedAt),
            ),
          )
          .limit(2)
          .for("update"),
        "Mention liveness action has no exact completed consult source",
      );
      if (!source.committedAt) {
        reject("Completed mention consult has no canonical close time");
      }
      return {
        companyId: source.companyId,
        issueId: source.issueId,
        kind: "mention_agent",
        referenceId: sourceReference,
        committedAt: source.committedAt,
        ownershipEpoch: source.ownershipEpoch,
        resultingOwnershipEpoch: source.ownershipEpoch,
      };
    }

    case "issue_execution_prompt_segment": {
      const source =
        await lockResumedAgentSteeringLivenessSourceInTransaction(
          transaction,
          reference,
        );
      if (!source) {
        reject("Mention liveness action has no exact resumed steering segment");
      }
      return {
        companyId: source.companyId,
        issueId: source.issueId,
        kind: "mention_agent",
        referenceId: sourceReference,
        committedAt: source.committedAt,
        ownershipEpoch: source.ownershipEpoch,
        resultingOwnershipEpoch: source.ownershipEpoch,
      };
    }

    case "issue_execution_ref": {
      const source = exactlyOne(
        await transaction
          .select({
            id: issueExecutionRefs.id,
            companyId: issueExecutionRefs.companyId,
            issueId: issueExecutionRefs.issueId,
            ownershipEpoch: issueExecutionRefs.ownershipEpoch,
            previousOwnershipEpoch:
              issueExecutionRefs.previousOwnershipEpoch,
            createdAt: issueExecutionRefs.createdAt,
          })
          .from(issueExecutionRefs)
          .where(
            and(
              eq(issueExecutionRefs.id, reference.sourceId),
              eq(issueExecutionRefs.mode, "owner"),
              eq(issueExecutionRefs.sourceKind, "issue_reassignment"),
              isNotNull(issueExecutionRefs.previousOwnershipEpoch),
            ),
          )
          .limit(2)
          .for("update"),
        "Assignment liveness action has no exact reassignment ref",
      );
      if (source.previousOwnershipEpoch === null) {
        reject("Assignment liveness action has no preceding issue epoch");
      }
      return {
        companyId: source.companyId,
        issueId: source.issueId,
        kind: "issue_assign",
        referenceId: sourceReference,
        committedAt: source.createdAt,
        ownershipEpoch: source.previousOwnershipEpoch,
        resultingOwnershipEpoch: source.ownershipEpoch,
      };
    }

    case "issue_update": {
      const source = exactlyOne(
        await transaction
          .select({
            id: issueUpdates.id,
            companyId: issueUpdates.companyId,
            issueId: issueUpdates.issueId,
            ownershipEpoch: issueUpdates.ownershipEpoch,
            createdAt: issueUpdates.createdAt,
            sourceKind: issueUpdates.sourceKind,
          })
          .from(issueUpdates)
          .where(
            and(
              eq(issueUpdates.id, reference.sourceId),
            ),
          )
          .limit(2)
          .for("update"),
        "Issue-update liveness action has no exact canonical update",
      );
      if (
        !["agent-execution", "user/board", "plugin"].includes(
          source.sourceKind,
        )
      ) {
        reject("Issue update is not a closed liveness action source");
      }
      const withdrawal = await transaction
        .select({ id: issueCreatorWithdrawalCommands.id })
        .from(issueCreatorWithdrawalCommands)
        .where(eq(issueCreatorWithdrawalCommands.issueUpdateId, source.id))
        .limit(1)
        .for("update");
      if (withdrawal.length > 0) {
        reject("Creator withdrawal must use its typed command source");
      }
      return {
        companyId: source.companyId,
        issueId: source.issueId,
        kind: "issue_update",
        referenceId: sourceReference,
        committedAt: source.createdAt,
        ownershipEpoch: source.ownershipEpoch,
        resultingOwnershipEpoch: source.ownershipEpoch,
      };
    }

    case "issue_creator_withdrawal_command": {
      const source = exactlyOne(
        await transaction
          .select({
            id: issueCreatorWithdrawalCommands.id,
            companyId: issueCreatorWithdrawalCommands.companyId,
            issueId: issueCreatorWithdrawalCommands.issueId,
            outgoingOwnershipEpoch:
              issueCreatorWithdrawalCommands.outgoingOwnershipEpoch,
            resultingOwnershipEpoch:
              issueCreatorWithdrawalCommands.resultingOwnershipEpoch,
            acceptedAt: issueCreatorWithdrawalCommands.acceptedAt,
          })
          .from(issueCreatorWithdrawalCommands)
          .where(eq(issueCreatorWithdrawalCommands.id, reference.sourceId))
          .limit(2)
          .for("update"),
        "Creator-withdrawal liveness action has no exact typed command",
      );
      return {
        companyId: source.companyId,
        issueId: source.issueId,
        kind: "creator_withdrawal",
        referenceId: sourceReference,
        committedAt: source.acceptedAt,
        ownershipEpoch: source.outgoingOwnershipEpoch,
        resultingOwnershipEpoch: source.resultingOwnershipEpoch,
      };
    }

    case "issue_board_lifecycle_command": {
      const source = exactlyOne(
        await transaction
          .select({
            id: issueBoardLifecycleCommands.id,
            companyId: issueBoardLifecycleCommands.companyId,
            issueId: issueBoardLifecycleCommands.issueId,
            ownershipEpoch: issueBoardLifecycleCommands.ownershipEpoch,
            committedAt: issueBoardLifecycleCommands.committedAt,
          })
          .from(issueBoardLifecycleCommands)
          .where(eq(issueBoardLifecycleCommands.id, reference.sourceId))
          .limit(2)
          .for("update"),
        "Board-lifecycle liveness action has no exact typed command",
      );
      return {
        companyId: source.companyId,
        issueId: source.issueId,
        kind: "board_lifecycle_command",
        referenceId: sourceReference,
        committedAt: source.committedAt,
        ownershipEpoch: source.ownershipEpoch,
        resultingOwnershipEpoch: source.ownershipEpoch,
      };
    }

    case "issue_board_reopen_command": {
      const source = exactlyOne(
        await transaction
          .select({
            id: issueBoardReopenCommands.id,
            companyId: issueBoardReopenCommands.companyId,
            issueId: issueBoardReopenCommands.issueId,
            ownershipEpoch: issueBoardReopenCommands.ownershipEpoch,
            createdAt: issueBoardReopenCommands.createdAt,
          })
          .from(issueBoardReopenCommands)
          .where(
            and(
              eq(issueBoardReopenCommands.id, reference.sourceId),
            ),
          )
          .limit(2)
          .for("update"),
        "Board-reopen liveness action has no exact reopen command",
      );
      return {
        companyId: source.companyId,
        issueId: source.issueId,
        kind: "board_reopen",
        referenceId: sourceReference,
        committedAt: source.createdAt,
        ownershipEpoch: source.ownershipEpoch,
        resultingOwnershipEpoch: source.ownershipEpoch,
      };
    }
  }
}

/**
 * Canonical action hook used by the closed P15 action producers. The producer
 * supplies only its immutable typed source reference; the resolver derives
 * kind, company, issue, epoch, and commit time from that locked source row.
 */
export async function recordIssueLivenessActionInTransaction(
  transaction: IssueSessionDbTransaction,
  sourceReference: IssueLivenessActionReference,
): Promise<readonly IssueLivenessActionSettlement[]> {
  const source = await resolveIssueLivenessActionSourceInTransaction(
    transaction,
    sourceReference,
  );

  const issue = exactlyOne(
    await transaction
      .select({
        ownershipEpoch: issues.ownershipEpoch,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, source.companyId),
          eq(issues.id, source.issueId),
        ),
      )
      .limit(2)
      .for("update"),
    "Liveness action lost its exact issue",
  );
  if (source.resultingOwnershipEpoch !== issue.ownershipEpoch) {
    reject("Liveness action source is not current for its exact issue");
  }
  const canonicalCommittedAt = source.committedAt;

  const rows = await transaction
    .select()
    .from(issueLivenessReconciliations)
    .where(
      and(
        eq(issueLivenessReconciliations.companyId, source.companyId),
        eq(issueLivenessReconciliations.issueId, source.issueId),
        eq(
          issueLivenessReconciliations.ownershipEpoch,
          source.ownershipEpoch,
        ),
        or(
          and(
            isNull(issueLivenessReconciliations.acceptedActionKind),
            isNull(
              issueLivenessReconciliations.supersededBeforeAttentionAt,
            ),
            isNull(issueLivenessReconciliations.boardAttentionEmittedAt),
          ),
          and(
            isNotNull(issueLivenessReconciliations.boardAttentionEmittedAt),
            isNull(issueLivenessReconciliations.exitActionKind),
          ),
        ),
      ),
    )
    .orderBy(asc(issueLivenessReconciliations.admittedAt))
    .for("update");

  const settlements: IssueLivenessActionSettlement[] = [];
  for (const row of rows) {
    // A P17 tool action is settled by the finalization consumer so the
    // accepted-action tuple and follow-up finalization remain one atomic
    // schema transition. Producer hooks may still observe the action here,
    // but must not create the forbidden finalized-later intermediate row.
    if (
      row.followupSystemReplyCommentId !== null &&
      row.followupFinalizationId === null
    ) {
      continue;
    }
    const settlement = decideIssueLivenessActionSettlement(
      row,
      canonicalCommittedAt,
    );
    if (settlement === "accepted") {
      const updated = await transaction
        .update(issueLivenessReconciliations)
        .set({
          acceptedActionKind: source.kind,
          acceptedActionSourceId: source.referenceId,
          acceptedActionCommittedAt: canonicalCommittedAt,
        })
        .where(
          and(
            eq(issueLivenessReconciliations.id, row.id),
            isNull(issueLivenessReconciliations.acceptedActionKind),
            isNull(
              issueLivenessReconciliations.supersededBeforeAttentionAt,
            ),
            isNull(issueLivenessReconciliations.boardAttentionEmittedAt),
          ),
        )
        .returning({ id: issueLivenessReconciliations.id });
      if (updated.length === 1) {
        settlements.push({ kind: "accepted", reconciliationId: row.id });
      }
      continue;
    }
    if (settlement === "exit") {
      const updated = await transaction
        .update(issueLivenessReconciliations)
        .set({
          exitActionKind: source.kind,
          exitActionSourceId: source.referenceId,
          exitActionCommittedAt: canonicalCommittedAt,
        })
        .where(
          and(
            eq(issueLivenessReconciliations.id, row.id),
            isNotNull(issueLivenessReconciliations.boardAttentionEmittedAt),
            isNull(issueLivenessReconciliations.exitActionKind),
          ),
        )
        .returning({ id: issueLivenessReconciliations.id });
      if (updated.length === 1) {
        settlements.push({ kind: "exit", reconciliationId: row.id });
      }
    }
  }
  return Object.freeze(settlements);
}

interface ExplicitAction {
  readonly kind: AgentLivenessActionKind;
  readonly referenceId: string;
  readonly committedAt: Date;
}

type ExplicitActionSearch =
  | {
      readonly kind: "run";
      readonly companyId: string;
      readonly issueId: string;
      readonly ownershipEpoch: number;
      readonly runId: string;
    }
  | {
      readonly kind: "post_admission";
      readonly row: Pick<
        ReconciliationRow,
        "companyId" | "issueId" | "ownershipEpoch" | "admittedAt"
      >;
    };

async function findExplicitAction(
  transaction: IssueSessionDbTransaction,
  search: ExplicitActionSearch,
  runService: Pick<
    IssueExecutionRunService,
    "listResumedAgentSteeringLivenessActionsInTransaction"
  >,
): Promise<ExplicitAction | null> {
  const scope = search.kind === "run" ? search : search.row;
  const updates = await transaction
    .select({
      id: issueUpdates.id,
      createdAt: issueUpdates.createdAt,
    })
    .from(issueUpdates)
    .leftJoin(
      issueCreatorWithdrawalCommands,
      eq(issueCreatorWithdrawalCommands.issueUpdateId, issueUpdates.id),
    )
    .where(
      and(
        eq(issueUpdates.companyId, scope.companyId),
        eq(issueUpdates.issueId, scope.issueId),
        eq(issueUpdates.ownershipEpoch, scope.ownershipEpoch),
        inArray(issueUpdates.sourceKind, [
          "agent-execution",
          "user/board",
          "plugin",
        ]),
        isNull(issueCreatorWithdrawalCommands.id),
        search.kind === "run"
          ? eq(issueUpdates.runId, search.runId)
          : gt(issueUpdates.createdAt, search.row.admittedAt),
      ),
    )
    .orderBy(asc(issueUpdates.createdAt), asc(issueUpdates.id));
  const actions: ExplicitAction[] = updates.map((update) => ({
    kind: "issue_update",
    referenceId: `issue_update:${update.id}`,
    committedAt: update.createdAt,
  }));

  const children = await transaction
    .select({
      id: issues.id,
      createdAt: issues.createdAt,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, scope.companyId),
        eq(issues.parentId, scope.issueId),
        eq(issues.parentOwnershipEpoch, scope.ownershipEpoch),
        search.kind === "run"
          ? and(
              eq(issues.originRunId, search.runId),
              eq(issues.originKind, "agent_issue_create"),
              eq(issues.creatorKind, "agent-execution"),
            )
          : gt(issues.createdAt, search.row.admittedAt),
      ),
    )
    .orderBy(asc(issues.createdAt), asc(issues.id));
  for (const child of children) {
    actions.push({
      kind: "issue_create_child",
      referenceId: `issue:${child.id}`,
      committedAt: child.createdAt,
    });
  }

  const mentions = await transaction
    .select({
      id: issueConsultExecutions.id,
      closedAt: issueConsultExecutions.closedAt,
    })
    .from(issueConsultExecutions)
    .innerJoin(
      issueSessionEvents,
      and(
        eq(
          issueSessionEvents.companyId,
          issueConsultExecutions.companyId,
        ),
        eq(issueSessionEvents.issueId, issueConsultExecutions.issueId),
        eq(issueSessionEvents.sessionId, issueConsultExecutions.sessionId),
        eq(
          issueSessionEvents.ownershipEpoch,
          issueConsultExecutions.ownershipEpoch,
        ),
        eq(issueSessionEvents.sourceKind, "consult_response"),
        eq(
          issueSessionEvents.sourceRecordId,
          issueConsultExecutions.id,
        ),
      ),
    )
    .where(
      and(
        eq(issueConsultExecutions.companyId, scope.companyId),
        eq(issueConsultExecutions.issueId, scope.issueId),
        eq(issueConsultExecutions.ownershipEpoch, scope.ownershipEpoch),
        eq(issueConsultExecutions.state, "completed"),
        eq(
          issueConsultExecutions.closeReason,
          "nested_execution_completed",
        ),
        isNotNull(issueConsultExecutions.closedAt),
        search.kind === "run"
          ? eq(issueConsultExecutions.sourceRunId, search.runId)
          : gt(issueConsultExecutions.closedAt, search.row.admittedAt),
      ),
    )
    .orderBy(
      asc(issueConsultExecutions.closedAt),
      asc(issueConsultExecutions.id),
    );
  for (const mention of mentions) {
    if (!mention.closedAt) continue;
    actions.push({
      kind: "mention_agent",
      referenceId: `issue_consult_execution:${mention.id}`,
      committedAt: mention.closedAt,
    });
  }

  const steering =
    await runService.listResumedAgentSteeringLivenessActionsInTransaction(
      transaction,
      search.kind === "run"
        ? {
            companyId: scope.companyId,
            issueId: scope.issueId,
            ownershipEpoch: scope.ownershipEpoch,
            sourceRunId: search.runId,
          }
        : {
            companyId: scope.companyId,
            issueId: scope.issueId,
            ownershipEpoch: scope.ownershipEpoch,
            committedAfter: search.row.admittedAt,
          },
    );
  for (const segment of steering) {
    actions.push({
      kind: "mention_agent",
      referenceId:
        `issue_execution_prompt_segment:${segment.runId}:${segment.refId}:${segment.segmentOrdinal}`,
      committedAt: segment.committedAt,
    });
  }
  actions.sort(
    (left, right) =>
      left.committedAt.getTime() - right.committedAt.getTime() ||
      left.referenceId.localeCompare(right.referenceId),
  );
  return actions[0] ?? null;
}

async function findAcceptedActionForFollowupFinalization(
  transaction: IssueSessionDbTransaction,
  row: ReconciliationRow,
  runService: Pick<
    IssueExecutionRunService,
    "listResumedAgentSteeringLivenessActionsInTransaction"
  >,
): Promise<ExplicitAction | null> {
  const actions: ExplicitAction[] = [];
  const agentAction = await findExplicitAction(transaction, {
    kind: "post_admission",
    row,
  }, runService);
  if (agentAction) actions.push(agentAction);

  const human = await transaction
    .select({
      id: issueBoardUserComments.id,
      createdAt: issueBoardUserComments.createdAt,
    })
    .from(issueBoardUserComments)
    .innerJoin(
      issueComments,
      eq(issueComments.id, issueBoardUserComments.commentId),
    )
    .where(
      and(
        eq(issueBoardUserComments.companyId, row.companyId),
        eq(issueBoardUserComments.issueId, row.issueId),
        eq(issueBoardUserComments.ownershipEpoch, row.ownershipEpoch),
        gt(issueBoardUserComments.createdAt, row.admittedAt),
        eq(issueComments.companyId, issueBoardUserComments.companyId),
        eq(issueComments.issueId, issueBoardUserComments.issueId),
        eq(issueComments.authorType, "user"),
      ),
    )
    .orderBy(
      asc(issueBoardUserComments.createdAt),
      asc(issueBoardUserComments.id),
    )
    .limit(1);
  if (human[0]) {
    actions.push({
      kind: "authenticated_human_comment",
      referenceId: `issue_board_user_comment:${human[0].id}`,
      committedAt: human[0].createdAt,
    });
  }

  const assignment = await transaction
    .select({
      id: issueExecutionRefs.id,
      createdAt: issueExecutionRefs.createdAt,
    })
    .from(issueExecutionRefs)
    .where(
      and(
        eq(issueExecutionRefs.companyId, row.companyId),
        eq(issueExecutionRefs.issueId, row.issueId),
        eq(issueExecutionRefs.ownershipEpoch, row.ownershipEpoch + 1),
        eq(
          issueExecutionRefs.previousOwnershipEpoch,
          row.ownershipEpoch,
        ),
        eq(issueExecutionRefs.mode, "owner"),
        eq(issueExecutionRefs.sourceKind, "issue_reassignment"),
        gt(issueExecutionRefs.createdAt, row.admittedAt),
      ),
    )
    .orderBy(asc(issueExecutionRefs.createdAt), asc(issueExecutionRefs.id))
    .limit(1);
  if (assignment[0]) {
    actions.push({
      kind: "issue_assign",
      referenceId: `issue_execution_ref:${assignment[0].id}`,
      committedAt: assignment[0].createdAt,
    });
  }

  const withdrawal = await transaction
    .select({
      id: issueCreatorWithdrawalCommands.id,
      acceptedAt: issueCreatorWithdrawalCommands.acceptedAt,
    })
    .from(issueCreatorWithdrawalCommands)
    .where(
      and(
        eq(issueCreatorWithdrawalCommands.companyId, row.companyId),
        eq(issueCreatorWithdrawalCommands.issueId, row.issueId),
        eq(
          issueCreatorWithdrawalCommands.outgoingOwnershipEpoch,
          row.ownershipEpoch,
        ),
        gt(issueCreatorWithdrawalCommands.acceptedAt, row.admittedAt),
      ),
    )
    .orderBy(
      asc(issueCreatorWithdrawalCommands.acceptedAt),
      asc(issueCreatorWithdrawalCommands.id),
    )
    .limit(1);
  if (withdrawal[0]) {
    actions.push({
      kind: "creator_withdrawal",
      referenceId:
        `issue_creator_withdrawal_command:${withdrawal[0].id}`,
      committedAt: withdrawal[0].acceptedAt,
    });
  }

  const boardLifecycle = await transaction
    .select({
      id: issueBoardLifecycleCommands.id,
      committedAt: issueBoardLifecycleCommands.committedAt,
    })
    .from(issueBoardLifecycleCommands)
    .where(
      and(
        eq(issueBoardLifecycleCommands.companyId, row.companyId),
        eq(issueBoardLifecycleCommands.issueId, row.issueId),
        eq(
          issueBoardLifecycleCommands.ownershipEpoch,
          row.ownershipEpoch,
        ),
        gt(issueBoardLifecycleCommands.committedAt, row.admittedAt),
      ),
    )
    .orderBy(
      asc(issueBoardLifecycleCommands.committedAt),
      asc(issueBoardLifecycleCommands.id),
    )
    .limit(1);
  if (boardLifecycle[0]) {
    actions.push({
      kind: "board_lifecycle_command",
      referenceId:
        `issue_board_lifecycle_command:${boardLifecycle[0].id}`,
      committedAt: boardLifecycle[0].committedAt,
    });
  }

  const reopen = await transaction
    .select({
      id: issueBoardReopenCommands.id,
      createdAt: issueBoardReopenCommands.createdAt,
    })
    .from(issueBoardReopenCommands)
    .where(
      and(
        eq(issueBoardReopenCommands.companyId, row.companyId),
        eq(issueBoardReopenCommands.issueId, row.issueId),
        eq(issueBoardReopenCommands.ownershipEpoch, row.ownershipEpoch),
        gt(issueBoardReopenCommands.createdAt, row.admittedAt),
      ),
    )
    .orderBy(
      asc(issueBoardReopenCommands.createdAt),
      asc(issueBoardReopenCommands.id),
    )
    .limit(1);
  if (reopen[0]) {
    actions.push({
      kind: "board_reopen",
      referenceId: `issue_board_reopen_command:${reopen[0].id}`,
      committedAt: reopen[0].createdAt,
    });
  }

  actions.sort(
    (left, right) =>
      left.committedAt.getTime() - right.committedAt.getTime() ||
      left.referenceId.localeCompare(right.referenceId),
  );
  return actions.find(
    (action) => action.committedAt > row.admittedAt,
  ) ?? null;
}

function attentionWork(
  row: Pick<
    ReconciliationRow,
    | "id"
    | "companyId"
    | "issueId"
    | "ownershipEpoch"
    | "frontierFinalizationId"
  >,
  reason: AgentLivenessAttentionReason,
): Extract<IssueLivenessPostCommitWork, { kind: "attention" }> {
  return {
    kind: "attention",
    reconciliationId: row.id,
    companyId: row.companyId,
    issueId: row.issueId,
    ownershipEpoch: row.ownershipEpoch,
    frontierFinalizationId: row.frontierFinalizationId,
    reason,
  };
}

async function settleWithoutAction(
  transaction: IssueSessionDbTransaction,
  row: ReconciliationRow,
  reason: AgentLivenessAttentionReason,
  at: Date,
): Promise<IssueLivenessPostCommitWork> {
  const edge = await transaction
    .select()
    .from(issueCreatorEdgeReceivability)
    .where(
      and(
        eq(issueCreatorEdgeReceivability.companyId, row.companyId),
        eq(issueCreatorEdgeReceivability.issueId, row.issueId),
        eq(
          issueCreatorEdgeReceivability.ownershipEpoch,
          row.ownershipEpoch,
        ),
        eq(issueCreatorEdgeReceivability.id, row.creatorEdgeId),
        eq(
          issueCreatorEdgeReceivability.admissionVersion,
          row.creatorEdgeAdmissionVersion,
        ),
      ),
    )
    .limit(2)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!edge || edge.state !== "receivable") {
    exactlyOne(
      await transaction
        .update(issueLivenessReconciliations)
        .set({ supersededBeforeAttentionAt: at })
        .where(
          and(
            eq(issueLivenessReconciliations.id, row.id),
            isNull(issueLivenessReconciliations.acceptedActionKind),
            isNull(
              issueLivenessReconciliations.supersededBeforeAttentionAt,
            ),
            isNull(issueLivenessReconciliations.boardAttentionEmittedAt),
          ),
        )
        .returning({ id: issueLivenessReconciliations.id }),
      "Liveness reconciliation could not record edge supersession",
    );
    return { kind: "none" };
  }
  exactlyOne(
    await transaction
      .update(issueLivenessReconciliations)
      .set({
        boardAttentionEmittedAt: at,
        boardAttentionReason: reason,
      })
      .where(
        and(
          eq(issueLivenessReconciliations.id, row.id),
          isNull(issueLivenessReconciliations.acceptedActionKind),
          isNull(issueLivenessReconciliations.supersededBeforeAttentionAt),
          isNull(issueLivenessReconciliations.boardAttentionEmittedAt),
        ),
      )
      .returning({ id: issueLivenessReconciliations.id }),
    "Liveness reconciliation could not emit its one Attention reason fact",
  );
  return attentionWork(row, reason);
}

async function markOutboxProcessed(
  transaction: IssueSessionDbTransaction,
  finalizationId: string,
  at: Date,
): Promise<void> {
  exactlyOne(
    await transaction
      .update(issueExecutionFinalizationStaleCheckOutbox)
      .set({ processedAt: at })
      .where(
        and(
          eq(
            issueExecutionFinalizationStaleCheckOutbox.finalizationId,
            finalizationId,
          ),
          isNull(issueExecutionFinalizationStaleCheckOutbox.processedAt),
        ),
      )
      .returning({
        finalizationId:
          issueExecutionFinalizationStaleCheckOutbox.finalizationId,
      }),
    "Finalization stale-check outbox lost its unprocessed work item",
  );
}

interface LockedLivenessFollowupRun {
  readonly run: IssueExecutionRunEnvelope;
  readonly member: RunRefRow;
  readonly ref: RefRow;
}

async function lockLivenessFollowupRun(
  transaction: IssueSessionDbTransaction,
  input: {
    readonly reconciliation: ReconciliationRow;
    readonly runId: string;
  },
): Promise<LockedLivenessFollowupRun> {
  const run = await lockIssueExecutionRunInTransaction(transaction, {
    companyId: input.reconciliation.companyId,
    issueId: input.reconciliation.issueId,
    runId: input.runId,
  });
  const binding = exactlyOne(
    await transaction
      .select({ member: issueExecutionRunRefs, ref: issueExecutionRefs })
      .from(issueExecutionRunRefs)
      .innerJoin(
        issueExecutionRefs,
        eq(issueExecutionRefs.id, issueExecutionRunRefs.refId),
      )
      .where(eq(issueExecutionRunRefs.runId, run.runId))
      .limit(2)
      .for("update"),
    "A liveness follow-up run must contain its one tagged ref only",
  );
  if (
    run.ownershipEpoch !== input.reconciliation.ownershipEpoch ||
    run.targetAgentId !== input.reconciliation.staleTargetAgentId ||
    run.executionMode !== input.reconciliation.sourceMode ||
    !["productive", "consult"].includes(run.kind) ||
    binding.member.companyId !== run.companyId ||
    binding.member.issueId !== run.issueId ||
    binding.member.sessionId !== run.sessionId ||
    binding.member.refOrdinal !== 0 ||
    binding.ref.id !== input.reconciliation.followupRefId ||
    binding.ref.companyId !== run.companyId ||
    binding.ref.issueId !== run.issueId ||
    binding.ref.sessionId !== run.sessionId ||
    binding.ref.ownershipEpoch !== run.ownershipEpoch ||
    binding.ref.targetAgentId !== run.targetAgentId ||
    binding.ref.mode !== run.executionMode ||
    binding.ref.sourceKind !== "agent_liveness_followup" ||
    binding.ref.sourceRecordId !== input.reconciliation.id
  ) {
    reject("Liveness follow-up retry chain crossed its immutable binding");
  }
  return { run, member: binding.member, ref: binding.ref };
}

function assertPreSendLivenessRetryLink(
  from: LockedLivenessFollowupRun,
  to: LockedLivenessFollowupRun,
  options: { readonly freshSuccessor: boolean },
): void {
  const sameScope =
    to.run.retryOfRunId === from.run.runId &&
    to.run.companyId === from.run.companyId &&
    to.run.issueId === from.run.issueId &&
    to.run.sessionId === from.run.sessionId &&
    to.run.executionScopeId === from.run.executionScopeId &&
    to.run.kind === from.run.kind &&
    to.run.ownershipEpoch === from.run.ownershipEpoch &&
    to.run.targetAgentId === from.run.targetAgentId &&
    to.run.adapterConfigRevisionId === from.run.adapterConfigRevisionId &&
    to.run.executionWorkspaceBindingId ===
      from.run.executionWorkspaceBindingId &&
    to.run.executionMode === from.run.executionMode &&
    to.run.issueExecutionAuthorityId === from.run.issueExecutionAuthorityId &&
    to.run.consultExecutionId === from.run.consultExecutionId &&
    to.run.compactionScopeKind === from.run.compactionScopeKind &&
    to.run.parentRunId === from.run.parentRunId &&
    to.run.triggeredByRunId === from.run.triggeredByRunId &&
    to.member.refId === from.member.refId &&
    to.member.admissionOrder === from.member.admissionOrder &&
    to.member.inputId === from.member.inputId &&
    to.member.batchDigest === from.member.batchDigest;
  const releasedBeforeSend =
    from.run.status === "failed" &&
    from.run.terminalClassification === "failed" &&
    from.run.terminalReasonCode === "process_loss_before_prompt" &&
    from.run.terminalFinalizationId !== null &&
    from.member.promptTransmissionPhase === "not_transmitted" &&
    from.member.outcome === "released_unsent" &&
    from.member.protocolSettlementState === "not_sent" &&
    from.member.settlementVersion > 0;
  const successorIsFresh =
    to.run.status === "queued" &&
    to.run.currentAttemptId === null &&
    to.run.currentLeaseId === null &&
    to.run.cancellationIntentId === null &&
    to.run.terminalFinalizationId === null &&
    to.ref.disposition === "active" &&
    to.member.promptTransmissionPhase === "not_transmitted" &&
    to.member.outcome === null &&
    to.member.protocolSettlementState === null &&
    to.member.settlementVersion === 0 &&
    to.member.attemptId === null &&
    to.member.capabilityConnectionId === null &&
    to.member.capabilityGeneration === null;
  if (
    !sameScope ||
    !releasedBeforeSend ||
    (options.freshSuccessor && !successorIsFresh)
  ) {
    reject(
      "Liveness authority can transfer only across its exact pre-send retry link",
    );
  }
}

async function livenessFollowupRunIsRetryAncestor(
  transaction: IssueSessionDbTransaction,
  input: {
    readonly reconciliation: ReconciliationRow;
    readonly ancestorRunId: string;
  },
): Promise<boolean> {
  let current = await lockLivenessFollowupRun(transaction, {
    reconciliation: input.reconciliation,
    runId: input.reconciliation.followupRunId!,
  });
  const visited = new Set<string>();
  while (true) {
    if (current.run.runId === input.ancestorRunId) return true;
    if (visited.has(current.run.runId)) {
      reject("Liveness follow-up retry chain contains a cycle");
    }
    visited.add(current.run.runId);
    if (current.run.retryOfRunId === null) return false;
    const parent = await lockLivenessFollowupRun(transaction, {
      reconciliation: input.reconciliation,
      runId: current.run.retryOfRunId,
    });
    assertPreSendLivenessRetryLink(parent, current, {
      freshSuccessor: false,
    });
    current = parent;
  }
}

/**
 * Transfers P17 ownership when process loss releases its never-transmitted ref
 * into an exact retry-linked run. The reconciliation, not either finalization
 * outbox, owns this CAS; the returned reply id keeps every retry progress
 * comment in the original grouped reply thread.
 */
export async function transferIssueLivenessFollowupRetryRunInTransaction(
  transaction: IssueSessionDbTransaction,
  input: {
    readonly companyId: string;
    readonly issueId: string;
    readonly ownershipEpoch: number;
    readonly refId: string;
    readonly fromRunId: string;
    readonly toRunId: string;
  },
): Promise<{ readonly replyToCommentId: string }> {
  for (const [label, value] of [
    ["liveness company id", input.companyId],
    ["liveness issue id", input.issueId],
    ["liveness ref id", input.refId],
    ["liveness retry-source run id", input.fromRunId],
    ["liveness retry run id", input.toRunId],
  ] as const) {
    exactIdentifier(value, label);
  }
  if (
    !Number.isSafeInteger(input.ownershipEpoch) ||
    input.ownershipEpoch <= 0 ||
    input.fromRunId === input.toRunId
  ) {
    reject("Liveness retry transfer identity is invalid");
  }
  const reconciliation = exactlyOne(
    await transaction
      .select()
      .from(issueLivenessReconciliations)
      .where(
        and(
          eq(issueLivenessReconciliations.companyId, input.companyId),
          eq(issueLivenessReconciliations.issueId, input.issueId),
          eq(
            issueLivenessReconciliations.ownershipEpoch,
            input.ownershipEpoch,
          ),
          eq(issueLivenessReconciliations.followupRefId, input.refId),
        ),
      )
      .limit(2)
      .for("update"),
    "Liveness retry transfer lost its reconciliation",
  );
  if (
    reconciliation.followupSystemReplyCommentId === null ||
    reconciliation.followupRunId !== input.fromRunId ||
    reconciliation.followupFinalizationId !== null ||
    reconciliation.acceptedActionKind !== null ||
    reconciliation.supersededBeforeAttentionAt !== null ||
    reconciliation.boardAttentionEmittedAt !== null
  ) {
    reject("Liveness retry transfer lost its unsettled current run authority");
  }
  const from = await lockLivenessFollowupRun(transaction, {
    reconciliation,
    runId: input.fromRunId,
  });
  const to = await lockLivenessFollowupRun(transaction, {
    reconciliation,
    runId: input.toRunId,
  });
  assertPreSendLivenessRetryLink(from, to, { freshSuccessor: true });
  exactlyOne(
    await transaction
      .update(issueLivenessReconciliations)
      .set({ followupRunId: input.toRunId })
      .where(
        and(
          eq(issueLivenessReconciliations.id, reconciliation.id),
          eq(issueLivenessReconciliations.followupRunId, input.fromRunId),
          isNull(issueLivenessReconciliations.followupFinalizationId),
          isNull(issueLivenessReconciliations.acceptedActionKind),
          isNull(issueLivenessReconciliations.supersededBeforeAttentionAt),
          isNull(issueLivenessReconciliations.boardAttentionEmittedAt),
        ),
      )
      .returning({ id: issueLivenessReconciliations.id }),
    "Liveness retry transfer lost its exact run compare-and-set",
  );
  return { replyToCommentId: reconciliation.followupSystemReplyCommentId };
}

export async function attachIssueLivenessFollowupRunInTransaction(
  transaction: IssueSessionDbTransaction,
  input: {
    readonly companyId: string;
    readonly issueId: string;
    readonly ownershipEpoch: number;
    readonly refId: string;
    readonly runId: string;
  },
): Promise<{ readonly replyToCommentId: string }> {
  const row = exactlyOne(
    await transaction
      .select()
      .from(issueLivenessReconciliations)
      .where(
        and(
          eq(issueLivenessReconciliations.companyId, input.companyId),
          eq(issueLivenessReconciliations.issueId, input.issueId),
          eq(
            issueLivenessReconciliations.ownershipEpoch,
            input.ownershipEpoch,
          ),
          eq(issueLivenessReconciliations.followupRefId, input.refId),
        ),
      )
      .limit(2)
      .for("update"),
    "Liveness follow-up ref lost its reconciliation",
  );
  if (!row.followupSystemReplyCommentId) {
    reject("Liveness follow-up reconciliation lost its system reply");
  }
  if (row.followupRunId !== null && row.followupRunId !== input.runId) {
    reject("Liveness follow-up ref was attached to a different run");
  }
  if (row.followupRunId === null) {
    exactlyOne(
      await transaction
        .update(issueLivenessReconciliations)
        .set({ followupRunId: input.runId })
        .where(
          and(
            eq(issueLivenessReconciliations.id, row.id),
            isNull(issueLivenessReconciliations.followupRunId),
          ),
        )
        .returning({ id: issueLivenessReconciliations.id }),
      "Liveness follow-up run attachment lost its reconciliation",
    );
  }
  return { replyToCommentId: row.followupSystemReplyCommentId };
}

export async function listActiveIssueLivenessAttentionRows(
  database: Db,
  companyId: string,
) {
  return database
    .select({
      issueId: issueLivenessReconciliations.issueId,
      ownershipEpoch: issueLivenessReconciliations.ownershipEpoch,
      frontierFinalizationId:
        issueLivenessReconciliations.frontierFinalizationId,
      boardAttentionEmittedAt:
        issueLivenessReconciliations.boardAttentionEmittedAt,
      boardAttentionReason:
        issueLivenessReconciliations.boardAttentionReason,
      admittedAt: issueLivenessReconciliations.admittedAt,
    })
    .from(issueLivenessReconciliations)
    .where(
      and(
        eq(issueLivenessReconciliations.companyId, companyId),
        isNotNull(issueLivenessReconciliations.boardAttentionEmittedAt),
        isNull(issueLivenessReconciliations.exitActionCommittedAt),
      ),
    )
    .orderBy(
      desc(issueLivenessReconciliations.boardAttentionEmittedAt),
      desc(issueLivenessReconciliations.frontierFinalizationId),
    );
}

export function createIssueLivenessReconciliationService(
  database: Db,
  options: {
    readonly runService: IssueLivenessRunService;
    readonly postCommit: IssueLivenessPostCommitPort;
    readonly now?: () => Date;
    readonly idFactory?: () => string;
  },
) {
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;
  const admission = createIssueSessionAdmissionService(database, {
    clock: now,
  });

  async function loadPendingPostCommitWork(
    transaction: IssueSessionDbTransaction,
    input: IssueLivenessFinalizationIdentity,
  ): Promise<IssueLivenessPostCommitWork> {
    const row = await transaction
      .select()
      .from(issueLivenessReconciliations)
      .where(
        and(
          eq(issueLivenessReconciliations.companyId, input.companyId),
          eq(issueLivenessReconciliations.issueId, input.issueId),
          eq(
            issueLivenessReconciliations.ownershipEpoch,
            input.ownershipEpoch,
          ),
          eq(
            issueLivenessReconciliations.frontierFinalizationId,
            input.finalizationId,
          ),
        ),
      )
      .limit(2)
      .then((rows) => rows[0] ?? null);
    if (!row) return { kind: "none" };
    if (
      row.boardAttentionEmittedAt !== null &&
      row.boardAttentionReason !== null &&
      row.exitActionCommittedAt === null
    ) {
      return attentionWork(row, row.boardAttentionReason);
    }
    if (
      row.followupRefId === null ||
      row.followupFinalizationId !== null ||
      row.acceptedActionKind !== null ||
      row.supersededBeforeAttentionAt !== null
    ) {
      return { kind: "none" };
    }
    const ref = exactlyOne(
      await transaction
        .select()
        .from(issueExecutionRefs)
        .where(eq(issueExecutionRefs.id, row.followupRefId))
        .limit(2),
      "Liveness reconciliation lost its follow-up ref",
    );
    if (ref.mode === "owner") {
      return {
        kind: "owner_followup",
        reconciliationId: row.id,
        refId: ref.id,
      };
    }
    const consult = exactlyOne(
      await transaction
        .select()
        .from(issueConsultExecutions)
        .where(eq(issueConsultExecutions.id, ref.consultExecutionId!))
        .limit(2),
      "Liveness reconciliation lost its consult execution",
    );
    return {
      kind: "consult_followup",
      reconciliationId: row.id,
      ref,
      consult,
    };
  }

  async function settleFollowupFinalization(
    transaction: IssueSessionDbTransaction,
    input: IssueLivenessFinalizationIdentity,
    run: IssueExecutionRunEnvelope,
    finalization: typeof issueExecutionFinalizations.$inferSelect,
    followupRef: RefRow,
    processedAt: Date,
  ): Promise<IssueLivenessPostCommitWork> {
    const row = exactlyOne(
      await transaction
        .select()
        .from(issueLivenessReconciliations)
        .where(eq(issueLivenessReconciliations.id, followupRef.sourceRecordId))
        .limit(2)
        .for("update"),
      "Tagged liveness follow-up lost its originating reconciliation",
    );
    if (
      row.companyId !== input.companyId ||
      row.issueId !== input.issueId ||
      row.ownershipEpoch !== input.ownershipEpoch ||
      row.staleTargetAgentId !== run.targetAgentId ||
      row.sourceMode !== run.executionMode ||
      row.followupRefId !== followupRef.id ||
      row.followupRunId === null
    ) {
      reject("Tagged liveness follow-up crossed its immutable chain");
    }
    if (row.followupRunId !== run.runId) {
      const authorityTransferred = await livenessFollowupRunIsRetryAncestor(
        transaction,
        {
          reconciliation: row,
          ancestorRunId: run.runId,
        },
      );
      decideIssueLivenessFollowupFinalizationAuthority({
        authoritativeRunId: row.followupRunId,
        finalizedRunId: run.runId,
        finalizedRunIsRetryAncestor: authorityTransferred,
        directRetrySuccessorCount: 0,
      });
      await markOutboxProcessed(transaction, input.finalizationId, processedAt);
      return { kind: "none" };
    }
    if (
      row.followupFinalizationId !== null &&
      row.followupFinalizationId !== finalization.id
    ) {
      reject("Tagged liveness follow-up crossed its terminal chain owner");
    }
    const retrySuccessor =
      await lockIssueExecutionRetrySuccessorInTransaction(transaction, {
        companyId: row.companyId,
        issueId: row.issueId,
        runId: run.runId,
      });
    decideIssueLivenessFollowupFinalizationAuthority({
      authoritativeRunId: row.followupRunId,
      finalizedRunId: run.runId,
      finalizedRunIsRetryAncestor: false,
      directRetrySuccessorCount: retrySuccessor ? 1 : 0,
    });
    const explicitAction = await findAcceptedActionForFollowupFinalization(
      transaction,
      row,
      options.runService,
    );
    const reason = classifyIssueLivenessFollowupWithoutAction({
      terminalClassification: run.terminalClassification!,
      finalizationAction: finalization.action,
    });
    if (
      explicitAction &&
      explicitAction.committedAt <= row.admittedAt
    ) {
      reject("Liveness follow-up action predates reconciliation admission");
    }

    let work: IssueLivenessPostCommitWork = { kind: "none" };
    if (row.followupFinalizationId === null) {
      if (explicitAction) {
        exactlyOne(
          await transaction
            .update(issueLivenessReconciliations)
            .set({
              followupRunId: run.runId,
              followupFinalizationId: finalization.id,
              acceptedActionKind: explicitAction.kind,
              acceptedActionSourceId: explicitAction.referenceId,
              acceptedActionCommittedAt: explicitAction.committedAt,
            })
            .where(
              and(
                eq(issueLivenessReconciliations.id, row.id),
                isNull(issueLivenessReconciliations.followupFinalizationId),
                isNull(issueLivenessReconciliations.acceptedActionKind),
                isNull(
                  issueLivenessReconciliations.supersededBeforeAttentionAt,
                ),
                isNull(issueLivenessReconciliations.boardAttentionEmittedAt),
              ),
            )
            .returning({ id: issueLivenessReconciliations.id }),
          "Liveness follow-up could not atomically settle its accepted action",
        );
      } else {
        const edge = await transaction
          .select()
          .from(issueCreatorEdgeReceivability)
          .where(
            and(
              eq(issueCreatorEdgeReceivability.companyId, row.companyId),
              eq(issueCreatorEdgeReceivability.issueId, row.issueId),
              eq(
                issueCreatorEdgeReceivability.ownershipEpoch,
                row.ownershipEpoch,
              ),
              eq(issueCreatorEdgeReceivability.id, row.creatorEdgeId),
              eq(
                issueCreatorEdgeReceivability.admissionVersion,
                row.creatorEdgeAdmissionVersion,
              ),
            ),
          )
          .limit(2)
          .for("update")
          .then((rows) => rows[0] ?? null);
        const superseded = !edge || edge.state !== "receivable";
        exactlyOne(
          await transaction
            .update(issueLivenessReconciliations)
            .set({
              followupRunId: run.runId,
              followupFinalizationId: finalization.id,
              ...(superseded
                ? { supersededBeforeAttentionAt: processedAt }
                : {
                    boardAttentionEmittedAt: processedAt,
                    boardAttentionReason: reason,
                  }),
            })
            .where(
              and(
                eq(issueLivenessReconciliations.id, row.id),
                isNull(issueLivenessReconciliations.followupFinalizationId),
                isNull(issueLivenessReconciliations.acceptedActionKind),
                isNull(
                  issueLivenessReconciliations.supersededBeforeAttentionAt,
                ),
                isNull(issueLivenessReconciliations.boardAttentionEmittedAt),
              ),
            )
            .returning({ id: issueLivenessReconciliations.id }),
          "Liveness follow-up could not atomically settle its Attention branch",
        );
        if (!superseded) work = attentionWork(row, reason);
      }
    }

    if (run.executionMode === "consult" && run.consultExecutionId !== null) {
      await transaction
        .update(issueConsultExecutions)
        .set({
          state:
            run.terminalClassification === "succeeded"
              ? "completed"
              : "cancelled",
          closeReason: "agent_liveness_followup_finalized",
          closedAt: processedAt,
        })
        .where(
          and(
            eq(issueConsultExecutions.id, run.consultExecutionId),
            eq(issueConsultExecutions.state, "active"),
          ),
        );
    }
    await markOutboxProcessed(transaction, input.finalizationId, processedAt);
    return work;
  }

  async function processFinalizationInTransaction(
    transaction: IssueSessionDbTransaction,
    input: IssueLivenessFinalizationIdentity,
  ): Promise<IssueLivenessPostCommitWork> {
    const processedAt = exactDate(now(), "liveness processing time");
    exactIdentifier(input.companyId, "liveness company id");
    exactIdentifier(input.issueId, "liveness issue id");
    exactIdentifier(input.runId, "liveness run id");
    exactIdentifier(input.finalizationId, "liveness finalization id");
    if (!Number.isSafeInteger(input.ownershipEpoch) || input.ownershipEpoch <= 0) {
      reject("Liveness ownership epoch is invalid");
    }
    exactlyOne(
      await transaction
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, input.companyId))
        .limit(2)
        .for("update"),
      "Liveness outbox lost its company",
    );
    const issue = exactlyOne(
      await transaction
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.companyId, input.companyId),
            eq(issues.id, input.issueId),
          ),
        )
        .limit(2)
        .for("update"),
      "Liveness outbox lost its issue",
    );
    const outbox = exactlyOne(
      await transaction
        .select()
        .from(issueExecutionFinalizationStaleCheckOutbox)
        .where(
          and(
            eq(
              issueExecutionFinalizationStaleCheckOutbox.companyId,
              input.companyId,
            ),
            eq(
              issueExecutionFinalizationStaleCheckOutbox.issueId,
              input.issueId,
            ),
            eq(
              issueExecutionFinalizationStaleCheckOutbox.ownershipEpoch,
              input.ownershipEpoch,
            ),
            eq(
              issueExecutionFinalizationStaleCheckOutbox.runId,
              input.runId,
            ),
            eq(
              issueExecutionFinalizationStaleCheckOutbox.finalizationId,
              input.finalizationId,
            ),
          ),
        )
        .limit(2)
        .for("update"),
      "Finalization-specific liveness outbox item is missing",
    );
    if (outbox.processedAt !== null) {
      return loadPendingPostCommitWork(transaction, input);
    }
    const run = await options.runService.lockRun(transaction, {
      companyId: input.companyId,
      issueId: input.issueId,
      runId: input.runId,
    });
    const finalization = exactlyOne(
      await transaction
        .select()
        .from(issueExecutionFinalizations)
        .where(
          and(
            eq(issueExecutionFinalizations.companyId, input.companyId),
            eq(issueExecutionFinalizations.runId, input.runId),
            eq(issueExecutionFinalizations.id, input.finalizationId),
          ),
        )
        .limit(2)
        .for("update"),
      "Liveness outbox lost its finalization",
    );
    if (
      !["productive", "consult"].includes(run.kind) ||
      run.ownershipEpoch !== input.ownershipEpoch ||
      run.terminalFinalizationId !== finalization.id ||
      run.targetAgentId === null ||
      run.executionMode === null ||
      finalization.progressCommentId === null
    ) {
      reject("Liveness outbox references a non-agent or incomplete finalization");
    }

    const runRefs = await transaction
      .select({
        ref: issueExecutionRefs,
        ordinal: issueExecutionRunRefs.refOrdinal,
      })
      .from(issueExecutionRunRefs)
      .innerJoin(
        issueExecutionRefs,
        eq(issueExecutionRefs.id, issueExecutionRunRefs.refId),
      )
      .where(eq(issueExecutionRunRefs.runId, run.runId))
      .orderBy(asc(issueExecutionRunRefs.refOrdinal))
      .for("update");
    const followupRefs = runRefs.filter(
      ({ ref }) => ref.sourceKind === "agent_liveness_followup",
    );
    if (followupRefs.length > 0) {
      if (followupRefs.length !== 1 || runRefs.length !== 1) {
        reject("A liveness follow-up run must contain its one tagged ref only");
      }
      return settleFollowupFinalization(
        transaction,
        input,
        run,
        finalization,
        followupRefs[0]!.ref,
        processedAt,
      );
    }

    const edge = await transaction
      .select()
      .from(issueCreatorEdgeReceivability)
      .where(
        and(
          eq(issueCreatorEdgeReceivability.companyId, input.companyId),
          eq(issueCreatorEdgeReceivability.issueId, input.issueId),
          eq(
            issueCreatorEdgeReceivability.ownershipEpoch,
            input.ownershipEpoch,
          ),
        ),
      )
      .limit(2)
      .for("update")
      .then((rows) => rows[0] ?? null);
    const explicitAction = await findExplicitAction(transaction, {
      kind: "run",
      companyId: input.companyId,
      issueId: input.issueId,
      ownershipEpoch: input.ownershipEpoch,
      runId: input.runId,
    }, options.runService);
    const existing = await transaction
      .select({ id: issueLivenessReconciliations.id })
      .from(issueLivenessReconciliations)
      .where(
        and(
          eq(issueLivenessReconciliations.companyId, input.companyId),
          eq(issueLivenessReconciliations.issueId, input.issueId),
          eq(
            issueLivenessReconciliations.ownershipEpoch,
            input.ownershipEpoch,
          ),
          eq(
            issueLivenessReconciliations.frontierFinalizationId,
            input.finalizationId,
          ),
        ),
      )
      .limit(2)
      .for("update");
    const issueCurrentAndNonterminal =
      issue.ownershipEpoch === input.ownershipEpoch &&
      ["open", "blocked"].includes(issue.lifecycleStatus);
    if (
      !shouldClaimIssueLivenessFrontier({
        issueCurrentAndNonterminal,
        creatorEdgeReceivable: edge?.state === "receivable",
        queuedRefExists: false,
        activeAgentRunExists: false,
        explicitSourceActionExists: explicitAction !== null,
        reconciliationExists: existing.length > 0,
      })
    ) {
      await markOutboxProcessed(transaction, input.finalizationId, processedAt);
      return { kind: "none" };
    }

    await transaction
      .select()
      .from(issueExecutionLanes)
      .where(
        and(
          eq(issueExecutionLanes.companyId, input.companyId),
          eq(issueExecutionLanes.issueId, input.issueId),
          eq(issueExecutionLanes.ownershipEpoch, input.ownershipEpoch),
        ),
      )
      .orderBy(asc(issueExecutionLanes.targetAgentId))
      .for("update");
    const queuedRefs = await transaction
      .select({ id: issueExecutionRefs.id })
      .from(issueExecutionRefs)
      .where(
        and(
          eq(issueExecutionRefs.companyId, input.companyId),
          eq(issueExecutionRefs.issueId, input.issueId),
          eq(issueExecutionRefs.ownershipEpoch, input.ownershipEpoch),
          eq(issueExecutionRefs.disposition, "active"),
        ),
      )
      .for("update");
    const activeRuns =
      await options.runService.lockActiveAgentRunsForIssueEpochInTransaction(
        transaction,
        {
          companyId: input.companyId,
          issueId: input.issueId,
          ownershipEpoch: input.ownershipEpoch,
        },
      );
    if (
      !shouldClaimIssueLivenessFrontier({
        issueCurrentAndNonterminal,
        creatorEdgeReceivable: edge.state === "receivable",
        queuedRefExists: queuedRefs.length > 0,
        activeAgentRunExists: activeRuns.length > 0,
        explicitSourceActionExists: false,
        reconciliationExists: false,
      })
    ) {
      await markOutboxProcessed(transaction, input.finalizationId, processedAt);
      return { kind: "none" };
    }

    const reconciliationId = idFactory();
    const reconciliation = exactlyOne(
      await transaction
        .insert(issueLivenessReconciliations)
        .values({
          id: reconciliationId,
          companyId: input.companyId,
          issueId: input.issueId,
          ownershipEpoch: input.ownershipEpoch,
          frontierFinalizationId: input.finalizationId,
          creatorEdgeId: edge.id,
          creatorEdgeAdmissionVersion: edge.admissionVersion,
          staleTargetAgentId: run.targetAgentId,
          sourceRunId: run.runId,
          sourceMode: run.executionMode,
          sourceCommentId: finalization.progressCommentId,
          admittedAt: processedAt,
        })
        .returning(),
      "Liveness frontier could not claim its reconciliation",
    );

    const companyAgents = await transaction
      .select()
      .from(agents)
      .where(eq(agents.companyId, input.companyId));
    const target = companyAgents.find((agent) => agent.id === run.targetAgentId);
    const invokability = evaluateAgentInvokability(target, companyAgents);
    const revision = target?.currentAdapterConfigRevisionId
      ? await transaction
          .select()
          .from(agentAdapterConfigRevisions)
          .where(
            and(
              eq(agentAdapterConfigRevisions.companyId, input.companyId),
              eq(agentAdapterConfigRevisions.agentId, run.targetAgentId),
              eq(
                agentAdapterConfigRevisions.id,
                target.currentAdapterConfigRevisionId,
              ),
            ),
          )
          .limit(2)
          .then((rows) => rows[0] ?? null)
      : null;
    const context = await transaction
      .select({ generation: issueSessionContextEpochs.generation })
      .from(issueSessionContextEpochs)
      .where(
        and(
          eq(issueSessionContextEpochs.companyId, input.companyId),
          eq(issueSessionContextEpochs.issueId, input.issueId),
          eq(issueSessionContextEpochs.sessionId, run.sessionId),
        ),
      )
      .limit(2)
      .then((rows) => rows[0] ?? null);
    const implementationAvailable = Boolean(
      revision &&
        isServerAdapterImplementationAvailable(
          revision.adapterType,
          revision.implementationIdentity,
        ),
    );

    let authorityId: string | null = null;
    let consult: ConsultRow | null = null;
    let sourceRef: RefRow | null = null;
    if (run.executionMode === "owner") {
      const authority = await transaction
        .select()
        .from(issueExecutionAuthorities)
        .where(
          and(
            eq(issueExecutionAuthorities.companyId, input.companyId),
            eq(issueExecutionAuthorities.issueId, input.issueId),
            eq(
              issueExecutionAuthorities.ownershipEpoch,
              input.ownershipEpoch,
            ),
            eq(issueExecutionAuthorities.agentId, run.targetAgentId),
            eq(issueExecutionAuthorities.state, "current"),
          ),
        )
        .limit(2)
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (
        issue.ownerKind === "agent" &&
        issue.ownerAgentId === run.targetAgentId
      ) {
        authorityId = authority?.id ?? null;
      }
    } else {
      sourceRef = runRefs[0]?.ref ?? null;
    }

    const baseUnavailable =
      !invokability.invokable ||
      !revision ||
      !implementationAvailable ||
      (run.executionMode === "owner" && authorityId === null) ||
      (run.executionMode === "consult" && !sourceRef);
    if (!context) {
      reject("Liveness follow-up lost the current issue Session context epoch");
    }
    if (
      run.executionMode === "consult" &&
      sourceRef &&
      sourceRef.consultChainToken === null
    ) {
      reject("Liveness consult follow-up lost its persisted consult chain token");
    }
    if (
      !baseUnavailable &&
      run.executionMode === "consult" &&
      sourceRef &&
      revision
    ) {
      consult = exactlyOne(
        await transaction
          .insert(issueConsultExecutions)
          .values({
            id: idFactory(),
            companyId: input.companyId,
            issueId: input.issueId,
            sessionId: run.sessionId,
            ownershipEpoch: input.ownershipEpoch,
            sourceRunId: run.runId,
            sourceRefId: sourceRef.id,
            callerExecutionScopeId: run.executionScopeId,
            targetAgentId: run.targetAgentId,
            adapterConfigRevisionId: revision.id,
            chainToken: sourceRef.consultChainToken!,
            state: "active",
            createdAt: processedAt,
          })
          .returning(),
        "Liveness consult follow-up could not reserve its execution",
      );
    }

    const unavailable =
      baseUnavailable ||
      (run.executionMode === "consult" && !consult);
    if (unavailable) {
      await markOutboxProcessed(transaction, input.finalizationId, processedAt);
      return settleWithoutAction(
        transaction,
        reconciliation,
        "agent_unavailable",
        processedAt,
      );
    }

    const admitted = await admission.admitExecutionSource(
      {
        companyId: input.companyId,
        issueId: input.issueId,
        sessionId: run.sessionId,
        ownershipEpoch: input.ownershipEpoch,
        targetAgentId: run.targetAgentId,
        issueExecutionAuthorityId:
          run.executionMode === "owner" ? authorityId! : null,
        consultExecutionId:
          run.executionMode === "consult" ? consult!.id : null,
        adapterConfigRevisionId: revision!.id,
        contextEpoch: context!.generation,
        mode: run.executionMode,
        ...(run.executionMode === "consult"
          ? {
              executionLineageId: sourceRef!.executionLineageId,
              consultCallerRefId: sourceRef!.id,
              consultChainToken: consult!.chainToken,
            }
          : {}),
        sourceKind: "agent_liveness_followup",
        actor: {
          kind: "system",
          sourceKind: "agent_liveness_followup",
          sourceId: reconciliation.id,
        },
        immutableSourceKey:
          `agent-liveness:${input.issueId}:${input.ownershipEpoch}:${input.finalizationId}`,
        sourceRecordId: reconciliation.id,
        exactText: ISSUE_LIVENESS_FOLLOWUP_TEXT,
        comment: {
          author: { kind: "system", source: "control" },
          producingRun: null,
          replyToCommentId: finalization.progressCommentId,
        },
        idempotencyKey:
          `agent-liveness:${input.issueId}:${input.ownershipEpoch}:${input.finalizationId}`,
      },
      transaction,
    );
    if (!admitted.ref || !admitted.comment) {
      reject("Liveness follow-up did not atomically create its reply and ref");
    }
    exactlyOne(
      await transaction
        .update(issueLivenessReconciliations)
        .set({
          followupSystemReplyCommentId: admitted.comment.id,
          followupRefId: admitted.ref.id,
        })
        .where(
          and(
            eq(issueLivenessReconciliations.id, reconciliation.id),
            isNull(
              issueLivenessReconciliations.followupSystemReplyCommentId,
            ),
            isNull(issueLivenessReconciliations.followupRefId),
          ),
        )
        .returning({ id: issueLivenessReconciliations.id }),
      "Liveness reconciliation could not attach its one reply/ref chain",
    );
    await markOutboxProcessed(transaction, input.finalizationId, processedAt);
    return run.executionMode === "owner"
      ? {
          kind: "owner_followup",
          reconciliationId: reconciliation.id,
          refId: admitted.ref.id,
        }
      : {
          kind: "consult_followup",
          reconciliationId: reconciliation.id,
          ref: admitted.ref,
          consult: consult!,
        };
  }

  async function consumeFinalizationOutbox(
    input: IssueLivenessFinalizationIdentity,
  ): Promise<IssueLivenessPostCommitWork> {
    const work = await database.transaction((transaction) =>
      processFinalizationInTransaction(transaction, input),
    );
    if (work.kind === "owner_followup" || work.kind === "consult_followup") {
      await options.postCommit.dispatchFollowup(work);
    } else if (work.kind === "attention") {
      await options.postCommit.notifyAttention(work);
    }
    return work;
  }

  return Object.freeze({
    consumeFinalizationOutbox,
    processFinalizationInTransaction,
  });
}

export type IssueLivenessReconciliationService = ReturnType<
  typeof createIssueLivenessReconciliationService
>;
