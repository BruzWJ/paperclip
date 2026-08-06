import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { PaperclipConfig } from "@paperclipai/shared";

const mocks = vi.hoisted(() => ({
  createDb: vi.fn(),
  resolveDatabaseTarget: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
  logMessage: vi.fn(),
  logSuccess: vi.fn(),
}));

vi.mock("@paperclipai/db", () => ({
  createDb: mocks.createDb,
  resolveDatabaseTarget: mocks.resolveDatabaseTarget,
}));

vi.mock("@clack/prompts", () => ({
  log: {
    error: mocks.logError,
    info: mocks.logInfo,
    message: mocks.logMessage,
    success: mocks.logSuccess,
  },
}));

vi.mock("picocolors", () => ({
  default: {
    cyan: (value: string) => value,
    dim: (value: string) => value,
  },
}));

import {
  bootstrapAdminInvite,
  issueBootstrapAdminCapability,
} from "../commands/auth-bootstrap-admin.js";

const ORIGINAL_ENV = { ...process.env };
const tempRoots: string[] = [];

type StoredInvite = {
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
};

function makeConfig(input: {
  exposure: "private" | "public";
  publicBaseUrl?: string;
}): PaperclipConfig {
  const root = path.join(os.tmpdir(), "paperclip-bootstrap-admin-runtime");
  return {
    $meta: {
      version: 1,
      updatedAt: "2026-08-02T00:00:00.000Z",
      source: "configure",
    },
    database: {
      connectionString: "postgresql://paperclip.invalid/paperclip"
    },
    logging: { mode: "file", logDir: path.join(root, "logs") },
    server: {
      exposure: input.exposure,
      bind: input.exposure === "public" ? "lan" : "loopback",
      host: input.exposure === "public" ? "0.0.0.0" : "127.0.0.1",
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    },
    auth: {
      disableSignUp: false,
      ...(input.publicBaseUrl ? { publicBaseUrl: input.publicBaseUrl } : {}),
    },
    telemetry: { enabled: true },
    storage: {
      provider: "local_disk",
      localDisk: { baseDir: path.join(root, "storage") },
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
      localEncrypted: { keyFilePath: path.join(root, "master.key") },
    },
  };
}

function writeConfig(config: PaperclipConfig | Record<string, unknown>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-bootstrap-admin-"));
  tempRoots.push(root);
  const configPath = path.join(root, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}

function makeTransactionalDb(input?: {
  adminUserIds?: string[];
  failInsert?: boolean;
  activeInvites?: StoredInvite[];
}) {
  const operations: string[] = [];
  const state = {
    invites: (input?.activeInvites ?? []).map((invite) => ({ ...invite })),
  };

  const tx = {
    execute: vi.fn(async () => {
      operations.push("lock");
    }),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => {
          operations.push("eligibility");
          return (input?.adminUserIds ?? []).map((userId) => ({ userId }));
        }),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: { revokedAt: Date }) => ({
        where: vi.fn(async () => {
          operations.push("revoke");
          for (const invite of state.invites) {
            if (!invite.revokedAt) invite.revokedAt = values.revokedAt;
          }
          return [];
        }),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((values: { tokenHash: string; expiresAt: Date }) => ({
        returning: vi.fn(async () => {
          operations.push("insert");
          if (input?.failInsert) throw new Error("simulated insert failure");
          state.invites.push({
            tokenHash: values.tokenHash,
            expiresAt: values.expiresAt,
            revokedAt: null,
          });
          return [{ expiresAt: values.expiresAt }];
        }),
      })),
    })),
  };

  const db = {
    transaction: vi.fn(async (operation: (transaction: typeof tx) => Promise<unknown>) => {
      operations.push("begin");
      const snapshot = state.invites.map((invite) => ({ ...invite }));
      try {
        const result = await operation(tx);
        operations.push("commit");
        return result;
      } catch (error) {
        state.invites.splice(0, state.invites.length, ...snapshot);
        operations.push("rollback");
        throw error;
      }
    }),
    $client: { end: vi.fn(async () => undefined) },
  };

  return { db: db as unknown as Db, operations, state, tx };
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.PAPERCLIP_PUBLIC_URL;
  vi.clearAllMocks();
  mocks.resolveDatabaseTarget.mockReturnValue({
    connectionString: "postgresql://paperclip.invalid/paperclip",
  });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("bootstrap admin origin validation", () => {
  it.each([
    {
      name: "missing",
      config: makeConfig({ exposure: "public" }),
      explicitBaseUrl: undefined,
      environmentPublicUrl: undefined,
      expected: /publicBaseUrl is required/,
    },
    {
      name: "invalid",
      config: makeConfig({ exposure: "public", publicBaseUrl: "not a URL" }),
      explicitBaseUrl: undefined,
      environmentPublicUrl: undefined,
      expected: /valid (?:HTTPS )?URL/,
    },
    {
      name: "conflicting",
      config: makeConfig({
        exposure: "public",
        publicBaseUrl: "https://paperclip.example.test",
      }),
      explicitBaseUrl: "https://other.example.test",
      environmentPublicUrl: undefined,
      expected: /must match the canonical public URL/,
    },
    {
      name: "insecure",
      config: makeConfig({
        exposure: "public",
        publicBaseUrl: "http://paperclip.example.test",
      }),
      explicitBaseUrl: undefined,
      environmentPublicUrl: undefined,
      expected: /must use https:\/\//,
    },
    {
      name: "environment-conflicting",
      config: makeConfig({
        exposure: "public",
        publicBaseUrl: "https://paperclip.example.test",
      }),
      explicitBaseUrl: undefined,
      environmentPublicUrl: "https://other.example.test",
      expected: /must match the canonical public URL/,
    },
    {
      name: "private-with-explicit-public",
      config: makeConfig({ exposure: "private" }),
      explicitBaseUrl: "https://paperclip.example.test",
      environmentPublicUrl: undefined,
      expected: /Private exposure derives its auth origin from requests/,
    },
  ])("makes no database change for a $name origin configuration", async (testCase) => {
    const fake = makeTransactionalDb({
      activeInvites: [{
        tokenHash: "prior-hash",
        expiresAt: new Date("2027-01-01T00:00:00.000Z"),
        revokedAt: null,
      }],
    });
    mocks.createDb.mockReturnValue(fake.db);
    if (testCase.environmentPublicUrl) {
      process.env.PAPERCLIP_PUBLIC_URL = testCase.environmentPublicUrl;
    }

    await expect(bootstrapAdminInvite({
      config: writeConfig(testCase.config),
      baseUrl: testCase.explicitBaseUrl,
    })).rejects.toThrow(testCase.expected);

    expect(mocks.createDb).not.toHaveBeenCalled();
    expect(fake.operations).toEqual([]);
    expect(fake.tx.update).not.toHaveBeenCalled();
    expect(fake.tx.insert).not.toHaveBeenCalled();
    expect(fake.state.invites).toEqual([expect.objectContaining({
      tokenHash: "prior-hash",
      revokedAt: null,
    })]);
  });
});

