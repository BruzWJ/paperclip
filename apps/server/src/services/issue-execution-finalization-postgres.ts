import { randomUUID } from "node:crypto";
import {
  activityLog,
  documentRevisions,
  issueCommentProjectionSources,
  issueComments,
  issueDocuments,
  issueExecutionFinalizationPromptDependencies,
  issueExecutionFinalizations,
  issueExecutionFinalizationUpdateDependencies,
  issueExecutionRefs,
  issueConsultExecutions,
  issueExecutionPromptCapabilities,
  issueExecutionPromptSegments,
  issueExecutionRunControls,
  issueExecutionRunLivenessFacts,
  issueExecutionRunRefs,
  issueSessionEvents,
  issueSessionMessages,
  issueUpdates,
  issueWorkProducts,
  issues,
  toolCallEvents,
  workspaceOperations,
  type Db,
} from "@paperclipai/db";
import type {
  IssueExecutionRunTerminalClassification,
} from "@paperclipai/shared";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  buildIssueExecutionFinalizationPlan,
  type IssueExecutionFinalizationPromptDependency,
  type IssueExecutionFinalizationPromptIdentity,
} from "./issue-execution-finalization.js";
import type { IssueExecutionRunService } from "./issue-execution-run-service.js";
import {
  issueSessionMessageFromRow,
} from "./issue-session/projector.js";
import { publishIssueSessionFinalCommentInTx } from "./issue-session/publication.js";
import { classifyRunLiveness } from "./run-liveness.js";

type IssueExecutionDbTransaction =
  Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface FinalizePostgresIssueExecutionRunInput {
  readonly companyId: string;
  readonly issueId: string;
  readonly runId: string;
  readonly status: IssueExecutionRunTerminalClassification;
  readonly terminalReasonCode: string;
  readonly finishedAt: Date;
}

export interface FinalizedPostgresIssueExecutionRun {
  readonly finalizationId: string;
  readonly status: IssueExecutionRunTerminalClassification;
  readonly retried: boolean;
}

export class PostgresIssueExecutionFinalizationRejected extends Error {
  readonly code = "postgres_issue_execution_finalization_rejected";

  constructor(message: string) {
    super(message);
    this.name = "PostgresIssueExecutionFinalizationRejected";
  }
}

function exactlyOne<T>(rows: readonly T[], message: string): T {
  if (rows.length !== 1) {
    throw new PostgresIssueExecutionFinalizationRejected(message);
  }
  return rows[0]!;
}

function countValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function dateValue(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function latestDate(...values: unknown[]): Date | null {
  let latest: Date | null = null;
  for (const value of values) {
    const parsed = dateValue(value);
    if (parsed && (!latest || parsed > latest)) latest = parsed;
  }
  return latest;
}

function terminalAssistantText(
  row: typeof issueSessionMessages.$inferSelect | null,
): string {
  if (!row) return "";
  const message = issueSessionMessageFromRow(row);
  if (message.type !== "assistant" || !message.time.completed) return "";
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
}

function activeRunStatus(
  value: string,
): value is "queued" | "scheduled_retry" | "running" {
  return (
    value === "queued" ||
    value === "scheduled_retry" ||
    value === "running"
  );
}

async function lockPromptFrontier(
  transaction: IssueExecutionDbTransaction,
  input: { companyId: string; issueId: string; runId: string },
): Promise<{
  expected: IssueExecutionFinalizationPromptIdentity[];
  dependencies: IssueExecutionFinalizationPromptDependency[];
}> {
  const refs = await transaction
    .select()
    .from(issueExecutionRunRefs)
    .where(
      and(
        eq(issueExecutionRunRefs.companyId, input.companyId),
        eq(issueExecutionRunRefs.issueId, input.issueId),
        eq(issueExecutionRunRefs.runId, input.runId),
      ),
    )
    .orderBy(asc(issueExecutionRunRefs.refOrdinal))
    .for("update");
  if (refs.length === 0) {
    throw new PostgresIssueExecutionFinalizationRejected(
      "Productive and consult finalization requires a nonempty run-ref frontier",
    );
  }
  if (refs.some((ref, ordinal) => ref.refOrdinal !== ordinal)) {
    throw new PostgresIssueExecutionFinalizationRejected(
      "Run-ref finalization frontier is not contiguous",
    );
  }
  const segments = await transaction
    .select()
    .from(issueExecutionPromptSegments)
    .where(
      and(
        eq(issueExecutionPromptSegments.companyId, input.companyId),
        eq(issueExecutionPromptSegments.issueId, input.issueId),
        eq(issueExecutionPromptSegments.runId, input.runId),
      ),
    )
    .orderBy(
      asc(issueExecutionPromptSegments.refOrdinal),
      asc(issueExecutionPromptSegments.segmentOrdinal),
    )
    .for("update");
  const segmentsByRef = new Map<string, typeof segments>();
  for (const segment of segments) {
    const current = segmentsByRef.get(segment.refId) ?? [];
    current.push(segment);
    segmentsByRef.set(segment.refId, current);
  }
  const expected: IssueExecutionFinalizationPromptIdentity[] = [];
  const dependencies: IssueExecutionFinalizationPromptDependency[] = [];
  for (const ref of refs) {
    if (
      ref.protocolSettlementState === null ||
      ref.settlementVersion < 1
    ) {
      throw new PostgresIssueExecutionFinalizationRejected(
        "Run finalization encountered an unsettled base prompt",
      );
    }
    const base = {
      kind: "base" as const,
      refId: ref.refId,
      refOrdinal: ref.refOrdinal,
      segmentOrdinal: 0 as const,
    };
    expected.push(base);
    dependencies.push({
      ...base,
      protocolSettlementState: ref.protocolSettlementState,
      settlementVersion: ref.settlementVersion,
      accountingId: ref.accountingId,
      costEventId: ref.costEventId,
    });
    const refSegments = segmentsByRef.get(ref.refId) ?? [];
    for (const [index, segment] of refSegments.entries()) {
      if (
        segment.refOrdinal !== ref.refOrdinal ||
        segment.segmentOrdinal !== index + 1 ||
        segment.protocolSettlementState === null ||
        segment.settlementVersion < 1
      ) {
        throw new PostgresIssueExecutionFinalizationRejected(
          "Run finalization encountered a noncontiguous or unsettled steering segment",
        );
      }
      const steering = {
        kind: "steering" as const,
        refId: segment.refId,
        refOrdinal: segment.refOrdinal,
        segmentOrdinal: segment.segmentOrdinal,
      };
      expected.push(steering);
      dependencies.push({
        ...steering,
        protocolSettlementState: segment.protocolSettlementState,
        settlementVersion: segment.settlementVersion,
        accountingId: segment.accountingId,
        costEventId: segment.costEventId,
      });
    }
    segmentsByRef.delete(ref.refId);
  }
  if (segmentsByRef.size !== 0) {
    throw new PostgresIssueExecutionFinalizationRejected(
      "Steering finalization frontier contains a segment outside its run refs",
    );
  }
  return { expected, dependencies };
}

async function lockRunUpdates(
  transaction: IssueExecutionDbTransaction,
  input: { companyId: string; runId: string },
): Promise<Array<{ issueUpdateId: string }>> {
  // Creator-form updates are persisted under the child issue even though the
  // producing run belongs to its parent. Run identity is therefore the only
  // canonical dedupe scope for suppressing a second final-output comment.
  const updates = await transaction
    .select()
    .from(issueUpdates)
    .where(
      and(
        eq(issueUpdates.companyId, input.companyId),
        eq(issueUpdates.runId, input.runId),
      ),
    )
    .orderBy(asc(issueUpdates.runSequence))
    .for("update");
  return updates.map((update) => ({ issueUpdateId: update.id }));
}

async function insertProductiveLivenessFact(
  transaction: IssueExecutionDbTransaction,
  input: FinalizePostgresIssueExecutionRunInput,
): Promise<string> {
  const [issueLifecycle, assistantRows, documentStats, workProductStats, workspaceStats, activityStats, toolStats] =
    await Promise.all([
      transaction
        .select({
          issueLifecycleStatus: issues.lifecycleStatus,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, input.companyId),
            eq(issues.id, input.issueId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
      transaction
        .select()
        .from(issueSessionMessages)
        .where(
          and(
            eq(issueSessionMessages.companyId, input.companyId),
            eq(issueSessionMessages.issueId, input.issueId),
            eq(issueSessionMessages.runId, input.runId),
            eq(issueSessionMessages.type, "assistant"),
          ),
        )
        .orderBy(asc(issueSessionMessages.seq), asc(issueSessionMessages.id))
        .limit(501),
      transaction
        .select({
          count: sql<number>`count(*)::int`,
          planCount: sql<number>`count(*) filter (where ${issueDocuments.key} = 'plan')::int`,
          latestAt: sql<Date | null>`max(${documentRevisions.createdAt})`,
        })
        .from(documentRevisions)
        .innerJoin(
          issueDocuments,
          eq(documentRevisions.documentId, issueDocuments.documentId),
        )
        .where(
          and(
            eq(documentRevisions.companyId, input.companyId),
            eq(documentRevisions.createdByRunId, input.runId),
            eq(issueDocuments.companyId, input.companyId),
            eq(issueDocuments.issueId, input.issueId),
          ),
        )
        .then((rows) => rows[0]),
      transaction
        .select({
          count: sql<number>`count(*)::int`,
          latestAt: sql<Date | null>`max(${issueWorkProducts.createdAt})`,
        })
        .from(issueWorkProducts)
        .where(
          and(
            eq(issueWorkProducts.companyId, input.companyId),
            eq(issueWorkProducts.issueId, input.issueId),
            eq(issueWorkProducts.createdByRunId, input.runId),
          ),
        )
        .then((rows) => rows[0]),
      transaction
        .select({
          count: sql<number>`count(*)::int`,
          latestAt: sql<Date | null>`max(${workspaceOperations.startedAt})`,
        })
        .from(workspaceOperations)
        .where(
          and(
            eq(workspaceOperations.companyId, input.companyId),
            eq(workspaceOperations.runId, input.runId),
          ),
        )
        .then((rows) => rows[0]),
      transaction
        .select({
          count: sql<number>`count(*)::int`,
          latestAt: sql<Date | null>`max(${activityLog.createdAt})`,
        })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, input.companyId),
            eq(activityLog.runId, input.runId),
          ),
        )
        .then((rows) => rows[0]),
      transaction
        .select({
          count: sql<number>`count(*)::int`,
          latestAt: sql<Date | null>`max(${toolCallEvents.createdAt})`,
        })
        .from(toolCallEvents)
        .where(
          and(
            eq(toolCallEvents.companyId, input.companyId),
            eq(toolCallEvents.runId, input.runId),
          ),
        )
        .then((rows) => rows[0]),
    ]);
  if (!issueLifecycle) {
    throw new PostgresIssueExecutionFinalizationRejected(
      "Productive finalization lost its canonical issue",
    );
  }
  if (assistantRows.length > 500) {
    throw new PostgresIssueExecutionFinalizationRejected(
      "Productive liveness exceeded its bounded canonical Session assistant view",
    );
  }
  const assistants = assistantRows.map((row) => {
    const message = issueSessionMessageFromRow(row);
    if (message.type !== "assistant") {
      throw new PostgresIssueExecutionFinalizationRejected(
        "Productive liveness selected a non-assistant Session row",
      );
    }
    return message;
  });
  const completedAssistants = assistants.filter(
    (assistant) => assistant.time.completed !== undefined,
  );
  const assistantTextParts = completedAssistants.flatMap((assistant) =>
    assistant.content.flatMap((part) =>
      part.type === "text" ? [part.text] : []
    )
  );
  const assistantErrors = completedAssistants.flatMap((assistant) =>
    assistant.error
      ? [{ type: assistant.error.type }]
      : []
  );
  const classification = classifyRunLiveness({
    runStatus: input.status,
    issueLifecycleStatus: issueLifecycle.issueLifecycleStatus,
    assistantTextParts,
    failureFacts: {
      terminalReasonCode: input.terminalReasonCode,
      assistantErrors,
    },
    continuationAttempt: 0,
    evidence: {
      documentRevisionsCreated: countValue(documentStats?.count),
      planDocumentRevisionsCreated: countValue(documentStats?.planCount),
      workProductsCreated: countValue(workProductStats?.count),
      workspaceOperationsCreated: countValue(workspaceStats?.count),
      activityEventsCreated: countValue(activityStats?.count),
      toolOrActionEventsCreated: countValue(toolStats?.count),
      latestEvidenceAt: latestDate(
        documentStats?.latestAt,
        workProductStats?.latestAt,
        workspaceStats?.latestAt,
        activityStats?.latestAt,
        toolStats?.latestAt,
      ),
    },
  });
  const id = randomUUID();
  await transaction.insert(issueExecutionRunLivenessFacts).values({
    id,
    companyId: input.companyId,
    runId: input.runId,
    livenessState: classification.livenessState,
    livenessReason: classification.livenessReason,
    continuationAttempt: classification.continuationAttempt,
    lastUsefulActionAt: classification.lastUsefulActionAt,
    nextAction: classification.nextAction,
  });
  return id;
}

