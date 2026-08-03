import fs from "node:fs";
import type { PaperclipConfig } from "../config/schema.js";
import type { CheckResult } from "./index.js";
import { resolveRuntimeLikePath } from "./path-resolver.js";

const AWS_CREDENTIAL_SOURCE_HINT =
  "Provide AWS runtime credentials through the AWS SDK default credential chain: IAM role/workload identity, AWS_PROFILE/SSO/shared credentials, web identity, container/instance metadata, or short-lived shell credentials";

function decodeMasterKey(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (/^[A-Fa-f0-9]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  try {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === 32) return decoded;
  } catch {
    // ignored
  }

  if (Buffer.byteLength(trimmed, "utf8") === 32) {
    return Buffer.from(trimmed, "utf8");
  }
  return null;
}

function withStrictModeNote(
  base: Pick<CheckResult, "name" | "status" | "message" | "guidance">,
  config: PaperclipConfig,
): CheckResult {
  const strictModeDisabledInDeployedSetup =
    config.secrets.strictMode === false;
  if (!strictModeDisabledInDeployedSetup) return base;

  if (base.status === "fail") return base;
  return {
    ...base,
    status: "warn",
    message: `${base.message}; strict secret mode is disabled for the external PostgreSQL deployment`,
    guidance: base.guidance
      ? `${base.guidance}. Consider enabling secrets.strictMode`
      : "Consider enabling secrets.strictMode",
  };
}

export function secretsCheck(config: PaperclipConfig, configPath?: string): CheckResult {
  const provider = config.secrets.provider;
  if (provider === "aws_secrets_manager") {
    return withStrictModeNote(awsSecretsManagerCheck(), config);
  }
  if (provider !== "local_encrypted") {
    return {
      name: "Secrets adapter",
      status: "fail",
      message: `${provider} is configured, but this build only supports local_encrypted and aws_secrets_manager`,
      guidance: "Run `paperclipai configure --section secrets` and choose local_encrypted or aws_secrets_manager",
    };
  }

  const envMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
  if (envMasterKey && envMasterKey.trim().length > 0) {
    if (!decodeMasterKey(envMasterKey)) {
      return {
        name: "Secrets adapter",
        status: "fail",
        message:
          "PAPERCLIP_SECRETS_MASTER_KEY is invalid (expected 32-byte base64, 64-char hex, or raw 32-char string)",
        guidance: "Set PAPERCLIP_SECRETS_MASTER_KEY to a valid key or use the configured key file",
      };
    }

    return withStrictModeNote(
      {
        name: "Secrets adapter",
        status: "pass",
        message: "Local encrypted provider configured via PAPERCLIP_SECRETS_MASTER_KEY",
      },
      config,
    );
  }

  const keyFileOverride = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const configuredPath =
    keyFileOverride && keyFileOverride.trim().length > 0
      ? keyFileOverride.trim()
      : config.secrets.localEncrypted.keyFilePath;
  const keyFilePath = resolveRuntimeLikePath(configuredPath, configPath);

  if (!fs.existsSync(keyFilePath)) {
    return withStrictModeNote(
      {
        name: "Secrets adapter",
        status: "fail",
        message: `Secrets key file does not exist yet: ${keyFilePath}`,
        guidance: "Create the deployment through `paperclipai onboard` or explicitly configure its secrets provider",
      },
      config,
    );
  }

  let raw: string;
  try {
    raw = fs.readFileSync(keyFilePath, "utf8");
  } catch (err) {
    return {
      name: "Secrets adapter",
      status: "fail",
      message: `Could not read secrets key file: ${err instanceof Error ? err.message : String(err)}`,
      guidance: "Check file permissions or set PAPERCLIP_SECRETS_MASTER_KEY",
    };
  }

  if (!decodeMasterKey(raw)) {
    return {
      name: "Secrets adapter",
      status: "fail",
      message: `Invalid key material in ${keyFilePath}`,
      guidance: "Provide the deployment's original valid key material or provision a new deployment",
    };
  }

  const keyMode = fs.statSync(keyFilePath).mode & 0o777;
  const permissionWarning =
    (keyMode & 0o077) !== 0
      ? `; key file permissions are ${keyMode.toString(8)} (run chmod 600 ${keyFilePath})`
      : "";

  return withStrictModeNote(
    {
      name: "Secrets adapter",
      status: permissionWarning ? "warn" : "pass",
      message: `Local encrypted provider configured with key file ${keyFilePath}${permissionWarning}`,
      guidance: permissionWarning
        ? "Restrict the local encrypted secrets key file to owner read/write permissions"
        : undefined,
    },
    config,
  );
}

