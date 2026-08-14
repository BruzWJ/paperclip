import { ImportFromVaultDialog } from "@/components/secrets/ImportFromVaultDialog";
import { SetMyUserSecretDialog } from "@/components/secrets/SetMyUserSecretDialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Spinner } from "@/components/ui/spinner";
import { useSecretsPage } from "./-SecretsPageContext";

export function DeleteSecretDialog() {
  const { deleteConfirm, deleteMutation, setDeleteConfirm } = useSecretsPage();
  return (
    <AlertDialog open={Boolean(deleteConfirm)} onOpenChange={(open) => !open && setDeleteConfirm(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete secret</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>
              Permanently removes <strong>{deleteConfirm?.name}</strong>. Active bindings will fail until you
              remap them.
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deleteMutation.isPending}
            onClick={(event) => {
              event.preventDefault();
              if (deleteConfirm) deleteMutation.mutate(deleteConfirm.id);
            }}
          >
            {deleteMutation.isPending ? <Spinner className="size-4" /> : null}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function DeleteUserSecretDialog() {
  const { definitionDeleteConfirm, deleteDefinitionMutation, setDefinitionDeleteConfirm } = useSecretsPage();
  return (
    <AlertDialog
      open={Boolean(definitionDeleteConfirm)}
      onOpenChange={(open) => !open && setDefinitionDeleteConfirm(null)}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete user-provided secret</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>
              Permanently removes <strong>{definitionDeleteConfirm?.name}</strong> for the whole company.
              Existing member values become unreferenced and active bindings must be remapped.
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteDefinitionMutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deleteDefinitionMutation.isPending}
            onClick={(event) => {
              event.preventDefault();
              if (definitionDeleteConfirm) deleteDefinitionMutation.mutate(definitionDeleteConfirm);
            }}
          >
            {deleteDefinitionMutation.isPending ? <Spinner className="size-4" /> : null}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function RemoveProviderVaultDialog() {
  const { removeVaultConfirm, removeVaultMutation, setRemoveVaultConfirm } = useSecretsPage();
  const remoteDataCopy =
    removeVaultConfirm?.provider === "aws_secrets_manager"
      ? "This does not delete the remote AWS Secrets Manager vault, secrets, or any AWS data."
      : "This does not delete any remote provider data.";
  return (
    <AlertDialog
      open={Boolean(removeVaultConfirm)}
      onOpenChange={(open) => !open && setRemoveVaultConfirm(null)}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove provider vault</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>
              Removes <strong>{removeVaultConfirm?.displayName}</strong> from Paperclip only. {remoteDataCopy}{" "}
              Secrets using this vault will lose the vault association until you assign another one.
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={removeVaultMutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={removeVaultMutation.isPending}
            onClick={(event) => {
              event.preventDefault();
              if (removeVaultConfirm) removeVaultMutation.mutate(removeVaultConfirm.id);
            }}
          >
            {removeVaultMutation.isPending ? <Spinner className="size-4" /> : null}
            Remove from Paperclip
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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
