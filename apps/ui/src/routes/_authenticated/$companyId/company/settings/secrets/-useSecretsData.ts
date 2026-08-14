import { secretsApi } from "@/api/secrets";
import { queryKeys } from "@/lib/queryKeys";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  EMPTY_MY_USER_SECRETS,
  EMPTY_PROVIDER_CONFIGS,
  EMPTY_SECRETS,
  EMPTY_SECRET_PROVIDERS,
  EMPTY_USER_SECRET_DEFINITIONS,
  type SecretValueProvider,
  type UnifiedSecretRow,
  deriveCompanySecretKey,
  getAwsManagedPathPreview,
  getCreateProviderBlockReason,
  getProviderConfigBlockReason,
  providerHealthText,
} from "./-secrets-model";
import type { SecretsControllerState } from "./-useSecretsControllerState";

type SecretsDataState = Pick<
  SecretsControllerState,
  | "createForm"
  | "createMode"
  | "providedByFilter"
  | "providerFilter"
  | "rotateProviderConfigId"
  | "search"
  | "selectedDefinitionId"
  | "selectedSecretId"
  | "statusFilter"
  | "usageDialogSecretId"
>;

export interface UseSecretsDataOptions {
  companyId: string;
  currentUserId: string | null;
  state: SecretsDataState;
}

