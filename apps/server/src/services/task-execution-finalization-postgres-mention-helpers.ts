import {
  agentActionGrants,
  agentMentionReachGrants,
  agents,
  taskConsultExecutions,
  taskExecutionRefs,
  taskExecutionRunRefs,
  tasks,
  type Db,
} from "@paperclipai/db";
import type { TaskExecutionRunTerminalClassification } from "@paperclipai/shared";
import { and, asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { resolveMentionReach } from "./mention-reach-resolver.js";
import { admitManagedAgentMessageInTransaction } from "./runtime-task-action-port.js";
import type { createPostgresTaskExecutionFinalizationWriter } from "./task-execution-finalization-postgres-part-2.js";
import {
  type FinalizePostgresTaskExecutionRunInput,
  type TaskExecutionDbTransaction,
  PostgresTaskExecutionFinalizationRejected,
} from "./task-execution-finalization-postgres-part-1.js";
import { createTaskSessionAdmissionService } from "./task-session/admission.js";

export function createPostgresTaskExecutionFinalizationMentionHelpers(
  options: Parameters<typeof createPostgresTaskExecutionFinalizationWriter>[0],
) {
  async function closeMentionExecutionInTransaction(
    transaction: TaskExecutionDbTransaction,
    input: {
      companyId: string;
      taskId: string;
      runId: string;
      targetAgentId: string;
      consultExecutionId: string;
      status: TaskExecutionRunTerminalClassification;
      at: Date;
    },
  ): Promise<void> {
    const incomingRows = await transaction
      .select({ ref: taskExecutionRefs })
      .from(taskExecutionRunRefs)
      .innerJoin(taskExecutionRefs, eq(taskExecutionRefs.id, taskExecutionRunRefs.refId))
      .where(
        and(
          eq(taskExecutionRunRefs.companyId, input.companyId),
          eq(taskExecutionRunRefs.taskId, input.taskId),
          eq(taskExecutionRunRefs.runId, input.runId),
          eq(taskExecutionRefs.consultExecutionId, input.consultExecutionId),
        ),
      )
      .limit(2)
      .for("update");
    if (incomingRows.length !== 1) {
      throw new PostgresTaskExecutionFinalizationRejected("Mention run lost its exact incoming ref");
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
      .update(taskConsultExecutions)
      .set({
        state: input.status === "succeeded" ? "completed" : "cancelled",
        closeReason: input.status === "succeeded" ? "mention_completed" : `mention_${input.status}`,
        closedAt: input.at,
      })
      .where(
        and(
          eq(taskConsultExecutions.id, input.consultExecutionId),
          eq(taskConsultExecutions.state, "active"),
        ),
      )
      .returning({ id: taskConsultExecutions.id });
    if (closed.length !== 1) {
      throw new PostgresTaskExecutionFinalizationRejected(
        "Mention run could not close its consult authority",
      );
    }
  }

  async function maybeAutoCaptureMentionResponse(
    transaction: TaskExecutionDbTransaction,
    input: FinalizePostgresTaskExecutionRunInput,
    run: Awaited<ReturnType<typeof options.runService.lockRun>>,
    finalText: string,
  ): Promise<string | null> {
    if (
      run.kind !== "consult" ||
      !run.consultExecutionId ||
      input.status !== "succeeded" ||
      finalText.length === 0
    ) {
      return null;
    }
    const consult = await transaction
      .select({
        taskId: taskConsultExecutions.taskId,
        sourceRunId: taskConsultExecutions.sourceRunId,
      })
      .from(taskConsultExecutions)
      .where(eq(taskConsultExecutions.id, run.consultExecutionId))
      .limit(1)
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!consult) return null;
    const sourceRun = await options.runService.lockRun(transaction, {
      companyId: input.companyId,
      taskId: consult.taskId,
      runId: consult.sourceRunId,
    });
    const finishingRef = await transaction
      .select({
        id: taskExecutionRefs.id,
        executionLineageId: taskExecutionRefs.executionLineageId,
        executionScopeId: taskExecutionRefs.executionScopeId,
      })
      .from(taskExecutionRefs)
      .innerJoin(
        taskExecutionRunRefs,
        and(
          eq(taskExecutionRunRefs.refId, taskExecutionRefs.id),
          eq(taskExecutionRunRefs.runId, input.runId),
          eq(taskExecutionRunRefs.companyId, input.companyId),
        ),
      )
      .where(
        and(
          eq(taskExecutionRefs.companyId, input.companyId),
          eq(taskExecutionRefs.taskId, input.taskId),
          eq(taskExecutionRefs.sessionId, run.sessionId),
          eq(taskExecutionRefs.mode, "consult"),
        ),
      )
      .orderBy(asc(taskExecutionRefs.id))
      .limit(1)
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!finishingRef) return null;
    const companyAgents = await transaction
      .select()
      .from(agents)
      .where(eq(agents.companyId, input.companyId));
    const taskTree = await transaction
      .select({
        id: tasks.id,
        identifier: tasks.identifier,
        parentId: tasks.parentId,
        ownerKind: tasks.ownerKind,
        ownerAgentId: tasks.ownerAgentId,
      })
      .from(tasks)
      .where(and(eq(tasks.companyId, input.companyId), eq(tasks.id, input.taskId)));
    const sourceTask = taskTree[0];
    if (!sourceTask) return null;
    const mentionReachRows = await transaction
      .select({ key: agentMentionReachGrants.key })
      .from(agentMentionReachGrants)
      .where(
        and(
          eq(agentMentionReachGrants.companyId, input.companyId),
          eq(agentMentionReachGrants.agentId, run.targetAgentId),
        ),
      );
    const mentionReach = Object.fromEntries(mentionReachRows.map((r) => [r.key, true]));
    const resolution = resolveMentionReach({
      sourceAgentId: run.targetAgentId,
      companyAgents,
      taskTree,
      mentionReach,
    });
    if (resolution.targetAgentIds.size > 0) return null;
    const mentionBoardRow = await transaction
      .select({ id: agentActionGrants.id })
      .from(agentActionGrants)
      .where(
        and(
          eq(agentActionGrants.companyId, input.companyId),
          eq(agentActionGrants.agentId, run.targetAgentId),
          eq(agentActionGrants.key, "mention_board"),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (mentionBoardRow) return null;
    const sourceAgent = companyAgents.find((a) => a.id === sourceRun.targetAgentId);
    if (!sourceAgent) return null;
    const finishingAgent = companyAgents.find((a) => a.id === run.targetAgentId);
    const consultId = randomUUID();
    await transaction.insert(taskConsultExecutions).values({
      id: consultId,
      companyId: input.companyId,
      taskId: input.taskId,
      sessionId: run.sessionId,
      ownershipEpoch: run.ownershipEpoch,
      sourceRunId: input.runId,
      sourceRefId: finishingRef.id,
      callerExecutionScopeId: finishingRef.executionScopeId,
      targetAgentId: sourceAgent.id,
      adapterConfigRevisionId: sourceRun.adapterConfigRevisionId,
      chainToken: `consult_chain:auto_capture:${input.runId}`,
      state: "active",
      createdAt: input.finishedAt,
    });
    const sessionAdmission = createTaskSessionAdmissionService(transaction as unknown as Db);
    const admission = await admitManagedAgentMessageInTransaction(sessionAdmission, transaction, {
      companyId: input.companyId,
      taskId: input.taskId,
      sessionId: run.sessionId,
      ownershipEpoch: run.ownershipEpoch,
      targetAgentId: sourceAgent.id,
      taskExecutionAuthorityId: null,
      consultExecutionId: consultId,
      adapterConfigRevisionId: sourceRun.adapterConfigRevisionId,
      contextEpoch: 0,
      mode: "consult",
      executionLineageId: finishingRef.executionLineageId,
      consultCallerRefId: finishingRef.id,
      consultChainToken: `consult_chain:auto_capture:${input.runId}`,
      sourceKind: "consult_mention",
      actor: {
        kind: "agent-execution",
        agentId: run.targetAgentId,
        authorityId: run.taskExecutionAuthorityId ?? "",
      },
      immutableSourceKey: `auto-capture:${input.runId}`,
      sourceRecordId: consultId,
      idempotencyKey: `auto-capture:${input.runId}`,
      recipient: {
        id: sourceAgent.id,
        name: sourceAgent.name,
      },
      delivery: {
        toolName: "mention_agent",
        body: finalText,
        context: {
          task: {
            id: sourceTask.id,
            identifier: sourceTask.identifier,
          },
          from: {
            id: run.targetAgentId,
            name: finishingAgent?.name ?? "Agent",
          },
        },
      },
      comment: {
        author: { kind: "agent", agentId: run.targetAgentId },
        producingRun: {
          runId: input.runId,
          adapterConfigRevisionId: run.adapterConfigRevisionId,
        },
      },
    });
    if (!admission.ref) return null;
    return admission.ref.id;
  }
  return {
    closeMentionExecutionInTransaction,
    maybeAutoCaptureMentionResponse,
  };
}
