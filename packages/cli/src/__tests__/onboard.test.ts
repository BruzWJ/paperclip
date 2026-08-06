import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const databaseMocks = vi.hoisted(() => ({
  createDb: vi.fn(),
  execute: vi.fn(),
  end: vi.fn(),
  redactExternalPostgresConnectionString: vi.fn(() => "postgresql://***"),
  validateExternalPostgresConnectionString: vi.fn((value: string) => value.trim()),
}));

vi.mock("@paperclipai/db", () => ({
  createDb: databaseMocks.createDb,
  redactExternalPostgresConnectionString:
    databaseMocks.redactExternalPostgresConnectionString,
  validateExternalPostgresConnectionString:
    databaseMocks.validateExternalPostgresConnectionString,
}));

import { onboard } from "../commands/onboard.js";
import type { PaperclipConfig } from "../config/schema.js";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_CWD = process.cwd();
const ORIGINAL_PATH = process.env.PATH;
const TEST_DATABASE_URL = "postgresql://paperclip.invalid/paperclip_onboard_test";
let isolatedHome = "";

function createExistingConfigFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-onboard-"));
  const runtimeRoot = path.join(root, "runtime");
  const configPath = path.join(root, ".paperclip", "config.json");
  const config: PaperclipConfig = {
    $meta: {
      version: 1,
      updatedAt: "2026-03-29T00:00:00.000Z",
      source: "configure",
    },
    database: {
      connectionString: TEST_DATABASE_URL
    },
    logging: {
      mode: "file",
      logDir: path.join(runtimeRoot, "logs"),
    },
    server: {
      exposure: "private",
      host: "127.0.0.1",
      port: 3100,
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

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  return { configPath, configText: fs.readFileSync(configPath, "utf8") };
}

function createFreshConfigPath() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-onboard-fresh-"));
  return path.join(root, ".paperclip", "config.json");
}

