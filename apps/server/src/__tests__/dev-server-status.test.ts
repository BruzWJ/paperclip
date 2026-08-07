import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  consumeDevServerRestartRequest,
  getDevServerRestartRequestFilePath,
  readDevServerRestartRequest,
  readPersistedDevServerStatus,
  toDevServerHealthStatus,
  writeDevServerRestartRequest,
} from "../dev-server-status.js";

const tempDirs = [];

function createTempStatusFile(payload: unknown) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-dev-status-"));
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

describe("dev server status helpers", () => {
  it("reads and normalizes persisted supervisor state", () => {
    const filePath = createTempStatusFile({
      dirty: true,
      lastChangedAt: "2026-03-20T12:00:00.000Z",
      changedPathCount: 4,
      changedPathsSample: ["apps/server/src/app.ts", "packages/shared/src/index.ts"],
      lastRestartAt: "2026-03-20T11:30:00.000Z",
    });

    expect(readPersistedDevServerStatus({ PAPERCLIP_DEV_SERVER_STATUS_FILE: filePath })).toEqual({
      dirty: true,
      lastChangedAt: "2026-03-20T12:00:00.000Z",
      changedPathCount: 4,
      changedPathsSample: ["apps/server/src/app.ts", "packages/shared/src/index.ts"],
      lastRestartAt: "2026-03-20T11:30:00.000Z",
    });
  });

  it("derives restart-required health state with automatic idle restart enabled", () => {
    const health = toDevServerHealthStatus(
      {
        dirty: true,
        lastChangedAt: "2026-03-20T12:00:00.000Z",
        changedPathCount: 2,
        changedPathsSample: ["apps/server/src/app.ts"],
        lastRestartAt: "2026-03-20T11:30:00.000Z",
      },
      { activeRunCount: 2, autoRestartEnabled: true },
    );

    expect(health).toMatchObject({
      enabled: true,
      restartRequired: true,
      reason: "backend_changes",
      autoRestartEnabled: true,
      activeRunCount: 2,
      waitingForIdle: true,
    });
  });

  it("does not wait for idle when automatic idle restart is disabled", () => {
    const health = toDevServerHealthStatus(
      {
        dirty: true,
        lastChangedAt: "2026-03-20T12:00:00.000Z",
        changedPathCount: 2,
        changedPathsSample: ["apps/server/src/app.ts"],
        lastRestartAt: "2026-03-20T11:30:00.000Z",
      },
      { activeRunCount: 2, autoRestartEnabled: false },
    );

    expect(health).toMatchObject({
      restartRequired: true,
      autoRestartEnabled: false,
      activeRunCount: 2,
      waitingForIdle: false,
    });
  });

  it("ignores oversized persisted status files", () => {
    const filePath = createTempStatusFile({
      dirty: true,
      changedPathsSample: ["x".repeat(70 * 1024)],
    });

    expect(readPersistedDevServerStatus({ PAPERCLIP_DEV_SERVER_STATUS_FILE: filePath })).toBeNull();
  });

  it("writes restart requests next to the persisted status file", () => {
    const filePath = createTempStatusFile({
      dirty: true,
      changedPathsSample: ["apps/server/src/app.ts"],
    });

    const env = { PAPERCLIP_DEV_SERVER_STATUS_FILE: filePath };
    expect(writeDevServerRestartRequest({
      requestedAt: "2026-03-20T12:05:00.000Z",
      reason: "manual_restart_now",
    }, env)).toBe(true);

    const requestPath = getDevServerRestartRequestFilePath(env);
    expect(requestPath).toBe(path.join(path.dirname(filePath), "dev-server-restart-request.json"));
    expect(requestPath && existsSync(requestPath)).toBe(true);
    expect(JSON.parse(readFileSync(requestPath!, "utf8"))).toEqual({
      requestedAt: "2026-03-20T12:05:00.000Z",
      reason: "manual_restart_now",
    });
    expect(readDevServerRestartRequest(env)).toEqual({
      requestedAt: "2026-03-20T12:05:00.000Z",
      reason: "manual_restart_now",
    });
    expect(consumeDevServerRestartRequest(env)).toEqual({
      requestedAt: "2026-03-20T12:05:00.000Z",
      reason: "manual_restart_now",
    });
    expect(requestPath && existsSync(requestPath)).toBe(false);
  });

  it("accepts automatic idle restart requests", () => {
    const filePath = createTempStatusFile({
      dirty: true,
      changedPathsSample: ["apps/server/src/app.ts"],
    });
    const env = { PAPERCLIP_DEV_SERVER_STATUS_FILE: filePath };

    expect(writeDevServerRestartRequest({
      requestedAt: "2026-03-20T12:05:00.000Z",
      reason: "auto_restart_when_idle",
    }, env)).toBe(true);
    expect(readDevServerRestartRequest(env)).toEqual({
      requestedAt: "2026-03-20T12:05:00.000Z",
      reason: "auto_restart_when_idle",
    });
  });

  it("preserves an existing restart request when requested", () => {
    const filePath = createTempStatusFile({
      dirty: true,
      changedPathsSample: ["apps/server/src/app.ts"],
    });
    const env = { PAPERCLIP_DEV_SERVER_STATUS_FILE: filePath };
    expect(writeDevServerRestartRequest({
      requestedAt: "2026-03-20T12:04:00.000Z",
      reason: "manual_restart_now",
    }, env)).toBe(true);

    expect(writeDevServerRestartRequest({
      requestedAt: "2026-03-20T12:05:00.000Z",
      reason: "manual_restart_now",
    }, env, { preserveExisting: true })).toBe(false);
    expect(readDevServerRestartRequest(env)).toEqual({
      requestedAt: "2026-03-20T12:04:00.000Z",
      reason: "manual_restart_now",
    });
  });

  it("does not consume malformed restart requests", () => {
    const filePath = createTempStatusFile({
      dirty: true,
      changedPathsSample: ["apps/server/src/app.ts"],
    });
    const env = { PAPERCLIP_DEV_SERVER_STATUS_FILE: filePath };
    const requestPath = getDevServerRestartRequestFilePath(env)!;
    writeFileSync(requestPath, JSON.stringify({
      requestedAt: "not-a-timestamp",
      reason: "manual_restart_now",
    }), "utf8");

    expect(readDevServerRestartRequest(env)).toBeNull();
    expect(consumeDevServerRestartRequest(env)).toBeNull();
    expect(existsSync(requestPath)).toBe(true);
  });
});
