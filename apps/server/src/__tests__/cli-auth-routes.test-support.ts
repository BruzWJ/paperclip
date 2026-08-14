import expressModule from "express";
import requestModule from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  testBoardKeyActor as testBoardKeyActorImport,
  testBoardSessionActor as testBoardSessionActorImport,
} from "./helpers/request-actor.js";
import { installTestRequestAuthority as installTestRequestAuthorityImport } from "./helpers/request-authority.js";

const express = expressModule;
export const request = requestModule;
export const testBoardKeyActor = testBoardKeyActorImport;
export const testBoardSessionActor = testBoardSessionActorImport;
const installTestRequestAuthority = installTestRequestAuthorityImport;
const mockAccessService = vi.hoisted(() => ({
  isInstanceAdmin: vi.fn(),
  hasPermission: vi.fn(),
  canUser: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const hoistedMockBoardAuthService = vi.hoisted(() => ({
  createCliAuthChallenge: vi.fn(),
  describeCliAuthChallenge: vi.fn(),
  approveCliAuthChallenge: vi.fn(),
  cancelCliAuthChallenge: vi.fn(),
  resolveBoardAccess: vi.fn(),
  resolveBoardActivityCompanyIds: vi.fn(),
  assertCurrentBoardKey: vi.fn(),
  revokeBoardApiKey: vi.fn(),
  listBoardApiKeys: vi.fn(),
  createNamedBoardApiKey: vi.fn(),
  getBoardApiKeyForUser: vi.fn(),
}));
export const mockBoardAuthService = hoistedMockBoardAuthService;

const hoistedMockLogActivity = vi.hoisted(() => vi.fn());
export const mockLogActivity = hoistedMockLogActivity;

export const CHALLENGE_ID = "11111111-1111-4111-8111-111111111111";
export const SECOND_CHALLENGE_ID = "22222222-2222-4222-8222-222222222222";

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  boardAuthService: () => hoistedMockBoardAuthService,
  createRuntimeAgentConfigurationService: () => ({}),
  createAgentAdapterConfigurationService: () => ({}),
  createAgentOperationalConfigurationService: () => ({}),
  createJoinRequestApprovalService: () => ({ approve: vi.fn() }),
  logActivity: hoistedMockLogActivity,
}));

function registerModuleMocks() {
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));

  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    boardAuthService: () => mockBoardAuthService,
    createRuntimeAgentConfigurationService: () => ({}),
    createAgentAdapterConfigurationService: () => ({}),
    createAgentOperationalConfigurationService: () => ({}),
    createJoinRequestApprovalService: () => ({ approve: vi.fn() }),
    logActivity: mockLogActivity,
  }));
}

export function registerSuiteSetup() {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../routes/access.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.resetAllMocks();
  });
}

let appImportCounter = 0;

export async function createApp(actor: any, db: any = {} as any) {
  appImportCounter += 1;
  const routeModulePath = `../routes/access.js?cli-auth-routes-${appImportCounter}`;
  const middlewareModulePath = `../middleware/index.js?cli-auth-routes-${appImportCounter}`;
  const [{ accessRoutes }, { errorHandler }] = await Promise.all([
    import(routeModulePath) as Promise<typeof import("../routes/access.js")>,
    import(middlewareModulePath) as Promise<typeof import("../middleware/index.js")>,
  ]);

  const app = express();
  installTestRequestAuthority(app);
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      ...actor,
      companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds,
      memberships: Array.isArray(actor.memberships)
        ? actor.memberships.map((membership: unknown) =>
            typeof membership === "object" && membership !== null ? { ...membership } : membership,
          )
        : actor.memberships,
    };
    next();
  });
  app.use(
    "/api",
    accessRoutes(db, {
      deploymentExposure: "private",
    }),
  );
  app.use(errorHandler);
  return app;
}

export { describe, expect, it };
