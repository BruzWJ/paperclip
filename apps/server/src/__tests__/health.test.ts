import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { healthRoutes } from "../routes/health.js";
import * as devServerStatus from "../dev-server-status.js";
import { serverVersion } from "../version.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const mockReadPersistedDevServerStatus = vi.hoisted(() => vi.fn());
const testServerInfo = {
  processStartedAt: "2026-06-26T00:00:00.000Z",
  git: {
    available: true,
    fullSha: "0123456789abcdef0123456789abcdef01234567",
    shortSha: "0123456",
    branchName: "master",
    subject: "Add server info debug view",
    committedAt: "2026-06-25T23:00:00.000Z",
    localChanges: {
      available: true,
      hasLocalChanges: false,
      stagedFileCount: 0,
      unstagedFileCount: 0,
      untrackedFileCount: 0,
    },
  },
} as const;

function createHealthyDb(): Db {
  return {
    execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([{ count: 1 }]),
      })),
    })),
  } as unknown as Db;
}

vi.mock("../dev-server-status.js", () => ({
  readPersistedDevServerStatus: mockReadPersistedDevServerStatus,
  toDevServerHealthStatus: vi.fn(),
}));

function createApp(
  db?: Db,
  serverInfo = testServerInfo,
) {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).actor = testBoardSessionActor({
      userId: "user-1",
      userName: "User One",
      userEmail: "user-1@paperclip.test",
      sessionId: "session-user-1",
      companyIds: [],
      memberships: [],
      isInstanceAdmin: true,
    });
    next();
  });
  app.use(
    "/health",
    healthRoutes(db, {
      deploymentExposure: "private",
      authReady: true,
      companyDeletionEnabled: true,
      serverInfo,
    }),
  );
  return app;
}

