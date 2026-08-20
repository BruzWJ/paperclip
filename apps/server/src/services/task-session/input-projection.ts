import {
  taskSessionInputDispositions,
  taskSessionInputs,
  taskSessionMessages,
  type Db,
} from "@paperclipai/db";
import { encodeTaskSessionEvent, type DurableEvent } from "@paperclipai/shared/task-session";
import { and, eq, isNull } from "drizzle-orm";
import {
  canonicalTaskSessionJson,
  TaskSessionInvariantError,
  TaskSessionLifecycleConflict,
} from "./store.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface TaskSessionInputBinding {
  sourceRefId: string | null;
  dispositionId: string;
}

function promptProjection(event: DurableEvent) {
  if (event.type !== "session.next.prompt.admitted" && event.type !== "session.next.prompted") {
    throw new TaskSessionLifecycleConflict("Task Session input projection requires a prompt event", {
      eventType: event.type,
    });
  }
  if (!event.durable) {
    throw new TaskSessionLifecycleConflict("Task Session prompt event has no durable sequence", {
      eventType: event.type,
    });
  }
  const wire = encodeTaskSessionEvent(event);
  const data = wire.data as {
    messageID: string;
    sessionID: string;
    timestamp: number;
    prompt: Record<string, unknown>;
  };
  return {
    id: data.messageID,
    sessionId: data.sessionID,
    prompt: data.prompt,
    timestamp: new Date(data.timestamp),
    seq: event.durable.seq,
  };
}

function sameInput(
  row: typeof taskSessionInputs.$inferSelect,
  input: ReturnType<typeof promptProjection>,
): boolean {
  return (
    row.id === input.id &&
    row.sessionId === input.sessionId &&
    canonicalTaskSessionJson(row.prompt) === canonicalTaskSessionJson(input.prompt) &&
    row.timeCreated.getTime() === input.timestamp.getTime()
  );
}

async function insertDisposition(
  transaction: Transaction,
  input: ReturnType<typeof promptProjection>,
  binding: TaskSessionInputBinding | undefined,
  scope: { companyId: string; taskId: string },
): Promise<void> {
  if (!binding) {
    throw new TaskSessionLifecycleConflict(
      "A new Task Session input requires its Paperclip correlation binding",
      { sessionId: input.sessionId, inputId: input.id },
    );
  }
  await transaction.insert(taskSessionInputDispositions).values({
    id: binding.dispositionId,
    companyId: scope.companyId,
    taskId: scope.taskId,
    sessionId: input.sessionId,
    inputId: input.id,
    sourceRefId: binding.sourceRefId,
    state: "active",
  });
}

/** Applies one durable prompt lifecycle event to the physical input inbox. */
export async function projectTaskSessionInput(
  transaction: Transaction,
  input: {
    event: DurableEvent;
    companyId: string;
    taskId: string;
    binding?: TaskSessionInputBinding;
    rebuilding: boolean;
  },
): Promise<void> {
  const projection = promptProjection(input.event);
  const existingRows = await transaction
    .select()
    .from(taskSessionInputs)
    .where(
      and(
        eq(taskSessionInputs.companyId, input.companyId),
        eq(taskSessionInputs.taskId, input.taskId),
        eq(taskSessionInputs.sessionId, projection.sessionId),
        eq(taskSessionInputs.id, projection.id),
      ),
    )
    .limit(1);
  const existing = existingRows[0];

  if (input.event.type === "session.next.prompt.admitted") {
    const messages = await transaction
      .select({ id: taskSessionMessages.id })
      .from(taskSessionMessages)
      .where(
        and(
          eq(taskSessionMessages.sessionId, projection.sessionId),
          eq(taskSessionMessages.id, projection.id),
        ),
      )
      .limit(1);
    if (messages[0]) {
      throw new TaskSessionLifecycleConflict("Prompt admission reused a projected message identity", {
        inputId: projection.id,
      });
    }
    if (existing) {
      if (
        !sameInput(existing, projection) ||
        existing.admittedSeq !== projection.seq ||
        existing.promotedSeq !== null
      ) {
        throw new TaskSessionLifecycleConflict("Prompt admission changed an existing Task Session input", {
          inputId: projection.id,
        });
      }
      return;
    }
    if (input.rebuilding) {
      throw new TaskSessionInvariantError(`Rebuild is missing admitted Task Session input ${projection.id}`);
    }
    const inserted = await transaction
      .insert(taskSessionInputs)
      .values({
        id: projection.id,
        companyId: input.companyId,
        taskId: input.taskId,
        sessionId: projection.sessionId,
        prompt: projection.prompt,
        admittedSeq: projection.seq,
        promotedSeq: null,
        timeCreated: projection.timestamp,
      })
      .returning({ id: taskSessionInputs.id });
    if (!inserted[0]) {
      throw new TaskSessionInvariantError(`Task Session input ${projection.id} was not admitted`);
    }
    await insertDisposition(transaction, projection, input.binding, input);
    return;
  }

  if (existing) {
    if (!sameInput(existing, projection)) {
      throw new TaskSessionLifecycleConflict("Prompt promotion changed an existing Task Session input", {
        inputId: projection.id,
      });
    }
    if (existing.promotedSeq === projection.seq) return;
    if (existing.promotedSeq !== null) {
      throw new TaskSessionLifecycleConflict("Task Session input was promoted at a different sequence", {
        inputId: projection.id,
      });
    }
    const updated = await transaction
      .update(taskSessionInputs)
      .set({ promotedSeq: projection.seq })
      .where(and(eq(taskSessionInputs.id, projection.id), isNull(taskSessionInputs.promotedSeq)))
      .returning({ id: taskSessionInputs.id });
    if (!updated[0]) {
      throw new TaskSessionLifecycleConflict("Task Session input promotion lost its lifecycle race", {
        inputId: projection.id,
      });
    }
    return;
  }

  const inserted = await transaction
    .insert(taskSessionInputs)
    .values({
      id: projection.id,
      companyId: input.companyId,
      taskId: input.taskId,
      sessionId: projection.sessionId,
      prompt: projection.prompt,
      admittedSeq: projection.seq,
      promotedSeq: projection.seq,
      timeCreated: projection.timestamp,
    })
    .returning({ id: taskSessionInputs.id });
  if (!inserted[0]) {
    throw new TaskSessionInvariantError(`Task Session input ${projection.id} was not promoted`);
  }
  await insertDisposition(transaction, projection, input.binding, input);
}
