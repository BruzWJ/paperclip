import {
  agentAdapterConfigRevisions,
  taskExecutionCancellationIntents,
  taskExecutionPromptCapabilities,
  taskExecutionPromptSegments,
  taskExecutionRunRefs,
  taskExecutionSessions,
  taskSessionMessages,
} from "@paperclipai/db";
import { agentAdapterAcpConfigurationSchema, TaskSession } from "@paperclipai/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import type {
  TaskExecutionPromptCapabilityIdentity,
  TaskExecutionPromptCycleRepository,
  TaskExecutionPromptIdentity,
} from "./task-execution-attempt-executor.js";
import {
  boundedReason,
  exactlyOne,
  reject,
  sha256,
} from "./task-execution-prompt-cycle-postgres-shared-part-1.js";
import {
  reserveTaskSessionEventSequence,
  reserveTaskSessionMessageId,
  type TaskSessionDbTransaction,
} from "./task-session/event-store.js";
import { taskSessionMessageFromRow } from "./task-session/projector.js";
import { publishTaskSessionEventInTx } from "./task-session/publication.js";

export async function lockCapability(
  transaction: TaskSessionDbTransaction,
  prompt: TaskExecutionPromptIdentity,
  capability: TaskExecutionPromptCapabilityIdentity,
) {
  const rows = await transaction
    .select()
    .from(taskExecutionPromptCapabilities)
    .where(
      and(
        eq(taskExecutionPromptCapabilities.capabilityConnectionId, capability.capabilityConnectionId),
        eq(taskExecutionPromptCapabilities.capabilityGeneration, capability.capabilityGeneration),
        eq(taskExecutionPromptCapabilities.companyId, prompt.companyId),
        eq(taskExecutionPromptCapabilities.taskId, prompt.taskId),
        eq(taskExecutionPromptCapabilities.runId, prompt.runId),
        eq(taskExecutionPromptCapabilities.refId, prompt.refId),
        eq(taskExecutionPromptCapabilities.refOrdinal, prompt.refOrdinal),
        eq(taskExecutionPromptCapabilities.segmentOrdinal, prompt.segmentOrdinal),
        eq(taskExecutionPromptCapabilities.attemptId, prompt.attemptId),
        eq(taskExecutionPromptCapabilities.leaseId, prompt.leaseId),
      ),
    )
    .limit(2)
    .for("update");
  return exactlyOne(rows, "prompt capability generation is missing or crossed");
}

export async function revokeCapability(
  transaction: TaskSessionDbTransaction,
  prompt: TaskExecutionPromptIdentity,
  capability: TaskExecutionPromptCapabilityIdentity,
  reason: string,
  at: Date,
): Promise<void> {
  const changed = await transaction
    .update(taskExecutionPromptCapabilities)
    .set({
      state: "revoked",
      revocationReason: boundedReason(reason, "prompt_closed"),
      revokedAt: at,
    })
    .where(
      and(
        eq(taskExecutionPromptCapabilities.capabilityConnectionId, capability.capabilityConnectionId),
        eq(taskExecutionPromptCapabilities.capabilityGeneration, capability.capabilityGeneration),
        eq(taskExecutionPromptCapabilities.runId, prompt.runId),
        inArray(taskExecutionPromptCapabilities.state, ["pending_setup", "active"]),
      ),
    )
    .returning({
      capabilityConnectionId: taskExecutionPromptCapabilities.capabilityConnectionId,
    });
  if (changed.length !== 1) reject("prompt capability could not be revoked exactly once");
}

export async function supersedeCorrelation(
  transaction: TaskSessionDbTransaction,
  correlationId: string | null,
  reason: string,
  at: Date,
): Promise<void> {
  if (!correlationId) return;
  await transaction
    .update(taskExecutionSessions)
    .set({
      state: "superseded",
      supersessionReason: boundedReason(reason, "prompt_closed"),
      supersededAt: at,
    })
    .where(
      and(
        eq(taskExecutionSessions.id, correlationId),
        inArray(taskExecutionSessions.state, ["eligible", "current"]),
      ),
    );
}