/**
 * Sole productive/consult finalization transaction owner. It derives every
 * dependency from locked canonical rows; callers provide only the run's
 * terminal classification and bounded reason, never output bytes or a
 * caller-assembled prompt frontier.
 */
export function createPostgresIssueExecutionFinalizationWriter(options: {
  readonly database: Db;
  readonly runService: Pick<IssueExecutionRunService, "lockRun" | "attachFinalization">;
}) {
  async function closeMentionExecutionInTransaction(
    transaction: IssueExecutionDbTransaction,
    input: {
      companyId: string;
      issueId: string;
      runId: string;
      targetAgentId: string;
      consultExecutionId: string;
      status: IssueExecutionRunTerminalClassification;
      at: Date;
    },
  ): Promise<void> {
    const incomingRows = await transaction
      .select({ ref: issueExecutionRefs })
      .from(issueExecutionRunRefs)
      .innerJoin(
        issueExecutionRefs,
        eq(issueExecutionRefs.id, issueExecutionRunRefs.refId),
      )
      .where(
        and(
          eq(issueExecutionRunRefs.companyId, input.companyId),
          eq(issueExecutionRunRefs.issueId, input.issueId),
          eq(issueExecutionRunRefs.runId, input.runId),
          eq(
            issueExecutionRefs.consultExecutionId,
            input.consultExecutionId,
          ),
        ),
      )
      .limit(2)
      .for("update");
    if (incomingRows.length !== 1) {
      throw new PostgresIssueExecutionFinalizationRejected(
        "Mention run lost its exact incoming ref",
      );
    }
    const incomingRef = incomingRows[0]!.ref;
    if (
      incomingRef.mode !== "consult" ||
      incomingRef.sourceKind !== "consult_mention" ||
      incomingRef.targetAgentId !== input.targetAgentId ||
      incomingRef.consultChainToken === null
    ) {
      return;
    }

    const closed = await transaction
      .update(issueConsultExecutions)
      .set({
        state: input.status === "succeeded" ? "completed" : "cancelled",
        closeReason:
          input.status === "succeeded"
            ? "mention_completed"
            : `mention_${input.status}`,
        closedAt: input.at,
      })
      .where(
        and(
          eq(issueConsultExecutions.id, input.consultExecutionId),
          eq(issueConsultExecutions.state, "active"),
        ),
      )
      .returning({ id: issueConsultExecutions.id });
    if (closed.length !== 1) {
      throw new PostgresIssueExecutionFinalizationRejected(
        "Mention run could not close its consult authority",
      );
    }
  }

  async function finalizeInTransaction(
    transaction: IssueExecutionDbTransaction,
    input: FinalizePostgresIssueExecutionRunInput,
  ): Promise<FinalizedPostgresIssueExecutionRun> {
      if (
        input.terminalReasonCode.length === 0 ||
        input.terminalReasonCode !== input.terminalReasonCode.trim() ||
        input.terminalReasonCode.length > 200 ||
        !Number.isFinite(input.finishedAt.getTime())
      ) {
        throw new PostgresIssueExecutionFinalizationRejected(
          "Run finalization has an invalid terminal reason or timestamp",
        );
      }
        const run = await options.runService.lockRun(transaction, input);
        if (run.terminalFinalizationId !== null) {
          const finalization = exactlyOne(
            await transaction
              .select()
              .from(issueExecutionFinalizations)
              .where(
                and(
                  eq(issueExecutionFinalizations.companyId, input.companyId),
                  eq(issueExecutionFinalizations.runId, input.runId),
                  eq(issueExecutionFinalizations.id, run.terminalFinalizationId),
                ),
              )
              .limit(2)
              .for("update"),
            "Terminal run lost its exact finalization",
          );
          if (
            run.status !== input.status ||
            run.terminalReasonCode !== input.terminalReasonCode ||
            run.finishedAt?.getTime() !== input.finishedAt.getTime() ||
            finalization.finalizedAt.getTime() !== input.finishedAt.getTime()
          ) {
            throw new PostgresIssueExecutionFinalizationRejected(
              "Finalization retry changed immutable terminal input",
            );
          }
          return {
            finalizationId: finalization.id,
            status: input.status,
            retried: true,
          };
        }
        if (!activeRunStatus(run.status)) {
          throw new PostgresIssueExecutionFinalizationRejected(
            "Only an active run can be finalized",
          );
        }
        const control = exactlyOne(
          await transaction
            .select()
            .from(issueExecutionRunControls)
            .where(eq(issueExecutionRunControls.runId, input.runId))
            .limit(2)
            .for("update"),
          "Productive or consult run lost its current-prompt control",
        );
        if (
          control.currentRefId !== null ||
          control.currentOrdinal !== null ||
          control.currentSegmentOrdinal !== null
        ) {
          throw new PostgresIssueExecutionFinalizationRejected(
            "Run cannot finalize while a prompt is current",
          );
        }
        const frontier = await lockPromptFrontier(transaction, input);
        const updates = await lockRunUpdates(transaction, input);
        const progressSources = await transaction
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
              eq(issueCommentProjectionSources.companyId, input.companyId),
              eq(issueCommentProjectionSources.issueId, input.issueId),
              eq(issueCommentProjectionSources.sessionId, run.sessionId),
              eq(issueCommentProjectionSources.sourceKind, "run_progress"),
              eq(issueCommentProjectionSources.runId, input.runId),
            ),
          )
          .limit(2)
          .for("update");
        const progress = exactlyOne(
          progressSources,
          "Run finalization requires one stable run-progress comment",
        );
        const terminalEvents = await transaction
          .select()
          .from(issueSessionEvents)
          .where(
            and(
              eq(issueSessionEvents.companyId, input.companyId),
              eq(issueSessionEvents.issueId, input.issueId),
              eq(issueSessionEvents.sessionId, run.sessionId),
              eq(issueSessionEvents.runId, input.runId),
              eq(issueSessionEvents.type, "session.next.step.ended.3"),
            ),
          )
          .orderBy(desc(issueSessionEvents.seq))
          .limit(1)
          .for("update");
        const terminalEvent = terminalEvents[0] ?? null;
        const terminalMessages = await transaction
          .select()
          .from(issueSessionMessages)
          .where(
            and(
              eq(issueSessionMessages.companyId, input.companyId),
              eq(issueSessionMessages.issueId, input.issueId),
              eq(issueSessionMessages.sessionId, run.sessionId),
              eq(issueSessionMessages.runId, input.runId),
              eq(issueSessionMessages.type, "assistant"),
            ),
          )
          .orderBy(desc(issueSessionMessages.seq))
          .limit(1)
          .for("update");
        const terminalMessage = terminalMessages[0] ?? null;
        const finalText = terminalAssistantText(terminalMessage);
        const action = updates.length > 0
          ? "updates_committed" as const
          : finalText.length > 0
            ? "comment_only" as const
            : "no_conversational_output" as const;
        if (
          (action !== "no_conversational_output" && !terminalEvent) ||
          (action === "comment_only" && !terminalMessage)
        ) {
          throw new PostgresIssueExecutionFinalizationRejected(
            "Conversational finalization is missing its terminal Session dependency",
          );
        }
        const revokedAt = input.finishedAt;
        await transaction
          .update(issueExecutionPromptCapabilities)
          .set({
            state: "revoked",
            revocationReason: "run_terminal",
            revokedAt,
          })
          .where(
            and(
              eq(issueExecutionPromptCapabilities.companyId, input.companyId),
              eq(issueExecutionPromptCapabilities.issueId, input.issueId),
              eq(issueExecutionPromptCapabilities.runId, input.runId),
              inArray(issueExecutionPromptCapabilities.state, [
                "pending_setup",
                "active",
              ]),
            ),
          );
        const capabilities = await transaction
          .select()
          .from(issueExecutionPromptCapabilities)
          .where(
            and(
              eq(issueExecutionPromptCapabilities.companyId, input.companyId),
              eq(issueExecutionPromptCapabilities.issueId, input.issueId),
              eq(issueExecutionPromptCapabilities.runId, input.runId),
            ),
          )
          .orderBy(desc(issueExecutionPromptCapabilities.capabilityGeneration))
          .for("update");
        const gateway = capabilities[0] ?? null;
        if (capabilities.some((capability) => capability.state !== "revoked")) {
          throw new PostgresIssueExecutionFinalizationRejected(
            "Run finalization could not prove complete capability revocation",
          );
        }
        const livenessId = run.kind === "productive"
          ? await insertProductiveLivenessFact(transaction, {
              ...input,
            })
          : null;
        const finalizationId = randomUUID();
        const plan = buildIssueExecutionFinalizationPlan({
          companyId: input.companyId,
          issueId: input.issueId,
          runId: input.runId,
          runKind: run.kind,
          action,
          expectedPromptIdentities: frontier.expected,
          promptDependencies: frontier.dependencies,
          terminalSessionEventId:
            action === "no_conversational_output" ? null : terminalEvent!.id,
          terminalSessionMessageId:
            action === "comment_only" ? terminalMessage!.id : null,
          progressCommentId: progress.comment.id,
          runLivenessFactId: livenessId,
          gatewayRevocationRequired: gateway !== null,
          gatewayRevocation: gateway
            ? {
                capabilityConnectionId: gateway.capabilityConnectionId,
                capabilityGeneration: gateway.capabilityGeneration,
              }
            : null,
          updates,
        });
        if (action === "comment_only") {
          const folded = await publishIssueSessionFinalCommentInTx(
            transaction,
            {
              eventId: terminalEvent!.id,
              progressCommentId: progress.comment.id,
            },
          );
          if (folded.id !== progress.comment.id || folded.body !== finalText) {
            throw new PostgresIssueExecutionFinalizationRejected(
              "Stable progress comment did not fold to the exact terminal assistant",
            );
          }
        }
        await transaction.insert(issueExecutionFinalizations).values({
          id: finalizationId,
          companyId: input.companyId,
          runId: input.runId,
          finalizationIdentityDigest: plan.finalizationIdentityDigest,
          action,
          terminalSessionEventId:
            action === "no_conversational_output" ? null : terminalEvent!.id,
          terminalSessionMessageId:
            action === "comment_only" ? terminalMessage!.id : null,
          progressCommentId: progress.comment.id,
          gatewayCapabilityConnectionId:
            gateway?.capabilityConnectionId ?? null,
          gatewayCapabilityGeneration:
            gateway?.capabilityGeneration ?? null,
          runLivenessFactId: livenessId,
          finalizedAt: input.finishedAt,
          createdAt: input.finishedAt,
        });
        if (run.kind === "consult" && run.consultExecutionId) {
          await closeMentionExecutionInTransaction(transaction, {
            companyId: input.companyId,
            issueId: input.issueId,
            runId: input.runId,
            targetAgentId: run.targetAgentId,
            consultExecutionId: run.consultExecutionId,
            status: input.status,
            at: input.finishedAt,
          });
        }
        await transaction
          .insert(issueExecutionFinalizationPromptDependencies)
          .values(
            plan.promptDependencies.map((dependency) => ({
              companyId: input.companyId,
              issueId: input.issueId,
              runId: input.runId,
              finalizationId,
              dependencyOrdinal: dependency.dependencyOrdinal,
              promptKind: dependency.kind,
              refId: dependency.refId,
              refOrdinal: dependency.refOrdinal,
              segmentOrdinal: dependency.segmentOrdinal,
              protocolSettlementState: dependency.protocolSettlementState,
              settlementVersion: dependency.settlementVersion,
              accountingId: dependency.accountingId,
              costEventId: dependency.costEventId,
            })),
          );
        if (plan.updateDependencies.length > 0) {
          await transaction
            .insert(issueExecutionFinalizationUpdateDependencies)
            .values(
              plan.updateDependencies.map((dependency) => ({
                companyId: input.companyId,
                runId: input.runId,
                finalizationId,
                dependencyOrdinal: dependency.dependencyOrdinal,
                issueUpdateId: dependency.issueUpdateId,
              })),
            );
        }
        await options.runService.attachFinalization(transaction, {
          companyId: input.companyId,
          issueId: input.issueId,
          runId: input.runId,
          expectedStatus: run.status as "queued" | "scheduled_retry" | "running",
          finalizationId,
          status: input.status,
          terminalReasonCode: input.terminalReasonCode,
          finishedAt: input.finishedAt,
          at: input.finishedAt,
        });
        return {
          finalizationId,
          status: input.status,
          retried: false,
        };
  }

  return {
    finalizeInTransaction,
    async finalize(
      input: FinalizePostgresIssueExecutionRunInput,
    ): Promise<FinalizedPostgresIssueExecutionRun> {
      return options.database.transaction((transaction) =>
        finalizeInTransaction(transaction, input));
    },
  };
}

export type PostgresIssueExecutionFinalizationWriter = ReturnType<
  typeof createPostgresIssueExecutionFinalizationWriter
>;
