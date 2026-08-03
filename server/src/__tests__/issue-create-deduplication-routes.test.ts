import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { OrdinaryIssueRuntimeRejected } from "../services/ordinary-issue-runtime.js";
import { createMockDb } from "./helpers/mock-db.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const companyId = "00000000-0000-4000-8000-000000000001";
const ownerAgentId = "00000000-0000-4000-8000-000000000010";
const boardUserId = "board-user";
const firstIssueId = "00000000-0000-4000-8000-000000000020";
const secondIssueId = "00000000-0000-4000-8000-000000000021";

const createIssue = vi.fn();
const ordinaryIssues = { create: createIssue } as never;

function createdResult(input: {
  id?: string;
  request: string;
  title: string;
  idempotencyKey: string;
  retried: boolean;
}) {
  return {
    issue: {
      id: input.id ?? firstIssueId,
      companyId,
      request: input.request,
      title: input.title,
      ownerKind: "agent",
      ownerAgentId,
      ownerUserId: null,
      creatorKind: "user/board",
      creatorUserId: boardUserId,
      originKind: "manual",
    },
    ref: { id: `ordinary-issue-create:${companyId}:${input.idempotencyKey}` },
    retried: input.retried,
  };
}

function createApp(db: Db) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = testBoardSessionActor({
      userId: boardUserId,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      isInstanceAdmin: false,
    });
    next();
  });
  app.use("/api", issueRoutes(db, {} as never, { ordinaryIssues }));
  app.use(errorHandler);
  return app;
}

describe("issue create deduplication routes", () => {
  beforeEach(() => createIssue.mockReset());

  it("returns 201 for the canonical create and 200 for an exact idempotent replay", async () => {
    const input = {
      request: "Prepare the release without changing these bytes.",
      ownerAgentId,
      title: "Prepare release",
      idempotencyKey: "run-1:prepare-release",
    };
    createIssue
      .mockResolvedValueOnce(createdResult({ ...input, retried: false }))
      .mockResolvedValueOnce(createdResult({ ...input, retried: true }));
    const harness = createMockDb();
    const app = createApp(harness.db);

    const first = await request(app).post(`/api/companies/${companyId}/issues`).send(input);
    const replay = await request(app).post(`/api/companies/${companyId}/issues`).send(input);

    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(first.body).toMatchObject({ id: firstIssueId, request: input.request, ownerAgentId, retried: false });
    expect(replay.body).toMatchObject({ id: firstIssueId, request: input.request, ownerAgentId, retried: true });
    expect(createIssue).toHaveBeenCalledTimes(2);
    expect(createIssue).toHaveBeenNthCalledWith(1, expect.objectContaining({
      companyId,
      request: input.request,
      ownerAgentId,
      creator: { kind: "user/board", userId: boardUserId },
      idempotencyKey: input.idempotencyKey,
      sourceKind: "issue_request",
    }));
    expect(harness.calls).toEqual([]);
  });

  it("maps an immutable-payload idempotency rejection to the canonical conflict response", async () => {
    const input = {
      request: "Prepare the release.",
      ownerAgentId,
      title: "Prepare release",
      idempotencyKey: "run-1:immutable-retry",
    };
    createIssue
      .mockResolvedValueOnce(createdResult({ ...input, retried: false }))
      .mockRejectedValueOnce(new OrdinaryIssueRuntimeRejected(
        "Issue creation idempotency key was retried with different immutable input",
        "create_idempotency_conflict",
      ));
    const app = createApp(createMockDb().db);

    const first = await request(app).post(`/api/companies/${companyId}/issues`).send(input);
    const conflict = await request(app).post(`/api/companies/${companyId}/issues`).send({
      ...input,
      request: "A changed request must not reuse the existing creation.",
    });

    expect(first.status).toBe(201);
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({
      error: "Issue creation idempotency key was retried with different immutable input",
      details: { code: "create_idempotency_conflict" },
    });
  });

  it("keeps identical titles independent when the explicit idempotency keys differ", async () => {
    createIssue
      .mockResolvedValueOnce(createdResult({
        id: firstIssueId,
        request: "First independent request.",
        title: "Coordinate launch",
        idempotencyKey: "run-2:coordinate-launch-a",
        retried: false,
      }))
      .mockResolvedValueOnce(createdResult({
        id: secondIssueId,
        request: "Second independent request.",
        title: "Coordinate launch",
        idempotencyKey: "run-2:coordinate-launch-b",
        retried: false,
      }));
    const app = createApp(createMockDb().db);

    const first = await request(app).post(`/api/companies/${companyId}/issues`).send({
      request: "First independent request.",
      ownerAgentId,
      title: "Coordinate launch",
      idempotencyKey: "run-2:coordinate-launch-a",
    });
    const second = await request(app).post(`/api/companies/${companyId}/issues`).send({
      request: "Second independent request.",
      ownerAgentId,
      title: "Coordinate launch",
      idempotencyKey: "run-2:coordinate-launch-b",
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.id).toBe(firstIssueId);
    expect(second.body.id).toBe(secondIssueId);
  });

  it("preserves serialized retry outcomes returned by the canonical runtime", async () => {
    const input = {
      request: "Coordinate one launch.",
      ownerAgentId,
      title: "Coordinate launch",
      idempotencyKey: "run-2:coordinate-launch",
    };
    createIssue
      .mockResolvedValueOnce(createdResult({ ...input, retried: false }))
      .mockResolvedValueOnce(createdResult({ ...input, retried: true }));
    const app = createApp(createMockDb().db);

    const [first, retry] = await Promise.all([
      request(app).post(`/api/companies/${companyId}/issues`).send(input),
      request(app).post(`/api/companies/${companyId}/issues`).send(input),
    ]);

    expect([first.status, retry.status].sort()).toEqual([200, 201]);
    expect(first.body.id).toBe(retry.body.id);
    expect([first.body.retried, retry.body.retried].sort()).toEqual([false, true]);
  });

  it("rejects retired title-only and allowDuplicate inputs before runtime dispatch", async () => {
    const app = createApp(createMockDb().db);

    const titleOnly = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Title-only compatibility create" });
    const allowDuplicate = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        request: "Do not restore the soft duplicate bypass.",
        ownerAgentId,
        title: "Explicit duplicate",
        idempotencyKey: "retired-allow-duplicate",
        allowDuplicate: true,
      });

    expect(titleOnly.status).toBe(400);
    expect(allowDuplicate.status).toBe(400);
    expect(createIssue).not.toHaveBeenCalled();
  });

  it("passes exact request bytes and canonical board creator identity to the runtime", async () => {
    const exactRequest = "  Keep leading, internal\n, and trailing bytes.  ";
    const input = {
      request: exactRequest,
      ownerAgentId,
      title: "Attributed create",
      idempotencyKey: "board-attributed-create",
    };
    createIssue.mockResolvedValue(createdResult({ ...input, retried: false }));
    const harness = createMockDb();

    const response = await request(createApp(harness.db))
      .post(`/api/companies/${companyId}/issues`)
      .send(input);

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      request: exactRequest,
      ownerKind: "agent",
      ownerAgentId,
      ownerUserId: null,
      creatorKind: "user/board",
      creatorUserId: boardUserId,
      originKind: "manual",
    });
    expect(createIssue).toHaveBeenCalledWith(expect.objectContaining({
      request: exactRequest,
      creator: { kind: "user/board", userId: boardUserId },
    }));
    expect(harness.calls).toEqual([]);
  });
});
