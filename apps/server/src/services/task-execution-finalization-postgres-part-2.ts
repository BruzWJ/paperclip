import {
  runInterfaceToolCalls,
  taskCommentProjectionSources,
  taskComments,
  taskExecutionFinalizationPromptDependencies,
  taskExecutionFinalizationUpdateDependencies,
  taskExecutionFinalizations,
  taskExecutionPromptCapabilities,
  taskExecutionRunControls,
  taskSessionEvents,
  taskSessionMessages,
  type Db,
} from "@paperclipai/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { createPostgresTaskExecutionFinalizationMentionHelpers } from "./task-execution-finalization-postgres-mention-helpers.js";
import * as finalizationCore from "./task-execution-finalization-postgres-part-1.js";
import { buildTaskExecutionFinalizationPlan } from "./task-execution-finalization.js";
import type { TaskExecutionRunService } from "./task-execution-run-service.js";
import { publishTaskSessionFinalCommentInTx } from "./task-session/publication.js";

/**
 * Sole productive/consult finalization transaction owner. It derives every
 * dependency from locked canonical rows; callers provide only the run's
 * terminal classification and bounded reason, never output bytes or a
 * caller-assembled prompt frontier.
 */
export function createPostgresTaskExecutionFinalizationWriter(options: {
  readonly database: Db;
  readonly runService: Pick<TaskExecutionRunService, "lockRun" | "attachFinalization">;
}) {
  const { closeMentionExecutionInTransaction, maybeAutoCaptureMentionResponse } =
    createPostgresTaskExecutionFinalizationMentionHelpers(options);
  async function finalizeInTransaction(
    transaction: finalizationCore.TaskExecutionDbTransaction,
    input: finalizationCore.FinalizePostgresTaskExecutionRunInput,
  ): Promise<finalizationCore.FinalizedPostgresTaskExecutionRun> {
    if (
      input.terminalReasonCode.length === 0 ||
      input.terminalReasonCode !== input.terminalReasonCode.trim() ||
      input.terminalReasonCode.length > 200 ||
      !Number.isFinite(input.finishedAt.getTime())
    ) {
      throw new finalizationCore.PostgresTaskExecutionFinalizationRejected(
        "Run finalization has an invalid terminal reason or timestamp",
      );
    }
    const run = await options.runService.lockRun(transaction, input);
    if (run.terminalFinalizationId !== null) {
      const finalization = finalizationCore.exactlyOne(
        await transaction
          .select()
          .from(taskExecutionFinalizations)
          .where(
            and(
              eq(taskExecutionFinalizations.companyId, input.companyId),
              eq(taskExecutionFinalizations.runId, input.runId),
              eq(taskExecutionFinalizations.id, run.terminalFinalizationId),
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
        throw new finalizationCore.PostgresTaskExecutionFinalizationRejected(
          "Finalization retry changed immutable terminal input",
        );
      }
      return {
        finalizationId: finalization.id,
        status: input.status,
        retried: true,
        autoCaptureRefId: null,
      };
    }
    if (!finalizationCore.activeRunStatus(run.status)) {
      throw new finalizationCore.PostgresTaskExecutionFinalizationRejected(
        "Only an active run can be finalized",
      );
    }
    const control = finalizationCore.exactlyOne(
      await transaction
        .select()
        .from(taskExecutionRunControls)
        .where(eq(taskExecutionRunControls.runId, input.runId))
        .limit(2)
        .for("update"),
      "Productive or consult run lost its current-prompt control",
    );
    if (
      control.currentRefId !== null ||
      control.currentOrdinal !== null ||
      control.currentSegmentOrdinal !== null
    ) {
      throw new finalizationCore.PostgresTaskExecutionFinalizationRejected(
        "Run cannot finalize while a prompt is current",
      );
    }
    const frontier = await finalizationCore.lockPromptFrontier(transaction, input);
    const updates = await finalizationCore.lockRunUpdates(transaction, input);
    const progressSources = await transaction
      .select({
        source: taskCommentProjectionSources,
        comment: taskComments,
      })
      .from(taskCommentProjectionSources)
      .innerJoin(taskComments, eq(taskComments.id, taskCommentProjectionSources.commentId))
      .where(
        and(
          eq(taskCommentProjectionSources.companyId, input.companyId),
          eq(taskCommentProjectionSources.taskId, input.taskId),
          eq(taskCommentProjectionSources.sessionId, run.sessionId),
          eq(taskCommentProjectionSources.sourceKind, "run_progress"),
          eq(taskCommentProjectionSources.runId, input.runId),
        ),
      )
      .limit(2)
      .for("update");
    const progress = finalizationCore.exactlyOne(
      progressSources,
      "Run finalization requires one stable run-progress comment",
    );
    const terminalEvents = await transaction
      .select()
      .from(taskSessionEvents)
      .where(
        and(
          eq(taskSessionEvents.companyId, input.companyId),
          eq(taskSessionEvents.taskId, input.taskId),
          eq(taskSessionEvents.sessionId, run.sessionId),
          eq(taskSessionEvents.runId, input.runId),
          eq(taskSessionEvents.type, "session.next.step.ended.3"),
        ),
      )
      .orderBy(desc(taskSessionEvents.seq))
      .limit(1)
      .for("update");
    const terminalEvent = terminalEvents[0] ?? null;
    const terminalMessages = await transaction
      .select()
      .from(taskSessionMessages)
      .where(
        and(
          eq(taskSessionMessages.companyId, input.companyId),
          eq(taskSessionMessages.taskId, input.taskId),
          eq(taskSessionMessages.sessionId, run.sessionId),
          eq(taskSessionMessages.runId, input.runId),
          eq(taskSessionMessages.type, "assistant"),
        ),
      )
      .orderBy(desc(taskSessionMessages.seq))
      .limit(1)
      .for("update");
    const terminalMessage = terminalMessages[0] ?? null;
    const finalText = finalizationCore.terminalAssistantText(terminalMessage);
    const mentionToolCallRows = await transaction
      .select({ toolName: runInterfaceToolCalls.toolName })
      .from(runInterfaceToolCalls)
      .innerJoin(
        taskExecutionPromptCapabilities,
        and(
          eq(
            runInterfaceToolCalls.capabilityConnectionId,
            taskExecutionPromptCapabilities.capabilityConnectionId,
          ),
          eq(
            runInterfaceToolCalls.capabilityGeneration,
            taskExecutionPromptCapabilities.capabilityGeneration,
          ),
        ),
      )
      .where(
        and(
          eq(runInterfaceToolCalls.companyId, input.companyId),
          eq(taskExecutionPromptCapabilities.companyId, input.companyId),
          eq(taskExecutionPromptCapabilities.runId, input.runId),
          eq(runInterfaceToolCalls.classification, "validated_mention"),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const hadMentionComment = mentionToolCallRows !== null;
    const hasSameTaskUpdate = updates.some((update) => update.updateTargetTaskId === input.taskId);
    const hasFinalResponse = finalText.length > 0;
    const action =
      hadMentionComment || updates.length > 0
        ? ("updates_committed" as const)
        : hasFinalResponse
          ? ("comment_only" as const)
          : ("no_conversational_output" as const);
    if (
      (action !== "no_conversational_output" && !terminalEvent) ||
      (hasFinalResponse && !terminalMessage)
    ) {
      throw new finalizationCore.PostgresTaskExecutionFinalizationRejected(
        "Conversational finalization is missing its terminal Session dependency",
      );
    }
    const revokedAt = input.finishedAt;
    await transaction
      .update(taskExecutionPromptCapabilities)
      .set({
        state: "revoked",
        revocationReason: "run_terminal",
        revokedAt,
      })
      .where(
        and(
          eq(taskExecutionPromptCapabilities.companyId, input.companyId),
          eq(taskExecutionPromptCapabilities.taskId, input.taskId),
          eq(taskExecutionPromptCapabilities.runId, input.runId),
          inArray(taskExecutionPromptCapabilities.state, ["pending_setup", "active"]),
        ),
      );
    const capabilities = await transaction
      .select()
      .from(taskExecutionPromptCapabilities)
      .where(
        and(
          eq(taskExecutionPromptCapabilities.companyId, input.companyId),
          eq(taskExecutionPromptCapabilities.taskId, input.taskId),
          eq(taskExecutionPromptCapabilities.runId, input.runId),
        ),
      )
      .orderBy(desc(taskExecutionPromptCapabilities.capabilityGeneration))
      .for("update");
    const gateway = capabilities[0] ?? null;
    if (capabilities.some((capability) => capability.state !== "revoked")) {
      throw new finalizationCore.PostgresTaskExecutionFinalizationRejected(
        "Run finalization could not prove complete capability revocation",
      );
    }
    const livenessId =
      run.kind === "productive"
        ? await finalizationCore.insertProductiveLivenessFact(transaction, {
            ...input,
          })
        : null;
    const finalizationId = randomUUID();
    const plan = buildTaskExecutionFinalizationPlan({
      companyId: input.companyId,
      taskId: input.taskId,
      runId: input.runId,
      runKind: run.kind,
      action,
      expectedPromptIdentities: frontier.expected,
      promptDependencies: frontier.dependencies,
      terminalSessionEventId: action === "no_conversational_output" ? null : terminalEvent!.id,
      terminalSessionMessageId: action === "comment_only" ? terminalMessage!.id : null,
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
    if (hasFinalResponse && !hasSameTaskUpdate) {
      const folded = await publishTaskSessionFinalCommentInTx(transaction, {
        eventId: terminalEvent!.id,
        progressCommentId: progress.comment.id,
      });
      if (folded.id !== progress.comment.id || folded.body !== finalText) {
        throw new finalizationCore.PostgresTaskExecutionFinalizationRejected(
          "Stable progress comment did not fold to the exact terminal assistant",
        );
      }
    }
    await transaction.insert(taskExecutionFinalizations).values({
      id: finalizationId,
      companyId: input.companyId,
      runId: input.runId,
      finalizationIdentityDigest: plan.finalizationIdentityDigest,
      action,
      terminalSessionEventId: action === "no_conversational_output" ? null : terminalEvent!.id,
      terminalSessionMessageId: action === "comment_only" ? terminalMessage!.id : null,
      progressCommentId: progress.comment.id,
      gatewayCapabilityConnectionId: gateway?.capabilityConnectionId ?? null,
      gatewayCapabilityGeneration: gateway?.capabilityGeneration ?? null,
      runLivenessFactId: livenessId,
      finalizedAt: input.finishedAt,
      createdAt: input.finishedAt,
    });
    if (run.kind === "consult" && run.consultExecutionId) {
      await closeMentionExecutionInTransaction(transaction, {
        companyId: input.companyId,
        taskId: input.taskId,
        runId: input.runId,
        targetAgentId: run.targetAgentId,
        consultExecutionId: run.consultExecutionId,
        status: input.status,
        at: input.finishedAt,
      });
    }
    await transaction.insert(taskExecutionFinalizationPromptDependencies).values(
      plan.promptDependencies.map((dependency) => ({
        companyId: input.companyId,
        taskId: input.taskId,
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
      await transaction.insert(taskExecutionFinalizationUpdateDependencies).values(
        plan.updateDependencies.map((dependency) => ({
          companyId: input.companyId,
          runId: input.runId,
          finalizationId,
          dependencyOrdinal: dependency.dependencyOrdinal,
          taskUpdateId: dependency.taskUpdateId,
        })),
      );
    }
    await options.runService.attachFinalization(transaction, {
      companyId: input.companyId,
      taskId: input.taskId,
      runId: input.runId,
      expectedStatus: run.status as "queued" | "scheduled_retry" | "running",
      finalizationId,
      status: input.status,
      terminalReasonCode: input.terminalReasonCode,
      finishedAt: input.finishedAt,
      at: input.finishedAt,
    });
    const autoCaptureRefId = await maybeAutoCaptureMentionResponse(transaction, input, run, finalText);
    return {
      finalizationId,
      status: input.status,
      retried: false,
      autoCaptureRefId: autoCaptureRefId ?? null,
    };
  }
  return {
    finalizeInTransaction,
    async finalize(
      input: finalizationCore.FinalizePostgresTaskExecutionRunInput,
    ): Promise<finalizationCore.FinalizedPostgresTaskExecutionRun> {
      return options.database.transaction((transaction) => finalizeInTransaction(transaction, input));
    },
  };
}

export type PostgresTaskExecutionFinalizationWriter = ReturnType<
  typeof createPostgresTaskExecutionFinalizationWriter
>;
