import { afterEach, describe, expect, it, vi } from "vitest";

const databaseMocks = vi.hoisted(() => ({
  createDb: vi.fn(() => {
    throw new Error("Unexpected database access from auth diagnostics test");
  }),
  resolveDatabaseTarget: vi.fn(() => {
    throw new Error("Unexpected database target resolution from auth diagnostics test");
  }),
}));

vi.mock("@paperclipai/db", () => ({
  createDb: databaseMocks.createDb,
  resolveDatabaseTarget: databaseMocks.resolveDatabaseTarget,
}));

import { authCheck } from "../checks/auth-check.js";
import type { PaperclipConfig } from "../config/schema.js";

const ORIGINAL_SECRET = process.env.BETTER_AUTH_SECRET;

function config(overrides?: {
  exposure?: PaperclipConfig["server"]["exposure"];
  bind?: PaperclipConfig["server"]["bind"];
  host?: string;
  publicBaseUrl?: string;
}): PaperclipConfig {
  return {
    $meta: {
      version: 1,
      updatedAt: "2026-07-29T00:00:00.000Z",
      source: "configure",
    },
    database: {
      connectionString: "postgresql://operator:secret@database.example.com/paperclip",
      backup: {
        enabled: true,
        intervalMinutes: 60,
        retentionDays: 30,
        dir: "/tmp/paperclip/backups",
      },
    },
    logging: {
      mode: "file",
      logDir: "/tmp/paperclip/logs",
    },
    server: {
      exposure: overrides?.exposure ?? "private",
      bind: overrides?.bind ?? "loopback",
      host: overrides?.host ?? "127.0.0.1",
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    },
    auth: {
      disableSignUp: false,
      ...(overrides?.publicBaseUrl ? { publicBaseUrl: overrides.publicBaseUrl } : {}),
    },
    telemetry: { enabled: false },
    storage: {
      provider: "local_disk",
      localDisk: { baseDir: "/tmp/paperclip/storage" },
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
      localEncrypted: { keyFilePath: "/tmp/paperclip/secrets/master.key" },
    },
  };
}

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) {
    delete process.env.BETTER_AUTH_SECRET;
  } else {
    process.env.BETTER_AUTH_SECRET = ORIGINAL_SECRET;
  }
});

describe("canonical Better Auth diagnostics", () => {
  it("requires a durable secret even on private loopback", () => {
    delete process.env.BETTER_AUTH_SECRET;

    expect(authCheck(config())).toMatchObject({
      status: "fail",
      message: "BETTER_AUTH_SECRET is required",
    });
  });

  it("accepts the canonical auth path on private loopback", () => {
    process.env.BETTER_AUTH_SECRET = "test-better-auth-secret";

    expect(authCheck(config())).toMatchObject({
      name: "Authentication",
      status: "pass",
    });
  });

  it("requires an explicit public URL for public exposure", () => {
    process.env.BETTER_AUTH_SECRET = "test-better-auth-secret";

    expect(
      authCheck(
        config({
          exposure: "public",
          bind: "lan",
          host: "0.0.0.0",
        }),
      ),
    ).toMatchObject({
      status: "fail",
      message: "Public exposure requires auth.publicBaseUrl",
    });
  });

  it("fails public HTTP origins instead of warning", () => {
    process.env.BETTER_AUTH_SECRET = "test-better-auth-secret";

    expect(
      authCheck(
        config({
          exposure: "public",
          bind: "lan",
          host: "0.0.0.0",
          publicBaseUrl: "http://paperclip.example",
        }),
      ),
    ).toMatchObject({
      status: "fail",
      message: "Invalid auth.publicBaseUrl: Public origin must use https://",
    });
  });

  it("does not accept a configured public origin for private exposure", () => {
    process.env.BETTER_AUTH_SECRET = "test-better-auth-secret";

    expect(authCheck(config({ publicBaseUrl: "https://paperclip.example" }))).toMatchObject({
      status: "fail",
      message: "Private exposure derives its auth origin from each request",
    });
  });
});
