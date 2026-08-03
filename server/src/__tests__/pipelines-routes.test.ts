import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import { errorHandler } from "../middleware/error-handler.js";
import { pipelineRoutes } from "../routes/pipelines.js";
import { createMockDb } from "./helpers/mock-db.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const mocks = vi.hoisted(() => ({
  createPipeline: vi.fn(),
  listReviewCases: vi.fn(),
  reviewCase: vi.fn(),
  accessDecide: vi.fn(),
}));

vi.mock("../services/pipelines.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/pipelines.js")>();
  return {
    ...actual,
    pipelineService: vi.fn(() => ({
      createPipeline: mocks.createPipeline,
      listReviewCases: mocks.listReviewCases,
      reviewCase: mocks.reviewCase,
    })),
  };
});

vi.mock("../services/access.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/access.js")>();
  return {
    ...actual,
    accessService: vi.fn(() => ({ decide: mocks.accessDecide })),
  };
});

vi.mock("../services/pipeline-case-outputs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/pipeline-case-outputs.js")>();
  return {
    ...actual,
    pipelineCaseOutputsService: vi.fn(() => ({ listCaseOutputs: vi.fn() })),
  };
});

const companyId = "00000000-0000-4000-8000-000000000001";
const otherCompanyId = "00000000-0000-4000-8000-000000000002";
const caseOne = "00000000-0000-4000-8000-000000000011";
const caseTwo = "00000000-0000-4000-8000-000000000012";

function app() {
  const expressApp = express();
  expressApp.use(express.json());
  expressApp.use((req, _res, next) => {
    req.actor = req.header("x-test-company") === "other"
      ? testBoardSessionActor({ userId: "other-user", companyIds: [otherCompanyId] })
      : testBoardSessionActor({ userId: "board-user", companyIds: [companyId] });
    next();
  });
  const mock = createMockDb();
  expressApp.use("/api", pipelineRoutes(mock.db, { ordinaryIssues: {} as never }));
  expressApp.use(errorHandler);
  return expressApp;
}

describe("pipeline routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.accessDecide.mockResolvedValue({
      allowed: true,
      explanation: "allowed",
      code: "allowed",
      reason: "board_member",
    });
  });

  it("creates a pipeline through the canonical board-authorized service contract", async () => {
    const created = {
      id: "pipeline-1",
      companyId,
      key: "release",
      name: "Release",
      stages: [],
    };
    mocks.createPipeline.mockResolvedValue(created);

    await request(app())
      .post(`/api/companies/${companyId}/pipelines`)
      .send({
        key: "release",
        name: "Release",
        description: "Canonical release workflow",
        enforceTransitions: true,
        stages: [
          { key: "open", name: "Open", kind: "open", position: 0 },
          { key: "done", name: "Done", kind: "done", position: 1 },
        ],
      })
      .expect(201, created);

    expect(mocks.accessDecide).toHaveBeenCalledWith(expect.objectContaining({
      action: "pipelines:write",
      resource: { type: "company", companyId },
    }));
    expect(mocks.createPipeline).toHaveBeenCalledWith(expect.objectContaining({
      companyId,
      key: "release",
      enforceTransitions: true,
      actor: { type: "user", userId: "board-user" },
      stages: expect.arrayContaining([
        expect.objectContaining({ key: "open", kind: "open" }),
        expect.objectContaining({ key: "done", kind: "done" }),
      ]),
    }));
  });

  it("rejects invalid pipeline documents before authorization or persistence", async () => {
    await request(app())
      .post(`/api/companies/${companyId}/pipelines`)
      .send({ key: "", name: "", stages: [{ key: "x", name: "X", kind: "unknown" }] })
      .expect(400);

    expect(mocks.accessDecide).not.toHaveBeenCalled();
    expect(mocks.createPipeline).not.toHaveBeenCalled();
  });

  it("returns the authorization decision when pipeline mutation is denied", async () => {
    mocks.accessDecide.mockResolvedValue({
      allowed: false,
      explanation: "Pipeline writes require an operator role.",
      code: "pipeline_write_forbidden",
      reason: "missing_permission",
    });

    const response = await request(app())
      .post(`/api/companies/${companyId}/pipelines`)
      .send({ key: "release", name: "Release" })
      .expect(403);

    expect(response.body).toMatchObject({
      error: "Pipeline writes require an operator role.",
      code: "pipeline_write_forbidden",
    });
    expect(mocks.createPipeline).not.toHaveBeenCalled();
  });

  it("passes review-list filters without querying route-owned persistence", async () => {
    mocks.listReviewCases.mockResolvedValue([{ id: caseOne, title: "Review me" }]);

    await request(app())
      .get(`/api/companies/${companyId}/review-cases`)
      .query({ pipelineId: "pipeline-1", parentCaseId: caseTwo })
      .expect(200, [{ id: caseOne, title: "Review me" }]);

    expect(mocks.listReviewCases).toHaveBeenCalledWith({
      companyId,
      pipelineId: "pipeline-1",
      parentCaseId: caseTwo,
    });
  });

  it("bulk review isolates stale cases instead of aborting successful decisions", async () => {
    mocks.reviewCase
      .mockResolvedValueOnce({ id: caseOne, stageKey: "done", version: 3 })
      .mockRejectedValueOnce(new HttpError(409, "Case changed", {
        code: "stale_case_version",
        currentVersion: 4,
      }));

    const response = await request(app())
      .post(`/api/companies/${companyId}/review-cases/bulk`)
      .send({
        items: [
          { caseId: caseOne, decision: "approve", expectedVersion: 2 },
          { caseId: caseTwo, decision: "reject", expectedVersion: 3, reason: "Needs revision" },
        ],
      })
      .expect(200);

    expect(response.body.results).toEqual([
      {
        caseId: caseOne,
        ok: true,
        result: { id: caseOne, stageKey: "done", version: 3 },
      },
      {
        caseId: caseTwo,
        ok: false,
        error: {
          status: 409,
          message: "Case changed",
          code: "stale_case_version",
          details: { code: "stale_case_version", currentVersion: 4 },
        },
      },
    ]);
  });

  it("conceals cross-company pipeline collection routes as not found", async () => {
    await request(app())
      .get(`/api/companies/${companyId}/review-cases`)
      .set("x-test-company", "other")
      .expect(404);
    expect(mocks.listReviewCases).not.toHaveBeenCalled();
  });
});
