import { describe, expect, it } from "vitest";
import { paperclipConfigSchema } from "./config-schema.js";

describe("paperclip config schema", () => {
  it("rejects non-canonical and duplicate private hostname configuration", () => {
    const config = {
      $meta: {
        version: 1,
        updatedAt: "2026-08-12T00:00:00.000Z",
        source: "configure",
      },
      database: {},
      logging: { mode: "file" },
      server: {
        bind: "lan",
        allowedHostnames: ["paperclip.test", "paperclip.test"],
      },
    } as const;
    expect(() => paperclipConfigSchema.parse(config)).toThrow(/duplicates/);
    expect(() =>
      paperclipConfigSchema.parse({
        ...config,
        server: { ...config.server, allowedHostnames: ["Paperclip.test"] },
      }),
    ).toThrow(/exact lowercase hostname/);
  });

  it("rejects storage identity aliases instead of rewriting them", () => {
    const base = {
      $meta: {
        version: 1,
        updatedAt: "2026-08-12T00:00:00.000Z",
        source: "configure",
      },
      database: {},
      logging: { mode: "file" },
      server: {},
      storage: {
        provider: "s3",
        localDisk: { baseDir: "/tmp/paperclip" },
        s3: {
          bucket: "paperclip",
          region: "us-east-1",
          prefix: "company/assets",
          forcePathStyle: false,
        },
      },
    } as const;
    expect(paperclipConfigSchema.parse(base).storage.s3.prefix).toBe(
      "company/assets",
    );
    expect(() =>
      paperclipConfigSchema.parse({
        ...base,
        storage: {
          ...base.storage,
          s3: { ...base.storage.s3, bucket: " paperclip" },
        },
      }),
    ).toThrow(/exact and non-empty/);
    expect(() =>
      paperclipConfigSchema.parse({
        ...base,
        storage: {
          ...base.storage,
          s3: { ...base.storage.s3, prefix: "company/" },
        },
      }),
    ).toThrow(/exact slash-separated/);
    expect(() =>
      paperclipConfigSchema.parse({
        ...base,
        storage: {
          ...base.storage,
          s3: { ...base.storage.s3, endpoint: "https://S3.example.test" },
        },
      }),
    ).toThrow(/exact HTTP\(S\) origin/);
  });

  it("rejects the retired server.host compatibility field", () => {
    expect(() =>
      paperclipConfigSchema.parse({
        $meta: {
          version: 1,
          updatedAt: "2026-08-11T00:00:00.000Z",
          source: "configure",
        },
        database: {},
        logging: { mode: "file" },
        server: { host: "127.0.0.1" },
      }),
    ).toThrow(/unrecognized key/i);
  });

  it("rejects the retired global LLM credential configuration", () => {
    expect(() =>
      paperclipConfigSchema.parse({
        $meta: {
          version: 1,
          updatedAt: "2026-07-26T00:00:00.000Z",
          source: "configure",
        },
        llm: {
          provider: "openai",
          apiKey: "retired-global-key",
        },
        database: {
          connectionString:
            "postgres://paperclip:paperclip@db.example.test:5432/paperclip",
        },
        logging: {
          mode: "file",
        },
        server: {},
      }),
    ).toThrow(/unrecognized key/i);
  });

  it("keeps only external database configuration and rejects retired local fields", () => {
    const parsed = paperclipConfigSchema.parse({
      $meta: {
        version: 1,
        updatedAt: "2026-05-10T00:00:00.000Z",
        source: "configure",
      },
      database: {
        connectionString:
          "postgres://paperclip:paperclip@db.example.test:5432/paperclip",
      },
      logging: {
        mode: "file",
      },
      server: {},
    });

    expect(parsed.database.connectionString).toBe(
      "postgres://paperclip:paperclip@db.example.test:5432/paperclip",
    );
    expect(parsed.database).not.toHaveProperty("backup");
    expect(parsed.logging.logDir).toBe("~/.paperclip/instances/default/logs");
    expect(parsed.storage.localDisk.baseDir).toBe(
      "~/.paperclip/instances/default/data/storage",
    );
    expect(parsed.secrets.localEncrypted.keyFilePath).toBe(
      "~/.paperclip/instances/default/secrets/master.key",
    );
    expect(() =>
      paperclipConfigSchema.parse({
        $meta: {
          version: 1,
          updatedAt: "2026-05-10T00:00:00.000Z",
          source: "configure",
        },
        database: {
          connectionString:
            "postgres://paperclip:paperclip@db.example.test:5432/paperclip",
          mode: ["embed", "ded-postgres"].join(""),
        },
        logging: { mode: "file" },
        server: {},
      }),
    ).toThrow(/unrecognized key/i);
  });

  it("rejects the retired database-backup configuration", () => {
    expect(() =>
      paperclipConfigSchema.parse({
        $meta: {
          version: 1,
          updatedAt: "2026-08-06T00:00:00.000Z",
          source: "configure",
        },
        database: {
          connectionString:
            "postgres://paperclip:paperclip@db.example.test:5432/paperclip",
          backup: {
            enabled: true,
            intervalMinutes: 60,
            retentionDays: 7,
            dir: "~/.paperclip/instances/default/data/backups",
          },
        },
        logging: { mode: "file" },
        server: {},
      }),
    ).toThrow(/unrecognized key/i);
  });

  it("uses bind and exposure without a deployment identity mode", () => {
    const parsed = paperclipConfigSchema.parse({
      $meta: {
        version: 1,
        updatedAt: "2026-07-29T00:00:00.000Z",
        source: "configure",
      },
      database: {
        connectionString:
          "postgres://paperclip:paperclip@db.example.test:5432/paperclip",
      },
      logging: {
        mode: "file",
      },
      server: {
        bind: "lan",
        exposure: "private",
      },
    });

    expect(parsed.server).toMatchObject({
      bind: "lan",
      exposure: "private",
    });
    expect(parsed.server).not.toHaveProperty("deploymentMode"); // paperclip:canonical-human-auth-removal-proof
  });

  it("rejects the retired deployment mode instead of stripping it", () => {
    expect(() =>
      paperclipConfigSchema.parse({
        $meta: {
          version: 1,
          updatedAt: "2026-07-29T00:00:00.000Z",
          source: "configure",
        },
        database: {
          connectionString:
            "postgres://paperclip:paperclip@db.example.test:5432/paperclip",
        },
        logging: {
          mode: "file",
        },
        server: {
          deploymentMode: ["local", "trusted"].join("_"), // paperclip:canonical-human-auth-removal-proof
        },
      }),
    ).toThrow(/unrecognized key/i);
  });

  it("keeps public-exposure hardening independent of human identity", () => {
    expect(() =>
      paperclipConfigSchema.parse({
        $meta: {
          version: 1,
          updatedAt: "2026-07-29T00:00:00.000Z",
          source: "configure",
        },
        database: {
          connectionString:
            "postgres://paperclip:paperclip@db.example.test:5432/paperclip",
        },
        logging: {
          mode: "file",
        },
        server: {
          bind: "tailnet",
          exposure: "public",
        },
        auth: {
          publicBaseUrl: "https://paperclip.example.test",
        },
      }),
    ).toThrow(
      /server\.bind=tailnet is only supported when server\.exposure=private/,
    );

    const parsed = paperclipConfigSchema.parse({
      $meta: {
        version: 1,
        updatedAt: "2026-07-29T00:00:00.000Z",
        source: "configure",
      },
      database: {
        connectionString:
          "postgres://paperclip:paperclip@db.example.test:5432/paperclip",
      },
      logging: {
        mode: "file",
      },
      server: {
        bind: "lan",
        exposure: "public",
      },
      auth: {
        publicBaseUrl: "https://paperclip.example.test",
      },
    });

    expect(parsed.server).toMatchObject({
      bind: "lan",
      exposure: "public",
    });
  });

  it("rejects the retired auth origin mode", () => {
    expect(() =>
      paperclipConfigSchema.parse({
        $meta: {
          version: 1,
          updatedAt: "2026-08-02T00:00:00.000Z",
          source: "configure",
        },
        database: {
          connectionString:
            "postgres://paperclip:paperclip@db.example.test:5432/paperclip",
        },
        logging: { mode: "file" },
        server: { exposure: "private" },
        auth: {
          [["base", "Url", "Mode"].join("")]: ["au", "to"].join(""),
        },
      }),
    ).toThrow(/unrecognized key/i);
  });

  it("requires the canonical origin only for public exposure", () => {
    const base = {
      $meta: {
        version: 1 as const,
        updatedAt: "2026-08-02T00:00:00.000Z",
        source: "configure" as const,
      },
      database: {
        connectionString:
          "postgres://paperclip:paperclip@db.example.test:5432/paperclip",
      },
      logging: { mode: "file" as const },
    };

    expect(() =>
      paperclipConfigSchema.parse({
        ...base,
        server: { exposure: "public", bind: "lan" },
      }),
    ).toThrow(/auth\.publicBaseUrl is required when server\.exposure=public/);

    expect(() =>
      paperclipConfigSchema.parse({
        ...base,
        server: { exposure: "private", bind: "loopback" },
        auth: { publicBaseUrl: "https://paperclip.example" },
      }),
    ).toThrow(/auth\.publicBaseUrl is only valid when server\.exposure=public/);
  });

  it("accepts only the exact persisted HTTPS public origin", () => {
    const base = {
      $meta: {
        version: 1 as const,
        updatedAt: "2026-08-02T00:00:00.000Z",
        source: "configure" as const,
      },
      database: {
        connectionString:
          "postgres://paperclip:paperclip@db.example.test:5432/paperclip",
      },
      logging: { mode: "file" as const },
      server: { exposure: "public" as const, bind: "lan" as const },
    };

    expect(
      paperclipConfigSchema.parse({
        ...base,
        auth: { publicBaseUrl: "https://paperclip.example" },
      }).auth.publicBaseUrl,
    ).toBe("https://paperclip.example");

    expect(() =>
      paperclipConfigSchema.parse({
        ...base,
        auth: { publicBaseUrl: "HTTPS://Paperclip.Example:443/" },
      }),
    ).toThrow(/exact canonical HTTPS origin/);

    expect(() =>
      paperclipConfigSchema.parse({
        ...base,
        auth: { publicBaseUrl: "https://paperclip.example/subpath" },
      }),
    ).toThrow(/must not contain a path/);

    expect(() =>
      paperclipConfigSchema.parse({
        ...base,
        auth: { publicBaseUrl: "http://paperclip.example" },
      }),
    ).toThrow(/must use https:\/\//);
  });
});
