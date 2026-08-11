import { describe, expect, it, vi } from "vitest";
import { taskTreeControlService } from "../services/task-tree-control.js";

function emptySelectDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve([])),
        })),
      })),
    })),
  };
}

describe("taskTreeControlService unit guards", () => {
  it("rejects cross-company roots before traversing descendants", async () => {
    const db = emptySelectDb();
    const svc = taskTreeControlService(db as any);

    await expect(svc.preview("company-2", "task-from-company-1", { mode: "pause" })).rejects.toMatchObject({
      status: 404,
    });
    expect(db.select).toHaveBeenCalledTimes(1);
  });
});