export async function recordNativeCancellationSettlement(
  transaction: TaskSessionDbTransaction,
  prompt: TaskExecutionPromptIdentity,
  at: Date,
): Promise<boolean> {
  const changed = await transaction
    .update(taskExecutionCancellationIntents)
    .set({ nativeCancellationSettledAt: at })
    .where(
      and(
        eq(taskExecutionCancellationIntents.companyId, prompt.companyId),
        eq(taskExecutionCancellationIntents.taskId, prompt.taskId),
        eq(taskExecutionCancellationIntents.runId, prompt.runId),
        eq(taskExecutionCancellationIntents.attemptId, prompt.attemptId),
        eq(taskExecutionCancellationIntents.leaseId, prompt.leaseId),
        inArray(taskExecutionCancellationIntents.state, ["requested", "acknowledged"]),
        sql`${taskExecutionCancellationIntents.nativeCancellationSettledAt} is null`,
      ),
    )
    .returning({ id: taskExecutionCancellationIntents.id });
  if (changed.length > 1) {
    reject("native ACPX cancellation matched multiple active intents");
  }
  return changed.length === 1;
}

export type NonProtocolPromptOwner = Pick<
  TaskExecutionPromptIdentity,
  "promptKind" | "runId" | "refId" | "refOrdinal" | "segmentOrdinal" | "attemptId"
>;

/** @internal Sole base/steering owner settlement for a non-protocol closure. */
export async function settleNonProtocolPromptInTransaction(
  transaction: TaskSessionDbTransaction,
  prompt: NonProtocolPromptOwner,
  input: {
    readonly state: "not_sent" | "incomplete";
    readonly outcome: "released_unsent" | "ambiguous" | "failed" | "cancelled";
    readonly referenceId: string;
    readonly at: Date;
  },
): Promise<void> {
  const values = {
    outcome: input.outcome,
    outcomeReferenceId: input.referenceId,
    protocolSettlementState: input.state,
    settlementVersion: 1,
    settledAt: input.at,
  } as const;
  const rows =
    prompt.promptKind === "base"
      ? await transaction
          .update(taskExecutionRunRefs)
          .set(values)
          .where(
            and(
              eq(taskExecutionRunRefs.runId, prompt.runId),
              eq(taskExecutionRunRefs.refId, prompt.refId),
              eq(taskExecutionRunRefs.refOrdinal, prompt.refOrdinal),
              eq(taskExecutionRunRefs.attemptId, prompt.attemptId),
              eq(
                taskExecutionRunRefs.promptTransmissionPhase,
                input.state === "not_sent" ? "not_transmitted" : "transmitted",
              ),
              sql`${taskExecutionRunRefs.protocolSettlementState} is null`,
            ),
          )
          .returning({ runId: taskExecutionRunRefs.runId })
      : await transaction
          .update(taskExecutionPromptSegments)
          .set({ ...values, steeringState: "protocol_settled" })
          .where(
            and(
              eq(taskExecutionPromptSegments.runId, prompt.runId),
              eq(taskExecutionPromptSegments.refId, prompt.refId),
              eq(taskExecutionPromptSegments.refOrdinal, prompt.refOrdinal),
              eq(taskExecutionPromptSegments.segmentOrdinal, prompt.segmentOrdinal),
              eq(taskExecutionPromptSegments.attemptId, prompt.attemptId),
              eq(
                taskExecutionPromptSegments.promptTransmissionPhase,
                input.state === "not_sent" ? "not_transmitted" : "transmitted",
              ),
              sql`${taskExecutionPromptSegments.protocolSettlementState} is null`,
            ),
          )
          .returning({ runId: taskExecutionPromptSegments.runId });
  if (rows.length !== 1) reject("non-protocol prompt settlement lost its exact owner");
}

