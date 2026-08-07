import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { ServerInfoSnapshot } from "@paperclipai/shared";
import { healthRoutes } from "../routes/health.js";
import { serverVersion } from "../version.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const testServerInfo: ServerInfoSnapshot = {
  processStartedAt: "2026-08-07T00:00:00.000Z",
  git: {
    available: true,
    fullSha: "0123456789abcdef0123456789abcdef01234567",
    shortSha: "0123456",
    branchName: "test",
    subject: "Test server info",
    committedAt: "2026-08-06T00:00:00.000Z",
    localChanges: {
      available: true,
      hasLocalChanges: false,
      stagedFileCount: 0,
      unstagedFileCount: 0,
      untrackedFileCount: 0,
    },
  },
};

function appFor(
  actor: unknown,
  db?: Db,
  serverInfo: ServerInfoSnapshot = testServerInfo,
) {
  const app = express();
  app.use((req, _res, next) => {
    (req as { actor: unknown }).actor = actor;
    next();
  });
  app.use(
    "/health",
    healthRoutes(db, {
      deploymentExposure: "public",
      authReady: true,
      companyDeletionEnabled: false,
      serverInfo,
    }),
  );
  return app;
}

function healthyDb(roleCount = 1): Db {
  return {
    execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([{ count: roleCount }]),
      })),
    })),
  } as unknown as Db;
}

describe("health routes", () => {
  it("keeps anonymous no-database health responses minimal", async () => {
    const response = await request(
      appFor({ type: "none", source: "none" }),
    ).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "ok",
      deploymentExposure: "public",
      bootstrapStatus: "bootstrap_pending",
      bootstrapInviteActive: false,
    });
  });

  it("returns board health details", async () => {
    const response = await request(
      appFor(testBoardSessionActor({ isInstanceAdmin: true })),
    ).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "ok",
      version: serverVersion,
      serverVersion,
      serverInfo: testServerInfo,
    });
  });

  it("returns an unhealthy response when a database probe fails", async () => {
    const db = { execute: vi.fn().mockRejectedValue(new Error("offline")) } as unknown as Db;
    const response = await request(
      appFor(testBoardSessionActor({ isInstanceAdmin: true }), db),
    ).get("/health");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      status: "unhealthy",
      version: serverVersion,
      serverVersion,
      error: "database_unreachable",
      serverInfo: testServerInfo,
    });
  });

  it("keeps bootstrap details for authenticated board health", async () => {
    const db = healthyDb();
    const response = await request(
      appFor(testBoardSessionActor({ isInstanceAdmin: true }), db),
    ).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "ok",
      bootstrapStatus: "ready",
      bootstrapInviteActive: false,
      features: { companyDeletionEnabled: false },
      serverInfo: testServerInfo,
    });
  });
});
