import type { SecretProviderConfigDiscoveryPreviewResult } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import {
  type SecretProviderClientErrorCode,
  type StoredSecretVersionMaterial,
  SecretProviderClientError,
} from "./types.js";
import * as awsCredentials from "./aws-secrets-manager-credentials.js";
import {
  asOptionalNonEmptyString,
  requireExactAwsIdentity,
  requireOptionalExactAwsIdentity,
} from "./aws-secrets-manager-config.js";
import * as awsMaterial from "./aws-secrets-manager-material.js";

export function discoverAwsProviderConfigCandidates(input: {
  companyId: string;
  config: awsCredentials.AwsSecretsManagerConfig;
  draftConfig: Record<string, unknown>;
  entries: awsCredentials.AwsSecretsManagerListSecretEntry[];
  nextToken: string | null;
}): SecretProviderConfigDiscoveryPreviewResult {
  type DiscoverySample = {
    entry: awsCredentials.AwsSecretsManagerListSecretEntry;
    name: string;
    tags: Map<string, string>;
    prefix: string | null;
    namespace: string | null;
    environmentTag: string | null;
    ownerTag: string | null;
    kmsKeyId: string | null;
    paperclipManaged: boolean;
    paperclipCompanyId: string | null;
  };

  const skippedWarnings: string[] = [];
  let skippedForeignPaperclipSampleCount = 0;
  const samples: DiscoverySample[] = [];

  for (const entry of input.entries) {
    const name = entry.Name?.trim() || entry.ARN?.trim();
    if (!name) continue;
    const tags = awsMaterial.normalizeAwsTags(entry.Tags);
    const paperclipManaged =
      awsMaterial.tagValue(tags, ["paperclip:managed-by"])?.toLowerCase() === "paperclip";
    const paperclipCompanyId = awsMaterial.tagValue(tags, ["paperclip:company-id"]);
    if (paperclipManaged && paperclipCompanyId !== input.companyId) {
      skippedForeignPaperclipSampleCount += 1;
      continue;
    }
    const path = awsMaterial.inferPathSignals(entry, tags);
    samples.push({
      entry,
      name,
      tags,
      prefix: path.prefix,
      namespace: path.namespace,
      environmentTag: awsMaterial.tagValue(tags, ["paperclip:environment", "environment", "env", "stage"]),
      ownerTag: awsMaterial.tagValue(tags, [
        "paperclip:provider-owner",
        "owner",
        "team",
        "service",
        "application",
      ]),
      kmsKeyId: asOptionalNonEmptyString(entry.KmsKeyId),
      paperclipManaged,
      paperclipCompanyId,
    });
  }

  if (skippedForeignPaperclipSampleCount > 0) {
    skippedWarnings.push(
      `Skipped ${skippedForeignPaperclipSampleCount} Paperclip-managed AWS secret sample(s) that were not tagged for this company.`,
    );
  }

  const draftNamespace = asOptionalNonEmptyString(input.draftConfig.namespace);
  const draftPrefix = asOptionalNonEmptyString(input.draftConfig.secretNamePrefix);
  const draftKmsKeyId = asOptionalNonEmptyString(input.draftConfig.kmsKeyId);
  const draftEnvironmentTag = asOptionalNonEmptyString(input.draftConfig.environmentTag);
  const draftOwnerTag = asOptionalNonEmptyString(input.draftConfig.ownerTag);
  const groups = new Map<string, DiscoverySample[]>();

  for (const sample of samples) {
    const key = [draftPrefix ?? sample.prefix ?? "", draftNamespace ?? sample.namespace ?? ""].join("\0");
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }

  const candidates = [...groups.values()]
    .sort((a, b) => b.length - a.length)
    .slice(0, awsCredentials.PROVIDER_CONFIG_DISCOVERY_CANDIDATE_LIMIT)
    .map((group) => {
      const prefix =
        draftPrefix ?? awsMaterial.commonValue(group.map((sample) => sample.prefix)) ?? input.config.prefix;
      const namespace =
        draftNamespace ?? awsMaterial.commonValue(group.map((sample) => sample.namespace)) ?? null;
      const environmentTag =
        draftEnvironmentTag ?? awsMaterial.commonValue(group.map((sample) => sample.environmentTag));
      const ownerTag = draftOwnerTag ?? awsMaterial.commonValue(group.map((sample) => sample.ownerTag));
      const kmsKeys = awsMaterial.uniqueValues(group.map((sample) => sample.kmsKeyId));
      const commonKmsKey = awsMaterial.commonValue(group.map((sample) => sample.kmsKeyId));
      const kmsKeyId = draftKmsKeyId ?? commonKmsKey;
      const candidateWarnings: string[] = [];

      if (!namespace) {
        candidateWarnings.push(
          "No stable namespace signal was found in the sampled AWS secret names or tags.",
        );
      }
      if (!environmentTag) {
        candidateWarnings.push("No common environment tag was found in the sampled AWS secrets.");
      }
      if (!ownerTag) {
        candidateWarnings.push("No common owner/team tag was found in the sampled AWS secrets.");
      }
      if (kmsKeys.length > 1 && !draftKmsKeyId) {
        candidateWarnings.push(
          "Sampled AWS secrets use multiple KMS keys; choose the intended KMS key before saving.",
        );
      }
      if (group.some((sample) => sample.paperclipManaged && sample.paperclipCompanyId === input.companyId)) {
        candidateWarnings.push(
          "Sample includes Paperclip-managed secrets for this company; do not import them as external references.",
        );
      }

      return {
        provider: "aws_secrets_manager" as const,
        displayName: awsMaterial.discoveryDisplayName({
          environmentTag,
          ownerTag,
          namespace,
          secretNamePrefix: prefix,
        }),
        config: {
          region: input.config.region,
          namespace,
          secretNamePrefix: prefix,
          kmsKeyId: kmsKeyId ?? null,
          ownerTag,
          environmentTag,
        },
        sampleCount: group.length,
        samples: group.slice(0, awsCredentials.PROVIDER_CONFIG_DISCOVERY_SAMPLE_LIMIT).map((sample) => ({
          name: sample.name,
          hasKmsKey: Boolean(sample.kmsKeyId),
          tagKeys: [...sample.tags.keys()].sort(),
        })),
        signals: {
          namespace,
          secretNamePrefix: prefix,
          environmentTag,
          ownerTag,
          kmsKeyId: kmsKeyId ?? null,
          hasKmsKey: kmsKeys.length > 0,
          sampleCount: group.length,
          paperclipManagedSampleCount: group.filter((sample) => sample.paperclipManaged).length,
          skippedForeignPaperclipSampleCount,
        },
        warnings: candidateWarnings,
      };
    });

  const warnings = [...skippedWarnings];
  if (samples.length === 0) {
    warnings.push("AWS Secrets Manager returned no metadata samples for this draft provider vault config.");
  }
  if (groups.size > awsCredentials.PROVIDER_CONFIG_DISCOVERY_CANDIDATE_LIMIT) {
    warnings.push(
      "Additional AWS secret name groups were omitted from this preview; refine the query to inspect them.",
    );
  }

  return {
    provider: "aws_secrets_manager",
    nextToken: input.nextToken,
    sampledSecretCount: samples.length,
    skippedForeignPaperclipSampleCount,
    candidates,
    warnings,
  };
}