export async function ensureAssistantStarted(
  transaction: TaskSessionDbTransaction,
  prompt: TaskExecutionPromptIdentity,
  at: Date,
): Promise<string> {
  const scope = {
    companyId: prompt.companyId,
    taskId: prompt.taskId,
    sessionId: prompt.sessionId,
  };
  const assistantMessageId = await reserveTaskSessionMessageId(
    transaction,
    scope,
    `acp-prompt:${prompt.attemptId}:assistant`,
  );
  const existing = await transaction
    .select()
    .from(taskSessionMessages)
    .where(
      and(
        eq(taskSessionMessages.companyId, prompt.companyId),
        eq(taskSessionMessages.taskId, prompt.taskId),
        eq(taskSessionMessages.sessionId, prompt.sessionId),
        eq(taskSessionMessages.id, assistantMessageId),
      ),
    )
    .limit(2)
    .for("update");
  if (existing.length > 1) reject("assistant message identity is ambiguous");
  if (existing[0]) {
    const message = taskSessionMessageFromRow(existing[0]);
    if (
      message.type !== "assistant" ||
      message.time.completed !== undefined ||
      existing[0].runId !== prompt.runId
    ) {
      reject("assistant message is not the unfinished exact prompt assistant");
    }
    return assistantMessageId;
  }
  const revision = exactlyOne(
    await transaction
      .select({
        acpConfiguration: agentAdapterConfigRevisions.acpConfiguration,
      })
      .from(agentAdapterConfigRevisions)
      .where(
        and(
          eq(agentAdapterConfigRevisions.id, prompt.adapterConfigRevisionId),
          eq(agentAdapterConfigRevisions.companyId, prompt.companyId),
          eq(agentAdapterConfigRevisions.agentId, prompt.targetAgentId),
        ),
      )
      .limit(2),
    "assistant start lost its immutable adapter revision",
  );
  const configuration = agentAdapterAcpConfigurationSchema.parse(revision.acpConfiguration);
  const immutableSourceKey = `acp_prompt_update:${prompt.attemptId}:0:${TaskSession.Event.Step.Started.type}`;
  const { seq } = await reserveTaskSessionEventSequence(transaction, scope);
  await publishTaskSessionEventInTx(transaction, {
    event: {
      id: `evt_${sha256(immutableSourceKey).slice(0, 40)}`,
      sessionId: prompt.sessionId,
      seq,
      type: TaskSession.Event.Step.Started.type,
      data: {
        timestamp: at.getTime(),
        sessionID: prompt.sessionId,
        assistantMessageID: assistantMessageId,
        agent: prompt.targetAgentId,
        ...(configuration.model === null
          ? {}
          : {
              model: {
                id: configuration.model.value,
                providerID: configuration.launchProfile.registryName,
              },
            }),
      },
    },
    envelope: {
      companyId: prompt.companyId,
      taskId: prompt.taskId,
      runId: prompt.runId,
      ownershipEpoch: prompt.ownershipEpoch,
      agentId: prompt.targetAgentId,
      adapterConfigRevisionId: prompt.adapterConfigRevisionId,
      sourceKind: "acp_prompt_update",
      sourceId: prompt.attemptId,
      immutableSourceKey,
      sourceRecordId: prompt.attemptId,
      sourceIdentityDigest: sha256(
        [
          prompt.companyId,
          prompt.taskId,
          prompt.sessionId,
          prompt.runId,
          prompt.attemptId,
          TaskSession.Event.Step.Started.type,
        ].join(":"),
      ),
      createdAt: at,
    },
  });
  return assistantMessageId;
}

export async function terminalAssistantText(
  transaction: TaskSessionDbTransaction,
  prompt: TaskExecutionPromptIdentity,
  assistantMessageId: string,
): Promise<string> {
  const row = await transaction
    .select()
    .from(taskSessionMessages)
    .where(
      and(
        eq(taskSessionMessages.companyId, prompt.companyId),
        eq(taskSessionMessages.taskId, prompt.taskId),
        eq(taskSessionMessages.sessionId, prompt.sessionId),
        eq(taskSessionMessages.id, assistantMessageId),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row) return "";
  const message = taskSessionMessageFromRow(row);
  if (message.type !== "assistant" || message.time.completed === undefined) return "";
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

export function terminalOutcome(stopReason: string): "succeeded" | "failed" | "cancelled" {
  if (stopReason === "cancelled") return "cancelled";
  if (stopReason === "error") return "failed";
  return "succeeded";
}

export type CreatePostgresTaskExecutionPromptCycleRepositoryResult = TaskExecutionPromptCycleRepository;
