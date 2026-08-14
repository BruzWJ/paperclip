import { unprocessable } from "../errors.js";
import type { PreparedSecretVersion, SecretProviderWriteContext } from "./types.js";
import * as awsCredentials from "./aws-secrets-manager-credentials.js";
import {
  requireExactAwsIdentity,
  requireOptionalExactAwsIdentity,
  sanitizePathSegment,
} from "./aws-secrets-manager-identities.js";

export { sanitizePathSegment };

export function buildManagedSecretName(
  config: awsCredentials.AwsSecretsManagerConfig,
  context: awsCredentials.ManagedSecretNamespaceContext | undefined,
) {
  if (!context) {
    throw unprocessable("AWS Secrets Manager provider requires secret context for managed values");
  }
  return [
    sanitizePathSegment(config.prefix),
    sanitizePathSegment(config.deploymentId),
    sanitizePathSegment(context.companyId),
    sanitizePathSegment(context.secretKey),
  ]
    .filter(Boolean)
    .join("/");
}

export function buildManagedSecretId(
  config: awsCredentials.AwsSecretsManagerConfig,
  context: awsCredentials.ManagedSecretNamespaceContext | undefined,
) {
  return buildManagedSecretName(config, context);
}

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractAwsSecretName(externalRef: string) {
  const exactRef = requireExactAwsIdentity(externalRef, "AWS secret reference");
  const arnMatch = /^arn:[^:]+:secretsmanager:[^:]*:[^:]*:secret:(.+)$/i.exec(exactRef);
  return arnMatch?.[1] ?? exactRef;
}

export function isManagedSecretRefForContext(
  config: awsCredentials.AwsSecretsManagerConfig,
  context: awsCredentials.ManagedSecretNamespaceContext | undefined,
  externalRef: string | null | undefined,
) {
  if (externalRef == null) return false;
  requireExactAwsIdentity(externalRef, "AWS secret reference");
  const expectedName = buildManagedSecretName(config, context);
  const actualName = extractAwsSecretName(externalRef);
  return new RegExp(`^${escapeRegExp(expectedName)}(?:-[A-Za-z0-9]{6})?$`).test(actualName);
}

export function isManagedSecretNamespaceRef(
  config: awsCredentials.AwsSecretsManagerConfig,
  externalRef: string | null | undefined,
) {
  if (externalRef == null) return false;
  requireExactAwsIdentity(externalRef, "AWS secret reference");
  const namespacePrefix = [sanitizePathSegment(config.prefix), sanitizePathSegment(config.deploymentId)]
    .filter(Boolean)
    .join("/");
  if (!namespacePrefix) return false;
  const actualName = extractAwsSecretName(externalRef);
  return actualName === namespacePrefix || actualName.startsWith(`${namespacePrefix}/`);
}

export function assertNotManagedNamespaceExternalRef(
  config: awsCredentials.AwsSecretsManagerConfig,
  externalRef: string,
) {
  if (!isManagedSecretNamespaceRef(config, externalRef)) return;
  throw unprocessable("AWS Paperclip-managed namespace secrets cannot be imported as external references");
}

export function resolveManagedSecretRef(input: {
  config: awsCredentials.AwsSecretsManagerConfig;
  context: awsCredentials.ManagedSecretNamespaceContext | undefined;
  externalRefs: Array<string | null | undefined>;
}) {
  let sawNonEmptyExternalRef = false;
  for (const externalRef of input.externalRefs) {
    if (externalRef == null) continue;
    const exactRef = requireExactAwsIdentity(externalRef, "AWS secret reference");
    sawNonEmptyExternalRef = true;
    if (isManagedSecretRefForContext(input.config, input.context, exactRef)) {
      return exactRef;
    }
  }
  if (sawNonEmptyExternalRef) {
    throw unprocessable(
      "AWS Secrets Manager managed secret ref drifted outside the derived deployment/company scope",
    );
  }
  return buildManagedSecretId(input.config, input.context);
}

export function buildManagedSecretTags(
  config: awsCredentials.AwsSecretsManagerConfig,
  context: SecretProviderWriteContext | undefined,
): awsCredentials.AwsSecretsManagerTag[] {
  if (!context) return [];
  return [
    { Key: "paperclip:managed-by", Value: "paperclip" },
    { Key: "paperclip:provider-owner", Value: config.providerOwnerTag },
    { Key: "paperclip:deployment-id", Value: config.deploymentId },
    { Key: "paperclip:company-id", Value: context.companyId },
    { Key: "paperclip:secret-key", Value: context.secretKey },
    { Key: "paperclip:environment", Value: config.environmentTag },
  ];
}

