import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { denyGenericAgentRest } from "../routes/compiled-interface-only.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

const sourceCompanyId = "00000000-0000-4000-8000-000000000001";
const targetCompanyId = "00000000-0000-4000-8000-000000000002";
const sourceAgentId = "00000000-0000-4000-8000-000000000003";
const taskId = "00000000-0000-4000-8000-000000000004";

function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
  return {
    type: "agent",
    agentId,
    companyId,
    runId: null,
    source: "internal",
  };
}

async function createApp(actor: Express.Request["actor"]) {
  const [{ activityRoutes }, { taskRoutes }] = await Promise.all([
    import("../routes/activity.js"),
    import("../routes/tasks.js"),
  ]);
  const db = {} as Db;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", denyGenericAgentRest("REST"));
  app.use("/api", taskRoutes(db, {} as never, { ordinaryTasks: {} as never }));
  app.use("/api", activityRoutes(db));
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const error = err as { status?: number; message?: string };
    res.status(error.status ?? 500).json({ error: error.message ?? "Internal server error" });
  });
  return app;
}

describe("permissions upgrade visibility and route boundaries", () => {
  it("does not let private-agent visibility bypass the compiled interface boundary", async () => {
    const app = await createApp(agentActor(sourceCompanyId, sourceAgentId));

    const responses = await Promise.all([
      request(app).get(`/api/companies/${sourceCompanyId}/tasks`),
      request(app).get(`/api/tasks/${taskId}/comments`),
      request(app).get(`/api/tasks/${taskId}/documents`),
      request(app).get(`/api/tasks/${taskId}/documents/plan`),
      request(app).get(`/api/tasks/${taskId}/attachments`),
      request(app).get(`/api/tasks/${taskId}/activity`),
      request(app).get(`/api/tasks/${taskId}/work-products`),
    ]);

    for (const response of responses) {
      expect(response.status, JSON.stringify(response.body)).toBe(403);
      expect(response.body.error).toBe(
        "Agent credentials cannot access the generic REST API; use the run-scoped compiled interface",
      );
    }
  }, 20_000);

  it("denies generic agent REST before cross-company task lookup or grant evaluation", async () => {
    const res = await request(
      await createApp(agentActor(sourceCompanyId, sourceAgentId)),
    ).get(`/api/companies/${targetCompanyId}/tasks/${taskId}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(
      "Agent credentials cannot access the generic REST API; use the run-scoped compiled interface",
    );
  });
});
