import { taskBoardLifecycleCommands, type TaskBoardLifecycleCommand } from "@paperclipai/db";
import type { TaskBoardLifecycleCommandSubtype } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

export interface NamedBoardLifecycleAffectedTask {
  readonly id: string;
  readonly ownershipEpoch: number;
}

export interface RecordNamedBoardLifecycleCommandInput {
  readonly companyId: string;
  readonly affectedTasks: readonly NamedBoardLifecycleAffectedTask[];
  readonly actorUserId: string;
  readonly subtype: TaskBoardLifecycleCommandSubtype;
  readonly sourceCommandId: string;
  readonly idempotencyKey: string;
  readonly committedAt: Date;
}

function sameInstant(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime();
}

function assertExistingCommand(
  row: TaskBoardLifecycleCommand,
  input: RecordNamedBoardLifecycleCommandInput,
  task: NamedBoardLifecycleAffectedTask,
): void {
  if (
    row.companyId !== input.companyId ||
    row.taskId !== task.id ||
    row.ownershipEpoch !== task.ownershipEpoch ||
    row.actorUserId !== input.actorUserId ||
    row.subtype !== input.subtype ||
    row.sourceCommandId !== input.sourceCommandId ||
    row.idempotencyKey !== input.idempotencyKey ||
    !sameInstant(row.committedAt, input.committedAt)
  ) {
    throw new Error("Board lifecycle command source was retried with different immutable facts");
  }
}

/**
 * Appends one typed liveness source for every task actually mutated by one
 * directly authenticated named-user board command. Callers derive every
 * field from locked domain rows; request payloads never choose a subtype,
 * source id, epoch, or commit time.
 */
export async function recordNamedBoardLifecycleCommandInTransaction(
  tx: TaskSessionDbTransaction,
  input: RecordNamedBoardLifecycleCommandInput,
): Promise<readonly TaskBoardLifecycleCommand[]> {
  const affectedById = new Map<string, NamedBoardLifecycleAffectedTask>();
  for (const task of input.affectedTasks) {
    const previous = affectedById.get(task.id);
    if (previous && previous.ownershipEpoch !== task.ownershipEpoch) {
      throw new Error("One board lifecycle command cannot target two epochs of one task");
    }
    affectedById.set(task.id, task);
  }

  const rows: TaskBoardLifecycleCommand[] = [];
  for (const task of [...affectedById.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    const existing = await tx
      .select()
      .from(taskBoardLifecycleCommands)
      .where(
        and(
          eq(taskBoardLifecycleCommands.companyId, input.companyId),
          eq(taskBoardLifecycleCommands.taskId, task.id),
          eq(taskBoardLifecycleCommands.sourceCommandId, input.sourceCommandId),
        ),
      )
      .limit(1)
      .then((found) => found[0] ?? null);

    const row =
      existing ??
      (await tx
        .insert(taskBoardLifecycleCommands)
        .values({
          companyId: input.companyId,
          taskId: task.id,
          ownershipEpoch: task.ownershipEpoch,
          actorUserId: input.actorUserId,
          subtype: input.subtype,
          sourceCommandId: input.sourceCommandId,
          idempotencyKey: input.idempotencyKey,
          committedAt: input.committedAt,
        })
        .returning()
        .then((inserted) => inserted[0] ?? null));
    if (!row) {
      throw new Error("Board lifecycle command source was not persisted");
    }
    assertExistingCommand(row, input, task);
    rows.push(row);
  }
  return rows;
}
