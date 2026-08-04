import { describe, expect, it } from "vitest";
import { activityService } from "../services/activity.ts";
import { createMockDb } from "./helpers/mock-db.js";

describe("activity service", () => {
  it("returns the ordered activity projection and applies the requested limit", async () => {
    const newest = {
      id: "activity-newest",
      companyId: "company-1",
      actorType: "system" as const,
      actorId: "system",
      action: "test.newest",
      entityType: "company",
      entityId: "company-1",
      createdAt: new Date("2026-04-21T12:00:00.000Z"),
    };
    const middle = {
      ...newest,
      id: "activity-middle",
      action: "test.middle",
      createdAt: new Date("2026-04-21T11:00:00.000Z"),
    };
    const { db, calls } = createMockDb({
      select: [[
        { activityLog: newest },
        { activityLog: middle },
      ]],
    });

    const result = await activityService(db).list({
      companyId: "company-1",
      limit: 2,
    });

    expect(result).toEqual([newest, middle]);
    expect(calls.find((call) => call.method === "limit")?.args).toEqual([2]);
    expect(calls.map((call) => call.method)).toContain("orderBy");
  });
});
