import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const databaseMocks = vi.hoisted(() => ({
  createDb: vi.fn(() => {
    throw new Error("Unexpected database access from secrets test");
  }),
  resolveDatabaseTarget: vi.fn(() => {
    throw new Error("Unexpected database target resolution from secrets test");
  }),
}));

vi.mock("@paperclipai/db", () => ({
  createDb: databaseMocks.createDb,
  resolveDatabaseTarget: databaseMocks.resolveDatabaseTarget,
}));

import type { PaperclipConfig } from "../config/schema.js";
import { secretsCheck } from "../checks/secrets-check.js";
import {
  parseSecretsInclude,
  registerSecretCommands,
} from "../commands/client/secrets.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

function configWithSecretsProvider(provider: PaperclipConfig["secrets"]["provider"]): PaperclipConfig {
  return {
    $meta: {
      version: 1,
      updatedAt: "2026-05-02T00:00:00.000Z",
      source: "configure",
    },
    database: {
      connectionString: "postgresql://operator:secret@database.example.com/paperclip"
    },
    logging: {
      mode: "file",
      logDir: "/tmp/paperclip/logs",
    },
    server: {
      exposure: "private",
      bind: "loopback",
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
        baseDir: "/tmp/paperclip/storage",
      },
      s3: {
        bucket: "paperclip",
        region: "us-east-1",
        prefix: "",
        forcePathStyle: false,
      },
    },
    secrets: {
      provider,
      strictMode: true,
      localEncrypted: {
        keyFilePath: "/tmp/paperclip/secrets/master.key",
      },
    },
  };
}

describe("secrets CLI helpers", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.PAPERCLIP_SECRETS_AWS_REGION;
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    delete process.env.PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID;
    delete process.env.PAPERCLIP_SECRETS_AWS_KMS_KEY_ID;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("parses declaration include filters", () => {
    expect(parseSecretsInclude("company,projects")).toEqual({
      company: true,
      agents: false,
      projects: true,
      tasks: false,
    });
  });

  it.each([
    "",
    " company",
    "projects ",
    "Company",
    ",company",
    "company,",
    "company,,projects",
    "company,company",
    "agents",
  ])("rejects a non-canonical declaration selector list (%j)", (input) => {
    expect(() => parseSecretsInclude(input)).toThrow(
      "Use a non-empty, duplicate-free comma-separated subset of: company,projects",
    );
  });

  it("reports the AWS bootstrap config required by doctor", () => {
    const result = secretsCheck(configWithSecretsProvider("aws_secrets_manager"));

    expect(result.status).toBe("fail");
    expect(result.message).toContain("PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID");
    expect(result.guidance).toContain("AWS SDK default credential chain");
    expect(result.guidance).toContain("Do not store AWS root credentials");
  });

  it("passes AWS doctor checks when non-secret provider config is present", () => {
    process.env.PAPERCLIP_SECRETS_AWS_REGION = "us-east-1";
    process.env.PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID = "prod-us-1";
    process.env.PAPERCLIP_SECRETS_AWS_KMS_KEY_ID =
      "arn:aws:kms:us-east-1:123456789012:key/test";
    process.env.AWS_PROFILE = "paperclip-prod";

    const result = secretsCheck(configWithSecretsProvider("aws_secrets_manager"));

    expect(result.status).toBe("pass");
    expect(result.message).toContain("prod-us-1");
    expect(result.message).toContain("AWS_PROFILE/shared config");
  });
});

describe("secrets API parity commands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_BOARD_API_KEY;
    delete process.env.PAPERCLIP_BOARD_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("wraps provider config and remote import endpoints", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await runSecretCommand(["secrets", "provider-configs", "--company-id", COMPANY_ID]);
    await runSecretCommand(["secrets", "provider-config:create", "--company-id", COMPANY_ID, "--payload-json", "{}"]);
    await runSecretCommand(["secrets", "provider-config:discovery-preview", "--company-id", COMPANY_ID, "--payload-json", "{}"]);
    await runSecretCommand(["secrets", "provider-config:get", "config-1"]);
    await runSecretCommand(["secrets", "provider-config:update", "config-1", "--payload-json", "{}"]);
    await runSecretCommand(["secrets", "provider-config:default", "config-1"]);
    await runSecretCommand(["secrets", "provider-config:health", "config-1"]);
    await runSecretCommand(["secrets", "provider-config:delete", "config-1"]);
    await runSecretCommand(["secrets", "remote-import:preview", "--company-id", COMPANY_ID, "--payload-json", "{}"]);
    await runSecretCommand(["secrets", "remote-import", "--company-id", COMPANY_ID, "--payload-json", "{}"]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/secret-provider-configs`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/secret-provider-configs`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/secret-provider-configs/discovery/preview`],
      ["GET", "http://localhost:3100/api/secret-provider-configs/config-1"],
      ["PATCH", "http://localhost:3100/api/secret-provider-configs/config-1"],
      ["POST", "http://localhost:3100/api/secret-provider-configs/config-1/default"],
      ["POST", "http://localhost:3100/api/secret-provider-configs/config-1/health"],
      ["DELETE", "http://localhost:3100/api/secret-provider-configs/config-1"],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/secrets/remote-import/preview`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/secrets/remote-import`],
    ]);
  });

  it("wraps secret metadata, rotation, usage, access event, and delete endpoints", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await runSecretCommand(["secrets", "update", "secret-1", "--payload-json", "{\"description\":\"updated\"}"]);
    await runSecretCommand(["secrets", "rotate", "secret-1", "--value", "new-value"]);
    await runSecretCommand(["secrets", "usage", "secret-1"]);
    await runSecretCommand(["secrets", "access-events", "secret-1"]);
    await runSecretCommand(["secrets", "delete", "secret-1", "--yes", "--confirm", "secret-1"]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["PATCH", "http://localhost:3100/api/secrets/secret-1"],
      ["POST", "http://localhost:3100/api/secrets/secret-1/rotate"],
      ["GET", "http://localhost:3100/api/secrets/secret-1/usage"],
      ["GET", "http://localhost:3100/api/secrets/secret-1/access-events"],
      ["DELETE", "http://localhost:3100/api/secrets/secret-1"],
    ]);
  });
});

async function runSecretCommand(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerSecretCommands(program);
  await program.parseAsync([...args, "--api-base", "http://localhost:3100", "--api-key", "board-token"], { from: "user" });
}

function jsonResponse(body: unknown = { ok: true }, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), init);
}