export function asAwsSecretsManagerMaterial(
  value: StoredSecretVersionMaterial,
): awsCredentials.AwsSecretsManagerMaterial {
  if (
    value &&
    typeof value === "object" &&
    value.scheme === awsCredentials.AWS_SECRETS_MANAGER_SCHEME &&
    typeof value.secretId === "string" &&
    (typeof value.versionId === "string" || value.versionId === null) &&
    (value.source === "managed" || value.source === "external_reference")
  ) {
    const material = value as awsCredentials.AwsSecretsManagerMaterial;
    requireExactAwsIdentity(material.secretId, "AWS secret reference");
    requireOptionalExactAwsIdentity(material.versionId, "AWS secret version reference");
    return material;
  }
  throw unprocessable("Invalid AWS Secrets Manager material");
}

export function classifyAwsProviderError(message: string): SecretProviderClientErrorCode {
  if (/ResourceExistsException|AlreadyExists/i.test(message)) return "conflict";
  if (/ResourceNotFoundException|NotFound/i.test(message)) return "not_found";
  if (
    /AccessDeniedException|AccessDenied|UnrecognizedClientException|InvalidClientTokenId|not authorized/i.test(
      message,
    )
  ) {
    return "access_denied";
  }
  if (/Throttl|TooManyRequests|RequestLimitExceeded|Rate exceeded/i.test(message)) return "throttled";
  if (/ValidationException|InvalidParameter|InvalidRequest/i.test(message)) return "invalid_request";
  if (/fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|network|timeout/i.test(message)) return "provider_unavailable";
  return "provider_error";
}

export function awsProviderSafeMessage(code: SecretProviderClientErrorCode): string {
  switch (code) {
    case "access_denied":
      return "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.";
    case "throttled":
      return "AWS Secrets Manager throttled the request. Wait and try again.";
    case "not_found":
      return "AWS Secrets Manager could not find the requested secret.";
    case "conflict":
      return "AWS Secrets Manager reported that the requested secret already exists.";
    case "invalid_request":
      return "AWS Secrets Manager rejected the request.";
    case "provider_unavailable":
      return "AWS Secrets Manager is unavailable right now.";
    case "provider_error":
    default:
      return "AWS Secrets Manager request failed.";
  }
}

export function normalizeAwsError(operation: string, error: unknown): never {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const code = classifyAwsProviderError(rawMessage);
  throw new SecretProviderClientError({
    code,
    provider: "aws_secrets_manager",
    operation,
    message: awsProviderSafeMessage(code),
    rawMessage,
    cause: error,
  });
}
