import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runDatabaseRestore: vi.fn(),
  validateExternalPostgresConnectionString: vi.fn(
    (value: string) => value.trim(),
  ),
  printPaperclipCliBanner: vi.fn(),
  intro: vi.fn(),
  outro: vi.fn(),
  logMessage: vi.fn(),
  logSuccess: vi.fn(),
}));

vi.mock("@paperclipai/db", () => ({
  runDatabaseRestore: mocks.runDatabaseRestore,
  validateExternalPostgresConnectionString:
    mocks.validateExternalPostgresConnectionString,
}));

vi.mock("@clack/prompts", () => ({
  intro: mocks.intro,
  outro: mocks.outro,
  log: {
    message: mocks.logMessage,
    success: mocks.logSuccess,
  },
}));

vi.mock("picocolors", () => ({
  default: {
    bgCyan: (value: string) => value,
    black: (value: string) => value,
    green: (value: string) => value,
  },
}));

vi.mock("../utils/banner.js", () => ({
  printPaperclipCliBanner: mocks.printPaperclipCliBanner,
}));

import { dbRestoreCommand } from "../commands/db-restore.js";

const RESTORE_RESULT = {
  manifestFormat: "paperclip-postgresql-disaster-recovery" as const,
  manifestFormatVersion: 1 as const,
  payloadChecksum: "a".repeat(64),
  sourceDatabaseIdentity: {
    clusterSystemIdentifier: "7312345678901234567",
    databaseOid: "16384",
    databaseName: "paperclip_source",
  },
  targetDatabaseIdentity: {
    clusterSystemIdentifier: "7312345678901234567",
    databaseOid: "16385",
    databaseName: "paperclip_restore",
  },
  restoredMigrationJournal: [
    { hash: "b".repeat(64), createdAt: "1776388800000" },
  ],
  appliedForwardMigrations: [
    { hash: "c".repeat(64), createdAt: "1776388860000" },
  ],
  finalMigrationJournal: [
    { hash: "b".repeat(64), createdAt: "1776388800000" },
    { hash: "c".repeat(64), createdAt: "1776388860000" },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runDatabaseRestore.mockResolvedValue(RESTORE_RESULT);
});

describe("dbRestoreCommand", () => {
  it("passes only the four explicit inputs and prints only the redacted result as JSON", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await dbRestoreCommand({
      databaseUrl:
        "postgres://restore-user:restore-password@restore.example/paperclip",
      backupFile: "./backup.dump",
      manifestFile: "./backup.manifest.json",
      betterAuthSecretFile: "./better-auth-secret",
      json: true,
    });

    expect(mocks.runDatabaseRestore).toHaveBeenCalledWith({
      connectionString:
        "postgres://restore-user:restore-password@restore.example/paperclip",
      backupFile: path.resolve("./backup.dump"),
      manifestFile: path.resolve("./backup.manifest.json"),
      betterAuthSecretFile: path.resolve("./better-auth-secret"),
    });
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(
      RESTORE_RESULT,
    );
    expect(mocks.printPaperclipCliBanner).not.toHaveBeenCalled();
    expect(mocks.intro).not.toHaveBeenCalled();
    expect(mocks.outro).not.toHaveBeenCalled();
  });

  it("prints verified identities without printing URL, credentials, or secret bytes", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await dbRestoreCommand({
      databaseUrl:
        "postgres://restore-user:restore-password@restore.example/paperclip",
      backupFile: "./backup.dump",
      manifestFile: "./backup.manifest.json",
      betterAuthSecretFile: "./super-secret-file-name",
    });

    const output = JSON.stringify([
      ...mocks.logMessage.mock.calls,
      ...mocks.logSuccess.mock.calls,
      ...mocks.outro.mock.calls,
      ...log.mock.calls,
    ]);
    expect(output).toContain("paperclip_source");
    expect(output).toContain("paperclip_restore");
    expect(output).toContain("Restored migration journal");
    expect(output).not.toContain("Lineage");
    expect(output).not.toContain("restore-password");
    expect(output).not.toContain("postgres://");
    expect(output).not.toContain("super-secret-file-name");
  });

  it("rejects empty explicit file inputs without calling restore", async () => {
    await expect(
      dbRestoreCommand({
        databaseUrl: "postgres://restore.example/paperclip",
        backupFile: " ",
        manifestFile: "./backup.manifest.json",
        betterAuthSecretFile: "./better-auth-secret",
        json: true,
      }),
    ).rejects.toThrow("--backup-file");
    expect(mocks.runDatabaseRestore).not.toHaveBeenCalled();
  });
});

describe("db:restore registration and ownership", () => {
  const repositoryRoot = fileURLToPath(
    new URL("../../../..", import.meta.url),
  );

  it("registers exactly the four required options plus optional --json", () => {
    const indexSource = fs.readFileSync(
      path.join(repositoryRoot, "packages/cli/src/index.ts"),
      "utf8",
    );
    const commandBlock = indexSource.match(
      /program\s*\n\s*\.command\("db:restore"\)([\s\S]*?)\nprogram\s*\n\s*\.command\("allowed-hostname"\)/,
    )?.[1];

    expect(commandBlock).toBeDefined();
    expect(commandBlock?.match(/\.requiredOption\(/g)).toHaveLength(4);
    for (const option of [
      "--database-url <url>",
      "--backup-file <path>",
      "--manifest-file <path>",
      "--better-auth-secret-file <path>",
    ]) {
      expect(commandBlock).toContain(option);
    }
    expect(commandBlock?.match(/\.option\(/g)).toHaveLength(1);
    expect(commandBlock).toContain('.option("--json"');
    expect(commandBlock).not.toContain("--config");
    expect(commandBlock).not.toContain("--data-dir");
  });

  it("keeps db:restore as the sole production runDatabaseRestore caller", () => {
    const roots = ["packages", "apps/server/src", "scripts"];
    const callers: string[] = [];

    const visit = (absoluteDirectory: string): void => {
      for (const entry of fs.readdirSync(absoluteDirectory, {
        withFileTypes: true,
      })) {
        if (
          entry.name === "node_modules" ||
          entry.name === "dist" ||
          entry.name.startsWith(".")
        ) {
          continue;
        }
        const absolutePath = path.join(absoluteDirectory, entry.name);
        if (entry.isDirectory()) {
          visit(absolutePath);
          continue;
        }
        if (
          !/\.(?:ts|tsx|js|mjs)$/.test(entry.name) ||
          /\.(?:test|spec)\.(?:ts|tsx|js|mjs)$/.test(entry.name)
        ) {
          continue;
        }
        const relativePath = path
          .relative(repositoryRoot, absolutePath)
          .replaceAll(path.sep, "/");
        if (relativePath === "packages/db/backup-lib.ts") continue;
        const source = fs.readFileSync(absolutePath, "utf8");
        if (/\brunDatabaseRestore\s*\(/.test(source)) {
          callers.push(relativePath);
        }
      }
    };

    for (const root of roots) {
      const absoluteRoot = path.join(repositoryRoot, root);
      if (fs.existsSync(absoluteRoot)) visit(absoluteRoot);
    }
    expect(callers.sort()).toEqual(["packages/cli/src/commands/db-restore.ts"]);
  });
});
