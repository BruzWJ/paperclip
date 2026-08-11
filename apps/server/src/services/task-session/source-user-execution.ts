import { taskSessionSourceUserExecutions } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import type { TaskSessionDbTransaction } from "./event-store.js";
import { TaskSessionLifecycleConflict } from "./store.js";

/**
 * The model/agent that produced an ordinary user-shaped boundary is immutable
 * provenance.  Several writers can retry the same durable boundary, but none
 * may silently replace that provenance with data inferred from a later turn.
 */
export interface TaskSessionSourceUserExecutionInput {
  companyId: string;
  taskId: string;
  sessionId: string;
  messageId: string;
  sourceAgentId: string;
  providerId: string;
  modelId: string;
  variant: string | null;
  createdAt?: Date;
}

export async function insertOrAssertTaskSessionSourceUserExecution(
  transaction: TaskSessionDbTransaction,
  input: TaskSessionSourceUserExecutionInput,
): Promise<typeof taskSessionSourceUserExecutions.$inferSelect> {
  await transaction
    .insert(taskSessionSourceUserExecutions)
    .values({
      companyId: input.companyId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      messageId: input.messageId,
      sourceAgentId: input.sourceAgentId,
      providerId: input.providerId,
      modelId: input.modelId,
      variant: input.variant,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    })
    .onConflictDoNothing();

  const existing = await transaction
    .select()
    .from(taskSessionSourceUserExecutions)
    .where(eq(taskSessionSourceUserExecutions.messageId, input.messageId))
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!existing) {
    throw new TaskSessionLifecycleConflict(
      "Task Session source-user execution was not durable after insertion",
      { messageId: input.messageId },
    );
  }
  if (
    existing.companyId !== input.companyId ||
    existing.taskId !== input.taskId ||
    existing.sessionId !== input.sessionId ||
    existing.messageId !== input.messageId ||
    existing.sourceAgentId !== input.sourceAgentId ||
    existing.providerId !== input.providerId ||
    existing.modelId !== input.modelId ||
    existing.variant !== input.variant
  ) {
    throw new TaskSessionLifecycleConflict(
      "Task Session source-user execution retry diverges from immutable provenance",
      {
        messageId: input.messageId,
        existing: {
          companyId: existing.companyId,
          taskId: existing.taskId,
          sessionId: existing.sessionId,
          sourceAgentId: existing.sourceAgentId,
          providerId: existing.providerId,
          modelId: existing.modelId,
          variant: existing.variant,
        },
        attempted: {
          companyId: input.companyId,
          taskId: input.taskId,
          sessionId: input.sessionId,
          sourceAgentId: input.sourceAgentId,
          providerId: input.providerId,
          modelId: input.modelId,
          variant: input.variant,
        },
      },
    );
  }
  return existing;
}
