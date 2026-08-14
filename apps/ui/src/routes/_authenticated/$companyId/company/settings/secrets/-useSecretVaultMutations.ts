import { ApiError } from "@/api/client";
import {
  secretsApi,
  type CreateSecretProviderConfigInput,
  type UpdateSecretProviderConfigInput,
} from "@/api/secrets";
import type {
  CompanySecretProviderConfig,
  SecretProvider,
  SecretProviderConfigDiscoveryCandidate,
} from "@paperclipai/shared";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  buildProviderVaultConfig,
  emptyProviderVaultForm,
  getAwsProviderVaultDiscoveryQuery,
  providerConfigValue,
  providerVaultFormFromConfig,
} from "./-secrets-model";
import type { SecretsControllerState } from "./-useSecretsControllerState";

type SecretVaultState = Pick<
  SecretsControllerState,
  | "editingVault"
  | "setEditingVault"
  | "setImportInitialVaultId"
  | "setImportOpen"
  | "setRemoveVaultConfirm"
  | "setVaultDialogOpen"
  | "setVaultDiscovery"
  | "setVaultDiscoveryError"
  | "setVaultError"
  | "setVaultForm"
  | "vaultForm"
>;

export interface UseSecretVaultMutationsOptions {
  companyId: string;
  invalidateAll: (extraIds?: string[]) => void;
  state: SecretVaultState;
}

export function useSecretVaultMutations({ companyId, invalidateAll, state }: UseSecretVaultMutationsOptions) {
  const {
    editingVault,
    setEditingVault,
    setImportInitialVaultId,
    setImportOpen,
    setRemoveVaultConfirm,
    setVaultDialogOpen,
    setVaultDiscovery,
    setVaultDiscoveryError,
    setVaultError,
    setVaultForm,
    vaultForm,
  } = state;

  const saveVaultMutation = useMutation({
    mutationFn: () => {
      const data: CreateSecretProviderConfigInput | UpdateSecretProviderConfigInput = {
        displayName: vaultForm.displayName.trim(),
        status: vaultForm.status,
        isDefault: vaultForm.isDefault,
        config: buildProviderVaultConfig(vaultForm),
      };
      if (editingVault) {
        return secretsApi.updateProviderConfig(editingVault.id, data);
      }
      return secretsApi.createProviderConfig(companyId, {
        ...(data as UpdateSecretProviderConfigInput),
        provider: vaultForm.provider,
      } as CreateSecretProviderConfigInput);
    },
    onSuccess: (saved) => {
      toast.success(editingVault ? "Provider vault updated" : "Provider vault created", {
        description: saved.displayName,
      });
      setVaultDialogOpen(false);
      setEditingVault(null);
      setVaultForm(emptyProviderVaultForm());
      setVaultError(null);
      invalidateAll();
    },
    onError: (error) => {
      setVaultError(error instanceof ApiError ? error.message : (error as Error).message);
    },
  });

  const discoverVaultMutation = useMutation({
    mutationFn: () =>
      secretsApi.providerConfigDiscoveryPreview(companyId, {
        provider: "aws_secrets_manager",
        config: buildProviderVaultConfig(vaultForm),
        query: getAwsProviderVaultDiscoveryQuery(vaultForm),
        pageSize: 25,
      }),
    onSuccess: (preview) => {
      setVaultDiscovery(preview);
      setVaultDiscoveryError(null);
    },
    onError: (error) => {
      setVaultDiscovery(null);
      setVaultDiscoveryError(error);
    },
  });

  const disableVaultMutation = useMutation({
    mutationFn: (id: string) => secretsApi.disableProviderConfig(id),
    onSuccess: (updated) => {
      toast.info("Provider vault disabled", {
        description: updated.displayName,
      });
      invalidateAll();
    },
    onError: (error) => {
      toast.error("Disable failed", {
        description: error instanceof Error ? error.message : "Try again",
      });
    },
  });

  const removeVaultMutation = useMutation({
    mutationFn: (id: string) => secretsApi.removeProviderConfig(id),
    onSuccess: (removed) => {
      toast.info("Provider vault removed", {
        description: `${removed.displayName} was removed from Paperclip only.`,
      });
      setRemoveVaultConfirm(null);
      invalidateAll();
    },
    onError: (error) => {
      toast.error("Remove failed", {
        description: error instanceof Error ? error.message : "Try again",
      });
    },
  });

  const defaultVaultMutation = useMutation({
    mutationFn: (id: string) => secretsApi.setDefaultProviderConfig(id),
    onSuccess: (updated) => {
      toast.success("Default vault set", { description: updated.displayName });
      invalidateAll();
    },
    onError: (error) => {
      toast.error("Default update failed", {
        description: error instanceof Error ? error.message : "Try again",
      });
    },
  });

  const healthVaultMutation = useMutation({
    mutationFn: (id: string) => secretsApi.checkProviderConfigHealth(id),
    onSuccess: (health) => {
      if (health.status === "error") {
        toast.error("Health checked", { description: health.message });
      } else {
        toast.info("Health checked", { description: health.message });
      }
      invalidateAll();
    },
    onError: (error) => {
      toast.error("Health check failed", {
        description: error instanceof Error ? error.message : "Try again",
      });
    },
  });

  function openCreateVault(provider: SecretProvider = "local_encrypted") {
    setEditingVault(null);
    setVaultForm(emptyProviderVaultForm(provider));
    setVaultError(null);
    setVaultDiscovery(null);
    setVaultDiscoveryError(null);
    setVaultDialogOpen(true);
  }

  function openEditVault(config: CompanySecretProviderConfig) {
    setEditingVault(config);
    setVaultForm(providerVaultFormFromConfig(config));
    setVaultError(null);
    setVaultDiscovery(null);
    setVaultDiscoveryError(null);
    setVaultDialogOpen(true);
  }

  function openImportFromVault(config?: CompanySecretProviderConfig | null) {
    setImportInitialVaultId(config?.id ?? null);
    setImportOpen(true);
  }

  function applyVaultDiscoveryCandidate(candidate: SecretProviderConfigDiscoveryCandidate) {
    if (candidate.provider !== "aws_secrets_manager") return;
    const config = candidate.config as Record<string, unknown>;
    setVaultForm((current) => ({
      ...current,
      displayName: current.displayName.trim() ? current.displayName : candidate.displayName,
      region: providerConfigValue(config, "region"),
      namespace: providerConfigValue(config, "namespace"),
      secretNamePrefix: providerConfigValue(config, "secretNamePrefix"),
      kmsKeyId: providerConfigValue(config, "kmsKeyId"),
      ownerTag: providerConfigValue(config, "ownerTag"),
      environmentTag: providerConfigValue(config, "environmentTag"),
    }));
  }

  return {
    saveVaultMutation,
    discoverVaultMutation,
    disableVaultMutation,
    removeVaultMutation,
    defaultVaultMutation,
    healthVaultMutation,
    openCreateVault,
    openEditVault,
    openImportFromVault,
    applyVaultDiscoveryCandidate,
  };
}

export type SecretVaultMutations = ReturnType<typeof useSecretVaultMutations>;
