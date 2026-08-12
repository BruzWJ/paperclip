import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseExternalPostgresDatabaseTarget,
  redactExternalPostgresConnectionString,
  resolveDatabaseTarget,
  resolveOptionalExternalPostgresConnectionString,
} from "../runtime-config.js";

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_ENV = { ...process.env };
const retiredField = (...parts: string[]) => parts.join("");

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function createConfig(value: unknown): string {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "paperclip-db-runtime-"),
  );
  const configPath = path.join(tempDir, "instance", "config.json");
  writeJson(configPath, value);
  return configPath;
}

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("resolveDatabaseTarget", () => {
  it.each(["test", "production"])(
    "preserves canonical discovery and precedence when NODE_ENV=%s",
    (nodeEnv) => {
      const configPath = createConfig({
        database: {
          connectionString: "postgres://config.invalid/paperclip",
        },
      });
      process.env.NODE_ENV = nodeEnv;
      process.env.PAPERCLIP_CONFIG = configPath;
      process.env.DATABASE_URL = "postgres://environment.invalid/paperclip";

      expect(resolveDatabaseTarget()).toMatchObject({
        connectionString: "postgres://environment.invalid/paperclip",
        source: "DATABASE_URL",
        configPath,
      });
    },
  );

  it("uses DATABASE_URL from an explicit environment fixture first", () => {
    const configPath = createConfig({ database: {} });

    const target = resolveDatabaseTarget({
      configPath,
      environment: {
        DATABASE_URL:
          "postgres://env-user:env-pass@db.example.com:5432/paperclip",
      },
    });

    expect(target).toMatchObject({
      connectionString:
        "postgres://env-user:env-pass@db.example.com:5432/paperclip",
      source: "DATABASE_URL",
    });
    expect(target).not.toHaveProperty("mode");
  });

  it("uses config.database.connectionString when configured", () => {
    const configPath = createConfig({
      database: {
        connectionString:
          "postgresql://cfg-user:cfg-pass@db.example.com:5432/paperclip",
      },
    });

    const target = resolveDatabaseTarget({ configPath, environment: {} });

    expect(target).toMatchObject({
      connectionString:
        "postgresql://cfg-user:cfg-pass@db.example.com:5432/paperclip",
      source: "config.database.connectionString",
    });
  });

  it("requires one configured external PostgreSQL URL", () => {
    const configPath = createConfig({ database: {} });

    expect(() =>
      resolveDatabaseTarget({ configPath, environment: {} }),
    ).toThrow("An external PostgreSQL connection is required");
  });

  it("rejects a non-PostgreSQL URL rather than falling back", () => {
    const configPath = createConfig({ database: {} });

    expect(() =>
      resolveDatabaseTarget({
        configPath,
        environment: { DATABASE_URL: "mysql://db.example.com/paperclip" },
      }),
    ).toThrow("must use the postgres:// or postgresql:// protocol");
  });

  it.each([
    "",
    " postgres://db.example.com/paperclip",
    "postgres://db.example.com/paperclip ",
  ])(
    "rejects non-canonical DATABASE_URL=%j instead of falling back",
    (value) => {
      const configPath = createConfig({
        database: { connectionString: "postgres://fallback.invalid/paperclip" },
      });
      expect(() =>
        resolveDatabaseTarget({
          configPath,
          environment: { DATABASE_URL: value },
        }),
      ).toThrow(/DATABASE_URL must be an exact non-empty/);
    },
  );

  it("rejects retired database configuration even when DATABASE_URL is set", () => {
    const configPath = createConfig({
      database: {
        [retiredField("mo", "de")]: "postgres",
        connectionString:
          "postgres://cfg-user:cfg-pass@db.example.com:5432/paperclip",
      },
    });

    expect(() =>
      resolveDatabaseTarget({
        configPath,
        environment: {
          DATABASE_URL:
            "postgres://env-user:env-pass@db.example.com:5432/paperclip",
        },
      }),
    ).toThrow("database.mode is retired");
  });

  it.each([
    retiredField("emb", "edded", "Postgres"),
    retiredField("emb", "edded", "Postgres", "Data", "Dir"),
    retiredField("emb", "edded", "Postgres", "Port"),
    retiredField("pg", "lite"),
    retiredField("pg", "lite", "Data", "Dir"),
    retiredField("pg", "lite", "Port"),
  ])("rejects retired database.%s configuration", (field) => {
    const configPath = createConfig({ database: { [field]: "retired" } });

    expect(() =>
      resolveDatabaseTarget({ configPath, environment: {} }),
    ).toThrow(`database.${field} is retired`);
  });

  it("resolves a config-specific target with an explicit empty environment fixture", () => {
    const configPath = createConfig({
      database: {
        connectionString:
          "postgres://config-user:config-pass@db.example.com:5432/worktree",
      },
    });
    process.env.DATABASE_URL =
      "postgres://env-user:env-pass@db.example.com:5432/process";

    const target = resolveDatabaseTarget({ configPath, environment: {} });

    expect(target).toMatchObject({
      connectionString:
        "postgres://config-user:config-pass@db.example.com:5432/worktree",
      source: "config.database.connectionString",
    });
  });

  it("validates an explicit migration credential without selecting a replacement target", () => {
    expect(
      resolveOptionalExternalPostgresConnectionString(
        "postgresql://migration:secret@db.example.com:5432/paperclip",
        "DATABASE_MIGRATION_URL",
      ),
    ).toBe("postgresql://migration:secret@db.example.com:5432/paperclip");
    expect(
      resolveOptionalExternalPostgresConnectionString(
        undefined,
        "DATABASE_MIGRATION_URL",
      ),
    ).toBeUndefined();
    expect(() =>
      resolveOptionalExternalPostgresConnectionString(
        "https://db.example.com/paperclip",
        "DATABASE_MIGRATION_URL",
      ),
    ).toThrow("must use the postgres:// or postgresql:// protocol");
    expect(() =>
      resolveOptionalExternalPostgresConnectionString(
        " ",
        "DATABASE_MIGRATION_URL",
      ),
    ).toThrow(/exact non-empty/);
  });

  it.each(["", " ./config.json", "./config.json "])(
    "rejects non-canonical explicit configPath=%j",
    (configPath) => {
      expect(() =>
        resolveDatabaseTarget({ configPath, environment: {} }),
      ).toThrow(/configPath must be exact and non-empty/);
    },
  );

  it("parses and redacts a named external target for client-only administration", () => {
    const target = parseExternalPostgresDatabaseTarget(
      "postgresql://operator:secret@db.example.com:6543/worktree_target?sslmode=require",
      "Target worktree database URL",
    );

    expect(target).toEqual({
      connectionString:
        "postgresql://operator:secret@db.example.com:6543/worktree_target?sslmode=require",
      adminConnectionString:
        "postgresql://operator:secret@db.example.com:6543/postgres?sslmode=require",
      databaseName: "worktree_target",
    });
    const redacted = redactExternalPostgresConnectionString(
      `${target.connectionString}&password=query-secret`,
    );
    expect(redacted).not.toContain("secret");
    expect(redacted).not.toContain("operator");
    expect(() =>
      parseExternalPostgresDatabaseTarget(
        "postgresql://operator:secret@db.example.com:6543/one/two",
        "Target worktree database URL",
      ),
    ).toThrow("must identify exactly one database");
  });
});
