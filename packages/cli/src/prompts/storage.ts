import * as p from "@clack/prompts";
import {
  parseExactStorageEndpoint,
  parseExactStorageName,
  parseExactStoragePrefix,
} from "@paperclipai/shared";
import type { StorageConfig } from "../config/schema.js";
import {
  resolveDefaultStorageDir,
  resolvePaperclipInstanceId,
} from "../config/home.js";

function defaultStorageBaseDir(): string {
  return resolveDefaultStorageDir(resolvePaperclipInstanceId());
}

export function defaultStorageConfig(): StorageConfig {
  return {
    provider: "local_disk",
    localDisk: {
      baseDir: defaultStorageBaseDir(),
    },
    s3: {
      bucket: "paperclip",
      region: "us-east-1",
      endpoint: undefined,
      prefix: "",
      forcePathStyle: false,
    },
  };
}

export async function promptStorage(
  current?: StorageConfig,
): Promise<StorageConfig> {
  const base = current ?? defaultStorageConfig();

  const provider = await p.select({
    message: "Storage provider",
    options: [
      {
        value: "local_disk" as const,
        label: "Local disk (recommended)",
        hint: "best for single-user local deployments",
      },
      {
        value: "s3" as const,
        label: "S3 compatible",
        hint: "for cloud/object storage backends",
      },
    ],
    initialValue: base.provider,
  });

  if (p.isCancel(provider)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  if (provider === "local_disk") {
    const baseDir = await p.text({
      message: "Local storage base directory",
      defaultValue: base.localDisk.baseDir || defaultStorageBaseDir(),
      placeholder: defaultStorageBaseDir(),
      validate: (value) => {
        if (!value || value.trim() !== value)
          return "Storage base directory must be exact and non-empty";
      },
    });

    if (p.isCancel(baseDir)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    return {
      provider: "local_disk",
      localDisk: {
        baseDir,
      },
      s3: base.s3,
    };
  }

  const bucket = await p.text({
    message: "S3 bucket",
    defaultValue: base.s3.bucket || "paperclip",
    placeholder: "paperclip",
    validate: (value) => {
      try {
        parseExactStorageName(value, "Bucket");
      } catch (error) {
        return (error as Error).message;
      }
    },
  });

  if (p.isCancel(bucket)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const region = await p.text({
    message: "S3 region",
    defaultValue: base.s3.region || "us-east-1",
    placeholder: "us-east-1",
    validate: (value) => {
      try {
        parseExactStorageName(value, "Region");
      } catch (error) {
        return (error as Error).message;
      }
    },
  });

  if (p.isCancel(region)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const endpoint = await p.text({
    message: "S3 endpoint (optional for compatible backends)",
    defaultValue: base.s3.endpoint ?? "",
    placeholder: "https://s3.amazonaws.com",
    validate: (value) => {
      if (value === "") return;
      try {
        parseExactStorageEndpoint(value);
      } catch (error) {
        return (error as Error).message;
      }
    },
  });

  if (p.isCancel(endpoint)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const prefix = await p.text({
    message: "Object key prefix (optional)",
    defaultValue: base.s3.prefix ?? "",
    placeholder: "paperclip",
    validate: (value) => {
      try {
        parseExactStoragePrefix(value);
      } catch (error) {
        return (error as Error).message;
      }
    },
  });

  if (p.isCancel(prefix)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const forcePathStyle = await p.confirm({
    message: "Use S3 path-style URLs?",
    initialValue: base.s3.forcePathStyle ?? false,
  });

  if (p.isCancel(forcePathStyle)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  return {
    provider: "s3",
    localDisk: base.localDisk,
    s3: {
      bucket,
      region,
      endpoint: endpoint || undefined,
      prefix,
      forcePathStyle,
    },
  };
}
