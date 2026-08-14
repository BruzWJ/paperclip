import type { SecretProviderConfigDiscoveryPreviewResult } from "@paperclipai/shared";
import type {
  RemoteSecretListResult,
  SecretProviderHealthCheck,
  SecretProviderModule,
  SecretProviderValidationResult,
  SecretProviderVaultRuntimeConfig,
} from "./types.js";
import * as awsCredentials from "./aws-secrets-manager-credentials.js";
import * as awsConfig from "./aws-secrets-manager-config.js";
import * as awsMaterial from "./aws-secrets-manager-material.js";
import {
  asAwsSecretsManagerMaterial,
  discoverAwsProviderConfigCandidates,
  normalizeAwsError,
} from "./aws-secrets-manager-discovery.js";
import { AwsSecretsManagerJsonGateway } from "./aws-secrets-manager-gateway.js";

export function createAwsSecretsManagerProvider(options?: {
  config?: awsCredentials.AwsSecretsManagerConfig;
  gateway?: awsCredentials.AwsSecretsManagerGateway;
}): SecretProviderModule {
  function resolveConfig(providerConfig?: SecretProviderVaultRuntimeConfig | null) {
    return awsConfig.assertExactAwsConfig(
      providerConfig
        ? awsConfig.readProviderVaultConfig(providerConfig)
        : (options?.config ?? awsConfig.loadAwsSecretsManagerConfig()),
    );
  }

  function resolveGateway(config: awsCredentials.AwsSecretsManagerConfig) {
    return options?.gateway ?? new AwsSecretsManagerJsonGateway(config);
  }

  async function validateConfig(input?: {
    strictMode?: boolean;
    providerConfig?: SecretProviderVaultRuntimeConfig | null;
  }): Promise<SecretProviderValidationResult> {
    const warnings: string[] = [];
    if (input?.strictMode === false) {
      warnings.push("Strict secret mode is disabled");
    }
    const config = resolveConfig(input?.providerConfig);
    if (!config.prefix) {
      warnings.push("PAPERCLIP_SECRETS_AWS_PREFIX should be set to a deployment-scoped prefix");
    }
    return { ok: true, warnings };
  }

  async function healthCheck(input?: {
    strictMode?: boolean;
    providerConfig?: SecretProviderVaultRuntimeConfig | null;
  }): Promise<SecretProviderHealthCheck> {
    try {
      const validation = await validateConfig(input);
      const config = resolveConfig(input?.providerConfig);
      const readiness = awsConfig.getAwsConfigReadiness();
      const warnings = [...validation.warnings];
      if (process.env.AWS_ACCESS_KEY_ID?.trim() && process.env.AWS_SECRET_ACCESS_KEY?.trim()) {
        warnings.push(
          "AWS static environment credentials are visible to this process; use only short-lived shell credentials locally and prefer IAM role/workload identity for hosted deployments.",
        );
      }
      return {
        provider: "aws_secrets_manager",
        status: warnings.length > 0 ? "warn" : "ok",
        message:
          "AWS Secrets Manager provider config is present; AWS credentials are resolved by the server runtime through the AWS SDK default credential provider chain.",
        warnings,
        details: {
          region: config.region,
          prefix: config.prefix,
          deploymentId: config.deploymentId,
          kmsKeyConfigured: Boolean(config.kmsKeyId),
          credentialSource: "AWS SDK default credential provider chain",
          detectedCredentialSources: readiness.credentialSources,
        },
        backupGuidance: [
          "Back up Paperclip metadata separately from AWS-managed secrets.",
          "Restoring access requires the Paperclip database plus the same AWS secret namespace and KMS permissions.",
        ],
      };
    } catch (error) {
      const readiness = awsConfig.getAwsConfigReadiness();
      const providerConfigMissing =
        input?.providerConfig &&
        (typeof input.providerConfig.config.region !== "string" ||
          input.providerConfig.config.region.length === 0 ||
          input.providerConfig.config.region.trim() !== input.providerConfig.config.region)
          ? ["region"]
          : [];
      const missingConfig = input?.providerConfig ? providerConfigMissing : readiness.missingConfig;
      return {
        provider: "aws_secrets_manager",
        status: "warn",
        message:
          missingConfig.length > 0
            ? `AWS Secrets Manager provider is not ready: missing ${missingConfig.join(", ")}.`
            : error instanceof Error
              ? error.message
              : String(error),
        warnings: [
          ...(missingConfig.length > 0
            ? [`Missing required non-secret AWS provider config: ${missingConfig.join(", ")}.`]
            : []),
          awsCredentials.AWS_RUNTIME_CREDENTIAL_WARNING,
          awsCredentials.AWS_CREDENTIAL_CUSTODY_WARNING,
          "Managed secret create/rotate/resolve calls will fail until AWS provider configuration is complete.",
        ],
        details: {
          missingConfig,
          requiredProviderConfig: input?.providerConfig
            ? ["region"]
            : [
                "PAPERCLIP_SECRETS_AWS_REGION or AWS_REGION/AWS_DEFAULT_REGION",
                "PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID",
                "PAPERCLIP_SECRETS_AWS_KMS_KEY_ID",
              ],
          optionalProviderConfig: [
            "PAPERCLIP_SECRETS_AWS_PREFIX",
            "PAPERCLIP_SECRETS_AWS_ENVIRONMENT",
            "PAPERCLIP_SECRETS_AWS_PROVIDER_OWNER",
            "PAPERCLIP_SECRETS_AWS_ENDPOINT",
            "PAPERCLIP_SECRETS_AWS_DELETE_RECOVERY_DAYS",
          ],
          credentialSource: "AWS SDK default credential provider chain",
          detectedCredentialSources: readiness.credentialSources,
        },
      };
    }
  }

  return {
    id: "aws_secrets_manager",
    descriptor() {
      return awsConfig.configuredAwsSecretsManagerDescriptor();
    },
    validateConfig,
    async createSecret(input) {
      const config = resolveConfig(input.providerConfig);
      const gateway = resolveGateway(config);
      const valueSha256 = awsCredentials.sha256Hex(input.value);
      const secretId = awsMaterial.buildManagedSecretId(config, input.context);

      try {
        const createInput = {
          Name: secretId,
          SecretString: input.value,
          ...(config.kmsKeyId ? { KmsKeyId: config.kmsKeyId } : {}),
          Description: input.context ? `Paperclip secret ${input.context.secretName}` : undefined,
          Tags: awsMaterial.buildManagedSecretTags(config, input.context),
        };
        const created = await gateway.createSecret({
          ...createInput,
        });
        const createdSecretId = awsConfig.requireExactAwsIdentity(
          created.ARN ?? created.Name ?? secretId,
          "AWS secret reference",
        );
        const createdVersionId = awsConfig.requireOptionalExactAwsIdentity(
          created.VersionId,
          "AWS secret version reference",
        );
        return {
          material: awsMaterial.createManagedMaterial(createdSecretId, createdVersionId),
          valueSha256,
          fingerprintSha256: valueSha256,
          externalRef: createdSecretId,
          providerVersionRef: createdVersionId,
        };
      } catch (error) {
        normalizeAwsError("createSecret", error);
      }
    },
    async createVersion(input) {
      const config = resolveConfig(input.providerConfig);
      const gateway = resolveGateway(config);
      const valueSha256 = awsCredentials.sha256Hex(input.value);
      const secretId = awsMaterial.resolveManagedSecretRef({
        config,
        context: input.context,
        externalRefs: [input.externalRef],
      });

      try {
        const created = await gateway.putSecretValue({
          SecretId: secretId,
          SecretString: input.value,
          VersionStages: [awsCredentials.PAPERCLIP_PENDING_VERSION_STAGE],
        });
        const createdSecretId = awsConfig.requireExactAwsIdentity(
          created.ARN ?? created.Name ?? secretId,
          "AWS secret reference",
        );
        const createdVersionId = awsConfig.requireOptionalExactAwsIdentity(
          created.VersionId,
          "AWS secret version reference",
        );
        return {
          material: awsMaterial.createManagedMaterial(createdSecretId, createdVersionId),
          valueSha256,
          fingerprintSha256: valueSha256,
          externalRef: createdSecretId,
          providerVersionRef: createdVersionId,
        };
      } catch (error) {
        normalizeAwsError("createVersion", error);
      }
    },
    async linkExternalSecret(input) {
      const config = resolveConfig(input.providerConfig);
      awsMaterial.assertNotManagedNamespaceExternalRef(config, input.externalRef);
      return awsMaterial.createExternalReferenceMaterial(input.externalRef, input.providerVersionRef ?? null);
    },
    async listRemoteSecrets(input): Promise<RemoteSecretListResult> {
      const config = resolveConfig(input.providerConfig);
      const gateway = resolveGateway(config);
      const query = input.query?.trim();
      const pageSize =
        input.pageSize && Number.isFinite(input.pageSize)
          ? Math.min(Math.max(Math.trunc(input.pageSize), 1), 100)
          : 50;

      try {
        if (!gateway.listSecrets) {
          throw new Error("ListSecrets gateway operation is unavailable");
        }
        const listed = await gateway.listSecrets({
          MaxResults: pageSize,
          NextToken: input.nextToken?.trim() || undefined,
          IncludePlannedDeletion: false,
          Filters: query ? [{ Key: "all", Values: [query] }] : undefined,
        });
        return {
          nextToken: listed.NextToken ?? null,
          secrets: (listed.SecretList ?? [])
            .filter((entry) => Boolean(entry.ARN ?? entry.Name))
            .map((entry) => ({
              externalRef: awsConfig.requireExactAwsIdentity(entry.ARN ?? entry.Name, "AWS secret reference"),
              name: entry.Name ?? entry.ARN ?? "",
              providerVersionRef: null,
              metadata: awsMaterial.createRemoteSecretMetadata(entry),
            })),
        };
      } catch (error) {
        normalizeAwsError("listSecrets", error);
      }
    },
    async discoverProviderConfigs(input): Promise<SecretProviderConfigDiscoveryPreviewResult> {
      const config = resolveConfig(input.providerConfig);
      const gateway = resolveGateway(config);
      const query = input.query?.trim();
      const pageSize =
        input.pageSize && Number.isFinite(input.pageSize)
          ? Math.min(Math.max(Math.trunc(input.pageSize), 1), 100)
          : 100;

      try {
        if (!gateway.listSecrets) {
          throw new Error("ListSecrets gateway operation is unavailable");
        }
        const listed = await gateway.listSecrets({
          MaxResults: pageSize,
          NextToken: input.nextToken?.trim() || undefined,
          IncludePlannedDeletion: false,
          Filters: query ? [{ Key: "all", Values: [query] }] : undefined,
        });
        return discoverAwsProviderConfigCandidates({
          companyId: input.companyId,
          config,
          draftConfig: input.providerConfig.config,
          entries: listed.SecretList ?? [],
          nextToken: listed.NextToken ?? null,
        });
      } catch (error) {
        normalizeAwsError("discoverProviderConfigs", error);
      }
    },
    async resolveVersion(input) {
      const config = resolveConfig(input.providerConfig);
      const gateway = resolveGateway(config);
      const material = asAwsSecretsManagerMaterial(input.material);
      const externalRef = awsConfig.requireOptionalExactAwsIdentity(
        input.externalRef,
        "AWS secret reference",
      );
      const providerVersionRef = awsConfig.requireOptionalExactAwsIdentity(
        input.providerVersionRef,
        "AWS secret version reference",
      );
      const secretId =
        material.source === "managed"
          ? awsMaterial.resolveManagedSecretRef({
              config,
              context: input.context,
              externalRefs: [externalRef, material.secretId],
            })
          : (externalRef ?? material.secretId);

      try {
        const resolved = await gateway.getSecretValue({
          SecretId: secretId,
          VersionId: providerVersionRef ?? material.versionId ?? undefined,
          VersionStage:
            providerVersionRef || material.versionId ? undefined : awsCredentials.DEFAULT_VERSION_STAGE,
        });
        if (typeof resolved.SecretString !== "string") {
          throw new Error("SecretString was empty");
        }
        return resolved.SecretString;
      } catch (error) {
        normalizeAwsError("resolveVersion", error);
      }
    },
    async deleteOrArchive(input) {
      const material =
        input.material && typeof input.material === "object"
          ? asAwsSecretsManagerMaterial(input.material)
          : null;

      if (material?.source !== "managed") return;

      const config = resolveConfig(input.providerConfig);
      const gateway = resolveGateway(config);
      const externalRef = awsConfig.requireOptionalExactAwsIdentity(
        input.externalRef,
        "AWS secret reference",
      );
      const secretId = awsMaterial.resolveManagedSecretRef({
        config,
        context: input.context,
        externalRefs: [externalRef, material.secretId],
      });

      try {
        if (input.mode === "archive") {
          if (material.versionId && gateway.updateSecretVersionStage) {
            await gateway.updateSecretVersionStage({
              SecretId: secretId,
              VersionStage: awsCredentials.PAPERCLIP_PENDING_VERSION_STAGE,
              RemoveFromVersionId: material.versionId,
            });
          }
          return;
        }
        await gateway.deleteSecret({
          SecretId: secretId,
          RecoveryWindowInDays: config.deleteRecoveryWindowDays,
        });
      } catch (error) {
        normalizeAwsError(input.mode === "archive" ? "updateSecretVersionStage" : "deleteSecret", error);
      }
    },
    healthCheck,
  };
}

export const awsSecretsManagerProvider = createAwsSecretsManagerProvider();