function awsSecretsManagerCheck(): CheckResult {
  const missingConfig = missingAwsSecretsManagerConfig();
  if (missingConfig.length > 0) {
    return {
      name: "Secrets adapter",
      status: "fail",
      message: `AWS Secrets Manager provider is missing non-secret config: ${missingConfig.join(", ")}`,
      guidance:
        `Set ${missingConfig.join(", ")} in the Paperclip server runtime. ${AWS_CREDENTIAL_SOURCE_HINT}. Do not store AWS root credentials or long-lived IAM user keys in Paperclip secrets.`,
    };
  }

  const staticEnvCredentials =
    process.env.AWS_ACCESS_KEY_ID?.trim() && process.env.AWS_SECRET_ACCESS_KEY?.trim();
  const credentialSource = detectedAwsCredentialSources().join(", ");
  const message =
    `AWS Secrets Manager provider configured for deployment ${process.env.PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID}; ` +
    `runtime credentials source: ${credentialSource || "AWS SDK default credential chain"}`;

  if (staticEnvCredentials) {
    return {
      name: "Secrets adapter",
      status: "warn",
      message,
      guidance:
        "AWS static environment credentials are visible. Use only short-lived shell credentials locally; prefer IAM role/workload identity for hosted deployments and never store AWS access keys in Paperclip company secrets.",
    };
  }

  return {
    name: "Secrets adapter",
    status: "pass",
    message,
  };
}

function missingAwsSecretsManagerConfig(): string[] {
  const missing: string[] = [];
  if (
    !(
      process.env.PAPERCLIP_SECRETS_AWS_REGION?.trim() ||
      process.env.AWS_REGION?.trim() ||
      process.env.AWS_DEFAULT_REGION?.trim()
    )
  ) {
    missing.push("PAPERCLIP_SECRETS_AWS_REGION or AWS_REGION/AWS_DEFAULT_REGION");
  }
  if (!process.env.PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID?.trim()) {
    missing.push("PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID");
  }
  if (!process.env.PAPERCLIP_SECRETS_AWS_KMS_KEY_ID?.trim()) {
    missing.push("PAPERCLIP_SECRETS_AWS_KMS_KEY_ID");
  }
  return missing;
}

function detectedAwsCredentialSources(): string[] {
  const sources: string[] = [];
  if (process.env.AWS_PROFILE?.trim()) sources.push("AWS_PROFILE/shared config");
  if (process.env.AWS_ACCESS_KEY_ID?.trim() && process.env.AWS_SECRET_ACCESS_KEY?.trim()) {
    sources.push("temporary AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY environment credentials");
  }
  if (process.env.AWS_WEB_IDENTITY_TOKEN_FILE?.trim() && process.env.AWS_ROLE_ARN?.trim()) {
    sources.push("AWS web identity token");
  }
  if (
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI?.trim() ||
    process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI?.trim()
  ) {
    sources.push("AWS container credentials endpoint");
  }
  if (process.env.AWS_SHARED_CREDENTIALS_FILE?.trim() || process.env.AWS_CONFIG_FILE?.trim()) {
    sources.push("custom AWS shared credentials/config file");
  }
  return sources;
}
