import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyRuntimeServerPortSelectionToConfig,
  maybePersistWorktreeServerPort,
} from "../worktree-config.js";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_CWD = process.cwd();

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PAPERCLIP_")) delete process.env[key];
  }
});

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }
});

function buildExternalConfig(
  root: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    $meta: {
      version: 1,
      updatedAt: "2026-07-28T00:00:00.000Z",
      source: "configure",
    },
    database: {
      connectionString:
        "postgres://worktree:secret@db.example.test:5432/paperclip_worktree",
      backup: {
        enabled: true,
        intervalMinutes: 60,
        retentionDays: 30,
        dir: path.join(root, "data", "backups"),
      },
    },
    logging: {
      mode: "file",
      logDir: path.join(root, "logs"),
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
    storage: {
      provider: "local_disk",
      localDisk: { baseDir: path.join(root, "data", "storage") },
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
      localEncrypted: { keyFilePath: path.join(root, "secrets", "master.key") },
    },
    ...overrides,
  };
}

function configureWorktree(tempRoot: string, config: unknown) {
  const worktreeRoot = path.join(tempRoot, "worktree");
  const paperclipDir = path.join(worktreeRoot, ".paperclip");
  const configPath = path.join(paperclipDir, "config.json");
  const envPath = path.join(paperclipDir, ".env");
  fs.mkdirSync(paperclipDir, { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  fs.writeFileSync(
    envPath,
    ["PAPERCLIP_IN_WORKTREE=true", "PAPERCLIP_WORKTREE_NAME=worktree", ""].join(
      "\n",
    ),
  );

  process.chdir(worktreeRoot);
  process.env.PAPERCLIP_IN_WORKTREE = "true";
  process.env.PAPERCLIP_WORKTREE_NAME = "worktree";
  process.env.PAPERCLIP_CONFIG = configPath;
  process.env.PAPERCLIP_WORKTREES_DIR = path.join(tempRoot, "instances-home");
  delete process.env.PAPERCLIP_HOME;
  delete process.env.PORT;

  return { worktreeRoot, configPath, envPath };
}

describe("worktree configuration", () => {
  it("persists only a selected server port and preserves the database target", () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "paperclip-worktree-config-"),
    );
    try {
      const { configPath } = configureWorktree(
        tempRoot,
        buildExternalConfig(
          path.join(tempRoot, "instances-home", "instances", "worktree"),
        ),
      );

      maybePersistWorktreeServerPort({ serverPort: 3999 });

      const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
      expect(written.server.port).toBe(3999);
      expect(written.auth.publicBaseUrl).toBeUndefined();
      expect(written.database.connectionString).toBe(
        "postgres://worktree:secret@db.example.test:5432/paperclip_worktree",
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not persist a detected server port when PORT is explicit", () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "paperclip-worktree-config-"),
    );
    try {
      const { configPath } = configureWorktree(
        tempRoot,
        buildExternalConfig(
          path.join(tempRoot, "instances-home", "instances", "worktree"),
        ),
      );
      process.env.PORT = "4100";

      maybePersistWorktreeServerPort({ serverPort: 3999 });

      expect(JSON.parse(fs.readFileSync(configPath, "utf8")).server.port).toBe(
        3100,
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("updates only the server-facing values when selecting a runtime port", () => {
    const config = buildExternalConfig("/tmp/paperclip-worktree");
    const result = applyRuntimeServerPortSelectionToConfig(config as never, {
      serverPort: 4567,
    });

    expect(result.changed).toBe(true);
    expect(result.config.server.port).toBe(4567);
    expect(result.config.auth.publicBaseUrl).toBeUndefined();
    expect(result.config.database.connectionString).toBe(
      "postgres://worktree:secret@db.example.test:5432/paperclip_worktree",
    );
  });
});
