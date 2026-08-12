import { z } from "zod";
import { addValidationDetail } from "./validation-details.js";
import {
  BIND_MODES,
  DEPLOYMENT_EXPOSURES,
  SECRET_PROVIDERS,
  STORAGE_PROVIDERS,
} from "./constants.js";
import {
  parseExactHostnameList,
  validateConfiguredBindMode,
} from "./network-bind.js";
import { parseExactPublicOrigin } from "./public-origin.js";
import {
  parseExactStorageEndpoint,
  parseExactStorageName,
  parseExactStoragePrefix,
} from "./storage-identity.js";

export const configMetaSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  source: z.enum(["onboard", "configure", "doctor"]),
});

export const databaseConfigSchema = z
  .object({
    connectionString: z.string().optional(),
  })
  .strict();

export const loggingConfigSchema = z.object({
  mode: z.enum(["file", "cloud"]),
  logDir: z.string().default("~/.paperclip/instances/default/logs"),
});

export const serverConfigSchema = z
  .object({
    exposure: z.enum(DEPLOYMENT_EXPOSURES).default("private"),
    bind: z.enum(BIND_MODES).default("loopback"),
    customBindHost: z
      .string()
      .refine(
        (value) => value.length > 0 && value.trim() === value,
        "server.customBindHost must be exact and non-empty",
      )
      .optional(),
    port: z.number().int().min(1).max(65535).default(3100),
    allowedHostnames: z
      .array(z.string())
      .superRefine((values, ctx) => {
        try {
          parseExactHostnameList(values);
        } catch (error) {
          addValidationDetail(ctx, {
            message:
              error instanceof Error ? error.message : "Invalid hostname list",
          });
        }
      })
      .default([]),
    serveUi: z.boolean().default(true),
  })
  .strict();

export const authConfigSchema = z
  .object({
    publicBaseUrl: z
      .string()
      .transform((value, ctx) => {
        try {
          return parseExactPublicOrigin(value);
        } catch (error) {
          addValidationDetail(ctx, {
            message:
              error instanceof Error ? error.message : "Invalid public origin",
          });
          return z.NEVER;
        }
      })
      .optional(),
    disableSignUp: z.boolean().default(false),
  })
  .strict();

export const storageLocalDiskConfigSchema = z.object({
  baseDir: z.string().default("~/.paperclip/instances/default/data/storage"),
});

export const storageS3ConfigSchema = z.object({
  bucket: z
    .string()
    .superRefine((value, ctx) => {
      try {
        parseExactStorageName(value, "storage.s3.bucket");
      } catch (error) {
        addValidationDetail(ctx, { message: (error as Error).message });
      }
    })
    .default("paperclip"),
  region: z
    .string()
    .superRefine((value, ctx) => {
      try {
        parseExactStorageName(value, "storage.s3.region");
      } catch (error) {
        addValidationDetail(ctx, { message: (error as Error).message });
      }
    })
    .default("us-east-1"),
  endpoint: z
    .string()
    .superRefine((value, ctx) => {
      try {
        parseExactStorageEndpoint(value);
      } catch (error) {
        addValidationDetail(ctx, { message: (error as Error).message });
      }
    })
    .optional(),
  prefix: z
    .string()
    .superRefine((value, ctx) => {
      try {
        parseExactStoragePrefix(value);
      } catch (error) {
        addValidationDetail(ctx, { message: (error as Error).message });
      }
    })
    .default(""),
  forcePathStyle: z.boolean().default(false),
});

export const storageConfigSchema = z.object({
  provider: z.enum(STORAGE_PROVIDERS).default("local_disk"),
  localDisk: storageLocalDiskConfigSchema.default({
    baseDir: "~/.paperclip/instances/default/data/storage",
  }),
  s3: storageS3ConfigSchema.default({
    bucket: "paperclip",
    region: "us-east-1",
    prefix: "",
    forcePathStyle: false,
  }),
});

export const secretsLocalEncryptedConfigSchema = z.object({
  keyFilePath: z
    .string()
    .default("~/.paperclip/instances/default/secrets/master.key"),
});

export const secretsConfigSchema = z.object({
  provider: z.enum(SECRET_PROVIDERS).default("local_encrypted"),
  strictMode: z.boolean().default(false),
  localEncrypted: secretsLocalEncryptedConfigSchema.default({
    keyFilePath: "~/.paperclip/instances/default/secrets/master.key",
  }),
});

export const telemetryConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
  })
  .default({});

export const paperclipConfigSchema = z
  .object({
    $meta: configMetaSchema,
    database: databaseConfigSchema,
    logging: loggingConfigSchema,
    server: serverConfigSchema,
    telemetry: telemetryConfigSchema,
    auth: authConfigSchema.default({
      disableSignUp: false,
    }),
    storage: storageConfigSchema.default({
      provider: "local_disk",
      localDisk: {
        baseDir: "~/.paperclip/instances/default/data/storage",
      },
      s3: {
        bucket: "paperclip",
        region: "us-east-1",
        prefix: "",
        forcePathStyle: false,
      },
    }),
    secrets: secretsConfigSchema.default({
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: {
        keyFilePath: "~/.paperclip/instances/default/secrets/master.key",
      },
    }),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const message of validateConfiguredBindMode({
      exposure: value.server.exposure,
      bind: value.server.bind,
      customBindHost: value.server.customBindHost,
    })) {
      addValidationDetail(ctx, {
        message,
        path: message.includes("customBindHost")
          ? ["server", "customBindHost"]
          : ["server", "bind"],
      });
    }

    if (value.server.exposure === "public" && !value.auth.publicBaseUrl) {
      addValidationDetail(ctx, {
        message: "auth.publicBaseUrl is required when server.exposure=public",
        path: ["auth", "publicBaseUrl"],
      });
    }

    if (value.server.exposure === "private" && value.auth.publicBaseUrl) {
      addValidationDetail(ctx, {
        message: "auth.publicBaseUrl is only valid when server.exposure=public",
        path: ["auth", "publicBaseUrl"],
      });
    }
  });

export type PaperclipConfig = z.infer<typeof paperclipConfigSchema>;
export type DatabaseConfig = z.infer<typeof databaseConfigSchema>;
export type LoggingConfig = z.infer<typeof loggingConfigSchema>;
export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type StorageConfig = z.infer<typeof storageConfigSchema>;
export type StorageLocalDiskConfig = z.infer<
  typeof storageLocalDiskConfigSchema
>;
export type StorageS3Config = z.infer<typeof storageS3ConfigSchema>;
export type SecretsConfig = z.infer<typeof secretsConfigSchema>;
export type SecretsLocalEncryptedConfig = z.infer<
  typeof secretsLocalEncryptedConfigSchema
>;
export type AuthConfig = z.infer<typeof authConfigSchema>;
export type TelemetryConfig = z.infer<typeof telemetryConfigSchema>;
export type ConfigMeta = z.infer<typeof configMetaSchema>;
