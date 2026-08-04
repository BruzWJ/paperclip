import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { testBoardSessionActor } from "./helpers/request-actor.js";
import { installTestRequestAuthority } from "./helpers/request-authority.js";

const logActivityMock = vi.fn();

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => ({
      isInstanceAdmin: vi.fn(),
      canUser: vi.fn().mockResolvedValue(true),
      hasPermission: vi.fn(),
    }),
    agentService: () => ({
      getById: vi.fn(),
    }),
    boardAuthService: () => ({
      createChallenge: vi.fn(),
      resolveBoardAccess: vi.fn(),
      assertCurrentBoardKey: vi.fn(),
      revokeBoardApiKey: vi.fn(),
    }),
    createRuntimeAgentConfigurationService: () => ({}),
    createAgentAdapterConfigurationService: () => ({}),
    createAgentOperationalConfigurationService: () => ({}),
    createJoinRequestApprovalService: () => ({}),
    deduplicateAgentName: vi.fn(),
    logActivity: (...args: unknown[]) => logActivityMock(...args),
  }));
}

function createDbStub() {
  const createdInvite = {
    id: "invite-1",
    companyId: "company-1",
    inviteType: "company_join",
    source: "board_api",
    allowedJoinTypes: "human",
    tokenHash: "hash",
    defaultsPayload: { humanRole: "viewer" },
    expiresAt: new Date("2027-03-10T00:00:00.000Z"),
    invitedByUserId: "board-user",
    revokedAt: null,
    acceptedAt: null,
    createdAt: new Date("2026-03-07T00:00:00.000Z"),
    updatedAt: new Date("2026-03-07T00:00:00.000Z"),
  };

  return {
    insert() {
      return {
        values() {
          return {
            returning() {
              return Promise.resolve([createdInvite]);
            },
          };
        },
      };
    },
    select(_shape?: unknown) {
      return {
        from() {
          const query = {
            leftJoin() {
              return query;
            },
            where() {
              return Promise.resolve([{
                name: "Acme Robotics",
                brandColor: "#114488",
                logoAssetId: "logo-1",
              }]);
            },
          };
          return query;
        },
      };
    },
  };
}

let accessRoutes: typeof import("../routes/access.js").accessRoutes;
let errorHandler: typeof import("../middleware/index.js").errorHandler;

function createApp() {
  const app = express();
  installTestRequestAuthority(app, {
    trustProxy: true,
    allowedHostnames: ["paperclip.example"],
  });
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = testBoardSessionActor({
      sessionId: "session-board-user",
      userId: "board-user",
      userName: "Board User",
      userEmail: "board@example.com",
      companyIds: ["company-1"],
      memberships: [{
        companyId: "company-1",
        membershipRole: "owner",
        status: "active",
      }],
      isInstanceAdmin: true,
    });
    next();
  });
  app.use(
    "/api",
    accessRoutes(createDbStub() as any, {
      deploymentExposure: "private",
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("POST /companies/:companyId/invites", () => {
  beforeAll(async () => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/access.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    [{ accessRoutes }, { errorHandler }] = await Promise.all([
      import("../routes/access.js"),
      import("../middleware/index.js"),
    ]);
  }, 15_000);

  beforeEach(() => {
    vi.clearAllMocks();
    logActivityMock.mockReset();
  });

  it("returns an absolute invite URL using the request base URL", async () => {
    const app = createApp();

    const res = await request(app)
      .post("/api/companies/company-1/invites")
      .set("host", "paperclip.example")
      .set("x-forwarded-proto", "https")
      .send({
        allowedJoinTypes: "human",
        humanRole: "viewer",
      });

    expect(res.status).toBe(201);
    expect(res.body.companyName).toBe("Acme Robotics");
    expect(res.body.invitePath).toMatch(/^\/invite\/pcp_invite_/);
    expect(res.body.inviteUrl).toMatch(/^https:\/\/paperclip\.example\/invite\/pcp_invite_/);
  });
});
