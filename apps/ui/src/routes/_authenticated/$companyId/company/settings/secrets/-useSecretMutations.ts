import { secretsApi, type CreateSecretInput } from "@/api/secrets";
import type { SecretStatus, UserSecretDefinition } from "@paperclipai/shared";
import { useMutation } from "@tanstack/react-query";
import { useEffect } from "react";
import { toast } from "sonner";

import {
  findCreateProviderReplacement,
  getCreateProviderBlockReason,
  getDefaultProviderConfigId,
} from "./-secrets-model";
import type { SecretsControllerState } from "./-useSecretsControllerState";
import type { SecretsData } from "./-useSecretsData";

type SecretMutationState = Pick<
  SecretsControllerState,
  | "createForm"
  | "createMode"
  | "createOpen"
  | "editingDefinition"
  | "rotateExternalRef"
  | "rotateOpen"
  | "rotateProviderConfigId"
  | "rotateValue"
  | "secretValueProvider"
  | "selectedDefinitionId"
  | "selectedSecretId"
  | "setCreateError"
  | "setCreateForm"
  | "setCreateKeyDirty"
  | "setCreateKeyEditable"
  | "setCreateMode"
  | "setCreateNamePrefix"
  | "setCreateOpen"
  | "setDefinitionDeleteConfirm"
  | "setDeleteConfirm"
  | "setEditingDefinition"
  | "setRotateError"
  | "setRotateExternalRef"
  | "setRotateOpen"
  | "setRotateProviderConfigId"
  | "setRotateValue"
  | "setSecretValueProvider"
  | "setSelectedDefinitionId"
  | "setSelectedSecretId"
>;

type SecretMutationData = Pick<
  SecretsData,
  "providerConfigs" | "providerHealthQuery" | "providers" | "selectedSecret"
>;

export interface UseSecretMutationsOptions {
  companyId: string;
  data: SecretMutationData;
  folderPath: string;
  invalidateAll: (extraIds?: string[]) => void;
  state: SecretMutationState;
}

