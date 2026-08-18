import { taskSessionMessages } from "@paperclipai/db";
import type { RunStreamAssistantMessage, RunStreamLiveEventPayload } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import type { TaskExecutionPromptIdentity } from "./task-execution-attempt-executor.js";
import { isPlainRecord, reject } from "./task-execution-acp-events-postgres-part-1.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";
import { redactTaskSessionPublicationValue } from "./task-session/publication.js";

export function runStreamAssistantMessageFromRow(
  row: typeof taskSessionMessages.$inferSelect,
): RunStreamAssistantMessage {
  const data = redactTaskSessionPublicationValue(row.data);
  if (row.type !== "assistant" || !isPlainRecord(data) || !Array.isArray(data.content)) {
    reject("ACP live projection has invalid assistant message data");
  }
  return {
    id: row.id,
    seq: row.seq,
    modelStateSeq: row.modelStateSeq,
    type: "assistant",
    data,
    timeCreated: row.timeCreated.toISOString(),
    timeUpdated: row.timeUpdated.toISOString(),
  };
}

async function readAssistantMessageRow(
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
        eq(taskSessionMessages.runId, prompt.runId),
        eq(taskSessionMessages.id, assistantMessageId),
        eq(taskSessionMessages.type, "assistant"),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row) reject("ACP live projection is missing its assistant message");
  return row;
}

export async function readRunStreamPartProjection(
  transaction: TaskSessionDbTransaction,
  prompt: TaskExecutionPromptIdentity,
  assistantMessageId: string,
  partId: string,
): Promise<RunStreamLiveEventPayload> {
  const row = await readAssistantMessageRow(transaction, prompt, assistantMessageId);
  const snapshot = runStreamAssistantMessageFromRow(row);
  const content = snapshot.data.content as unknown[];
  const part = content.findLast(
    (candidate): candidate is Record<string, unknown> & { id: string; type: string } =>
      isPlainRecord(candidate) &&
      candidate.id === partId &&
      typeof candidate.type === "string" &&
      candidate.type.length > 0,
  );
  if (!part) reject("ACP live projection is missing its updated assistant part");
  return {
    kind: "part.upsert",
    runId: prompt.runId,
    message: { ...snapshot, data: { ...snapshot.data, content: [] } },
    part,
  };
}

export async function readRunStreamMessageSnapshot(
  transaction: TaskSessionDbTransaction,
  prompt: TaskExecutionPromptIdentity,
  assistantMessageId: string,
): Promise<RunStreamLiveEventPayload> {
  const row = await readAssistantMessageRow(transaction, prompt, assistantMessageId);
  return {
    kind: "message.snapshot",
    runId: prompt.runId,
    message: runStreamAssistantMessageFromRow(row),
  };
}
