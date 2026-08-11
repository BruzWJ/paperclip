import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const mockProjectService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  createWorkspace: vi.fn(),
  listWorkspaces: vi.fn(),
  updateWorkspace: vi.fn(),
  clearWorkspaces: vi.fn(),
  remove: vi.fn(),
  resolveByReference: vi.fn(),
}));
const mockSecretService = vi.hoisted(() => ({
  normalizeEnvBindingsForPersistence: vi.fn(),
  syncEnvBindingsForTarget: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: mockGetTelemetryClient,
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
  secretService: () => mockSecretService,
  toPublicProject: <T>(project: T) => project,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

function registerModuleMocks() {
  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: mockGetTelemetryClient,
  }));

  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    logActivity: mockLogActivity,
    projectService: () => mockProjectService,
    secretService: () => mockSecretService,
    toPublicProject: <T>(project: T) => project,
  }));

  vi.doMock("../services/secrets.js", () => ({
    secretService: () => mockSecretService,
  }));

}

async function createApp() {
  const [{ projectRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/projects.js")>("../routes/projects.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = testBoardSessionActor({
      userId: "board-user",
      userName: "Board User",
      userEmail: "board-user@paperclip.test",
      sessionId: "session-board-user",
      companyIds: ["company-1"],
      memberships: [{
        companyId: "company-1",
        membershipRole: "operator",
        status: "active",
      }],
      isInstanceAdmin: false,
    });
    next();
  });
  app.use("/api", projectRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function buildProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-1",
    companyId: "company-1",
    urlKey: "project-1",
    goalIds: [],
    goals: [],
    name: "Project",
    description: null,
    status: "backlog",
    leadAgentId: null,
    targetDate: null,
    color: null,
    env: null,
    pauseReason: null,
    pausedAt: null,
    codebase: {
      workspaceId: null,
      repoUrl: null,
      localFolder: null,
    },
    workspaces: [],
    primaryWorkspace: null,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("project env routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/projects.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../services/secrets.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "project:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockProjectService.resolveByReference.mockResolvedValue({ ambiguous: false, project: null });
    mockProjectService.createWorkspace.mockResolvedValue(null);
    mockProjectService.clearWorkspaces.mockResolvedValue([]);
    mockProjectService.listWorkspaces.mockResolvedValue([]);
    mockSecretService.normalizeEnvBindingsForPersistence.mockImplementation(async (_companyId, env) => env);
    mockSecretService.syncEnvBindingsForTarget.mockResolvedValue([]);
  });

  it("normalizes env bindings on create and logs only env keys", async () => {
    const normalizedEnv = {
      API_KEY: {
        type: "secret_ref",
        secretId: "11111111-1111-4111-8111-111111111111",
        version: "latest",
      },
    };
    mockSecretService.normalizeEnvBindingsForPersistence.mockResolvedValue(normalizedEnv);
    mockProjectService.create.mockResolvedValue(buildProject({ env: normalizedEnv }));

    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/projects")
      .send({
        name: "Project",
        env: normalizedEnv,
      });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mockSecretService.normalizeEnvBindingsForPersistence).toHaveBeenCalledWith(
      "company-1",
      normalizedEnv,
      expect.objectContaining({ fieldPath: "env" }),
    );
    expect(mockProjectService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ env: normalizedEnv }),
    );
    expect(mockSecretService.syncEnvBindingsForTarget).toHaveBeenCalledWith(
      "company-1",
      { targetType: "project", targetId: "project-1" },
      normalizedEnv,
      { actor: { type: "user", userId: "board-user" } },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({
          envKeys: ["API_KEY"],
        }),
      }),
    );
  });

  it("normalizes env bindings on update and avoids logging raw values", async () => {
    const normalizedEnv = {
      PLAIN_KEY: { type: "plain", value: "top-secret" },
    };
    mockSecretService.normalizeEnvBindingsForPersistence.mockResolvedValue(normalizedEnv);
    mockProjectService.getById.mockResolvedValue(buildProject());
    mockProjectService.update.mockResolvedValue(buildProject({ env: normalizedEnv }));

    const app = await createApp();
    const res = await request(app)
      .patch("/api/projects/project-1")
      .send({
        env: normalizedEnv,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockSecretService.syncEnvBindingsForTarget).toHaveBeenCalledWith(
      "company-1",
      { targetType: "project", targetId: "project-1" },
      normalizedEnv,
      { actor: { type: "user", userId: "board-user" } },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: {
          changedKeys: ["env"],
          envKeys: ["PLAIN_KEY"],
        },
      }),
    );
  });

  it("creates a project with a board-managed repo and local agent directory", async () => {
    const created = buildProject();
    const hydrated = buildProject({
      codebase: {
        workspaceId: "11111111-1111-4111-8111-111111111111",
        repoUrl: "https://github.com/acme/project.git",
        localFolder: "/srv/acme/project",
      },
    });
    mockProjectService.create.mockResolvedValue(created);
    mockProjectService.createWorkspace.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
    });
    mockProjectService.getById.mockResolvedValue(hydrated);

    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/projects")
      .send({
        name: "Project",
        codebase: {
          repoUrl: "https://github.com/acme/project.git",
          localFolder: "/srv/acme/project",
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockProjectService.create).toHaveBeenCalledWith(
      "company-1",
      expect.not.objectContaining({ codebase: expect.anything() }),
    );
    expect(mockProjectService.createWorkspace).toHaveBeenCalledWith(
      "project-1",
      {
        cwd: "/srv/acme/project",
        repoUrl: "https://github.com/acme/project.git",
      },
    );
  });

  it("reads and updates the project's single Codebase projection", async () => {
    const existing = buildProject({
      codebase: {
        workspaceId: "11111111-1111-4111-8111-111111111111",
        repoUrl: "https://github.com/acme/old.git",
        localFolder: "/srv/acme/project",
      },
      primaryWorkspace: { id: "11111111-1111-4111-8111-111111111111" },
    });
    const updated = buildProject({
      codebase: {
        workspaceId: "11111111-1111-4111-8111-111111111111",
        repoUrl: "https://github.com/acme/new.git",
        localFolder: "/srv/acme/project",
      },
      primaryWorkspace: { id: "11111111-1111-4111-8111-111111111111" },
    });
    mockProjectService.getById
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce(updated);
    mockProjectService.updateWorkspace.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
    });

    const app = await createApp();
    const getResponse = await request(app).get("/api/projects/project-1/codebase");
    expect(getResponse.status, JSON.stringify(getResponse.body)).toBe(200);
    expect(getResponse.body).toEqual(existing.codebase);

    const patchResponse = await request(app)
      .patch("/api/projects/project-1/codebase")
      .send({ repoUrl: "https://github.com/acme/new.git" });
    expect(patchResponse.status, JSON.stringify(patchResponse.body)).toBe(200);
    expect(patchResponse.body).toEqual(updated.codebase);
    expect(mockProjectService.updateWorkspace).toHaveBeenCalledWith(
      "project-1",
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        repoUrl: "https://github.com/acme/new.git",
      }),
    );
  });

  it("removes the project Codebase when both retained fields are cleared", async () => {
    const existing = buildProject({
      codebase: {
        workspaceId: "11111111-1111-4111-8111-111111111111",
        repoUrl: "https://github.com/acme/project.git",
        localFolder: "/srv/acme/project",
      },
      primaryWorkspace: { id: "11111111-1111-4111-8111-111111111111" },
    });
    mockProjectService.getById
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce(buildProject());
    mockProjectService.clearWorkspaces.mockResolvedValue([
      { id: "11111111-1111-4111-8111-111111111111" },
    ]);

    const app = await createApp();
    const res = await request(app)
      .patch("/api/projects/project-1/codebase")
      .send({ localFolder: null, repoUrl: null });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockProjectService.clearWorkspaces).toHaveBeenCalledWith("project-1");
    expect(mockProjectService.updateWorkspace).not.toHaveBeenCalled();
  });
});