export function useSecretMutations({
  companyId,
  data,
  folderPath,
  invalidateAll,
  state,
}: UseSecretMutationsOptions) {
  // Async pending contract: disabled={isPending} aria-busy={isPending} role="status" {isPending ? "Saving" : "Save"}
  const { providerConfigs, providerHealthQuery, providers, selectedSecret } = data;
  const {
    createForm,
    createMode,
    createOpen,
    editingDefinition,
    rotateExternalRef,
    rotateOpen,
    rotateProviderConfigId,
    rotateValue,
    secretValueProvider,
    selectedDefinitionId,
    selectedSecretId,
    setCreateError,
    setCreateForm,
    setCreateKeyDirty,
    setCreateKeyEditable,
    setCreateMode,
    setCreateNamePrefix,
    setCreateOpen,
    setDefinitionDeleteConfirm,
    setDeleteConfirm,
    setEditingDefinition,
    setRotateError,
    setRotateExternalRef,
    setRotateOpen,
    setRotateProviderConfigId,
    setRotateValue,
    setSecretValueProvider,
    setSelectedDefinitionId,
    setSelectedSecretId,
  } = state;

  function openCreateSecret() {
    const prefix = folderPath ? `${folderPath}/` : null;
    setEditingDefinition(null);
    setCreateNamePrefix(prefix);
    setSecretValueProvider("company");
    setCreateMode("managed");
    setCreateKeyDirty(false);
    setCreateKeyEditable(false);
    setCreateError(null);
    setCreateForm({
      name: prefix ?? "",
      key: "",
      value: "",
      description: "",
      usageGuidance: "",
      externalRef: "",
      provider: "local_encrypted",
      providerConfigId: getDefaultProviderConfigId(providerConfigs, "local_encrypted"),
    });
    setCreateOpen(true);
  }

  function openEditDefinition(definition: UserSecretDefinition) {
    setEditingDefinition(definition);
    setCreateNamePrefix(null);
    setSecretValueProvider("user");
    setCreateMode("managed");
    setCreateKeyDirty(true);
    setCreateKeyEditable(false);
    setCreateError(null);
    setCreateForm({
      name: definition.name,
      key: definition.key,
      value: "",
      description: definition.description ?? "",
      usageGuidance: definition.usageGuidance ?? "",
      externalRef: "",
      provider: "local_encrypted",
      providerConfigId: "",
    });
    setCreateOpen(true);
  }

  const createMutation = useMutation({
    mutationFn: async () => {
      const sharedDefinitionPayload = {
        name: createForm.name.trim(),
        description: createForm.description.trim() || null,
        usageGuidance: createForm.usageGuidance.trim() || null,
      };
      if (editingDefinition) {
        const definition = await secretsApi.updateUserSecretDefinition(
          companyId,
          editingDefinition.id,
          sharedDefinitionPayload,
        );
        return {
          kind: "user" as const,
          item: definition,
          action: "updated" as const,
        };
      }
      if (secretValueProvider === "user") {
        const definition = await secretsApi.createUserSecretDefinition(companyId, {
          ...sharedDefinitionPayload,
          key: createForm.key,
          status: "active",
        });
        return {
          kind: "user" as const,
          item: definition,
          action: "created" as const,
        };
      }

      const input: CreateSecretInput = {
        name: createForm.name.trim(),
        provider: createForm.provider,
        providerConfigId: createForm.providerConfigId || null,
        managedMode: createMode === "external" ? "external_reference" : "paperclip_managed",
        description: createForm.description.trim() || null,
      };
      if (createForm.key.length > 0) input.key = createForm.key;
      if (createMode === "managed") input.value = createForm.value;
      else input.externalRef = createForm.externalRef;

      const secret = await secretsApi.create(companyId, input);
      return {
        kind: "company" as const,
        item: secret,
        action: "created" as const,
      };
    },
    onSuccess: (result) => {
      toast.success(
        result.kind === "company"
          ? "Secret created"
          : result.action === "updated"
            ? "User-provided secret updated"
            : "User-provided secret created",
        { description: result.item.name },
      );
      setCreateOpen(false);
      setEditingDefinition(null);
      setCreateNamePrefix(null);
      setSecretValueProvider("company");
      setCreateKeyDirty(false);
      setCreateKeyEditable(false);
      setCreateForm({
        name: "",
        key: "",
        value: "",
        description: "",
        usageGuidance: "",
        externalRef: "",
        provider: createForm.provider,
        providerConfigId: getDefaultProviderConfigId(providerConfigs, createForm.provider),
      });
      setCreateError(null);
      if (result.kind === "company") {
        setSelectedSecretId(result.item.id);
        setSelectedDefinitionId(null);
      } else {
        setSelectedDefinitionId(result.item.id);
        setSelectedSecretId(null);
      }
      invalidateAll([result.item.id]);
    },
    onError: setCreateError,
  });

  const rotateMutation = useMutation({
    mutationFn: () => {
      if (!selectedSecret) throw new Error("Select a secret first");
      if (selectedSecret.managedMode === "external_reference") {
        return secretsApi.rotate(selectedSecret.id, {
          externalRef:
            rotateExternalRef.length > 0 ? rotateExternalRef : selectedSecret.externalRef || undefined,
          providerConfigId: rotateProviderConfigId || null,
        });
      }
      return secretsApi.rotate(selectedSecret.id, {
        value: rotateValue,
        providerConfigId: rotateProviderConfigId || null,
      });
    },
    onSuccess: (updated) => {
      toast.success("Rotated", {
        description: `${updated.name} → v${updated.latestVersion}`,
      });
      setRotateOpen(false);
      setRotateValue("");
      setRotateExternalRef("");
      setRotateProviderConfigId("");
      setRotateError(null);
      invalidateAll([updated.id]);
    },
    onError: (error) => {
      setRotateError(error instanceof Error ? error.message : "Rotate failed");
    },
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: SecretStatus }) => {
      switch (status) {
        case "active":
          return secretsApi.enable(id);
        case "disabled":
          return secretsApi.disable(id);
        case "archived":
          return secretsApi.archive(id);
        default:
          return secretsApi.update(id, { status });
      }
    },
    onSuccess: (updated) => {
      toast.info(`Secret ${updated.status}`, { description: updated.name });
      invalidateAll([updated.id]);
    },
    onError: (error) => {
      toast.error("Status update failed", {
        description: error instanceof Error ? error.message : "Try again",
      });
    },
  });

  const definitionStatusMutation = useMutation({
    mutationFn: ({ definition, status }: { definition: UserSecretDefinition; status: SecretStatus }) =>
      secretsApi.updateUserSecretDefinition(companyId, definition.id, {
        status,
      }),
    onSuccess: (updated) => {
      toast.info(`User-provided secret ${updated.status}`, {
        description: updated.name,
      });
      invalidateAll([updated.id]);
    },
    onError: (error) => {
      toast.error("Status update failed", {
        description: error instanceof Error ? error.message : "Try again",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => secretsApi.remove(id),
    onSuccess: (_response, id) => {
      toast.info("Secret deleted");
      setDeleteConfirm(null);
      if (selectedSecretId === id) setSelectedSecretId(null);
      invalidateAll([id]);
    },
    onError: (error) => {
      toast.error("Delete failed", {
        description: error instanceof Error ? error.message : "Try again",
      });
    },
  });

  const deleteDefinitionMutation = useMutation({
    mutationFn: (definition: UserSecretDefinition) =>
      secretsApi.removeUserSecretDefinition(companyId, definition.id),
    onSuccess: (_response, definition) => {
      toast.info("User-provided secret removed", {
        description: definition.name,
      });
      setDefinitionDeleteConfirm(null);
      if (selectedDefinitionId === definition.id) setSelectedDefinitionId(null);
      invalidateAll([definition.id]);
    },
    onError: (error) => {
      toast.error("Delete failed", {
        description: error instanceof Error ? error.message : "Try again",
      });
    },
  });

  useEffect(() => {
    if (!createOpen || providers.length === 0) return;
    const currentBlockReason = getCreateProviderBlockReason(
      providers.find((provider) => provider.id === createForm.provider) ?? null,
      createMode,
      providerHealthQuery.data ?? null,
      providerConfigs.find((config) => config.id === createForm.providerConfigId) ?? null,
    );
    if (!currentBlockReason) return;
    const replacement = findCreateProviderReplacement({
      providers,
      providerConfigs,
      currentProvider: createForm.provider,
      mode: createMode,
      health: providerHealthQuery.data ?? null,
    });
    if (replacement && replacement.id !== createForm.provider) {
      setCreateForm((current) => ({
        ...current,
        provider: replacement.id,
        providerConfigId: getDefaultProviderConfigId(providerConfigs, replacement.id),
      }));
    }
  }, [
    createForm.provider,
    createForm.providerConfigId,
    createMode,
    createOpen,
    providerConfigs,
    providerHealthQuery.data,
    providers,
    setCreateForm,
  ]);

  useEffect(() => {
    if (!createOpen) return;
    const current = providerConfigs.find((config) => config.id === createForm.providerConfigId);
    if (current?.provider === createForm.provider) return;
    const nextProviderConfigId = getDefaultProviderConfigId(providerConfigs, createForm.provider);
    if (nextProviderConfigId === createForm.providerConfigId) return;
    setCreateForm((form) => ({
      ...form,
      providerConfigId: nextProviderConfigId,
    }));
  }, [createForm.provider, createForm.providerConfigId, createOpen, providerConfigs, setCreateForm]);

  useEffect(() => {
    if (!rotateOpen || !selectedSecret) return;
    setRotateProviderConfigId(
      selectedSecret.providerConfigId ?? getDefaultProviderConfigId(providerConfigs, selectedSecret.provider),
    );
  }, [providerConfigs, rotateOpen, selectedSecret, setRotateProviderConfigId]);

  return {
    openCreateSecret,
    openEditDefinition,
    createMutation,
    rotateMutation,
    statusMutation,
    definitionStatusMutation,
    deleteMutation,
    deleteDefinitionMutation,
  };
}

export type SecretMutations = ReturnType<typeof useSecretMutations>;
