import { userSecretDefinitions } from "@paperclipai/db";
import type { SecretProvider, SecretProviderConfigStatus } from "@paperclipai/shared";
import { HttpError, unprocessable } from "../errors.js";
import { isSecretProviderClientError } from "../secrets/types.js";
import { COMING_SOON_SECRET_PROVIDERS } from "./secret-mutation-foundation.js";
import * as secretBindings from "./secrets.js";

export function defaultProviderConfigStatus(provider: SecretProvider): SecretProviderConfigStatus {
  return COMING_SOON_SECRET_PROVIDERS.has(provider) ? "coming_soon" : "ready";
}

export function secretResolutionErrorCode(error: unknown): secretBindings.SecretResolutionErrorCode {
  if (isSecretProviderClientError(error)) return "provider_error";
  if (error instanceof HttpError) {
    const details = secretBindings.asRecord(error.details);
    switch (details?.code) {
      case "binding_missing":
      case "secret_deleted":
      case "secret_inactive":
      case "version_missing":
      case "version_inactive":
      case "provider_error":
        return details.code;
    }
    if (error.message === "Secret is not active") return "secret_inactive";
    if (error.message === "User secret value is not configured") return "user_secret_missing";
    if (error.message === "Responsible user is required for user secret resolution") {
      return "responsible_user_missing";
    }
    if (error.message === "User secret definition not found") return "user_secret_definition_missing";
    if (error.message === "User secret definition is not active") return "user_secret_definition_inactive";
    if (error.message === "User-scoped secrets must be resolved through user secret declarations") {
      return "secret_scope_invalid";
    }
    if (error.message === "Secret version not found") return "version_missing";
    if (error.message === "Secret version is not active") return "version_inactive";
    if (
      error.message === "Secret resolution requires a binding config path" ||
      error.message.startsWith("Secret is not bound to ")
    ) {
      return "binding_missing";
    }
    if (error.status >= 500) return "provider_error";
  }
  return "provider_error";
}

export function missingUserSecretDefinitionRuntimeBinding(
  entry: {
    key: string;
    configPath: string;
    binding: Extract<secretBindings.CanonicalEnvBinding, { type: "user_secret_ref" }>;
  },
  context: Omit<secretBindings.SecretConsumerContext, "configPath">,
  definition: typeof userSecretDefinitions.$inferSelect | null,
  errorCode: "user_secret_definition_missing" | "user_secret_definition_inactive",
): secretBindings.MissingRuntimeBinding {
  return {
    consumerType: secretBindings.missingRuntimeConsumerType(context.consumerType),
    consumerId: context.consumerId,
    configPath: entry.configPath,
    envKey: entry.key,
    bindingType: "user_secret_ref",
    secretId: null,
    secretName: null,
    userSecretDefinitionId: definition?.id ?? null,
    userSecretDefinitionKey: definition?.key ?? entry.binding.key,
    userSecretDefinitionName: definition?.name ?? null,
    responsibleUserId: context.responsibleUserId ?? null,
    errorCode,
  };
}

export function assertSelectableProviderConfig(
  config: {
    provider: string;
    status: string;
    companyId: string;
  },
  companyId: string,
  provider: SecretProvider,
) {
  if (config.companyId !== companyId) throw unprocessable("Provider vault must belong to same company");
  if (config.provider !== provider) throw unprocessable("Provider vault must match the secret provider");
  if (config.status === "coming_soon") {
    throw unprocessable("Provider vault is locked while coming soon");
  }
  if (config.status === "disabled") {
    throw unprocessable("Provider vault is disabled");
  }
}
