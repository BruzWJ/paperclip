import type { MyUserSecretEntry } from "@/api/secrets";
import { assertOnlySearchKeys, optionalExactSearchString } from "@/routes/-search";
import type {
  CompanySecret,
  CompanySecretProviderConfig,
  SecretProvider,
  SecretProviderConfigStatus,
  SecretProviderDescriptor,
  UserSecretDefinition,
} from "@paperclipai/shared";

export function validateSecretsSearch(search: Record<string, unknown>): {
  path?: string;
} {
  assertOnlySearchKeys(search, ["path"]);
  const path = optionalExactSearchString(search.path, "path");
  if (path !== undefined && path.split("/").some((segment) => segment.trim().length === 0)) {
    throw new Error('Invalid search parameter "path": must use exact non-empty slash-separated segments');
  }
  return { path };
}

export type CreateMode = "managed" | "external";

export type SecretValueProvider = "company" | "user";

export type ProvidedByFilter = "all" | SecretValueProvider;

export type SecretsTab = "secrets" | "my-secrets" | "vaults";

export type SecretsViewMode = "folders" | "flat";

export const SECRETS_VIEW_MODE_STORAGE_KEY = "paperclip.secrets.viewMode";

export function readStoredViewMode(): SecretsViewMode | null {
  try {
    const stored = window.localStorage.getItem(SECRETS_VIEW_MODE_STORAGE_KEY);
    return stored === "folders" || stored === "flat" ? stored : null;
  } catch {
    return null;
  }
}

/** "12 secrets · 3 folders" — folder part omitted when there are no subfolders. */
export function formatSecretPathCounts(secretCount: number, folderCount: number): string {
  const parts = [`${secretCount} ${secretCount === 1 ? "secret" : "secrets"}`];
  if (folderCount > 0) {
    parts.push(`${folderCount} ${folderCount === 1 ? "folder" : "folders"}`);
  }
  return parts.join(" · ");
}

export type UnifiedSecretRow =
  | { id: string; kind: "company"; secret: CompanySecret }
  | { id: string; kind: "user"; definition: UserSecretDefinition };

export type ProviderVaultForm = {
  provider: SecretProvider;
  displayName: string;
  status: SecretProviderConfigStatus;
  isDefault: boolean;
  backupReminderAcknowledged: boolean;
  region: string;
  namespace: string;
  secretNamePrefix: string;
  kmsKeyId: string;
  ownerTag: string;
  environmentTag: string;
  projectId: string;
  location: string;
  address: string;
  mountPath: string;
  secretPathPrefix: string;
};

export type SafeProviderErrorDetails = {
  code?: string;
  provider?: string;
  operation?: string;
  providerConfigId?: string;
  providerVaultContext?: string;
  region?: string;
  credentialPath?: string;
  requiredCapability?: string;
  actionableMessage?: string;
  safeAlternative?: string;
};

export const EMPTY_SECRETS: CompanySecret[] = [];

export const EMPTY_USER_SECRET_DEFINITIONS: UserSecretDefinition[] = [];

export const EMPTY_MY_USER_SECRETS: MyUserSecretEntry[] = [];

export const EMPTY_SECRET_PROVIDERS: SecretProviderDescriptor[] = [];

export const EMPTY_PROVIDER_CONFIGS: CompanySecretProviderConfig[] = [];

export const PROVIDER_ORDER: SecretProvider[] = [
  "local_encrypted",
  "aws_secrets_manager",
  "gcp_secret_manager",
  "vault",
];
