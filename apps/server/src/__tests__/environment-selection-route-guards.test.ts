import type { Server } from "node:http";
import express from "express";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { projectRoutes } from "../routes/projects.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const mockProjectService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  createWorkspace: vi.fn(),
  remove: vi.fn(),
  resolveByReference: vi.fn(),
  listWorkspaces: vi.fn(),
}));

const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeEnvBindingsForPersistence: vi.fn(async (_companyId: string, env: Record<string, unknown>) => env),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  projectService: () => mockProjectService,
  logActivity: mockLogActivity,
  workspaceOperationService: () => ({}),
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => mockEnvironmentService,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

function buildApp(routerFactory: (app: express.Express) => void) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = testBoardSessionActor({
      userId: "user-1",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "member" }],
      isInstanceAdmin: false,
    });
    next();
  });
  routerFactory(app);
  app.use(errorHandler);
  return app;
}

let projectServer: Server | null = null;

function createProjectApp() {
  projectServer ??= buildApp((expressApp) => {
    expressApp.use("/api", projectRoutes({} as any));
  }).listen(0);
  return projectServer;
}

const sandboxEnvironmentId = "11111111-1111-4111-8111-111111111111";

async function closeServer(server: Server | null) {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

describe.sequential("execution environment route guards", () => {
  afterAll(async () => {
    await closeServer(projectServer);
    projectServer = null;
  });

  beforeEach(() => {
    mockProjectService.create.mockReset();
    mockProjectService.getById.mockReset();
    mockProjectService.update.mockReset();
    mockProjectService.createWorkspace.mockReset();
    mockProjectService.remove.mockReset();
    mockProjectService.resolveByReference.mockReset();
    mockProjectService.listWorkspaces.mockReset();
    mockEnvironmentService.getById.mockReset();
    mockSecretService.normalizeEnvBindingsForPersistence.mockClear();
    mockLogActivity.mockReset();
  });

  it("accepts sandbox environments on project create", async () => {
    mockEnvironmentService.getById.mockResolvedValue({
      id: sandboxEnvironmentId,
      companyId: "company-1",
      driver: "sandbox",
      config: { provider: "fake-plugin" },
    });
    mockProjectService.create.mockResolvedValue({
      id: "project-1",
      companyId: "company-1",
      name: "Sandboxed Project",
      status: "backlog",
    });
    const app = createProjectApp();

    const res = await request(app)
      .post("/api/companies/company-1/projects")
      .send({
        name: "Sandboxed Project",
        executionWorkspacePolicy: {
          enabled: true,
          environmentId: sandboxEnvironmentId,
        },
      });

    expect(res.status).not.toBe(422);
    expect(mockProjectService.create).toHaveBeenCalled();
  });

  it("accepts sandbox environments on project update", async () => {
    mockProjectService.getById.mockResolvedValue({
      id: "project-1",
      companyId: "company-1",
      name: "Sandboxed Project",
      status: "backlog",
      archivedAt: null,
    });
    mockEnvironmentService.getById.mockResolvedValue({
      id: sandboxEnvironmentId,
      companyId: "company-1",
      driver: "sandbox",
      config: { provider: "fake-plugin" },
    });
    mockProjectService.update.mockResolvedValue({
      id: "project-1",
      companyId: "company-1",
      name: "Sandboxed Project",
      status: "backlog",
    });
    const app = createProjectApp();

    const res = await request(app)
      .patch("/api/projects/project-1")
      .send({
        executionWorkspacePolicy: {
          enabled: true,
          environmentId: sandboxEnvironmentId,
        },
      });

    expect(res.status).not.toBe(422);
    expect(mockProjectService.update).toHaveBeenCalled();
  });

});
