import { taskSessionContextEpochs, type Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { TaskSessionInvariantError } from "./store.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function resetTaskSessionContext(
  transaction: Transaction,
  scope: { companyId: string; taskId: string; sessionId: string },
): Promise<number> {
  const rows = await transaction
    .insert(taskSessionContextEpochs)
    .values({
      companyId: scope.companyId,
      taskId: scope.taskId,
      sessionId: scope.sessionId,
      baseline: null,
      snapshot: null,
      baselineSeq: null,
      generation: 1,
    })
    .onConflictDoUpdate({
      target: taskSessionContextEpochs.sessionId,
      set: {
        baseline: null,
        snapshot: null,
        baselineSeq: null,
        generation: sql`${taskSessionContextEpochs.generation} + 1`,
      },
    })
    .returning({ generation: taskSessionContextEpochs.generation });
  const generation = rows[0]?.generation;
  if (generation === undefined) {
    throw new TaskSessionInvariantError(
      `Task Session ${scope.sessionId} could not reset its context`,
    );
  }
  return generation;
}