describe("GET /health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadPersistedDevServerStatus.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  it("returns 200 with status ok", async () => {
    const app = createApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", version: serverVersion, serverVersion: serverVersion, serverInfo: testServerInfo });
  }, 15_000);

  it("returns 200 when the database probe succeeds", async () => {
    const db = createHealthyDb();
    const app = createApp(db);

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(res.body).toMatchObject({
      status: "ok",
      version: serverVersion,
      serverInfo: testServerInfo,
    });
  });

  it("does not expose full health details to runtime-agent actors", async () => {
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "agent",
        source: "internal",
        agentId: "agent-1",
        companyId: "company-1",
        runId: "run-1",
      };
      next();
    });
    app.use("/health", healthRoutes(undefined));

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      deploymentExposure: "private",
      bootstrapStatus: "bootstrap_pending",
      bootstrapInviteActive: false,
    });
  });

  it("returns 503 when the database probe fails", async () => {
    const db = {
      execute: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
    } as unknown as Db;
    const app = createApp(db);

    const res = await request(app).get("/health");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: "unhealthy",
      version: serverVersion,
      serverVersion,
      error: "database_unreachable",
      serverInfo: testServerInfo,
    });
  });

  it("returns only the stable failure code when the anonymous database probe fails", async () => {
    const db = {
      execute: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
    } as unknown as Db;
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = { type: "none", source: "none" };
      next();
    });
    app.use(
      "/health",
      healthRoutes(db, {
        deploymentExposure: "public",
        authReady: true,
        companyDeletionEnabled: false,
        serverInfo: testServerInfo,
      }),
    );

    const res = await request(app).get("/health");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: "unhealthy",
      error: "database_unreachable",
    });
  });

  it("returns safe server info fallbacks when git metadata is unavailable", async () => {
    const app = createApp(undefined, {
      processStartedAt: "2026-06-26T00:00:00.000Z",
      git: {
        available: false,
        unavailableReason: "git_unavailable",
      },
    });

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.serverInfo).toEqual({
      processStartedAt: "2026-06-26T00:00:00.000Z",
      git: {
        available: false,
        unavailableReason: "git_unavailable",
      },
    });
  });


  it("redacts detailed metadata for anonymous requests in authenticated mode", async () => {
    const devServerStatus = await import("../dev-server-status.js");
    vi.spyOn(devServerStatus, "readPersistedDevServerStatus").mockReturnValue(undefined);
    const { healthRoutes } = await import("../routes/health.js");
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 1 }]),
        })),
      })),
    } as unknown as Db;
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = { type: "none", source: "none" };
      next();
    });
    app.use(
      "/health",
      healthRoutes(db, {
        deploymentExposure: "public",
        authReady: true,
        companyDeletionEnabled: false,
        serverInfo: testServerInfo,
      }),
    );

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      deploymentExposure: "public",
      bootstrapStatus: "ready",
      bootstrapInviteActive: false,
    });
    expect(res.body.serverInfo).toBeUndefined();
  });

  it("redacts detailed metadata when authenticated mode is reached without auth middleware", async () => {
    const devServerStatus = await import("../dev-server-status.js");
    vi.spyOn(devServerStatus, "readPersistedDevServerStatus").mockReturnValue(undefined);
    const { healthRoutes } = await import("../routes/health.js");
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 1 }]),
        })),
      })),
    } as unknown as Db;
    const app = express();
    app.use(
      "/health",
      healthRoutes(db, {
        deploymentExposure: "public",
        authReady: true,
        companyDeletionEnabled: false,
        serverInfo: testServerInfo,
      }),
    );

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      deploymentExposure: "public",
      bootstrapStatus: "ready",
      bootstrapInviteActive: false,
    });
    expect(res.body.serverInfo).toBeUndefined();
  });

  it("keeps detailed metadata for authenticated requests in authenticated mode", async () => {
    const devServerStatus = await import("../dev-server-status.js");
    vi.spyOn(devServerStatus, "readPersistedDevServerStatus").mockReturnValue(undefined);
    const { healthRoutes } = await import("../routes/health.js");
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 1 }]),
        })),
      })),
    } as unknown as Db;
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = testBoardSessionActor({
        userId: "user-1",
        userName: "User One",
        userEmail: "user-1@paperclip.test",
        sessionId: "session-user-1",
        companyIds: [],
        memberships: [],
        isInstanceAdmin: true,
      });
      next();
    });
    app.use(
      "/health",
      healthRoutes(db, {
        deploymentExposure: "public",
        authReady: true,
        companyDeletionEnabled: false,
        serverInfo: testServerInfo,
      }),
    );

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      version: serverVersion,
      serverVersion,
      deploymentExposure: "public",
      authReady: true,
      bootstrapStatus: "ready",
      bootstrapInviteActive: false,
      features: {
        companyDeletionEnabled: false,
      },
      serverInfo: testServerInfo,
    });
  });

  it("reports bootstrap_pending in authenticated mode when no instance admin exists", async () => {
    const { healthRoutes } = await import("../routes/health.js");
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 0 }]),
        })),
      })),
    } as unknown as Db;
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = { type: "none", source: "none" };
      next();
    });
    app.use(
      "/health",
      healthRoutes(db, {
        deploymentExposure: "public",
        authReady: true,
        companyDeletionEnabled: false,
        serverInfo: testServerInfo,
      }),
    );

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      bootstrapStatus: "bootstrap_pending",
      bootstrapInviteActive: false,
    });
  });

  it("does not bypass first-admin bootstrap when retired cloud headers are present", async () => {
    vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "ignored-retired-token"); // paperclip:canonical-human-auth-removal-proof
    const { healthRoutes } = await import("../routes/health.js");
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 0 }]),
        })),
      })),
    } as unknown as Db;
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = { type: "none", source: "none" };
      next();
    });
    app.use(
      "/health",
      healthRoutes(db, {
        deploymentExposure: "public",
        authReady: true,
        companyDeletionEnabled: false,
        serverInfo: testServerInfo,
      }),
    );

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      bootstrapStatus: "bootstrap_pending",
      bootstrapInviteActive: false,
    });
  });
});