export function useSecretsData({ companyId, currentUserId, state }: UseSecretsDataOptions) {
  const {
    createForm,
    createMode,
    providedByFilter,
    providerFilter,
    rotateProviderConfigId,
    search,
    selectedDefinitionId,
    selectedSecretId,
    statusFilter,
    usageDialogSecretId,
  } = state;
  const secretsQuery = useQuery({
    queryKey: queryKeys.secrets.list(companyId),
    queryFn: () => secretsApi.list(companyId),
  });
  const userDefinitionsQuery = useQuery({
    queryKey: queryKeys.secrets.userDefinitions(companyId),
    queryFn: () => secretsApi.listUserSecretDefinitions(companyId),
  });
  const myUserSecretsQuery = useQuery({
    queryKey: currentUserId
      ? queryKeys.secrets.userSecrets(companyId, currentUserId)
      : (["user-secrets", companyId, currentUserId] as const),
    queryFn: () => secretsApi.listUserSecrets(companyId, currentUserId!),
    enabled: Boolean(currentUserId),
  });
  const providersQuery = useQuery({
    queryKey: queryKeys.secrets.providers(companyId),
    queryFn: () => secretsApi.providers(companyId),
    staleTime: 5 * 60_000,
  });
  const providerHealthQuery = useQuery({
    queryKey: ["secret-provider-health", companyId],
    queryFn: () => secretsApi.providerHealth(companyId),
    // Provider connectivity can change without a Paperclip mutation.
    refetchInterval: 60_000,
    retry: false,
  });
  const providerConfigsQuery = useQuery({
    queryKey: queryKeys.secrets.providerConfigs(companyId),
    queryFn: () => secretsApi.providerConfigs(companyId),
    retry: false,
  });

  const secrets = secretsQuery.data ?? EMPTY_SECRETS;
  const userDefinitions = userDefinitionsQuery.data ?? EMPTY_USER_SECRET_DEFINITIONS;
  const myUserSecrets = myUserSecretsQuery.data ?? EMPTY_MY_USER_SECRETS;
  const providers = providersQuery.data ?? EMPTY_SECRET_PROVIDERS;
  const providerConfigs = providerConfigsQuery.data ?? EMPTY_PROVIDER_CONFIGS;
  const selectedSecret = useMemo(
    () => secrets.find((secret) => secret.id === selectedSecretId) ?? null,
    [secrets, selectedSecretId],
  );
  const selectedDefinition = useMemo(
    () => userDefinitions.find((definition) => definition.id === selectedDefinitionId) ?? null,
    [selectedDefinitionId, userDefinitions],
  );
  const selectedDefinitionMyEntry = useMemo(() => {
    if (!selectedDefinition) return null;
    return (
      myUserSecrets.find((entry) => entry.definition.id === selectedDefinition.id) ?? {
        definition: selectedDefinition,
        secret: null,
      }
    );
  }, [myUserSecrets, selectedDefinition]);
  const usageDialogSecret = useMemo(
    () => secrets.find((secret) => secret.id === usageDialogSecretId) ?? null,
    [secrets, usageDialogSecretId],
  );
  const selectedCreateProvider = useMemo(
    () => providers.find((provider) => provider.id === createForm.provider) ?? null,
    [providers, createForm.provider],
  );
  const createProviderConfigs = useMemo(
    () => providerConfigs.filter((config) => config.provider === createForm.provider),
    [createForm.provider, providerConfigs],
  );
  const selectedCreateProviderConfig = useMemo(
    () => providerConfigs.find((config) => config.id === createForm.providerConfigId) ?? null,
    [createForm.providerConfigId, providerConfigs],
  );
  const selectedRotateProviderConfigs = useMemo(
    () => providerConfigs.filter((config) => config.provider === selectedSecret?.provider),
    [providerConfigs, selectedSecret?.provider],
  );
  const selectedRotateProviderConfig = useMemo(
    () => providerConfigs.find((config) => config.id === rotateProviderConfigId) ?? null,
    [providerConfigs, rotateProviderConfigId],
  );
  const createProviderBlockReason =
    getCreateProviderBlockReason(
      selectedCreateProvider,
      createMode,
      providerHealthQuery.data ?? null,
      selectedCreateProviderConfig,
    ) ?? getProviderConfigBlockReason(selectedCreateProviderConfig);
  const rotateProviderBlockReason = getProviderConfigBlockReason(selectedRotateProviderConfig);
  const createProviderHealthText = providerHealthText(
    selectedCreateProvider,
    providerHealthQuery.data ?? null,
    selectedCreateProviderConfig,
  );
  const awsManagedPathPreview = getAwsManagedPathPreview({
    provider: selectedCreateProvider,
    health: providerHealthQuery.data ?? null,
    companyId,
    secretKey: createForm.key.length > 0 ? createForm.key : deriveCompanySecretKey(createForm.name),
  });

  const unifiedRows = useMemo<UnifiedSecretRow[]>(
    () => [
      ...secrets.map((secret) => ({
        id: `company:${secret.id}`,
        kind: "company" as const,
        secret,
      })),
      ...userDefinitions.map((definition) => ({
        id: `user:${definition.id}`,
        kind: "user" as const,
        definition,
      })),
    ],
    [secrets, userDefinitions],
  );
  const filteredRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return unifiedRows.filter((row) => {
      const providedBy: SecretValueProvider = row.kind === "company" ? "company" : "user";
      const status = row.kind === "company" ? row.secret.status : row.definition.status;
      if (providedByFilter !== "all" && providedBy !== providedByFilter) {
        return false;
      }
      if (statusFilter !== "all" && status !== statusFilter) return false;
      if (providerFilter !== "all" && row.kind === "company" && row.secret.provider !== providerFilter) {
        return false;
      }
      if (!needle) return true;
      if (row.kind === "company") {
        return (
          row.secret.name.toLowerCase().includes(needle) ||
          row.secret.key.toLowerCase().includes(needle) ||
          (row.secret.description?.toLowerCase().includes(needle) ?? false) ||
          (row.secret.externalRef?.toLowerCase().includes(needle) ?? false)
        );
      }
      return (
        row.definition.name.toLowerCase().includes(needle) ||
        row.definition.key.toLowerCase().includes(needle) ||
        (row.definition.description?.toLowerCase().includes(needle) ?? false) ||
        (row.definition.usageGuidance?.toLowerCase().includes(needle) ?? false)
      );
    });
  }, [providedByFilter, providerFilter, search, statusFilter, unifiedRows]);
  const activeSecretFilterCount =
    (statusFilter === "active" ? 0 : 1) +
    (providerFilter === "all" ? 0 : 1) +
    (providedByFilter === "all" ? 0 : 1);

  const usageQuery = useQuery({
    queryKey: selectedSecret
      ? queryKeys.secrets.usage(selectedSecret.id)
      : ["secrets", "usage", "__disabled__"],
    queryFn: () => secretsApi.usage(selectedSecret!.id),
    enabled: Boolean(selectedSecret),
  });
  const eventsQuery = useQuery({
    queryKey: selectedSecret
      ? queryKeys.secrets.accessEvents(selectedSecret.id)
      : ["secrets", "access-events", "__disabled__"],
    queryFn: () => secretsApi.accessEvents(selectedSecret!.id),
    enabled: Boolean(selectedSecret),
  });
  const usageDialogQuery = useQuery({
    queryKey: usageDialogSecret
      ? queryKeys.secrets.usage(usageDialogSecret.id)
      : ["secrets", "usage-dialog", "__disabled__"],
    queryFn: () => secretsApi.usage(usageDialogSecret!.id),
    enabled: Boolean(usageDialogSecret),
  });

  return {
    secretsQuery,
    userDefinitionsQuery,
    myUserSecretsQuery,
    providersQuery,
    providerHealthQuery,
    providerConfigsQuery,
    secrets,
    userDefinitions,
    myUserSecrets,
    providers,
    providerConfigs,
    selectedSecret,
    selectedDefinition,
    selectedDefinitionMyEntry,
    usageDialogSecret,
    selectedCreateProvider,
    createProviderConfigs,
    selectedCreateProviderConfig,
    selectedRotateProviderConfigs,
    selectedRotateProviderConfig,
    createProviderBlockReason,
    rotateProviderBlockReason,
    createProviderHealthText,
    awsManagedPathPreview,
    unifiedRows,
    filteredRows,
    activeSecretFilterCount,
    usageQuery,
    eventsQuery,
    usageDialogQuery,
  };
}

export type SecretsData = ReturnType<typeof useSecretsData>;
