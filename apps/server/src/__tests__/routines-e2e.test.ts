import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { routineRoutes } from "../routes/routines.js";
import { createMockDb } from "./helpers/mock-db.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  runRoutine: vi.fn(),
  firePublicTrigger: vi.fn(),
  accessDecide: vi.fn(),
  logActivity: vi.fn(),
}));

vi.mock("../services/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/index.js")>();
  return {
    ...actual,
    routineService: vi.fn(() => ({
      list: mocks.list,
      get: mocks.get,
      create: mocks.create,
      runRoutine: mocks.runRoutine,
      firePublicTrigger: mocks.firePublicTrigger,
    })),
    documentAnnotationService: vi.fn(() => ({})),
    accessService: vi.fn(() => ({ decide: mocks.accessDecide })),
    logActivity: mocks.logActivity,
  };
});

vi.mock("../telemetry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../telemetry.js")>();
  return { ...actual, getTelemetryClient: vi.fn(() => null) };
});

const companyId = "00000000-0000-4000-8000-000000000001";
const otherCompanyId = "00000000-0000-4000-8000-000000000002";
const routineId = "00000000-0000-4000-8000-000000000010";
const projectId = "00000000-0000-4000-8000-000000000020";
const agentId = "00000000-0000-4000-8000-000000000030";

function app() {
  const expressApp = express();
  expressApp.use(express.json());
  expressApp.use((req, _res, next) => {
    req.actor = req.header("x-test-company") === "other"
      ? testBoardSessionActor({ userId: "other-user", companyIds: [otherCompanyId] })
      : testBoardSessionActor({ userId: "board-user", companyIds: [companyId] });
    next();
  });
  expressApp.use("/api", routineRoutes(createMockDb().db, { ordinaryIssues: {} as never }));
  expressApp.use(errorHandler);
  return expressApp;
}

function routine(overrides: Record<string, unknown> = {}) {
  return {
    id: routineId,
    companyId,
    projectId,
    title: "Repository triage",
    description: "Review {{repo}} for bugs",
    assigneeAgentId: agentId,
    priority: "high",
    status: "active",
    latestRevisionId: null,
    latestRevisionNumber: 1,
    ...overrides,
  };
}

describe("routine routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.accessDecide.mockResolvedValue({ allowed: true, explanation: "allowed" });
    mocks.logActivity.mockResolvedValue(undefined);
  });

  it("lists company routines with the optional project boundary", async () => {
    mocks.list.mockResolvedValue([routine()]);

    const response = await request(app())
      .get(`/api/companies/${companyId}/routines`)
      .query({ projectId })
      .expect(200);

    expect(response.body).toEqual([expect.objectContaining({ id: routineId })]);
    expect(mocks.list).toHaveBeenCalledWith(companyId, { projectId });
  });

  it("creates a routine through board authorization and records the user-owned activity", async () => {
    const created = routine();
    mocks.create.mockResolvedValue(created);

    await request(app())
      .post(`/api/companies/${companyId}/routines`)
      .send({
        projectId,
        title: "Repository triage",
        description: "Review {{repo}} for bugs",
        assigneeAgentId: agentId,
        priority: "high",
        variables: [{ name: "repo", type: "text", required: true }],
      })
      .expect(201, created);

    expect(mocks.accessDecide).toHaveBeenCalledWith(expect.objectContaining({
      action: "issue:mutate",
      resource: { type: "company", companyId },
    }));
    expect(mocks.create).toHaveBeenCalledWith(companyId, expect.objectContaining({
      title: "Repository triage",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
    }), { type: "user", userId: "board-user" });
    expect(mocks.logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId,
      actorType: "user",
      actorId: "board-user",
      action: "routine.created",
      entityId: routineId,
    }));
  });

  it("rejects malformed routine input before service work", async () => {
    await request(app())
      .post(`/api/companies/${companyId}/routines`)
      .send({ title: "", priority: "impossible" })
      .expect(400);

    expect(mocks.accessDecide).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("runs an existing routine with one-off execution selections", async () => {
    mocks.get.mockResolvedValue(routine());
    mocks.runRoutine.mockResolvedValue({
      id: "run-1",
      routineId,
      source: "manual",
      status: "issue_created",
      linkedIssueId: "issue-1",
    });

    const response = await request(app())
      .post(`/api/routines/${routineId}/run`)
      .send({
        source: "manual",
        variables: { repo: "paperclip" },
        projectId,
        assigneeAgentId: agentId,
      })
      .expect(202);

    expect(response.body).toMatchObject({ status: "issue_created", linkedIssueId: "issue-1" });
    expect(mocks.runRoutine).toHaveBeenCalledWith(routineId, expect.objectContaining({
      source: "manual",
      variables: { repo: "paperclip" },
      projectId,
      assigneeAgentId: agentId,
    }), { type: "user", userId: "board-user" });
    expect(mocks.logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "routine.run_triggered",
      entityType: "routine_run",
      entityId: "run-1",
    }));
  });

  it("returns not found when a routine is outside the actor's company", async () => {
    mocks.get.mockResolvedValue(routine());

    await request(app())
      .post(`/api/routines/${routineId}/run`)
      .set("x-test-company", "other")
      .send({ source: "manual" })
      .expect(404);

    expect(mocks.runRoutine).not.toHaveBeenCalled();
  });

  it("forwards the canonical signed-trigger envelope without board persistence", async () => {
    mocks.firePublicTrigger.mockResolvedValue({ runId: "run-public", accepted: true });

    await request(app())
      .post("/api/routine-triggers/public/public-trigger/fire")
      .set("authorization", "Bearer public-token")
      .set("x-paperclip-signature", "signature")
      .set("x-paperclip-timestamp", "1700000000")
      .set("idempotency-key", "request-1")
      .send({ event: "push" })
      .expect(202, { runId: "run-public", accepted: true });

    expect(mocks.firePublicTrigger).toHaveBeenCalledWith("public-trigger", expect.objectContaining({
      authorizationHeader: "Bearer public-token",
      signatureHeader: "signature",
      timestampHeader: "1700000000",
      idempotencyKey: "request-1",
      payload: { event: "push" },
    }));
  });
});
