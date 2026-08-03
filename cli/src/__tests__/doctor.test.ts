import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const databaseMocks = vi.hoisted(() => ({
  createDb: vi.fn(),
  resolveDatabaseTarget: vi.fn(),
  execute: vi.fn(),
  end: vi.fn(),
}));

vi.mock("@paperclipai/db", () => ({
  createDb: databaseMocks.createDb,
  resolveDatabaseTarget: databaseMocks.resolveDatabaseTarget,
}));

import { doctor } from "../commands/doctor.js";
import { writeConfig } from "../config/store.js";
import type { PaperclipConfig } from "../config/schema.js";

const ORIGINAL_ENV = { ...process.env };
const TEST_DATABASE_URL = "postgresql://paperclip.invalid/paperclip_doctor_test";

function createTempConfig(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-doctor-"));
  const configPath = path.join(root, ".paperclip", "config.json");
  const runtimeRoot = path.join(root, "runtime");

  const config: PaperclipConfig = {
    $meta: {
      version: 1,
      updatedAt: "2026-03-10T00:00:00.000Z",
      source: "configure",
    },
    database: {
      connectionString: TEST_DATABASE_URL,
      backup: {
        enabled: true,
        intervalMinutes: 60,
        retentionDays: 30,
        dir: path.join(runtimeRoot, "backups"),
      },
    },
    logging: {
      mode: "file",
      logDir: path.join(runtimeRoot, "logs"),
    },
    server: {
      exposure: "private",
      host: "127.0.0.1",
      port: 3199,
      allowedHostnames: [],
      serveUi: true,
    },
    auth: {
      disableSignUp: false,
    },
    telemetry: {
      enabled: true,
    },
    storage: {
      provider: "local_disk",
      localDisk: {
        baseDir: path.join(runtimeRoot, "storage"),
      },
      s3: {
        bucket: "paperclip",
        region: "us-east-1",
        prefix: "",
        forcePathStyle: false,
      },
    },
    secrets: {
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: {
        keyFilePath: path.join(runtimeRoot, "secrets", "master.key"),
      },
    },
  };

  writeConfig(config, configPath);
  return configPath;
}

describe("doctor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseMocks.resolveDatabaseTarget.mockReturnValue({
      connectionString: TEST_DATABASE_URL,
      source: "config",
    });
    databaseMocks.execute.mockResolvedValue([]);
    databaseMocks.end.mockResolvedValue(undefined);
    databaseMocks.createDb.mockReturnValue({
      execute: databaseMocks.execute,
      $client: { end: databaseMocks.end },
    });
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    process.env.BETTER_AUTH_SECRET = "doctor-test-better-auth-secret";
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("reports missing creation-time resources without mutating them", async () => {
    const configPath = createTempConfig();
    const keyPath = path.join(path.dirname(path.dirname(configPath)), "runtime", "secrets", "master.key");

    const summary = await doctor({ config: configPath });

    expect(summary.failed).toBeGreaterThan(0);
    expect(fs.existsSync(keyPath)).toBe(false);
    expect(databaseMocks.createDb).toHaveBeenCalledWith(TEST_DATABASE_URL);
    expect(databaseMocks.execute).toHaveBeenCalledWith("SELECT 1");
    expect(databaseMocks.end).toHaveBeenCalledWith({ timeout: 5 });
  });
});
