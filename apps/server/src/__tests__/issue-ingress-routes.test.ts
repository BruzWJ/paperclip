import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { issueIngressRoutes } from "../routes/issue-ingress.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const issueId = "22222222-2222-4222-8222-222222222222";
const parentId = "33333333-3333-4333-8333-333333333333";
const ownerAgentId = "44444444-4444-4444-8444-444444444444";
const boardUserId = "board-user";

const mockGetById = vi.hoisted(() => vi.fn());

type TestActor = Express.Request["actor"];

function createApp(input: {
  actor: TestActor;
  create: ReturnType<typeof vi.fn>;
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = input.actor;
    next();
  });
  app.use(
    "/api",
    issueIngressRoutes({
      ordinaryIssues: {
        create: input.create,
        dispatchDirectEvent: vi.fn(),
      } as never,
      getIssueById: mockGetById,
    }),
  );
  app.use(errorHandler);
  return app;
}

function boardActor(): TestActor {
  return testBoardSessionActor({
    userId: boardUserId,
    companyIds: [companyId],
    memberships: [
      {
        companyId,
        membershipRole: "owner",
        status: "active",
      },
    ],
  });
}

function agentActor(): TestActor {
  return {
    type: "agent",
    agentId: ownerAgentId,
    companyId,
    source: "internal",
    runId: "55555555-5555-4555-8555-555555555555",
  };
}

function createResult(retried = false) {
  return {
    issue: {
      id: issueId,
      companyId,
      request: "  Preserve this request exactly.  ",
      title: "Canonical issue",
      lifecycleStatus: "open",
      ownerKind: "agent",
      ownerAgentId,
      ownerUserId: null,
      ownershipEpoch: 1,
      creatorKind: "user/board",
      creatorUserId: boardUserId,
    },
    sessionId: "ses_test",
    authorityId: "66666666-6666-4666-8666-666666666666",
    ref: { id: "77777777-7777-4777-8777-777777777777" },
    retried,
  };
}

describe("canonical board issue ingress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetById.mockResolvedValue({
      id: parentId,
      companyId,
      title: "Parent",
    });
  });

  it("creates through OrdinaryIssueRuntime and dispatches its persisted ref", async () => {
    const dispatchPersistedRef = vi.fn();
    const create = vi.fn(async () => {
      const result = createResult();
      dispatchPersistedRef(result.ref.id);
      return result;
    });
    const app = await createApp({ actor: boardActor(), create });
    const exactRequest = "  Preserve this request exactly.  ";

    const response = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        request: exactRequest,
        ownerAgentId,
        idempotencyKey: "board-create-1",
        title: "Canonical issue",
        priority: "high",
      })
      .expect(201);

    expect(create).toHaveBeenCalledWith({
      companyId,
      request: exactRequest,
      ownerAgentId,
      creator: { kind: "user/board", userId: boardUserId },
      idempotencyKey: "board-create-1",
      sourceKind: "issue_request",
      title: "Canonical issue",
      projectId: null,
      goalId: null,
      parentId: null,
      priority: "high",
    });
    expect(dispatchPersistedRef).toHaveBeenCalledOnce();
    expect(dispatchPersistedRef).toHaveBeenCalledWith(
      "77777777-7777-4777-8777-777777777777",
    );
    expect(response.body).toMatchObject({
      id: issueId,
      request: exactRequest,
      lifecycleStatus: "open",
      ownerKind: "agent",
      ownerAgentId,
      ownershipEpoch: 1,
      creatorKind: "user/board",
      creatorUserId: boardUserId,
      refId: "77777777-7777-4777-8777-777777777777",
      retried: false,
    });
  });

  it("requires an owner and rejects legacy create payloads instead of stripping them", async () => {
    const create = vi.fn();
    const app = await createApp({ actor: boardActor(), create });

    await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        request: "Owner is missing",
        idempotencyKey: "board-create-2",
      })
      .expect(400);
    await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        request: "Per-issue context override is forbidden",
        ownerAgentId,
        idempotencyKey: "board-create-4",
        contextAccessMask: { carry_context: false },
      })
      .expect(400);
    await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        request: "Legacy status is forbidden",
        ownerAgentId,
        idempotencyKey: "board-create-3",
        status: "todo",
      })
      .expect(400);

    expect(create).not.toHaveBeenCalled();
  });

  it("denies agent REST creation before accepting any payload shape", async () => {
    const create = vi.fn();
    const app = await createApp({ actor: agentActor(), create });

    const response = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ description: "legacy agent bypass" })
      .expect(403);

    expect(response.body.error).toContain("Board access required");
    expect(create).not.toHaveBeenCalled();
  });

  it("replays canonical idempotent creation with HTTP 200", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(createResult(false))
      .mockResolvedValueOnce(createResult(true));
    const app = await createApp({ actor: boardActor(), create });
    const body = {
      request: "  Preserve this request exactly.  ",
      ownerAgentId,
      idempotencyKey: "board-create-retry",
      title: "Canonical issue",
    };

    await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send(body)
      .expect(201);
    const retry = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send(body)
      .expect(200);

    expect(create).toHaveBeenCalledTimes(2);
    expect(retry.body).toMatchObject({ id: issueId, retried: true });
  });

  it("creates a board child with the path parent and the same named creator", async () => {
    const create = vi.fn().mockResolvedValue(createResult(false));
    const app = await createApp({ actor: boardActor(), create });

    await request(app)
      .post(`/api/issues/${parentId}/children`)
      .send({
        request: "Implement the child",
        ownerAgentId,
        idempotencyKey: "board-child-1",
      })
      .expect(201);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId,
        request: "Implement the child",
        ownerAgentId,
        parentId,
        creator: { kind: "user/board", userId: boardUserId },
        idempotencyKey: "board-child-1",
      }),
    );

    await request(app)
      .post(`/api/issues/${parentId}/children`)
      .send({
        request: "Cannot override the path parent",
        ownerAgentId,
        idempotencyKey: "board-child-2",
        parentId: issueId,
      })
      .expect(400);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
