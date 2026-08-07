import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { instanceSettingsRoutes } from "../routes/instance-settings.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  getGeneral: vi.fn(),
  updateGeneral: vi.fn(),
  listCompanyIds: vi.fn(),
  logActivity: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  instanceSettingsService: () => ({
    get: mocks.get,
    getGeneral: mocks.getGeneral,
    updateGeneral: mocks.updateGeneral,
    listCompanyIds: mocks.listCompanyIds,
  }),
  logActivity: mocks.logActivity,
}));

const safeguards = {
  censorUsernameInLogs: false,
  keyboardShortcuts: false,
  enableWorkspaceBranchReconcileForward: true,
  enableWorkspaceDirtyQuarantineRepair: true,
  enableServerInfoDebugView: false,
  autoRestartDevServerWhenIdle: false,
  enableWorktreeRunExecution: false,
  worktreeRunExecutionActivatedAt: null,
  worktreeRunExecutionActivationInstanceId: null,
};

function createApp(actor = testBoardSessionActor({
  userId: "board-user",
  isInstanceAdmin: true,
  companyIds: ["company-1"],
})) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", instanceSettingsRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe("instance general settings routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getGeneral.mockResolvedValue(safeguards);
    mocks.updateGeneral.mockResolvedValue({ id: "settings-1", general: safeguards });
    mocks.listCompanyIds.mockResolvedValue(["company-1"]);
    mocks.logActivity.mockResolvedValue(undefined);
  });

  it("exposes the workspace safeguards as general settings", async () => {
    const response = await request(createApp()).get("/api/instance/settings/general");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(safeguards);
    expect(mocks.getGeneral).toHaveBeenCalledOnce();
  });

  it("updates both safeguards through the general settings endpoint", async () => {
    const updated = {
      ...safeguards,
      enableWorkspaceBranchReconcileForward: false,
      enableWorkspaceDirtyQuarantineRepair: false,
    };
    mocks.updateGeneral.mockResolvedValueOnce({ id: "settings-1", general: updated });

    const response = await request(createApp())
      .patch("/api/instance/settings/general")
      .send({
        enableWorkspaceBranchReconcileForward: false,
        enableWorkspaceDirtyQuarantineRepair: false,
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(updated);
    expect(mocks.updateGeneral).toHaveBeenCalledWith({
      enableWorkspaceBranchReconcileForward: false,
      enableWorkspaceDirtyQuarantineRepair: false,
    });
    expect(mocks.logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "instance.settings.general_updated",
        details: expect.objectContaining({
          changedKeys: [
            "enableWorkspaceBranchReconcileForward",
            "enableWorkspaceDirtyQuarantineRepair",
          ],
        }),
      }),
    );
  });

  it("updates retained server controls through the general settings endpoint", async () => {
    const updated = {
      ...safeguards,
      enableServerInfoDebugView: true,
      autoRestartDevServerWhenIdle: true,
      enableWorktreeRunExecution: true,
      worktreeRunExecutionActivatedAt: "2026-08-07T00:00:00.000Z",
      worktreeRunExecutionActivationInstanceId: "worktree-instance",
    };
    mocks.updateGeneral.mockResolvedValueOnce({ id: "settings-1", general: updated });

    const response = await request(createApp())
      .patch("/api/instance/settings/general")
      .send({
        enableServerInfoDebugView: true,
        autoRestartDevServerWhenIdle: true,
        enableWorktreeRunExecution: true,
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(updated);
    expect(mocks.updateGeneral).toHaveBeenCalledWith({
      enableServerInfoDebugView: true,
      autoRestartDevServerWhenIdle: true,
      enableWorktreeRunExecution: true,
    });
  });

  it("rejects server-managed worktree activation metadata", async () => {
    const response = await request(createApp())
      .patch("/api/instance/settings/general")
      .send({
        worktreeRunExecutionActivatedAt: "2026-08-07T00:00:00.000Z",
      });

    expect(response.status).toBe(400);
    expect(mocks.updateGeneral).not.toHaveBeenCalled();
  });

  it("requires instance administration to change general settings", async () => {
    const response = await request(createApp(testBoardSessionActor({
      userId: "member",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    })))
      .patch("/api/instance/settings/general")
      .send({ enableWorkspaceDirtyQuarantineRepair: false });

    expect(response.status).toBe(403);
    expect(mocks.updateGeneral).not.toHaveBeenCalled();
  });
});
