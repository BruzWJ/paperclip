import { unprocessable } from "../errors.js";
import type { SecretProviderVaultRuntimeConfig } from "./types.js";
import {
  type AwsSecretsManagerConfig,
  DEFAULT_DELETE_RECOVERY_WINDOW_DAYS,
  DEFAULT_OWNER_TAG,
  DEFAULT_PREFIX,
} from "./aws-secrets-manager-credentials.js";
import {
  requireExactAwsIdentity,
  requireOptionalExactAwsIdentity,
  sanitizePathSegment,
} from "./aws-secrets-manager-identities.js";

export { requireExactAwsIdentity, requireOptionalExactAwsIdentity };

export function configuredAwsSecretsManagerDescriptor() {
  return {
    id: "aws_secrets_manager" as const,
    label: "AWS Secrets Manager",
    requiresExternalRef: false,
    supportsManagedValues: true,
    supportsExternalReferences: true,
    configured: canLoadAwsSecretsManagerConfig(),
  };
}

export function canLoadAwsSecretsManagerConfig() {
  return getAwsConfigReadiness().missingConfig.length === 0;
}

export function asOptionalNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function assertExactAwsConfig(config: AwsSecretsManagerConfig) {
  requireExactAwsIdentity(config.region, "AWS region");
  requireOptionalExactAwsIdentity(config.kmsKeyId, "AWS KMS key ID");
  return config;
}

export function readProviderVaultConfig(input: SecretProviderVaultRuntimeConfig): AwsSecretsManagerConfig {
  if (input.provider !== "aws_secrets_manager") {
    throw unprocessable("AWS Secrets Manager provider received a mismatched provider vault");
  }
  if (input.status === "disabled") {
    throw unprocessable("AWS Secrets Manager provider vault is disabled");
  }
  if (input.status === "coming_soon") {
    throw unprocessable("AWS Secrets Manager provider vault runtime is locked while coming soon");
  }
  const region = requireExactAwsIdentity(input.config.region, "AWS Secrets Manager provider vault region");
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/.test(region)) {
    throw unprocessable("AWS Secrets Manager provider vault requires non-secret config: region");
  }
  const recoveryWindowRaw = process.env.PAPERCLIP_SECRETS_AWS_DELETE_RECOVERY_DAYS?.trim();
  const recoveryWindow = recoveryWindowRaw ? Number(recoveryWindowRaw) : DEFAULT_DELETE_RECOVERY_WINDOW_DAYS;
  if (!Number.isFinite(recoveryWindow) || recoveryWindow < 7 || recoveryWindow > 30) {
    throw unprocessable("PAPERCLIP_SECRETS_AWS_DELETE_RECOVERY_DAYS must be an integer between 7 and 30");
  }

  return {
    region,
    endpoint:
      process.env.PAPERCLIP_SECRETS_AWS_ENDPOINT?.trim() || `https://secretsmanager.${region}.amazonaws.com`,
    deploymentId: sanitizePathSegment(asOptionalNonEmptyString(input.config.namespace) ?? input.id),
    prefix: sanitizePathSegment(asOptionalNonEmptyString(input.config.secretNamePrefix) || DEFAULT_PREFIX),
    kmsKeyId: requireOptionalExactAwsIdentity(
      input.config.kmsKeyId,
      "AWS Secrets Manager provider vault KMS key ID",
    ),
    environmentTag:
      asOptionalNonEmptyString(input.config.environmentTag) || process.env.NODE_ENV?.trim() || "unknown",
    providerOwnerTag: asOptionalNonEmptyString(input.config.ownerTag) || DEFAULT_OWNER_TAG,
    deleteRecoveryWindowDays: recoveryWindow,
  };
}

export function getAwsConfigReadiness() {
  const region = (
    process.env.PAPERCLIP_SECRETS_AWS_REGION ??
    process.env.AWS_REGION ??
    process.env.AWS_DEFAULT_REGION
  )?.trim();
  const deploymentId = process.env.PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID?.trim();
  const kmsKeyId = process.env.PAPERCLIP_SECRETS_AWS_KMS_KEY_ID?.trim();
  const missingConfig: string[] = [];

  if (!region) {
    missingConfig.push("PAPERCLIP_SECRETS_AWS_REGION or AWS_REGION/AWS_DEFAULT_REGION");
  }
  if (!deploymentId) {
    missingConfig.push("PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID");
  }
  if (!kmsKeyId) {
    missingConfig.push("PAPERCLIP_SECRETS_AWS_KMS_KEY_ID");
  }

  return {
    missingConfig,
    region: region || null,
    deploymentId: deploymentId || null,
    kmsKeyConfigured: Boolean(kmsKeyId),
    credentialSources: describeDetectedAwsCredentialSources(),
  };
}

export function describeDetectedAwsCredentialSources() {
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

export function loadAwsSecretsManagerConfig(): AwsSecretsManagerConfig {
  const readiness = getAwsConfigReadiness();
  const region =
    process.env.PAPERCLIP_SECRETS_AWS_REGION?.trim() ||
    process.env.AWS_REGION?.trim() ||
    process.env.AWS_DEFAULT_REGION?.trim();
  const deploymentId = process.env.PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID?.trim();
  const kmsKeyId = process.env.PAPERCLIP_SECRETS_AWS_KMS_KEY_ID?.trim();

  if (readiness.missingConfig.length > 0) {
    throw unprocessable(
      `AWS Secrets Manager provider requires non-secret config: ${readiness.missingConfig.join(", ")}`,
    );
  }
  if (!region) {
    throw unprocessable("AWS Secrets Manager provider requires PAPERCLIP_SECRETS_AWS_REGION or AWS_REGION");
  }
  if (!deploymentId) {
    throw unprocessable("AWS Secrets Manager provider requires PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID");
  }
  if (!kmsKeyId) {
    throw unprocessable("AWS Secrets Manager provider requires PAPERCLIP_SECRETS_AWS_KMS_KEY_ID");
  }

  const recoveryWindowRaw = process.env.PAPERCLIP_SECRETS_AWS_DELETE_RECOVERY_DAYS?.trim();
  const recoveryWindow = recoveryWindowRaw ? Number(recoveryWindowRaw) : DEFAULT_DELETE_RECOVERY_WINDOW_DAYS;
  if (!Number.isFinite(recoveryWindow) || recoveryWindow < 7 || recoveryWindow > 30) {
    throw unprocessable("PAPERCLIP_SECRETS_AWS_DELETE_RECOVERY_DAYS must be an integer between 7 and 30");
  }

  return {
    region,
    endpoint:
      process.env.PAPERCLIP_SECRETS_AWS_ENDPOINT?.trim() || `https://secretsmanager.${region}.amazonaws.com`,
    deploymentId,
    prefix: sanitizePathSegment(process.env.PAPERCLIP_SECRETS_AWS_PREFIX?.trim() || DEFAULT_PREFIX),
    kmsKeyId,
    environmentTag:
      process.env.PAPERCLIP_SECRETS_AWS_ENVIRONMENT?.trim() || process.env.NODE_ENV?.trim() || "unknown",
    providerOwnerTag: process.env.PAPERCLIP_SECRETS_AWS_PROVIDER_OWNER?.trim() || DEFAULT_OWNER_TAG,
    deleteRecoveryWindowDays: recoveryWindow,
  };
}
