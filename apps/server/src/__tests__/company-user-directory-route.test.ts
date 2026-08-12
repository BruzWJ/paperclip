import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accessRoutes } from "../routes/access.js";
import { errorHandler } from "../middleware/index.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    isInstanceAdmin: vi.fn(),
    canUser: vi.fn(),
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
  createJoinRequestApprovalService: () => ({ approve: vi.fn() }),
  logActivity: vi.fn(),
}));

function createDbStub() {
  const activeMemberships = [
    { principalId: "user-2", status: "active" as const },
    { principalId: "user-1", status: "active" as const },
  ];
  const users = [
    { id: "user-1", name: "Dotta", email: "dotta@example.com", image: "https://example.com/dotta.png" },
    { id: "user-2", name: null, email: "alex@example.com", image: null },
  ];

  const isCompanyMembershipsTable = (table: unknown) =>
    !!table &&
    typeof table === "object" &&
    "membershipRole" in table &&
    "principalType" in table &&
    "principalUserId" in table;
  const isAuthUsersTable = (table: unknown) =>
    !!table &&
    typeof table === "object" &&
    "emailVerified" in table &&
    "createdAt" in table &&
    "updatedAt" in table;

  return {
    select() {
      return {
        from(table: unknown) {
          if (isCompanyMembershipsTable(table)) {
            const query = {
              where() {
                return query;
              },
              orderBy() {
                return Promise.resolve(activeMemberships);
              },
            };
            return query;
          }
          if (isAuthUsersTable(table)) {
            return {
              where() {
                return Promise.resolve(users);
              },
            };
          }
          throw new Error("Unexpected table");
        },
      };
    },
  };
}

function createApp(actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use(
    "/api",
    accessRoutes(createDbStub() as never, {
      deploymentExposure: "private",
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("GET /companies/:companyId/user-directory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns active human users for operators without manage-permissions access", async () => {
    const app = createApp(testBoardSessionActor({
      userId: "user-1",
      userName: "User One",
      userEmail: "user-1@example.com",
      sessionId: "session-user-1",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole: "operator", status: "active" }],
    }));

    const res = await request(app).get("/api/companies/company-1/user-directory");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      users: [
        {
          principalId: "user-2",
          status: "active",
          user: { id: "user-2", name: null, email: "alex@example.com", image: null },
        },
        {
          principalId: "user-1",
          status: "active",
          user: { id: "user-1", name: "Dotta", email: "dotta@example.com", image: "https://example.com/dotta.png" },
        },
      ],
    });
  });
});
