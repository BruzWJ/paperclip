import { and, eq } from "drizzle-orm";
import { localExecutionLeases, type Db } from "@paperclipai/db";

export type LocalRunLeaseStatus = "active" | "released" | "failed";

export interface LocalRunLease {
  readonly id: string;
  readonly companyId: string;
  readonly executionWorkspaceId: string;
  readonly issueId: string;
  readonly runId: string;
  readonly status: LocalRunLeaseStatus;
  readonly acquiredAt: Date;
  readonly lastUsedAt: Date;
  readonly releasedAt: Date | null;
  readonly failureReason: string | null;
  readonly updatedAt: Date;
}

type LocalRunLeaseRow = typeof localExecutionLeases.$inferSelect;

function toLocalRunLease(row: LocalRunLeaseRow): LocalRunLease {
  if (
    row.status !== "active" &&
    row.status !== "released" &&
    row.status !== "failed"
  ) {
    throw new Error(`Unexpected local run lease status: ${row.status}`);
  }
  return {
    id: row.id,
    companyId: row.companyId,
    executionWorkspaceId: row.executionWorkspaceId,
    issueId: row.issueId,
    runId: row.runId,
    status: row.status,
    acquiredAt: row.acquiredAt,
    lastUsedAt: row.lastUsedAt,
    releasedAt: row.releasedAt ?? null,
    failureReason: row.failureReason ?? null,
    updatedAt: row.updatedAt,
  };
}

export interface LocalRunLeaseRecord {
  readonly lease: LocalRunLease;
}

/**
 * Persist one lease for each local provider run. The durable row is also the
 * company-purge fence proving that no local provider process is still active.
 */
export function localRunLeaseService(db: Db) {
  return {
    async acquireRunLease(input: {
      companyId: string;
      executionWorkspaceId: string;
      issueId: string;
      runId: string;
    }): Promise<LocalRunLeaseRecord> {
      const now = new Date();
      const row = await db
        .insert(localExecutionLeases)
        .values({
          companyId: input.companyId,
          executionWorkspaceId: input.executionWorkspaceId,
          issueId: input.issueId,
          runId: input.runId,
          status: "active",
          acquiredAt: now,
          lastUsedAt: now,
          releasedAt: null,
          failureReason: null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            localExecutionLeases.companyId,
            localExecutionLeases.runId,
          ],
          set: {
            executionWorkspaceId: input.executionWorkspaceId,
            issueId: input.issueId,
            status: "active",
            acquiredAt: now,
            lastUsedAt: now,
            releasedAt: null,
            failureReason: null,
            updatedAt: now,
          },
        })
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!row) throw new Error("Failed to acquire local run lease");
      return {
        lease: toLocalRunLease(row),
      };
    },

    async releaseRunLeases(input: {
      companyId: string;
      runId: string;
      status?: Extract<LocalRunLeaseStatus, "released" | "failed">;
      failureReason?: string;
    }): Promise<LocalRunLeaseRecord[]> {
      const now = new Date();
      const status = input.status ?? "released";
      const rows = await db
        .update(localExecutionLeases)
        .set({
          status,
          releasedAt: now,
          lastUsedAt: now,
          updatedAt: now,
          failureReason:
            status === "failed"
              ? input.failureReason ?? "provider execution failed"
              : null,
        })
        .where(
          and(
            eq(localExecutionLeases.companyId, input.companyId),
            eq(localExecutionLeases.runId, input.runId),
            eq(localExecutionLeases.status, "active"),
          ),
        )
        .returning();

      return rows.map((row) => ({ lease: toLocalRunLease(row) }));
    },
  };
}

export type LocalRunLeaseService = ReturnType<typeof localRunLeaseService>;
