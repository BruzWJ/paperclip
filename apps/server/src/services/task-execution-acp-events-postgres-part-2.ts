import {
  normalizeAcpToolOutput,
  type NormalizedAcpSessionEvent,
} from "@paperclipai/adapter-utils/acpx-runtime";

import { agentAdapterConfigRevisions, taskSessionEvents, taskSessionMessages } from "@paperclipai/db";

import { agentAdapterAcpConfigurationSchema, TaskSession } from "@paperclipai/shared";

import { and, eq, sql } from "drizzle-orm";

import { redactSensitiveText } from "../redaction.js";

import type {
  TaskExecutionPromptCapabilityIdentity,
  TaskExecutionPromptIdentity,
} from "./task-execution-attempt-executor.js";

import {
  reserveTaskSessionEventSequence,
  reserveTaskSessionMessageId,
  type TaskSessionDbTransaction,
} from "./task-session/event-store.js";

import { taskSessionMessageFromRow } from "./task-session/projector.js";

import {
  type PromptPublication,
  isPlainRecord,
  projectedAcpToolName,
  redactValue,
  reject,
  sha256,
} from "./task-execution-acp-events-postgres-part-1.js";
import {
  publishTaskSessionEventInTx,
  type TaskSessionPublicationRedactor,
} from "./task-session/publication.js";

