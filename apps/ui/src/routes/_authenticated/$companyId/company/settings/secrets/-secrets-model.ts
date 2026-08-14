import { ApiError } from "@/api/client";
import { type SecretProviderHealthResponse } from "@/api/secrets";
import type {
  CompanySecretProviderConfig,
  SecretManagedMode,
  SecretProvider,
  SecretProviderConfigStatus,
  SecretProviderDescriptor,
  SecretStatus,
} from "@paperclipai/shared";
import type { CreateMode, ProviderVaultForm, SafeProviderErrorDetails } from "./-secrets-model-types.js";

export {
  EMPTY_MY_USER_SECRETS,
  EMPTY_PROVIDER_CONFIGS,
  EMPTY_SECRET_PROVIDERS,
  EMPTY_SECRETS,
  EMPTY_USER_SECRET_DEFINITIONS,
  PROVIDER_ORDER,
  SECRETS_VIEW_MODE_STORAGE_KEY,
  formatSecretPathCounts,
  readStoredViewMode,
  validateSecretsSearch,
} from "./-secrets-model-types.js";
export type {
  CreateMode,
  ProvidedByFilter,
  ProviderVaultForm,
  SafeProviderErrorDetails,
  SecretValueProvider,
  SecretsTab,
  SecretsViewMode,
  UnifiedSecretRow,
} from "./-secrets-model-types.js";

export function defaultProviderVaultStatus(provider: SecretProvider): SecretProviderConfigStatus {
  return provider === "gcp_secret_manager" || provider === "vault" ? "coming_soon" : "ready";
}

export function emptyProviderVaultForm(provider: SecretProvider = "local_encrypted"): ProviderVaultForm {
  return {
    provider,
    displayName: "",
    status: defaultProviderVaultStatus(provider),
    isDefault: false,
    backupReminderAcknowledged: false,
    region: "",
    namespace: "",
    secretNamePrefix: "",
    kmsKeyId: "",
    ownerTag: "",
    environmentTag: "",
    projectId: "",
    location: "",
    address: "",
    mountPath: "",
    secretPathPrefix: "",
  };
}

export function providerConfigValue(config: CompanySecretProviderConfig["config"], key: string) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return "";
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

export function apiErrorDetails(error: unknown): SafeProviderErrorDetails | null {
  if (!(error instanceof ApiError)) return null;
  const body = error.body;
  if (!body || typeof body !== "object") return null;
  const details = (body as Record<string, unknown>).details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  return details as SafeProviderErrorDetails;
}

export function apiErrorCode(error: unknown): string | null {
  return apiErrorDetails(error)?.code ?? null;
}

export function isAwsDiscoveryAccessDenied(error: unknown): boolean {
  const details = apiErrorDetails(error);
  if (
    details?.provider === "aws_secrets_manager" &&
    details.operation === "secret_provider_config.discovery.preview"
  ) {
    return details.code === "access_denied";
  }
  if (!(error instanceof ApiError)) return false;
  return apiErrorCode(error) === "access_denied";
}

export function readableErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message || `Request failed: ${error.status}`;
  if (error instanceof Error) return error.message;
  return "Unexpected error";
}

export function providerVaultFormFromConfig(config: CompanySecretProviderConfig): ProviderVaultForm {
  return {
    ...emptyProviderVaultForm(config.provider),
    displayName: config.displayName,
    status: config.status,
    isDefault: config.isDefault,
    backupReminderAcknowledged: Boolean(
      (config.config as Record<string, unknown> | undefined)?.backupReminderAcknowledged,
    ),
    region: providerConfigValue(config.config, "region"),
    namespace: providerConfigValue(config.config, "namespace"),
    secretNamePrefix: providerConfigValue(config.config, "secretNamePrefix"),
    kmsKeyId: providerConfigValue(config.config, "kmsKeyId"),
    ownerTag: providerConfigValue(config.config, "ownerTag"),
    environmentTag: providerConfigValue(config.config, "environmentTag"),
    projectId: providerConfigValue(config.config, "projectId"),
    location: providerConfigValue(config.config, "location"),
    address: providerConfigValue(config.config, "address"),
    mountPath: providerConfigValue(config.config, "mountPath"),
    secretPathPrefix: providerConfigValue(config.config, "secretPathPrefix"),
  };
}

