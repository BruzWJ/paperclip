import { issueSessionContextEpochs, type Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { IssueSessionInvariantError } from "./store.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function resetIssueSessionContext(
  transaction: Transaction,
  scope: { companyId: string; issueId: string; sessionId: string },
): Promise<number> {
  const rows = await transaction
    .insert(issueSessionContextEpochs)
    .values({
      companyId: scope.companyId,
      issueId: scope.issueId,
      sessionId: scope.sessionId,
      baseline: null,
      snapshot: null,
      baselineSeq: null,
      generation: 1,
    })
    .onConflictDoUpdate({
      target: issueSessionContextEpochs.sessionId,
      set: {
        baseline: null,
        snapshot: null,
        baselineSeq: null,
        generation: sql`${issueSessionContextEpochs.generation} + 1`,
      },
    })
    .returning({ generation: issueSessionContextEpochs.generation });
  const generation = rows[0]?.generation;
  if (generation === undefined) {
    throw new IssueSessionInvariantError(
      `Issue Session ${scope.sessionId} could not reset its context`,
    );
  }
  return generation;
}