export async function beginPromptPublication(
  transaction: TaskSessionDbTransaction,
  input: {
    prompt: TaskExecutionPromptIdentity;
    capability: TaskExecutionPromptCapabilityIdentity;
    redactor: TaskSessionPublicationRedactor;
    timestamp: Date;
  },
): Promise<PromptPublication> {
  const scope = {
    companyId: input.prompt.companyId,
    taskId: input.prompt.taskId,
    sessionId: input.prompt.sessionId,
  };
  const assistantMessageId = await reserveTaskSessionMessageId(
    transaction,
    scope,
    `acp-prompt:${input.prompt.attemptId}:assistant`,
  );
  const count = await transaction
    .select({ count: sql<number>`count(*)::int` })
    .from(taskSessionEvents)
    .where(
      and(
        eq(taskSessionEvents.companyId, input.prompt.companyId),
        eq(taskSessionEvents.taskId, input.prompt.taskId),
        eq(taskSessionEvents.sessionId, input.prompt.sessionId),
        eq(taskSessionEvents.runId, input.prompt.runId),
        eq(taskSessionEvents.sourceKind, "acp_prompt_update"),
        eq(taskSessionEvents.sourceId, input.prompt.attemptId),
      ),
    )
    .then((rows) => Number(rows[0]?.count ?? 0));
  if (!Number.isSafeInteger(count) || count < 0) {
    reject("ACP prompt update event frontier is invalid");
  }
  const publication: PromptPublication = {
    assistantMessageId,
    timestamp: input.timestamp,
    nextSourceOrdinal: count,
    async publish(type, data, companions) {
      const sourceOrdinal = publication.nextSourceOrdinal;
      publication.nextSourceOrdinal += 1;
      const immutableSourceKey = ["acp_prompt_update", input.prompt.attemptId, sourceOrdinal, type].join(":");
      const eventId = `evt_${sha256(immutableSourceKey).slice(0, 40)}`;
      const { seq } = await reserveTaskSessionEventSequence(transaction, scope);
      await publishTaskSessionEventInTx(transaction, {
        event: {
          id: eventId,
          sessionId: input.prompt.sessionId,
          seq,
          type,
          data,
        },
        envelope: {
          companyId: input.prompt.companyId,
          taskId: input.prompt.taskId,
          runId: input.prompt.runId,
          ownershipEpoch: input.prompt.ownershipEpoch,
          agentId: input.prompt.targetAgentId,
          adapterConfigRevisionId: input.prompt.adapterConfigRevisionId,
          sourceKind: "acp_prompt_update",
          sourceId: input.prompt.attemptId,
          immutableSourceKey,
          sourceRecordId: input.capability.capabilityConnectionId,
          sourceIdentityDigest: sha256(
            [
              input.prompt.companyId,
              input.prompt.taskId,
              input.prompt.sessionId,
              input.prompt.runId,
              input.prompt.refId,
              input.prompt.refOrdinal,
              input.prompt.segmentOrdinal,
              input.prompt.attemptId,
              input.capability.capabilityConnectionId,
              input.capability.capabilityGeneration,
              sourceOrdinal,
              type,
            ].join(":"),
          ),
          createdAt: input.timestamp,
        },
        ...(companions ? { companions } : {}),
        redactor: input.redactor,
      });
      return eventId;
    },
  };
  const existing = await transaction
    .select()
    .from(taskSessionMessages)
    .where(
      and(
        eq(taskSessionMessages.companyId, input.prompt.companyId),
        eq(taskSessionMessages.taskId, input.prompt.taskId),
        eq(taskSessionMessages.sessionId, input.prompt.sessionId),
        eq(taskSessionMessages.id, assistantMessageId),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (existing) {
    if (
      existing.type !== "assistant" ||
      existing.runId !== input.prompt.runId ||
      existing.agentId !== input.prompt.targetAgentId ||
      existing.adapterConfigRevisionId !== input.prompt.adapterConfigRevisionId
    ) {
      reject("ACP prompt assistant identity is already owned elsewhere");
    }
    return publication;
  }
  const revision = await transaction
    .select({
      acpConfiguration: agentAdapterConfigRevisions.acpConfiguration,
    })
    .from(agentAdapterConfigRevisions)
    .where(
      and(
        eq(agentAdapterConfigRevisions.id, input.prompt.adapterConfigRevisionId),
        eq(agentAdapterConfigRevisions.companyId, input.prompt.companyId),
        eq(agentAdapterConfigRevisions.agentId, input.prompt.targetAgentId),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!revision) reject("ACP prompt immutable adapter revision is missing");
  const configuration = agentAdapterAcpConfigurationSchema.parse(revision.acpConfiguration);
  await publication.publish(TaskSession.Event.Step.Started.type, {
    timestamp: input.timestamp.getTime(),
    sessionID: input.prompt.sessionId,
    assistantMessageID: assistantMessageId,
    agent: input.prompt.targetAgentId,
    ...(configuration.model === null
      ? {}
      : {
          model: {
            id: configuration.model.value,
            providerID: configuration.launchProfile.registryName,
          },
        }),
  });
  return publication;
}

export async function currentAssistant(
  transaction: TaskSessionDbTransaction,
  prompt: TaskExecutionPromptIdentity,
  assistantMessageId: string,
) {
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
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!row) reject("ACP prompt assistant projection is missing");
  const message = taskSessionMessageFromRow(row);
  if (message.type !== "assistant" || message.time.completed) {
    reject("ACP update arrived outside an unfinished assistant step");
  }
  return message;
}

export function toolContent(sourceOutputText: string) {
  return sourceOutputText.length === 0 ? [] : [{ type: "text" as const, text: sourceOutputText }];
}

export function outputPaths(
  event: Extract<NormalizedAcpSessionEvent, { kind: "tool_call" | "tool_call_update" }>,
): string[] | undefined {
  const values = event.locations?.map((location) => location.path) ?? [];
  return values.length === 0 ? undefined : values;
}

export function toolInput(value: unknown): Record<string, unknown> {
  return isPlainRecord(value) ? value : {};
}

export function isAssistantTool(
  part: TaskSession.Message.AssistantContent,
): part is TaskSession.Message.AssistantTool {
  return part.type === "tool";
}

export async function publishToolEvent(
  transaction: TaskSessionDbTransaction,
  publication: PromptPublication,
  prompt: TaskExecutionPromptIdentity,
  event: Extract<NormalizedAcpSessionEvent, { kind: "tool_call" | "tool_call_update" }>,
  redactText: (value: string) => string,
): Promise<void> {
  const redactedRawInput = event.rawInput === undefined ? undefined : redactValue(event.rawInput, redactText);
  const redactedRawOutput =
    event.rawOutput === undefined ? undefined : redactValue(event.rawOutput, redactText);
  const redactedContent =
    event.content === undefined || event.content === null
      ? event.content
      : redactValue(event.content, redactText);
  let assistant = await currentAssistant(transaction, prompt, publication.assistantMessageId);
  let tool = assistant.content.findLast(
    (part): part is TaskSession.Message.AssistantTool =>
      isAssistantTool(part) && part.id === event.toolCallId,
  );
  if (!tool) {
    if (event.kind !== "tool_call") {
      reject("ACP tool update arrived before its tool-call creation");
    }
    const name = redactSensitiveText(redactText(projectedAcpToolName(event.rawInput, event.title)));
    await publication.publish(TaskSession.Event.Tool.Input.Started.type, {
      timestamp: publication.timestamp.getTime(),
      sessionID: prompt.sessionId,
      assistantMessageID: publication.assistantMessageId,
      callID: event.toolCallId,
      name,
    });
    const inputText =
      redactedRawInput === undefined ? "{}" : normalizeAcpToolOutput({ rawOutput: redactedRawInput });
    await publication.publish(TaskSession.Event.Tool.Input.Ended.type, {
      timestamp: publication.timestamp.getTime(),
      sessionID: prompt.sessionId,
      assistantMessageID: publication.assistantMessageId,
      callID: event.toolCallId,
      text: inputText,
    });
    assistant = await currentAssistant(transaction, prompt, publication.assistantMessageId);
    tool = assistant.content.findLast(
      (part): part is TaskSession.Message.AssistantTool =>
        isAssistantTool(part) && part.id === event.toolCallId,
    );
  } else if (tool.state.status === "pending" && redactedRawInput !== undefined) {
    await publication.publish(TaskSession.Event.Tool.Input.Ended.type, {
      timestamp: publication.timestamp.getTime(),
      sessionID: prompt.sessionId,
      assistantMessageID: publication.assistantMessageId,
      callID: event.toolCallId,
      text: normalizeAcpToolOutput({ rawOutput: redactedRawInput }),
    });
  }
  if (!tool) reject("ACP tool-call creation did not project its tool");

  const status = event.status ?? null;
  if (
    tool.state.status === "pending" &&
    (status === "in_progress" || status === "completed" || status === "failed")
  ) {
    await publication.publish(TaskSession.Event.Tool.Called.type, {
      timestamp: publication.timestamp.getTime(),
      sessionID: prompt.sessionId,
      assistantMessageID: publication.assistantMessageId,
      callID: event.toolCallId,
      tool: tool.name,
      input: toolInput(redactedRawInput),
      provider: { executed: true },
    });
    assistant = await currentAssistant(transaction, prompt, publication.assistantMessageId);
    tool = assistant.content.findLast(
      (part): part is TaskSession.Message.AssistantTool =>
        isAssistantTool(part) && part.id === event.toolCallId,
    );
  }
  if (!tool) reject("ACP tool-call transition lost its tool projection");
  const sourceOutputText = normalizeAcpToolOutput({
    ...(redactedRawOutput === undefined ? {} : { rawOutput: redactedRawOutput }),
    ...(redactedContent === undefined ? {} : { content: redactedContent }),
  });
  const structured = isPlainRecord(redactedRawOutput) ? redactedRawOutput : {};
  if (status === "completed") {
    if (tool.state.status !== "running") {
      reject("ACP completed tool is not in the running donor state");
    }
    await publication.publish(TaskSession.Event.Tool.Success.type, {
      timestamp: publication.timestamp.getTime(),
      sessionID: prompt.sessionId,
      assistantMessageID: publication.assistantMessageId,
      callID: event.toolCallId,
      structured,
      content: toolContent(sourceOutputText),
      ...(outputPaths(event) === undefined ? {} : { outputPaths: outputPaths(event) }),
      ...(redactedRawOutput === undefined ? {} : { result: redactedRawOutput }),
      provider: { executed: true },
    });
    return;
  }
  if (status === "failed") {
    if (tool.state.status !== "pending" && tool.state.status !== "running") {
      reject("ACP failed tool is already terminal");
    }
    await publication.publish(TaskSession.Event.Tool.Failed.type, {
      timestamp: publication.timestamp.getTime(),
      sessionID: prompt.sessionId,
      assistantMessageID: publication.assistantMessageId,
      callID: event.toolCallId,
      error: {
        type: "unknown",
        message: redactSensitiveText(redactText(event.title ?? "ACP tool call failed")),
      },
      ...(redactedRawOutput === undefined ? {} : { result: redactedRawOutput }),
      provider: { executed: true },
    });
    return;
  }
  if (tool.state.status === "running" && (event.content !== undefined || event.rawOutput !== undefined)) {
    await publication.publish(TaskSession.Event.Tool.Progress.type, {
      timestamp: publication.timestamp.getTime(),
      sessionID: prompt.sessionId,
      assistantMessageID: publication.assistantMessageId,
      callID: event.toolCallId,
      structured,
      content: toolContent(sourceOutputText),
    });
  }
}
