import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { accessRoutes } from "../routes/access.js";
import { denyGenericAgentRest } from "../routes/compiled-interface-only.js";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import { errorHandler } from "../middleware/index.js";
import { testBoardKeyActor, testBoardSessionActor } from "./helpers/request-actor.js";
import { installTestRequestAuthority } from "./helpers/request-authority.js";

const claimFirstInstanceAdminMock = vi.hoisted(() => vi.fn());
const accessServiceMock = vi.hoisted(() => ({
  isInstanceAdmin: vi.fn(),
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalGrants: vi.fn(),
}));

vi.mock("../first-admin-claim.js", () => ({
  claimFirstInstanceAdmin: claimFirstInstanceAdminMock,
}));

vi.mock("../services/index.js", () => ({
  accessService: () => accessServiceMock,
  agentService: () => ({
    getById: vi.fn(),
  }),
  boardAuthService: () => ({
    createCliAuthChallenge: vi.fn(),
    resolveBoardAccess: vi.fn(),
    assertCurrentBoardKey: vi.fn(),
    revokeBoardApiKey: vi.fn(),
  }),
  createRuntimeAgentConfigurationService: () => ({}),
  createAgentAdapterConfigurationService: () => ({}),
  createAgentOperationalConfigurationService: () => ({}),
  createJoinRequestApprovalService: () => ({ approve: vi.fn() }),
  deduplicateAgentName: vi.fn(),
  logActivity: vi.fn(),
}));

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createDb(invite?: Record<string, unknown>) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(invite ? [invite] : [])),
      })),
    })),
  } as any;
}

function createApp(input: {
  actor?: Record<string, unknown>;
  deploymentExposure?: "private" | "public";
  guardMutations?: boolean;
  db?: Record<string, unknown>;
}) {
  const app = express();
  app.use(express.json());
  installTestRequestAuthority(app, {
    allowedHostnames: ["paperclip.local"],
  });
  app.use((req, _res, next) => {
    (req as any).actor = input.actor ?? testBoardSessionActor({
      userId: "user-1",
      sessionId: "session-1",
      userName: "User One",
      userEmail: "user@example.com",
      companyIds: [],
      memberships: [],
      isInstanceAdmin: false,
    });
    next();
  });
  app.use("/api", denyGenericAgentRest("REST"));
  if (input.guardMutations) {
    app.use(boardMutationGuard());
  }
  app.use(
    "/api",
    accessRoutes(input.db as any ?? createDb(), {
      deploymentExposure: input.deploymentExposure ?? "private",
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("POST /bootstrap/claim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimFirstInstanceAdminMock.mockResolvedValue({
      status: "claimed",
      userId: "user-1",
      value: null,
    });
  });

  it("claims first admin for an authenticated private browser session", async () => {
    const app = createApp({});

    const res = await request(app).post("/api/bootstrap/claim").send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ claimed: true, userId: "user-1" });
    expect(claimFirstInstanceAdminMock).toHaveBeenCalledWith(expect.anything(), { userId: "user-1" });
  });

  it("is not exposed with public exposure", async () => {
    const app = createApp({ deploymentExposure: "public" });

    const res = await request(app).post("/api/bootstrap/claim").send({});

    expect(res.status).toBe(404);
    expect(claimFirstInstanceAdminMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ type: "none", source: "none" }, "anonymous caller"],
    [testBoardKeyActor({
      userId: "user-1",
      keyId: "board-key-1",
      userName: "User One",
      userEmail: "user@example.com",
      companyIds: [],
      memberships: [],
      isInstanceAdmin: false,
    }), "board API key"],
    [{ type: "board", source: "session", userId: null }, "session without a user"],
  ])("rejects %s before opening the first-admin transaction", async (actor) => {
    const app = createApp({ actor });

    const res = await request(app).post("/api/bootstrap/claim").send({});

    expect(res.status).toBe(401);
    expect(claimFirstInstanceAdminMock).not.toHaveBeenCalled();
  });

  it("rejects an exact runtime-agent actor at the generic REST boundary", async () => {
    const app = createApp({
      actor: {
        type: "agent",
        source: "internal",
        agentId: "agent-1",
        companyId: "company-1",
        runId: "run-1",
      },
    });

    const res = await request(app).post("/api/bootstrap/claim").send({});

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("compiled_run_interface_required");
    expect(claimFirstInstanceAdminMock).not.toHaveBeenCalled();
  });

  it("returns conflict when first admin has already been claimed", async () => {
    claimFirstInstanceAdminMock.mockResolvedValueOnce({
      status: "already_claimed",
      existingUserId: "user-2",
      value: null,
    });
    const app = createApp({});

    const res = await request(app).post("/api/bootstrap/claim").send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("already claimed");
  });

  it("stays behind the board mutation origin guard", async () => {
    const app = createApp({ guardMutations: true });

    const blocked = await request(app).post("/api/bootstrap/claim").send({});
    expect(blocked.status).toBe(403);
    expect(claimFirstInstanceAdminMock).not.toHaveBeenCalled();

    const allowed = await request(app)
      .post("/api/bootstrap/claim")
      .set("Host", "paperclip.local")
      .set("Origin", "http://paperclip.local")
      .send({});
    expect(allowed.status).toBe(200);
    expect(claimFirstInstanceAdminMock).toHaveBeenCalledTimes(1);
  });
});

describe("bootstrap invite first-admin acceptance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createBootstrapInvite() {
    return {
      id: "invite-1",
      companyId: null,
      inviteType: "bootstrap_admin",
      source: "bootstrap_admin_cli",
      allowedJoinTypes: "human",
      tokenHash: hashToken("pcp_invite_test"),
      defaultsPayload: {},
      expiresAt: new Date("2027-03-10T00:00:00.000Z"),
      invitedByUserId: null,
      revokedAt: null,
      acceptedAt: null,
      createdAt: new Date("2026-03-07T00:00:00.000Z"),
      updatedAt: new Date("2026-03-07T00:00:00.000Z"),
    };
  }

  it("uses the shared first-admin helper for bootstrap invite acceptance", async () => {
    const invite = createBootstrapInvite();
    claimFirstInstanceAdminMock.mockResolvedValueOnce({
      status: "claimed",
      userId: "user-1",
      value: { ...invite, acceptedAt: new Date("2026-03-07T00:01:00.000Z") },
    });
    const app = createApp({ db: createDb(invite) });

    const res = await request(app)
      .post("/api/invites/pcp_invite_test/accept")
      .send({ requestType: "human" });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      inviteId: "invite-1",
      inviteType: "bootstrap_admin",
      bootstrapAccepted: true,
      userId: "user-1",
    });
    expect(claimFirstInstanceAdminMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: "user-1", onClaim: expect.any(Function) }),
    );
  });

  it("conflicts cleanly when browser claim already won before invite acceptance", async () => {
    claimFirstInstanceAdminMock.mockResolvedValueOnce({
      status: "already_claimed",
      existingUserId: "user-2",
      value: null,
    });
    const app = createApp({ db: createDb(createBootstrapInvite()) });

    const res = await request(app)
      .post("/api/invites/pcp_invite_test/accept")
      .send({ requestType: "human" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("already claimed");
  });
});
