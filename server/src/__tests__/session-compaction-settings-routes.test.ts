import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { sessionCompactionRoutes } from "../routes/session-compactions.js";
import {
  SessionCompactionConflict,
  type PostgresIssueSessionCompactionRuntime,
} from "../services/issue-session-compaction-postgres.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const companyId = "00000000-0000-4000-8000-000000000001";
const otherCompanyId = "00000000-0000-4000-8000-000000000002";
const runtime = {
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
} as unknown as PostgresIssueSessionCompactionRuntime;

function actorFor(value: string | undefined): Express.Request["actor"] {
  if (value === "none") return { type: "none", source: "none" };
  if (value === "agent") {
    return {
      type: "agent",
      source: "internal",
      agentId: "00000000-0000-4000-8000-000000000003",
      companyId,
      runId: null,
    };
  }
  if (value === "cross-company") {
    return testBoardSessionActor({
      userId: "cross-company-user",
      companyIds: [otherCompanyId],
    });
  }
  return testBoardSessionActor({
    userId: "board-user",
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "operator", status: "active" }],
  });
}

function app() {
  const expressApp = express();
  expressApp.use(express.json());
  expressApp.use((req, _res, next) => {
    req.actor = actorFor(req.header("x-test-actor") ?? undefined);
    next();
  });
  expressApp.use(
    "/api",
    sessionCompactionRoutes({} as Db, runtime),
  );
  expressApp.use(errorHandler);
  return expressApp;
}

describe("session compaction settings routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps GET and full PATCH documents sparse and exact", async () => {
    const server = app();
    const sparse = {
      reserved: 0,
      tail_turns: 0,
      preserve_recent_tokens: 0,
    };
    vi.mocked(runtime.getSettings)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(sparse);
    vi.mocked(runtime.updateSettings)
      .mockResolvedValueOnce({ previous: {}, current: sparse })
      .mockResolvedValueOnce({ previous: sparse, current: {} });

    await request(server)
      .get(`/api/companies/${companyId}/session-compaction-settings`)
      .expect(200, {});
    await request(server)
      .patch(`/api/companies/${companyId}/session-compaction-settings`)
      .send(sparse)
      .expect(200, sparse);
    await request(server)
      .get(`/api/companies/${companyId}/session-compaction-settings`)
      .expect(200, sparse);
    await request(server)
      .patch(`/api/companies/${companyId}/session-compaction-settings`)
      .send({})
      .expect(200, {});

    expect(runtime.updateSettings).toHaveBeenNthCalledWith(
      1,
      companyId,
      sparse,
      { actorType: "user", actorId: "board-user" },
    );
    expect(runtime.updateSettings).toHaveBeenNthCalledWith(
      2,
      companyId,
      {},
      { actorType: "user", actorId: "board-user" },
    );
  });

  it("rejects invalid documents before a settings write", async () => {
    const server = app();

    await request(server)
      .patch(`/api/companies/${companyId}/session-compaction-settings`)
      .send({ reserved: -1 })
      .expect(400);
    await request(server)
      .patch(`/api/companies/${companyId}/session-compaction-settings`)
      .send({ unknown: true })
      .expect(400);

    expect(runtime.updateSettings).not.toHaveBeenCalled();
  });

  it("requires an authorized board actor and prevents cross-company mutation", async () => {
    const server = app();
    for (const actor of ["none", "agent", "cross-company"]) {
      await request(server)
        .patch(`/api/companies/${companyId}/session-compaction-settings`)
        .set("x-test-actor", actor)
        .send({ auto: false })
        .expect(403);
    }
    expect(runtime.updateSettings).not.toHaveBeenCalled();
  });

  it("maps runtime model conflicts and forwards the exact accepted model selection", async () => {
    vi.mocked(runtime.updateSettings).mockImplementation(async (_companyId, patch) => {
      if (patch.modelRef === "unavailable/model") {
        throw new SessionCompactionConflict("Model is not available");
      }
      return { previous: {}, current: patch };
    });
    const server = app();

    await request(server)
      .patch(`/api/companies/${companyId}/session-compaction-settings`)
      .send({ modelRef: "unavailable/model" })
      .expect(409);
    await request(server)
      .patch(`/api/companies/${companyId}/session-compaction-settings`)
      .send({ modelRef: "available/model" })
      .expect(200, { modelRef: "available/model" });

    expect(runtime.updateSettings).toHaveBeenNthCalledWith(
      2,
      companyId,
      { modelRef: "available/model" },
      { actorType: "user", actorId: "board-user" },
    );
  });
});