describe("onboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseMocks.execute.mockResolvedValue([]);
    databaseMocks.end.mockResolvedValue(undefined);
    databaseMocks.createDb.mockReturnValue({
      execute: databaseMocks.execute,
      $client: { end: databaseMocks.end },
    });
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    delete process.env.PAPERCLIP_STORAGE_PROVIDER;
    delete process.env.PAPERCLIP_STORAGE_LOCAL_DIR;
    delete process.env.PAPERCLIP_SECRETS_PROVIDER;
    delete process.env.PAPERCLIP_SECRETS_STRICT_MODE;
    delete process.env.PAPERCLIP_HOME;
    delete process.env.PAPERCLIP_CONFIG;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    delete process.env.PAPERCLIP_BIND;
    delete process.env.PAPERCLIP_BIND_HOST;
    delete process.env.PAPERCLIP_TAILNET_BIND_HOST;
    delete process.env.PAPERCLIP_DEPLOYMENT_MODE; // paperclip:canonical-human-auth-removal-proof
    delete process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE;
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.HOST;
    isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-onboard-test-home-"));
    process.env.PAPERCLIP_HOME = isolatedHome;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.chdir(ORIGINAL_CWD);
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  });

  it("preserves an existing config when rerun without flags", async () => {
    const fixture = createExistingConfigFixture();

    await onboard({ config: fixture.configPath });

    expect(fs.readFileSync(fixture.configPath, "utf8")).toBe(fixture.configText);
    expect(fs.existsSync(`${fixture.configPath}.backup`)).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(fixture.configPath), ".env"))).toBe(false);
  });

  it("preserves an existing config when rerun with --yes", async () => {
    const fixture = createExistingConfigFixture();

    await onboard({ config: fixture.configPath, yes: true, invokedByRun: true });

    expect(fs.readFileSync(fixture.configPath, "utf8")).toBe(fixture.configText);
    expect(fs.existsSync(`${fixture.configPath}.backup`)).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(fixture.configPath), ".env"))).toBe(false);
  });

  it("fails before writing config when no external database URL is supplied", async () => {
    const configPath = createFreshConfigPath();
    delete process.env.DATABASE_URL;

    await expect(
      onboard({ config: configPath, yes: true, invokedByRun: true }),
    ).rejects.toThrow(/external PostgreSQL URL is required/i);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("keeps --yes onboarding on private loopback defaults", async () => {
    const configPath = createFreshConfigPath();
    process.env.HOST = "0.0.0.0";
    process.env.PAPERCLIP_BIND = "lan";

    await onboard({ config: configPath, yes: true, invokedByRun: true });

    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as PaperclipConfig;
    expect(raw.server).not.toHaveProperty("deploymentMode"); // paperclip:canonical-human-auth-removal-proof
    expect(raw.server.exposure).toBe("private");
    expect(raw.server.bind).toBe("loopback");
    expect(raw.server.host).toBe("127.0.0.1");
    expect(databaseMocks.createDb).toHaveBeenCalledWith(TEST_DATABASE_URL);
    expect(databaseMocks.execute).toHaveBeenCalledWith("SELECT 1");
    expect(databaseMocks.end).toHaveBeenCalledWith({ timeout: 5 });
  });

  it("creates instance-root config and data paths for a fresh PAPERCLIP_HOME", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-onboard-home-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-onboard-cwd-"));
    process.chdir(cwd);
    process.env.PAPERCLIP_HOME = home;

    await onboard({ yes: true, invokedByRun: true });

    const instanceRoot = path.join(home, "instances", "default");
    const configPath = path.join(instanceRoot, "config.json");
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as PaperclipConfig;

    expect(raw.database.connectionString).toBeUndefined();
    expect(raw.database).not.toHaveProperty("backup");
    expect(raw.logging.logDir).toBe(path.join(instanceRoot, "logs"));
    expect(raw.storage.localDisk.baseDir).toBe(path.join(instanceRoot, "data", "storage"));
    expect(raw.secrets.localEncrypted.keyFilePath).toBe(path.join(instanceRoot, "secrets", "master.key"));
    const envPath = path.join(instanceRoot, ".env");
    expect(fs.existsSync(envPath)).toBe(true);
    expect(fs.readFileSync(envPath, "utf8")).toMatch(/^BETTER_AUTH_SECRET=[A-Za-z0-9_-]{43}$/m);
    expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(instanceRoot, "secrets", "master.key"))).toBe(true);
  });

  it("supports private quickstart bind presets", async () => {
    const configPath = createFreshConfigPath();
    process.env.PAPERCLIP_TAILNET_BIND_HOST = "100.64.0.8";

    await onboard({ config: configPath, yes: true, invokedByRun: true, bind: "tailnet" });

    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as PaperclipConfig;
    expect(raw.server.exposure).toBe("private");
    expect(raw.server.bind).toBe("tailnet");
    expect(raw.server.host).toBe("100.64.0.8");
  });

  it("keeps tailnet quickstart on loopback until tailscale is available", async () => {
    const configPath = createFreshConfigPath();
    delete process.env.PAPERCLIP_TAILNET_BIND_HOST;
    process.env.PATH = "";

    try {
      await onboard({ config: configPath, yes: true, invokedByRun: true, bind: "tailnet" });
    } finally {
      process.env.PATH = ORIGINAL_PATH;
    }

    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as PaperclipConfig;
    expect(raw.server.exposure).toBe("private");
    expect(raw.server.bind).toBe("tailnet");
    expect(raw.server.host).toBe("127.0.0.1");
  });

  it("rejects the retired deployment-mode environment input", async () => {
    const configPath = createFreshConfigPath();
    process.env.PAPERCLIP_DEPLOYMENT_MODE = "authenticated"; // paperclip:canonical-human-auth-removal-proof

    await expect(
      onboard({ config: configPath, yes: true, invokedByRun: true }),
    ).rejects.toThrow(/PAPERCLIP_DEPLOYMENT_MODE is unsupported/); // paperclip:canonical-human-auth-removal-proof
    expect(fs.existsSync(configPath)).toBe(false);
  });
});
