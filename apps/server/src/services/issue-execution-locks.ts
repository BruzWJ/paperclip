import {
  companies,
  issueExecutionRefs,
  issueSessions,
  issues,
  type Db,
} from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type RefRow = typeof issueExecutionRefs.$inferSelect;

/**
 * Lock the immutable company -> issue -> Session parents before the ref so
 * canonical admission, lifecycle cancellation, and hard delete share one
 * deterministic lock order.
 */
export async function lockIssueExecutionRefParentFirst(
  transaction: Transaction,
  refId: string,
  options: {
    issueLock?: "share" | "update";
    sessionLock?: "share" | "update";
  } = {},
): Promise<RefRow | null> {
  const candidate = await transaction
    .select()
    .from(issueExecutionRefs)
    .where(eq(issueExecutionRefs.id, refId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!candidate) return null;

  await transaction.execute(
    sql`select ${companies.id}
      from ${companies}
      where ${companies.id} = ${candidate.companyId}
      for share`,
  );
  if (options.issueLock === "update") {
    await transaction.execute(
      sql`select ${issues.id}
        from ${issues}
        where ${issues.companyId} = ${candidate.companyId}
          and ${issues.id} = ${candidate.issueId}
        for update`,
    );
  } else {
    await transaction.execute(
      sql`select ${issues.id}
        from ${issues}
        where ${issues.companyId} = ${candidate.companyId}
          and ${issues.id} = ${candidate.issueId}
        for share`,
    );
  }
  if (options.sessionLock === "update") {
    await transaction.execute(
      sql`select ${issueSessions.id}
        from ${issueSessions}
        where ${issueSessions.companyId} = ${candidate.companyId}
          and ${issueSessions.issueId} = ${candidate.issueId}
          and ${issueSessions.id} = ${candidate.sessionId}
        for update`,
    );
  } else {
    await transaction.execute(
      sql`select ${issueSessions.id}
        from ${issueSessions}
        where ${issueSessions.companyId} = ${candidate.companyId}
          and ${issueSessions.issueId} = ${candidate.issueId}
          and ${issueSessions.id} = ${candidate.sessionId}
        for share`,
    );
  }

  const locked = await transaction
    .select()
    .from(issueExecutionRefs)
    .where(eq(issueExecutionRefs.id, refId))
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (
    locked &&
    (locked.companyId !== candidate.companyId ||
      locked.issueId !== candidate.issueId ||
      locked.sessionId !== candidate.sessionId)
  ) {
    throw new Error(
      "Issue-execution ref changed its immutable parent scope while locking",
    );
  }
  return locked;
}