export function formatRelative(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  const diff = Date.now() - date.getTime();
  if (diff < 0) return date.toLocaleString();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

export function providerLabel(providers: SecretProviderDescriptor[] | undefined, id: SecretProvider) {
  return providers?.find((p) => p.id === id)?.label ?? id.replaceAll("_", " ");
}

export function deriveCompanySecretKey(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

export function deriveUserSecretKey(input: string) {
  return input
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

export function modeLabel(managedMode: SecretManagedMode) {
  return managedMode === "paperclip_managed" ? "Paperclip-managed" : "Linked external";
}

export function modeDescription(managedMode: SecretManagedMode) {
  return managedMode === "paperclip_managed"
    ? "Paperclip owns create and rotation writes for this provider secret."
    : "Paperclip resolves this provider reference but does not rotate the provider value.";
}

export function statusLabel(status: SecretStatus) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function healthEntryForProvider(
  health: SecretProviderHealthResponse | null,
  providerId: SecretProvider,
) {
  return health?.providers.find((entry) => entry.provider === providerId) ?? null;
}

export function getCreateProviderBlockReason(
  provider: SecretProviderDescriptor | null | undefined,
  mode: CreateMode,
  health: SecretProviderHealthResponse | null,
  providerConfig?: CompanySecretProviderConfig | null,
) {
  if (!provider) return "Select a provider.";
  if (mode === "managed" && provider.supportsManagedValues === false) {
    return `${provider.label} does not support Paperclip-managed secret values.`;
  }
  if (mode === "external" && provider.supportsExternalReferences === false) {
    return `${provider.label} does not support linked external references.`;
  }
  const selectedProviderConfigBlockReason =
    providerConfig?.provider === provider.id ? getProviderConfigBlockReason(providerConfig) : null;
  const selectedProviderConfigReady =
    providerConfig?.provider === provider.id && !selectedProviderConfigBlockReason;
  if (provider.configured === false) {
    if (selectedProviderConfigReady) return null;
    if (selectedProviderConfigBlockReason) return selectedProviderConfigBlockReason;
    const healthEntry = healthEntryForProvider(health, provider.id);
    const deploymentMessage = `Deployment default ${provider.label} is not configured.`;
    const nextStep = " Select a ready provider vault or configure the deployment default.";
    return healthEntry?.message
      ? `${deploymentMessage}${nextStep} ${healthEntry.message}`
      : `${deploymentMessage}${nextStep}`;
  }
  const healthEntry = healthEntryForProvider(health, provider.id);
  if (healthEntry?.status === "error") {
    return `${provider.label} health check failed: ${healthEntry.message}`;
  }
  return null;
}

export function providerHealthText(
  provider: SecretProviderDescriptor | null | undefined,
  health: SecretProviderHealthResponse | null,
  providerConfig?: CompanySecretProviderConfig | null,
) {
  if (!provider) return null;
  if (
    provider.configured === false &&
    providerConfig?.provider === provider.id &&
    !getProviderConfigBlockReason(providerConfig)
  ) {
    return `Using selected provider vault. Deployment default ${provider.label} is not configured.`;
  }
  const entry = healthEntryForProvider(health, provider.id);
  if (!entry) return null;
  const warnings = entry.warnings?.join(" ");
  return [entry.message, warnings].filter(Boolean).join(" ");
}

export function detailString(details: Record<string, unknown> | undefined, key: string) {
  const value = details?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function getProviderConfigBlockReason(config: CompanySecretProviderConfig | null | undefined) {
  if (!config) return null;
  if (config.status === "disabled") return "This provider vault is disabled.";
  if (config.status === "coming_soon") return "This provider vault is saved as draft metadata only.";
  if (config.healthStatus === "error") {
    return config.healthMessage ?? "This provider vault health check failed.";
  }
  return null;
}

export function getSelectableProviderConfig(
  configs: CompanySecretProviderConfig[],
  provider: SecretProvider,
) {
  const providerConfigs = configs.filter((config) => config.provider === provider);
  return (
    providerConfigs.find((config) => config.isDefault && !getProviderConfigBlockReason(config)) ??
    providerConfigs.find((config) => !getProviderConfigBlockReason(config)) ??
    null
  );
}

export function getDefaultProviderConfigId(configs: CompanySecretProviderConfig[], provider: SecretProvider) {
  const selected = getSelectableProviderConfig(configs, provider);
  const providerConfigs = configs.filter((config) => config.provider === provider);
  return selected?.id ?? providerConfigs.find((config) => config.isDefault)?.id ?? "";
}

export function findCreateProviderReplacement({
  providers,
  providerConfigs,
  currentProvider,
  mode,
  health,
}: {
  providers: SecretProviderDescriptor[];
  providerConfigs: CompanySecretProviderConfig[];
  currentProvider: SecretProvider;
  mode: CreateMode;
  health: SecretProviderHealthResponse | null;
}) {
  return (
    providers.find((provider) => {
      const selectedConfig =
        provider.id === currentProvider
          ? (providerConfigs.find(
              (config) => config.provider === provider.id && !getProviderConfigBlockReason(config),
            ) ?? null)
          : getSelectableProviderConfig(providerConfigs, provider.id);
      return !getCreateProviderBlockReason(provider, mode, health, selectedConfig);
    }) ?? null
  );
}

export function providerVaultLabel(configs: CompanySecretProviderConfig[], id: string | null | undefined) {
  if (!id) return "Deployment default";
  return configs.find((config) => config.id === id)?.displayName ?? "Unknown vault";
}

export function buildProviderVaultConfig(form: ProviderVaultForm): Record<string, unknown> {
  const optional = (value: string) => (value === "" ? null : value);
  switch (form.provider) {
    case "local_encrypted":
      return { backupReminderAcknowledged: form.backupReminderAcknowledged };
    case "aws_secrets_manager":
      return {
        region: form.region,
        namespace: optional(form.namespace),
        secretNamePrefix: optional(form.secretNamePrefix),
        kmsKeyId: optional(form.kmsKeyId),
        ownerTag: optional(form.ownerTag),
        environmentTag: optional(form.environmentTag),
      };
    case "gcp_secret_manager":
      return {
        projectId: optional(form.projectId),
        location: optional(form.location),
        namespace: optional(form.namespace),
        secretNamePrefix: optional(form.secretNamePrefix),
      };
    case "vault":
      return {
        address: optional(form.address),
        namespace: optional(form.namespace),
        mountPath: optional(form.mountPath),
        secretPathPrefix: optional(form.secretPathPrefix),
      };
    default:
      return {};
  }
}

export function getAwsProviderVaultDiscoveryQuery(form: ProviderVaultForm): string | null {
  return (
    form.secretNamePrefix.trim() ||
    form.namespace.trim() ||
    form.environmentTag.trim() ||
    form.ownerTag.trim() ||
    null
  );
}

export function getAwsManagedPathPreview(input: {
  provider: SecretProviderDescriptor | null | undefined;
  health: SecretProviderHealthResponse | null;
  companyId: string;
  secretKey: string;
}) {
  if (input.provider?.id !== "aws_secrets_manager") return null;
  const healthEntry = healthEntryForProvider(input.health, "aws_secrets_manager");
  const prefix = detailString(healthEntry?.details, "prefix") ?? "paperclip";
  const deploymentId = detailString(healthEntry?.details, "deploymentId") ?? "{deploymentId}";
  const secretKey = /^[a-zA-Z0-9_.-]{1,120}$/.test(input.secretKey) ? input.secretKey : "{secretKey}";
  return `${prefix}/${deploymentId}/${input.companyId}/${secretKey}`;
}
