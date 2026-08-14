import { createHash, createHmac } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import type { SecretProviderWriteContext, StoredSecretVersionMaterial } from "./types.js";

export const AWS_SECRETS_MANAGER_SCHEME = "aws_secrets_manager_v1";

export const DEFAULT_PREFIX = "paperclip";

export const DEFAULT_OWNER_TAG = "paperclip";

export const DEFAULT_VERSION_STAGE = "AWSCURRENT";

export const PAPERCLIP_PENDING_VERSION_STAGE = "PAPERCLIP_PENDING";

export const DEFAULT_DELETE_RECOVERY_WINDOW_DAYS = 30;

export const AWS_SECRETS_MANAGER_REQUEST_TIMEOUT_MS = 30_000;

export const AWS_CREDENTIAL_CACHE_TTL_MS = 5 * 60_000;

export const AWS_CREDENTIAL_EXPIRATION_SKEW_MS = 60_000;

export const PROVIDER_CONFIG_DISCOVERY_SAMPLE_LIMIT = 3;

export const PROVIDER_CONFIG_DISCOVERY_CANDIDATE_LIMIT = 6;

export const AWS_RUNTIME_CREDENTIAL_WARNING =
  "AWS bootstrap credentials must be available to the Paperclip server runtime through the AWS SDK default credential provider chain: IAM role/workload identity, AWS_PROFILE/SSO/shared credentials, web identity, container/instance metadata, or short-lived shell credentials.";

export const AWS_CREDENTIAL_CUSTODY_WARNING =
  "Do not store AWS root credentials or long-lived IAM user access keys in Paperclip company_secrets; the AWS provider bootstrap belongs in deployment infrastructure, the process environment, an AWS profile, or the orchestrator secret store.";

export interface AwsSecretsManagerMaterial extends StoredSecretVersionMaterial {
  scheme: typeof AWS_SECRETS_MANAGER_SCHEME;
  secretId: string;
  versionId: string | null;
  source: "managed" | "external_reference";
}

export interface AwsSecretsManagerConfig {
  region: string;
  endpoint: string;
  deploymentId: string;
  prefix: string;
  kmsKeyId: string | null;
  environmentTag: string;
  providerOwnerTag: string;
  deleteRecoveryWindowDays: number;
}

export interface AwsSecretsManagerTag {
  Key: string;
  Value: string;
}

export interface AwsSecretsManagerListSecretEntry {
  ARN?: string;
  Name?: string;
  Description?: string;
  KmsKeyId?: string;
  CreatedDate?: string | number | Date;
  LastAccessedDate?: string | number | Date;
  LastChangedDate?: string | number | Date;
  DeletedDate?: string | number | Date;
  Tags?: AwsSecretsManagerTag[];
}

export interface AwsCredentialIdentity {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface CachedAwsCredentialProvider {
  client: S3Client;
  credentials: AwsCredentialIdentity | null;
  expiresAt: number;
  pending: Promise<AwsCredentialIdentity> | null;
}

export type ManagedSecretNamespaceContext = Pick<SecretProviderWriteContext, "companyId" | "secretKey">;

export const awsCredentialProviders = new Map<string, CachedAwsCredentialProvider>();

export interface AwsSecretsManagerGateway {
  createSecret(input: {
    Name: string;
    SecretString: string;
    KmsKeyId?: string;
    Description?: string;
    Tags: AwsSecretsManagerTag[];
  }): Promise<{
    ARN?: string;
    Name?: string;
    VersionId?: string;
  }>;
  putSecretValue(input: { SecretId: string; SecretString: string; VersionStages?: string[] }): Promise<{
    ARN?: string;
    Name?: string;
    VersionId?: string;
  }>;
  getSecretValue(input: { SecretId: string; VersionId?: string; VersionStage?: string }): Promise<{
    SecretString?: string;
    ARN?: string;
    Name?: string;
    VersionId?: string;
  }>;
  deleteSecret(input: { SecretId: string; RecoveryWindowInDays: number }): Promise<unknown>;
  updateSecretVersionStage?(input: {
    SecretId: string;
    VersionStage: string;
    RemoveFromVersionId?: string;
    MoveToVersionId?: string;
  }): Promise<unknown>;
  listSecrets?(input: {
    MaxResults?: number;
    NextToken?: string;
    Filters?: Array<{
      Key: "all" | "name" | "description" | "tag-key" | "tag-value" | "primary-region" | "owning-service";
      Values: string[];
    }>;
    IncludePlannedDeletion?: boolean;
  }): Promise<{
    SecretList?: AwsSecretsManagerListSecretEntry[];
    NextToken?: string;
  }>;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hmac(key: string | Buffer, value: string) {
  return createHmac("sha256", key).update(value).digest();
}

export function awsDateParts(now = new Date()) {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8),
  };
}

export function canonicalHeaderValue(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

export function signAwsSecretsManagerRequest(input: {
  endpoint: URL;
  region: string;
  operation: string;
  body: string;
  credentials: AwsCredentialIdentity;
}) {
  const { amzDate, dateStamp } = awsDateParts();
  const payloadHash = sha256Hex(input.body);
  const headers: Record<string, string> = {
    "content-type": "application/x-amz-json-1.1",
    host: input.endpoint.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    "x-amz-target": `secretsmanager.${input.operation}`,
  };
  if (input.credentials.sessionToken) {
    headers["x-amz-security-token"] = input.credentials.sessionToken;
  }

  const sortedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaderNames
    .map((name) => `${name}:${canonicalHeaderValue(headers[name] ?? "")}\n`)
    .join("");
  const signedHeaders = sortedHeaderNames.join(";");
  const canonicalRequest = [
    "POST",
    input.endpoint.pathname || "/",
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${input.region}/secretsmanager/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const dateKey = hmac(`AWS4${input.credentials.secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, input.region);
  const serviceKey = hmac(regionKey, "secretsmanager");
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  return {
    ...headers,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export async function loadAwsCredentials(region: string): Promise<AwsCredentialIdentity> {
  const now = Date.now();
  let cached = awsCredentialProviders.get(region);
  if (!cached) {
    // S3Client is only used as a carrier for the AWS SDK default credential provider chain.
    // No S3 API calls are made here; switch to defaultProvider({ region }) if we add that dependency.
    cached = {
      client: new S3Client({ region }),
      credentials: null,
      expiresAt: 0,
      pending: null,
    };
    awsCredentialProviders.set(region, cached);
  }

  if (cached.credentials && cached.expiresAt > now) return cached.credentials;
  if (cached.pending) return cached.pending;

  cached.pending = (async () => {
    const credentialSource = cached.client.config.credentials;
    const credentials =
      typeof credentialSource === "function" ? await credentialSource() : await credentialSource;
    if (!credentials?.accessKeyId || !credentials.secretAccessKey) {
      throw new Error("AWS SDK default credential provider chain did not return credentials");
    }
    const resolved = {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    };
    const expiration = (credentials as { expiration?: Date }).expiration?.getTime();
    cached.credentials = resolved;
    cached.expiresAt = Math.min(
      now + AWS_CREDENTIAL_CACHE_TTL_MS,
      expiration ? expiration - AWS_CREDENTIAL_EXPIRATION_SKEW_MS : Number.POSITIVE_INFINITY,
    );
    return resolved;
  })().finally(() => {
    if (cached) cached.pending = null;
  });

  return cached.pending;
}