export function createExternalReferenceMaterial(
  externalRef: string,
  providerVersionRef: string | null,
): PreparedSecretVersion {
  const exactExternalRef = requireExactAwsIdentity(externalRef, "AWS secret reference");
  const exactProviderVersionRef = requireOptionalExactAwsIdentity(
    providerVersionRef,
    "AWS secret version reference",
  );
  const fingerprint = awsCredentials.sha256Hex(
    `${awsCredentials.AWS_SECRETS_MANAGER_SCHEME}:${exactExternalRef}:${exactProviderVersionRef ?? ""}`,
  );
  return {
    material: {
      scheme: awsCredentials.AWS_SECRETS_MANAGER_SCHEME,
      secretId: exactExternalRef,
      versionId: exactProviderVersionRef,
      source: "external_reference",
    },
    valueSha256: fingerprint,
    fingerprintSha256: fingerprint,
    externalRef: exactExternalRef,
    providerVersionRef: exactProviderVersionRef,
  };
}

export function createManagedMaterial(
  secretId: string,
  versionId: string | null,
): awsCredentials.AwsSecretsManagerMaterial {
  return {
    scheme: awsCredentials.AWS_SECRETS_MANAGER_SCHEME,
    secretId: requireExactAwsIdentity(secretId, "AWS secret reference"),
    versionId: requireOptionalExactAwsIdentity(versionId, "AWS secret version reference"),
    source: "managed",
  };
}

export function serializeAwsDate(value: string | number | Date | undefined): string | null {
  if (value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function createRemoteSecretMetadata(
  entry: awsCredentials.AwsSecretsManagerListSecretEntry,
): Record<string, unknown> {
  return {
    createdDate: serializeAwsDate(entry.CreatedDate),
    lastAccessedDate: serializeAwsDate(entry.LastAccessedDate),
    lastChangedDate: serializeAwsDate(entry.LastChangedDate),
    deletedDate: serializeAwsDate(entry.DeletedDate),
    hasDescription: Boolean(entry.Description),
    hasKmsKey: Boolean(entry.KmsKeyId),
    tagCount: Array.isArray(entry.Tags) ? entry.Tags.length : 0,
  };
}

export function tagValue(tags: Map<string, string>, keys: string[]) {
  for (const key of keys) {
    const value = tags.get(key.toLowerCase());
    if (value) return value;
  }
  return null;
}

export function normalizeAwsTags(tags: awsCredentials.AwsSecretsManagerTag[] | undefined) {
  const normalized = new Map<string, string>();
  for (const tag of tags ?? []) {
    const key = tag.Key?.trim();
    const value = tag.Value?.trim();
    if (key && value) normalized.set(key.toLowerCase(), value);
  }
  return normalized;
}

export function commonValue(values: Array<string | null | undefined>) {
  const nonEmpty = values.filter((value): value is string => Boolean(value?.trim()));
  if (nonEmpty.length === 0) return null;
  const first = nonEmpty[0];
  return nonEmpty.every((value) => value === first) ? first : null;
}

export function uniqueValues(values: Array<string | null | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value?.trim())))];
}

export function pathSegments(name: string) {
  return name
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

export function inferPathSignals(
  entry: awsCredentials.AwsSecretsManagerListSecretEntry,
  tags: Map<string, string>,
) {
  const name = entry.Name?.trim() || entry.ARN?.trim() || "";
  const segments = pathSegments(name);
  const paperclipDeploymentId = tagValue(tags, ["paperclip:deployment-id"]);
  const paperclipManaged = tagValue(tags, ["paperclip:managed-by"])?.toLowerCase() === "paperclip";

  if (paperclipDeploymentId || paperclipManaged) {
    return {
      prefix: segments[0] ?? awsCredentials.DEFAULT_PREFIX,
      namespace: paperclipDeploymentId ?? segments[1] ?? null,
    };
  }

  if (segments.length >= 3) {
    return {
      prefix: segments[0] ?? null,
      namespace: segments[1] ?? null,
    };
  }

  return {
    prefix: segments[0] ?? null,
    namespace: null,
  };
}

export function discoveryDisplayName(input: {
  environmentTag: string | null;
  ownerTag: string | null;
  namespace: string | null;
  secretNamePrefix: string | null;
}) {
  const qualifier =
    input.environmentTag ?? input.namespace ?? input.secretNamePrefix ?? input.ownerTag ?? "discovered";
  return `AWS ${qualifier}`;
}
