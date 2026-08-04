import { describe, expect, it } from "vitest";
import { instanceUserRoles } from "@paperclipai/db";
import { claimFirstInstanceAdmin } from "../first-admin-claim.js";
import { createMockDb } from "./helpers/mock-db.js";

describe("claimFirstInstanceAdmin", () => {
  it("locks, checks, and inserts when no instance admin exists", async () => {
    const { db, calls } = createMockDb({
      execute: [[]],
      select: [[]],
      insert: [[]],
    });

    const result = await claimFirstInstanceAdmin(db, { userId: "user-first" });

    expect(result).toEqual({
      status: "claimed",
      userId: "user-first",
      value: null,
    });
    expect(calls.map(({ operation, method }) => `${operation}.${method}`)).toEqual([
      "execute.execute",
      "select.select",
      "select.from",
      "select.where",
      "insert.insert",
      "insert.values",
    ]);
    expect(calls.find((call) => call.method === "values")?.args).toEqual([
      { userId: "user-first", role: "instance_admin" },
    ]);
  });

  it("reports the existing admin without inserting", async () => {
    const { db, calls } = createMockDb({
      execute: [[]],
      select: [[{ userId: "user-first" }]],
    });

    const result = await claimFirstInstanceAdmin(db, { userId: "user-second" });

    expect(result).toEqual({
      status: "already_claimed",
      existingUserId: "user-first",
      value: null,
    });
    expect(calls.some((call) => call.operation === "insert")).toBe(false);
  });

  it("runs onClaim after the winning insert in the same transaction", async () => {
    const { db, calls } = createMockDb({
      execute: [[]],
      select: [[], [{ userId: "user-first" }]],
      insert: [[]],
    });
    const result = await claimFirstInstanceAdmin(db, {
      userId: "user-first",
      onClaim: async (tx) => {
        const roles = await tx.select().from(instanceUserRoles);
        return roles.map((role) => role.userId);
      },
    });

    expect(result).toEqual({
      status: "claimed",
      userId: "user-first",
      value: ["user-first"],
    });
    const methods = calls.map(({ operation, method }) => `${operation}.${method}`);
    expect(methods.indexOf("insert.values")).toBeLessThan(
      methods.lastIndexOf("select.select"),
    );
  });
});
