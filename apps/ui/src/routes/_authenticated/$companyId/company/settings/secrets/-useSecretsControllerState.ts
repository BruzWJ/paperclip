import type { MyUserSecretEntry } from "@/api/secrets";
import type {
  CompanySecret,
  CompanySecretProviderConfig,
  SecretProvider,
  SecretProviderConfigDiscoveryPreviewResult,
  SecretStatus,
  UserSecretDefinition,
} from "@paperclipai/shared";
import { useState } from "react";

import {
  type CreateMode,
  type ProvidedByFilter,
  type ProviderVaultForm,
  type SecretValueProvider,
  type SecretsTab,
  type SecretsViewMode,
  emptyProviderVaultForm,
  readStoredViewMode,
} from "./-secrets-model";

export function useSecretsControllerState() {
  const [activeTab, setActiveTab] = useState<SecretsTab>("secrets");
  const [secretDetailTab, setSecretDetailTab] = useState("details");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<SecretStatus | "all">("active");
  const [providerFilter, setProviderFilter] = useState<SecretProvider | "all">("all");
  const [providedByFilter, setProvidedByFilter] = useState<ProvidedByFilter>("all");
  const [selectedSecretId, setSelectedSecretId] = useState<string | null>(null);
  const [selectedDefinitionId, setSelectedDefinitionId] = useState<string | null>(null);
  const [usageDialogSecretId, setUsageDialogSecretId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importInitialVaultId, setImportInitialVaultId] = useState<string | null>(null);
  const [secretValueProvider, setSecretValueProvider] = useState<SecretValueProvider>("company");
  const [createMode, setCreateMode] = useState<CreateMode>("managed");
  const [editingDefinition, setEditingDefinition] = useState<UserSecretDefinition | null>(null);
  const [createNamePrefix, setCreateNamePrefix] = useState<string | null>(null);
  const [createKeyDirty, setCreateKeyDirty] = useState(false);
  const [createKeyEditable, setCreateKeyEditable] = useState(false);
  const [createForm, setCreateForm] = useState({
    name: "",
    key: "",
    value: "",
    description: "",
    usageGuidance: "",
    externalRef: "",
    provider: "local_encrypted" as SecretProvider,
    providerConfigId: "",
  });
  const [createError, setCreateError] = useState<unknown>(null);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [rotateValue, setRotateValue] = useState("");
  const [rotateExternalRef, setRotateExternalRef] = useState("");
  const [rotateProviderConfigId, setRotateProviderConfigId] = useState("");
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<CompanySecret | null>(null);
  const [definitionDeleteConfirm, setDefinitionDeleteConfirm] = useState<UserSecretDefinition | null>(null);
  const [setMyValueFor, setSetMyValueFor] = useState<MyUserSecretEntry | null>(null);
  const [vaultDialogOpen, setVaultDialogOpen] = useState(false);
  const [editingVault, setEditingVault] = useState<CompanySecretProviderConfig | null>(null);
  const [removeVaultConfirm, setRemoveVaultConfirm] = useState<CompanySecretProviderConfig | null>(null);
  const [vaultForm, setVaultForm] = useState<ProviderVaultForm>(() => emptyProviderVaultForm());
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [vaultDiscovery, setVaultDiscovery] = useState<SecretProviderConfigDiscoveryPreviewResult | null>(
    null,
  );
  const [vaultDiscoveryError, setVaultDiscoveryError] = useState<unknown | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderError, setNewFolderError] = useState<string | null>(null);
  const [storedViewMode, setStoredViewMode] = useState<SecretsViewMode | null>(readStoredViewMode);

  return {
    activeTab,
    setActiveTab,
    secretDetailTab,
    setSecretDetailTab,
    search,
    setSearch,
    statusFilter,
    setStatusFilter,
    providerFilter,
    setProviderFilter,
    providedByFilter,
    setProvidedByFilter,
    selectedSecretId,
    setSelectedSecretId,
    selectedDefinitionId,
    setSelectedDefinitionId,
    usageDialogSecretId,
    setUsageDialogSecretId,
    createOpen,
    setCreateOpen,
    importOpen,
    setImportOpen,
    importInitialVaultId,
    setImportInitialVaultId,
    secretValueProvider,
    setSecretValueProvider,
    createMode,
    setCreateMode,
    editingDefinition,
    setEditingDefinition,
    createNamePrefix,
    setCreateNamePrefix,
    createKeyDirty,
    setCreateKeyDirty,
    createKeyEditable,
    setCreateKeyEditable,
    createForm,
    setCreateForm,
    createError,
    setCreateError,
    rotateOpen,
    setRotateOpen,
    rotateValue,
    setRotateValue,
    rotateExternalRef,
    setRotateExternalRef,
    rotateProviderConfigId,
    setRotateProviderConfigId,
    rotateError,
    setRotateError,
    deleteConfirm,
    setDeleteConfirm,
    definitionDeleteConfirm,
    setDefinitionDeleteConfirm,
    setMyValueFor,
    setSetMyValueFor,
    vaultDialogOpen,
    setVaultDialogOpen,
    editingVault,
    setEditingVault,
    removeVaultConfirm,
    setRemoveVaultConfirm,
    vaultForm,
    setVaultForm,
    vaultError,
    setVaultError,
    vaultDiscovery,
    setVaultDiscovery,
    vaultDiscoveryError,
    setVaultDiscoveryError,
    newFolderOpen,
    setNewFolderOpen,
    newFolderName,
    setNewFolderName,
    newFolderError,
    setNewFolderError,
    storedViewMode,
    setStoredViewMode,
  };
}

export type SecretsControllerState = ReturnType<typeof useSecretsControllerState>;