describe("bootstrap admin capability transaction", () => {
  it("rolls prior revocation back when the replacement insert fails", async () => {
    const priorInvite: StoredInvite = {
      tokenHash: "prior-hash",
      expiresAt: new Date("2027-01-01T00:00:00.000Z"),
      revokedAt: null,
    };
    const fake = makeTransactionalDb({ activeInvites: [priorInvite], failInsert: true });

    await expect(issueBootstrapAdminCapability(fake.db, {
      tokenHash: "replacement-hash",
      now: new Date("2026-08-02T00:00:00.000Z"),
      expiresAt: new Date("2026-08-05T00:00:00.000Z"),
    })).rejects.toThrow("simulated insert failure");

    expect(fake.operations).toEqual([
      "begin",
      "lock",
      "lock",
      "eligibility",
      "revoke",
      "insert",
      "rollback",
    ]);
    expect(fake.state.invites).toEqual([priorInvite]);
  });

  it("commits the replacement before printing its usable URL", async () => {
    const fake = makeTransactionalDb({
      activeInvites: [{
        tokenHash: "prior-hash",
        expiresAt: new Date("2027-01-01T00:00:00.000Z"),
        revokedAt: null,
      }],
    });
    mocks.createDb.mockReturnValue(fake.db);
    mocks.logSuccess.mockImplementation(() => {
      fake.operations.push("print");
    });

    await bootstrapAdminInvite({
      config: writeConfig(makeConfig({
        exposure: "public",
        publicBaseUrl: "https://paperclip.example.test/",
      })),
    });

    expect(fake.operations).toEqual([
      "begin",
      "lock",
      "lock",
      "eligibility",
      "revoke",
      "insert",
      "commit",
      "print",
    ]);
    expect(fake.state.invites).toHaveLength(2);
    expect(fake.state.invites[0]?.revokedAt).toBeInstanceOf(Date);
    expect(fake.state.invites[1]).toMatchObject({ revokedAt: null });
    expect(fake.state.invites[1]?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(mocks.logMessage).toHaveBeenCalledWith(
      expect.stringMatching(/^Invite URL: https:\/\/paperclip\.example\.test\/invite\/pcp_bootstrap_[a-f0-9]{48}$/),
    );
  });

  it("does not revoke or insert after an administrator already exists", async () => {
    const fake = makeTransactionalDb({ adminUserIds: ["admin-user"] });

    await expect(issueBootstrapAdminCapability(fake.db, {
      tokenHash: "unused-hash",
      now: new Date("2026-08-02T00:00:00.000Z"),
      expiresAt: new Date("2026-08-05T00:00:00.000Z"),
    })).resolves.toEqual({ status: "closed" });

    expect(fake.operations).toEqual([
      "begin",
      "lock",
      "lock",
      "eligibility",
      "commit",
    ]);
    expect(fake.tx.update).not.toHaveBeenCalled();
    expect(fake.tx.insert).not.toHaveBeenCalled();
  });
});
