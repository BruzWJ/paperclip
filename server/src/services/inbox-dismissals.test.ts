import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { inboxDismissalService } from "./inbox-dismissals.js";

describe("agent-liveness inbox suppression boundary", () => {
  const service = inboxDismissalService({} as Db);
  const key =
    "attention:agent-liveness:issue-1:1:finalization-1";

  it("rejects dismiss, snooze, and restore before touching persistence", async () => {
    await expect(
      service.dismiss("company-1", "user-1", key),
    ).rejects.toThrow(/remain until an explicit issue action/i);
    await expect(
      service.snooze(
        "company-1",
        "user-1",
        key,
        new Date("2099-01-01T00:00:00.000Z"),
      ),
    ).rejects.toThrow(/remain until an explicit issue action/i);
    await expect(
      service.restore("company-1", "user-1", key),
    ).rejects.toThrow(/remain until an explicit issue action/i);
  });
});
