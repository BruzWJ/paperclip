import { readFileSync } from "node:fs";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { denyGenericAgentRest } from "../routes/compiled-interface-only.js";
import {
  issueRoutes,
  requireNamedBoardUser,
} from "../routes/issues.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";

type TestActor = Express.Request["actor"];

function agentActor(): TestActor {
  return {
    type: "agent",
    agentId,
    companyId,
    runId: "44444444-4444-4444-8444-444444444444",
    source: "internal",
  };
}

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

function createGuardApp(actor: TestActor, surface: "issue" | "activity") {
  const app = express();
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use(denyGenericAgentRest(surface));
  app.use((_req, res) => res.status(204).end());
  return app;
}

function createIssueRouteApp(actor: TestActor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", denyGenericAgentRest("issue"));
  app.use(
    "/api",
    issueRoutes({} as never, {} as never, {
      ordinaryIssues: {} as never,
    }),
  );
  app.use((
    error: { status?: number; message?: string; code?: string },
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    res.status(error.status ?? 500).json({
      error: error.message ?? "Request failed",
      code: error.code,
    });
  });
  return app;
}

describe("canonical generic issue and activity route surface", () => {
  it.each(["issue", "activity"] as const)(
    "denies agent credentials before generic %s access",
    async (surface) => {
      const response = await request(createGuardApp(agentActor(), surface))
        .get("/api/anything")
        .expect(403);

      expect(response.body).toMatchObject({
        code: "compiled_run_interface_required",
      });
    },
  );

  it.each([
    ["put", "/api/issues/issue-1/execution-policy", {
      executionPolicy: null,
    }],
    ["post", "/api/issues/issue-1/execution-policy/decisions", {
      outcome: "approved",
      body: "Approved",
      idempotencyKey: "decision-1",
    }],
  ] as const)(
    "denies agent credentials on the execution-policy %s surface",
    async (method, path, body) => {
      const response = await request(createIssueRouteApp(agentActor()))
        [method](path)
        .send(body)
        .expect(403);
      expect(response.body).toMatchObject({
        code: "compiled_run_interface_required",
      });
    },
  );

  it("requires a named board identity for execution-policy control", () => {
    expect(() =>
      requireNamedBoardUser({
        actor: {
          ...boardActor(),
          userId: "",
        },
      } as express.Request),
    ).toThrow("authenticated named board user");
    expect(
      requireNamedBoardUser({
        actor: boardActor(),
      } as express.Request),
    ).toBe("board-user");
  });

  it.each(["issue", "activity"] as const)(
    "allows board requests through the generic %s guard",
    async (surface) => {
      await request(createGuardApp(boardActor(), surface))
        .get("/api/anything")
        .expect(204);
    },
  );

  it("registers the canonical mutations and omits retired issue routes", () => {
    const source = readFileSync(
      new URL("../routes/issues.ts", import.meta.url),
      "utf8",
    );
    const openApi = readFileSync(
      new URL("../routes/openapi.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain(
      'router.patch("/issues/:id", validate(updateIssueTitleSchema)',
    );
    expect(source).toContain(
      'router.post("/issues/:id/reassign", validate(reassignIssueSchema)',
    );
    expect(source).toContain('"/issues/:id/creator-reassign",');
    expect(source).toContain(
      '"/issues/:id/withdrawal-self-assignment",',
    );
    expect(source).toContain('"/issue-creator-form-updates",');
    expect(source).toContain('"/issue-owner-form-updates",');
    expect(source).toContain(
      'router.post("/issues/:id/reopen", validate(reopenIssueSchema)',
    );
    expect(source).toContain(
      '"/issues/:id/execution-policy",',
    );
    expect(source).toContain(
      '"/issues/:id/execution-policy/decisions",',
    );
    expect(source).toContain(
      "const actorUserId = requireNamedBoardUser(req);",
    );
    expect(source).toContain(
      '"/issues/:id/comments",\n    validate(createIssueUserCommentSchema)',
    );
    expect(openApi).toContain("/api/issues/{id}/execution-policy");
    expect(openApi).toContain(
      "/api/issues/{id}/execution-policy/decisions",
    );
    expect(openApi).toContain("/api/issues/{id}/creator-reassign");
    expect(openApi).toContain(
      "/api/issues/{id}/withdrawal-self-assignment",
    );
    expect(openApi).toContain("/api/issue-creator-form-updates");
    expect(openApi).toContain("/api/issue-owner-form-updates");
    expect(source).toContain("ordinaryIssues: OrdinaryIssueRuntime;");
    expect(source).not.toContain(
      "createOrdinaryIssueRuntime(db)",
    );
    expect(source).not.toContain(
      "new Proxy({} as OrdinaryIssueRuntime",
    );

    for (const retired of [
      'router.delete("/issues/:id"',
      '"/issues/:id/checkout"',
      '"/issues/:id/release"',
      '"/issues/:id/admin/force-release"',
    ]) {
      expect(source).not.toContain(retired);
    }
    for (const retired of [
      "/api/issues/{id}/checkout",
      "/api/issues/{id}/release",
      "/api/issues/{id}/admin/force-release",
    ]) {
      expect(openApi).not.toContain(retired);
    }
  });
});
