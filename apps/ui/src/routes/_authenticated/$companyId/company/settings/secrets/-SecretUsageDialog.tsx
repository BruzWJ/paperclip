import { ImportFromVaultDialog } from "@/components/secrets/ImportFromVaultDialog";
import { SetMyUserSecretDialog } from "@/components/secrets/SetMyUserSecretDialog";
import { ConfirmActionDialog } from "@/components/patterns/ConfirmActionDialog";
import { useSecretsPage } from "./-SecretsPageContext";

export function DeleteSecretDialog() {
  const { deleteConfirm, deleteMutation, setDeleteConfirm } = useSecretsPage();
  return (
    <ConfirmActionDialog
      open={Boolean(deleteConfirm)}
      onOpenChange={(open) => !open && setDeleteConfirm(null)}
      title="Delete secret"
      description={
        <>
          Permanently removes <strong>{deleteConfirm?.name}</strong>. Active bindings will fail until you
          remap them.
        </>
      }
      confirmLabel="Delete"
      variant="destructive"
      disabled={!deleteConfirm}
      pending={deleteMutation.isPending}
      onConfirm={() =>
        deleteConfirm ? deleteMutation.mutateAsync(deleteConfirm.id).then(() => undefined) : undefined
      }
    />
  );
}

export function DeleteUserSecretDialog() {
  const { definitionDeleteConfirm, deleteDefinitionMutation, setDefinitionDeleteConfirm } = useSecretsPage();
  return (
    <ConfirmActionDialog
      open={Boolean(definitionDeleteConfirm)}
      onOpenChange={(open) => !open && setDefinitionDeleteConfirm(null)}
      title="Delete user-provided secret"
      description={
        <>
          Permanently removes <strong>{definitionDeleteConfirm?.name}</strong> for the whole company. Existing
          member values become unreferenced and active bindings must be remapped.
        </>
      }
      confirmLabel="Delete"
      variant="destructive"
      disabled={!definitionDeleteConfirm}
      pending={deleteDefinitionMutation.isPending}
      onConfirm={() =>
        definitionDeleteConfirm
          ? deleteDefinitionMutation.mutateAsync(definitionDeleteConfirm).then(() => undefined)
          : undefined
      }
    />
  );
}

export function RemoveProviderVaultDialog() {
  const { removeVaultConfirm, removeVaultMutation, setRemoveVaultConfirm } = useSecretsPage();
  const remoteDataCopy =
    removeVaultConfirm?.provider === "aws_secrets_manager"
      ? "This does not delete the remote AWS Secrets Manager vault, secrets, or any AWS data."
      : "This does not delete any remote provider data.";
  return (
    <ConfirmActionDialog
      open={Boolean(removeVaultConfirm)}
      onOpenChange={(open) => !open && setRemoveVaultConfirm(null)}
      title="Remove provider vault"
      description={
        <>
          Removes <strong>{removeVaultConfirm?.displayName}</strong> from Paperclip only. {remoteDataCopy}{" "}
          Secrets using this vault will lose the vault association until you assign another one.
        </>
      }
      confirmLabel="Remove from Paperclip"
      variant="destructive"
      disabled={!removeVaultConfirm}
      pending={removeVaultMutation.isPending}
      onConfirm={() =>
        removeVaultConfirm
          ? removeVaultMutation.mutateAsync(removeVaultConfirm.id).then(() => undefined)
          : undefined
      }
    />
  );
}

export function SetMySecretDialog() {
  const { companyId, currentUserId, setMyValueFor, setSetMyValueFor } = useSecretsPage();
  return (
    <SetMyUserSecretDialog
      companyId={companyId}
      userId={currentUserId}
      definition={setMyValueFor?.definition ?? null}
      existingSecret={setMyValueFor?.secret ?? null}
      open={setMyValueFor !== null}
      onOpenChange={(open) => !open && setSetMyValueFor(null)}
    />
  );
}

export function SecretsImportDialog() {
  const {
    companyId,
    importInitialVaultId,
    importOpen,
    providerConfigs,
    secrets,
    secretsQuery,
    setActiveTab,
    setImportInitialVaultId,
    setImportOpen,
  } = useSecretsPage();
  const closeImport = () => {
    setImportOpen(false);
    setImportInitialVaultId(null);
  };
  return (
    <ImportFromVaultDialog
      open={importOpen}
      onOpenChange={(open) => (open ? setImportOpen(true) : closeImport())}
      companyId={companyId}
      providerConfigs={providerConfigs}
      existingSecrets={secrets}
      initialProviderConfigId={importInitialVaultId}
      onManageVaults={() => {
        closeImport();
        setActiveTab("vaults");
      }}
      onImportComplete={() => void secretsQuery.refetch()}
    />
  );
}
