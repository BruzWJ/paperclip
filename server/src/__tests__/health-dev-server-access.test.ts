import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { healthRoutes } from "../routes/health.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const tempDirs: string[] = [];

function createDevServerStatusFile(payload: unknown) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-health-dev-server-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, "dev-server-status.json");
  writeFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
  return filePath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("GET /health dev-server supervisor access", () => {
  it("keeps dev-server metadata board-only", async () => {
    const previousFile = process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE;
    process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE = createDevServerStatusFile({
      dirty: true,
      lastChangedAt: "2026-03-20T12:00:00.000Z",
      changedPathCount: 1,
      changedPathsSample: ["server/src/routes/health.ts"],
      lastRestartAt: "2026-03-20T11:30:00.000Z",
    });

    const db = {
      execute: async () => [{ "?column?": 1 }],
      select: () => ({
        from: () => ({
          where: async () => [{ count: 1 }],
        }),
      }),
    } as unknown as Db;

    try {
      const app = express();
      app.use((req, _res, next) => {
        (req as any).actor = { type: "none", source: "none" };
        next();
      });
      app.use(
        "/health",
        healthRoutes(db, {
          deploymentExposure: "private",
          authReady: true,
          companyDeletionEnabled: true,
        }),
      );

      const res = await request(app).get("/health");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        status: "ok",
        deploymentExposure: "private",
        bootstrapStatus: "ready",
        bootstrapInviteActive: false,
      });
    } finally {
      if (previousFile === undefined) {
        delete process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE;
      } else {
        process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE = previousFile;
      }
    }
  });
});

describe("POST /health/dev-server/restart", () => {
  it("records a manual restart request for the dev runner", async () => {
    const previousFile = process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE;
    process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE = createDevServerStatusFile({
      dirty: true,
      lastChangedAt: "2026-03-20T12:00:00.000Z",
      changedPathCount: 1,
      changedPathsSample: ["server/src/routes/health.ts"],
      lastRestartAt: "2026-03-20T11:30:00.000Z",
    });

    try {
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
      app.use("/health", healthRoutes(undefined));

      const res = await request(app).post("/health/dev-server/restart");

      expect(res.status).toBe(202);
      expect(res.body).toEqual({ status: "restart_requested" });

      const requestPath = path.join(
        path.dirname(process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE),
        "dev-server-restart-request.json",
      );
      expect(existsSync(requestPath)).toBe(true);
      expect(JSON.parse(readFileSync(requestPath, "utf8"))).toMatchObject({
        reason: "manual_restart_now",
      });
    } finally {
      if (previousFile === undefined) {
        delete process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE;
      } else {
        process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE = previousFile;
      }
    }
  });

  it("rejects unauthenticated manual restarts in authenticated mode", async () => {
    const previousFile = process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE;
    process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE = createDevServerStatusFile({
      dirty: true,
      changedPathCount: 1,
      changedPathsSample: ["server/src/routes/health.ts"],
    });

    try {
      const app = express();
      app.use((req, _res, next) => {
        (req as any).actor = { type: "none", source: "none" };
        next();
      });
      app.use(
        "/health",
        healthRoutes(undefined, {
          deploymentExposure: "private",
          authReady: true,
          companyDeletionEnabled: true,
        }),
      );
      app.use(errorHandler);

      const res = await request(app).post("/health/dev-server/restart");

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Board access required" });
    } finally {
      if (previousFile === undefined) {
        delete process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE;
      } else {
        process.env.PAPERCLIP_DEV_SERVER_STATUS_FILE = previousFile;
      }
    }
  });
});
