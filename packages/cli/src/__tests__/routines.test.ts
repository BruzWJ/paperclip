import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const databaseMocks = vi.hoisted(() => ({
  createDb: vi.fn(),
  resolveDatabaseTarget: vi.fn(),
  select: vi.fn(),
  selectFrom: vi.fn(),
  selectWhere: vi.fn(),
  update: vi.fn(),
  updateSet: vi.fn(),
  updateWhere: vi.fn(),
  end: vi.fn(),
}));

const drizzleMocks = vi.hoisted(() => ({
  eq: vi.fn((field: unknown, value: unknown) => ({ operator: "eq", field, value })),
  inArray: vi.fn((field: unknown, values: unknown[]) => ({
    operator: "inArray",
    field,
    values,
  })),
}));

vi.mock("@paperclipai/db", () => ({
  createDb: databaseMocks.createDb,
  resolveDatabaseTarget: databaseMocks.resolveDatabaseTarget,
  routines: {
    id: "routines.id",
    companyId: "routines.companyId",
    status: "routines.status",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: drizzleMocks.eq,
  inArray: drizzleMocks.inArray,
}));

import { disableAllRoutinesInConfig } from "../commands/routines.js";

const ORIGINAL_ENV = { ...process.env };
const TEST_DATABASE_URL = "postgresql://paperclip.invalid/paperclip_routines_test";
const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const ACTIVE_ROUTINE_ID = "22222222-2222-4222-8222-222222222222";
const PAUSED_ROUTINE_ID = "33333333-3333-4333-8333-333333333333";
const ARCHIVED_ROUTINE_ID = "44444444-4444-4444-8444-444444444444";

function writeTestConfig(configPath: string, tempRoot: string) {
  const config = {
    $meta: {
      version: 1,
      updatedAt: "2026-08-02T00:00:00.000Z",
      source: "doctor" as const,
    },
    database: {
      connectionString: TEST_DATABASE_URL,
      backup: {
        enabled: false,
        intervalMinutes: 60,
        retentionDays: 30,
        dir: path.join(tempRoot, "backups"),
      },
    },
    logging: {
      mode: "file" as const,
      logDir: path.join(tempRoot, "logs"),
    },
    server: {
      exposure: "private" as const,
      host: "127.0.0.1",
      port: 3100,
      allowedHostnames: [],
      serveUi: false,
    },
    auth: {
      disableSignUp: false,
    },
    storage: {
      provider: "local_disk" as const,
      localDisk: {
        baseDir: path.join(tempRoot, "storage"),
      },
      s3: {
        bucket: "paperclip",
        region: "us-east-1",
        prefix: "",
        forcePathStyle: false,
      },
    },
    secrets: {
      provider: "local_encrypted" as const,
      strictMode: false,
      localEncrypted: {
        keyFilePath: path.join(tempRoot, "secrets", "master.key"),
      },
    },
  };

  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

describe("disableAllRoutinesInConfig", () => {
  let tempRoot = "";
  let configPath = "";

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    tempRoot = mkdtempSync(path.join(os.tmpdir(), "paperclip-routines-cli-config-"));
    configPath = path.join(tempRoot, "config.json");
    writeTestConfig(configPath, tempRoot);

    databaseMocks.resolveDatabaseTarget.mockReturnValue({
      connectionString: TEST_DATABASE_URL,
      source: "config",
    });
    databaseMocks.selectWhere.mockResolvedValue([
      { id: ACTIVE_ROUTINE_ID, status: "active" },
      { id: PAUSED_ROUTINE_ID, status: "paused" },
      { id: ARCHIVED_ROUTINE_ID, status: "archived" },
    ]);
    databaseMocks.selectFrom.mockReturnValue({ where: databaseMocks.selectWhere });
    databaseMocks.select.mockReturnValue({ from: databaseMocks.selectFrom });
    databaseMocks.updateWhere.mockResolvedValue([]);
    databaseMocks.updateSet.mockReturnValue({ where: databaseMocks.updateWhere });
    databaseMocks.update.mockReturnValue({ set: databaseMocks.updateSet });
    databaseMocks.end.mockResolvedValue(undefined);
    databaseMocks.createDb.mockReturnValue({
      select: databaseMocks.select,
      update: databaseMocks.update,
      $client: { end: databaseMocks.end },
    });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("pauses only active routines selected for the requested company", async () => {
    const result = await disableAllRoutinesInConfig({
      config: configPath,
      companyId: COMPANY_ID,
    });

    expect(result).toEqual({
      companyId: COMPANY_ID,
      totalRoutines: 3,
      pausedCount: 1,
      alreadyPausedCount: 1,
      archivedCount: 1,
    });
    expect(databaseMocks.createDb).toHaveBeenCalledWith(TEST_DATABASE_URL);
    expect(databaseMocks.selectWhere).toHaveBeenCalledWith({
      operator: "eq",
      field: "routines.companyId",
      value: COMPANY_ID,
    });
    expect(databaseMocks.updateSet).toHaveBeenCalledWith({
      status: "paused",
      updatedAt: expect.any(Date),
    });
    expect(databaseMocks.updateWhere).toHaveBeenCalledWith({
      operator: "inArray",
      field: "routines.id",
      values: [ACTIVE_ROUTINE_ID],
    });
    expect(databaseMocks.end).toHaveBeenCalledWith({ timeout: 5 });
  });
});
