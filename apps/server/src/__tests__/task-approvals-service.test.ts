import { describe, expect, it } from "vitest";
import { taskApprovalService } from "../services/task-approvals.js";
import { createMockDb } from "./helpers/mock-db.js";

describe("task approval service identity contracts", () => {
  it("rejects a noncanonical approval UUID before database access", async () => {
    const harness = createMockDb();
    const service = taskApprovalService(harness.db);

    await expect(service.unlink(
      "11111111-1111-4111-8111-111111111111",
      "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
    )).rejects.toMatchObject({ status: 404 });
    expect(harness.calls).toEqual([]);
  });
});
