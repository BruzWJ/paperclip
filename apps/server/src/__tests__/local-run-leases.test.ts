import { describe, expect, it } from "vitest";
import { localRunLeaseService } from "../services/local-run-leases.js";
import { createMockDb } from "./helpers/mock-db.js";

const now = new Date("2026-08-09T12:00:00.000Z");

function leaseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "lease-1",
    companyId: "company-1",
    executionWorkspaceId: "workspace-1",
    taskId: "task-1",
    runId: "run-1",
    status: "active",
    acquiredAt: now,
    lastUsedAt: now,
    releasedAt: null,
    failureReason: null,
    updatedAt: now,
    ...overrides,
  };
}

describe("localRunLeaseService", () => {
  it("creates a per-run lease for the exact persisted workspace", async () => {
    const active = leaseRow();
    const db = createMockDb({ insert: [[active]] });

    await expect(localRunLeaseService(db.db).acquireRunLease({
      companyId: "company-1",
      executionWorkspaceId: "workspace-1",
      taskId: "task-1",
      runId: "run-1",
    })).resolves.toEqual({
      lease: active,
    });
  });

  it("releases only active leases for the exact run with failure details", async () => {
    const failed = leaseRow({
      status: "failed",
      releasedAt: now,
      failureReason: "provider failed",
    });
    const db = createMockDb({ update: [[failed]] });

    await expect(
      localRunLeaseService(db.db).releaseRunLeases(
        {
          companyId: "company-1",
          runId: "run-1",
          status: "failed",
          failureReason: "provider failed",
        },
      ),
    ).resolves.toEqual([{ lease: failed }]);
  });
});
