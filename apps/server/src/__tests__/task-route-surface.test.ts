import { readFileSync } from "node:fs";
import express from "express";
import { describe, expect, it } from "vitest";
import {
  requireNamedBoardUser,
} from "../routes/tasks.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const companyId = "22222222-2222-4222-8222-222222222222";

type TestActor = Express.Request["actor"];

function boardActor(): TestActor {
  return testBoardSessionActor({
    userId: "board-user",
    companyIds: [companyId],
    memberships: [
      {
        companyId,
        membershipRole: "owner",
        status: "active",
      },
    ],
    sessionId: "session-board-user",
    userName: "Board User",
    userEmail: "board-user@example.com",
    isInstanceAdmin: false,
  });
}

describe("canonical generic task and activity route surface", () => {
  it("requires a named board identity for execution-policy control", () => {
    expect(() =>
      requireNamedBoardUser({
        actor: {
          ...boardActor(),
          userId: "",
        },
      } as express.Request),
    ).toThrow("exact authenticated board user ID");
    expect(
      requireNamedBoardUser({
        actor: boardActor(),
      } as express.Request),
    ).toBe("board-user");
  });

  it("registers the canonical mutations and omits retired task routes", () => {
    const source = readFileSync(
      new URL("../routes/tasks.ts", import.meta.url),
      "utf8",
    );
    const openApi = readFileSync(
      new URL("../routes/openapi.ts", import.meta.url),
      "utf8",
    );

    expect(source).toMatch(
      /router\.patch\(\s*"\/tasks\/:id",\s*validate\(updateTaskTitleSchema\)/,
    );
    expect(source).toMatch(
      /router\.post\(\s*"\/tasks\/:id\/reassign",\s*validate\(reassignTaskSchema\)/,
    );
    expect(source).toContain('"/tasks/:id/creator-reassign",');
    expect(source).toContain(
      '"/tasks/:id/withdrawal-self-assignment",',
    );
    expect(source).toContain('"/task-creator-form-updates",');
    expect(source).toContain('"/task-owner-form-updates",');
    expect(source).toMatch(
      /router\.post\(\s*"\/tasks\/:id\/reopen",\s*validate\(reopenTaskSchema\)/,
    );
    expect(source).toContain(
      '"/tasks/:id/execution-policy",',
    );
    expect(source).toContain(
      '"/tasks/:id/execution-policy/decisions",',
    );
    expect(source).toContain(
      "const actorUserId = requireNamedBoardUser(req);",
    );
    expect(source).toContain(
      '"/tasks/:id/comments",\n    validate(createTaskUserCommentSchema)',
    );
    expect(openApi).toContain("/api/tasks/{id}/execution-policy");
    expect(openApi).toContain(
      "/api/tasks/{id}/execution-policy/decisions",
    );
    expect(openApi).toContain("/api/tasks/{id}/creator-reassign");
    expect(openApi).toContain(
      "/api/tasks/{id}/withdrawal-self-assignment",
    );
    expect(openApi).toContain("/api/task-creator-form-updates");
    expect(openApi).toContain("/api/task-owner-form-updates");
    expect(source).toContain("ordinaryTasks: OrdinaryTaskRuntime;");
    expect(source).not.toContain(
      "createOrdinaryTaskRuntime(db)",
    );
    expect(source).not.toContain(
      "new Proxy({} as OrdinaryTaskRuntime",
    );

    for (const retired of [
      'router.delete("/tasks/:id"',
      '"/tasks/:id/checkout"',
      '"/tasks/:id/release"',
      '"/tasks/:id/admin/force-release"',
    ]) {
      expect(source).not.toContain(retired);
    }
    for (const retired of [
      "/api/tasks/{id}/checkout",
      "/api/tasks/{id}/release",
      "/api/tasks/{id}/admin/force-release",
    ]) {
      expect(openApi).not.toContain(retired);
    }
  });
});
