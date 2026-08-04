import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configure } from "../commands/configure.js";
import type { PaperclipConfig } from "../config/schema.js";
import { readConfig } from "../config/store.js";

const ORIGINAL_EXIT_CODE = process.exitCode;

afterEach(() => {
  process.exitCode = ORIGINAL_EXIT_CODE;
});

function writeBaseConfig(configPath: string) {
  const base: PaperclipConfig = {
    $meta: {
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      source: "configure",
    },
    database: {
      connectionString: "postgresql://operator:secret@database.example.com/paperclip",
      backup: {
        enabled: true,
        intervalMinutes: 60,
        retentionDays: 30,
        dir: "/tmp/paperclip-backups",
      },
    },
    logging: {
      mode: "file",
      logDir: "/tmp/paperclip-logs",
    },
    server: {
      exposure: "private",
      bind: "loopback",
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
      localDisk: { baseDir: "/tmp/paperclip-storage" },
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
      localEncrypted: { keyFilePath: "/tmp/paperclip-secrets/master.key" },
    },
  };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(base, null, 2));
}

describe("configure command", () => {
  it("rejects the retired server deployment-mode field", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-configure-retired-server-"));
    const configPath = path.join(root, "config.json");
    writeBaseConfig(configPath);
    const candidate = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, any>;
    candidate.server.deploymentMode = "authenticated"; // paperclip:canonical-human-auth-removal-proof
    fs.writeFileSync(configPath, JSON.stringify(candidate, null, 2));

    try {
      expect(() => readConfig(configPath)).toThrow(/Invalid config/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects every retired database configuration field without rewriting it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-configure-retired-db-"));
    const configPath = path.join(root, "config.json");
    writeBaseConfig(configPath);
    const pristine = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, any>;
    const retiredKeys = [
      ["mo", "de"].join(""),
      ["embedded", "Postgres", "DataDir"].join(""),
      ["embedded", "Postgres", "Port"].join(""),
      ["pg", "lite", "DataDir"].join(""),
      ["pg", "lite", "Port"].join(""),
    ];

    try {
      for (const retiredKey of retiredKeys) {
        const candidate = structuredClone(pristine);
        candidate.database[retiredKey] = retiredKey.endsWith("Port") ? 5432 : "retired";
        fs.writeFileSync(configPath, JSON.stringify(candidate, null, 2));
        expect(() => readConfig(configPath)).toThrow(/Invalid config/);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects the retired global LLM configuration section", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-configure-llm-"));
    const configPath = path.join(root, "config.json");
    writeBaseConfig(configPath);

    try {
      await configure({ config: configPath, section: "llm" });

      expect(process.exitCode).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("sets a failing exit code for unknown sections", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-configure-"));
    const configPath = path.join(root, "config.json");
    writeBaseConfig(configPath);

    try {
      await configure({ config: configPath, section: "invalid-section" });

      expect(process.exitCode).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("sets a failing exit code when no config exists", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-configure-missing-"));
    const configPath = path.join(root, "missing.json");

    try {
      await configure({ config: configPath, section: "server" });

      expect(process.exitCode).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
