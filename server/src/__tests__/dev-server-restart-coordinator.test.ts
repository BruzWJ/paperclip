import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  createDevServerRestartCoordinator,
} from "../services/dev-server-restart-coordinator.js";
import type {
  DevServerRestartRequest,
  PersistedDevServerStatus,
} from "../dev-server-status.js";

const dirtyStatus: PersistedDevServerStatus = {
  dirty: true,
  lastChangedAt: "2026-07-29T12:00:00.000Z",
  changedPathCount: 1,
  changedPathsSample: ["server/src/routes/health.ts"],
  lastRestartAt: "2026-07-29T11:30:00.000Z",
};

function createCoordinator(input: {
  status?: PersistedDevServerStatus | null;
  request?: DevServerRestartRequest | null;
  autoRestartEnabled?: boolean;
  activeRunCount?: number;
}) {
  const writeRequest = vi.fn(() => true);
  const getAutoRestartEnabled = vi.fn(async () => input.autoRestartEnabled ?? true);
  const getActiveRunCount = vi.fn(async () => input.activeRunCount ?? 0);
  const coordinator = createDevServerRestartCoordinator({} as Db, {
    dependencies: {
      readStatus: () => input.status === undefined ? dirtyStatus : input.status,
      readRequest: () => input.request ?? null,
      writeRequest,
      getAutoRestartEnabled,
      getActiveRunCount,
      now: () => new Date("2026-07-29T12:05:00.000Z"),
    },
  });
  return {
    coordinator,
    writeRequest,
    getAutoRestartEnabled,
    getActiveRunCount,
  };
}

describe("dev-server restart coordinator", () => {
  it("requests an automatic restart only when changes are pending and runs are idle", async () => {
    const { coordinator, writeRequest } = createCoordinator({});

    await expect(coordinator.checkNow()).resolves.toBe(true);
    expect(writeRequest).toHaveBeenCalledWith({
      requestedAt: "2026-07-29T12:05:00.000Z",
      reason: "auto_restart_when_idle",
    });
  });

  it("does nothing when automatic restart is disabled", async () => {
    const {
      coordinator,
      writeRequest,
      getActiveRunCount,
    } = createCoordinator({ autoRestartEnabled: false });

    await expect(coordinator.checkNow()).resolves.toBe(false);
    expect(getActiveRunCount).not.toHaveBeenCalled();
    expect(writeRequest).not.toHaveBeenCalled();
  });

  it("waits while an agent run is queued or running", async () => {
    const { coordinator, writeRequest } = createCoordinator({ activeRunCount: 2 });

    await expect(coordinator.checkNow()).resolves.toBe(false);
    expect(writeRequest).not.toHaveBeenCalled();
  });

  it("does nothing when no restart is required", async () => {
    const {
      coordinator,
      writeRequest,
      getAutoRestartEnabled,
    } = createCoordinator({
      status: {
        ...dirtyStatus,
        dirty: false,
        changedPathCount: 0,
        changedPathsSample: [],
      },
    });

    await expect(coordinator.checkNow()).resolves.toBe(false);
    expect(getAutoRestartEnabled).not.toHaveBeenCalled();
    expect(writeRequest).not.toHaveBeenCalled();
  });

  it("never overwrites an existing manual restart request", async () => {
    const {
      coordinator,
      writeRequest,
      getAutoRestartEnabled,
    } = createCoordinator({
      request: {
        requestedAt: "2026-07-29T12:03:00.000Z",
        reason: "manual_restart_now",
      },
    });

    await expect(coordinator.checkNow()).resolves.toBe(false);
    expect(getAutoRestartEnabled).not.toHaveBeenCalled();
    expect(writeRequest).not.toHaveBeenCalled();
  });
});
