import type { CompanySecret, UserSecretDefinition } from "@paperclipai/shared";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AlertCircle, KeyRound } from "lucide-react";
import { useCallback, useEffect } from "react";

import { MyUserSecretsTab } from "@/routes/_authenticated/$companyId/company/settings/secrets/-MyUserSecretsTab";
import { EntityCombobox } from "@/components/patterns/EntityCombobox";
import { FormDialog, LabeledFormField } from "@/components/patterns/FormPatterns";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { toast } from "sonner";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { useCurrentUserId } from "@/hooks/useCurrentUserId";
import { copyTextToClipboard } from "@/lib/clipboard";
import { queryKeys } from "@/lib/queryKeys";

import { ProviderVaultEditorDialog } from "./-ProviderVaultEditorDialog";
import { ProviderVaultsTab } from "./-ProviderVaultsList";
import { SecretUsageTab } from "./-CompanySecretDetails";
import { SecretDetailsSheet } from "./-SecretDetailsSheet";
import { SecretEditorDialog } from "./-SecretEditorDialog";
import { SecretsBrowser } from "./-SecretsBrowser";
import { SecretsPageProvider, useSecretsPage } from "./-SecretsPageContext";
import { SecretsToolbar } from "./-SecretsToolbar";
import {
  DeleteSecretDialog,
  DeleteUserSecretDialog,
  RemoveProviderVaultDialog,
  SecretsImportDialog,
  SetMySecretDialog,
} from "./-SecretUsageDialog";
import {
  getDefaultProviderConfigId,
  getProviderConfigBlockReason,
  type SecretsTab,
  type UnifiedSecretRow,
  validateSecretsSearch,
} from "./-secrets-model";
import { useSecretMutations } from "./-useSecretMutations";
import { useSecretVaultMutations } from "./-useSecretVaultMutations";
import { useSecretsControllerState } from "./-useSecretsControllerState";
import { useSecretsData } from "./-useSecretsData";
import { useSecretsFolders } from "./-useSecretsFolders";

export { ProviderVaultsTab } from "./-ProviderVaultsList";
export { SecretEventsTab, SecretUsageTab } from "./-CompanySecretDetails";
export {
  findCreateProviderReplacement,
  getAwsManagedPathPreview,
  getCreateProviderBlockReason,
  getDefaultProviderConfigId,
  getProviderConfigBlockReason,
  getSelectableProviderConfig,
  validateSecretsSearch,
} from "./-secrets-model";

export const Route = createFileRoute("/_authenticated/$companyId/company/settings/secrets/")({
  validateSearch: validateSecretsSearch,
  component: Secrets,
});

export function useSecretsController() {
  const currentUserId = useCurrentUserId();
  const queryClient = useQueryClient();
  const companyId = useCompanyRouteId();
  const { setBreadcrumbs } = useBreadcrumbs();
  const state = useSecretsControllerState();
  const data = useSecretsData({ companyId, currentUserId, state });
  const folders = useSecretsFolders({ state, data });

  useEffect(() => {
    setBreadcrumbs([{ label: "Secrets" }]);
  }, [setBreadcrumbs]);

  const invalidateAll = useCallback(
    (extraIds: string[] = []) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.secrets.list(companyId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.secrets.userDefinitions(companyId),
      });
      if (currentUserId) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.secrets.userSecrets(companyId, currentUserId),
        });
      }
      void queryClient.invalidateQueries({
        queryKey: queryKeys.secrets.providerConfigs(companyId),
      });
      for (const id of extraIds) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.secrets.usage(id),
        });
        void queryClient.invalidateQueries({
          queryKey: queryKeys.secrets.accessEvents(id),
        });
        void queryClient.invalidateQueries({
          queryKey: queryKeys.secrets.userDefinitionCoverage(companyId, id),
        });
      }
    },
    [companyId, currentUserId, queryClient],
  );

  const secretMutations = useSecretMutations({
    companyId,
    data,
    folderPath: folders.folderPath,
    invalidateAll,
    state,
  });
  const vaultMutations = useSecretVaultMutations({
    companyId,
    invalidateAll,
    state,
  });

  function openCompanySecret(secret: CompanySecret) {
    state.setSecretDetailTab("details");
    state.setSelectedSecretId(secret.id);
    state.setSelectedDefinitionId(null);
  }

  function openUserDefinition(definition: UserSecretDefinition) {
    state.setSecretDetailTab("details");
    state.setSelectedDefinitionId(definition.id);
    state.setSelectedSecretId(null);
  }

  function openSecretRow(row: UnifiedSecretRow) {
    if (row.kind === "company") openCompanySecret(row.secret);
    else openUserDefinition(row.definition);
  }

  function openRotateSecret(secret: CompanySecret) {
    openCompanySecret(secret);
    state.setRotateOpen(true);
    state.setRotateValue("");
    state.setRotateExternalRef("");
    state.setRotateProviderConfigId(
      secret.providerConfigId ?? getDefaultProviderConfigId(data.providerConfigs, secret.provider),
    );
    state.setRotateError(null);
  }

  function copySecretKey(key: string) {
    void copyTextToClipboard(key)
      .then(() => toast.success("Secret key copied", { description: key }))
      .catch((error) =>
        toast.error("Copy failed", {
          description: error instanceof Error ? error.message : "Unable to copy secret key",
        }),
      );
  }

  return {
    currentUserId,
    queryClient,
    companyId,
    setBreadcrumbs,
    ...state,
    ...data,
    ...folders,
    invalidateAll,
    ...secretMutations,
    ...vaultMutations,
    openCompanySecret,
    openUserDefinition,
    openSecretRow,
    openRotateSecret,
    copySecretKey,
  };
}

export type SecretsController = ReturnType<typeof useSecretsController>;

function Secrets() {
  const controller = useSecretsController();
  const rotateVaultBlockReason = controller.selectedRotateProviderConfig
    ? getProviderConfigBlockReason(controller.selectedRotateProviderConfig)
    : null;
  const rotateVaultMessage =
    rotateVaultBlockReason ?? controller.selectedRotateProviderConfig?.healthMessage ?? null;

  return (
    <SecretsPageProvider value={controller}>
      <TooltipProvider>
        <div className="flex h-full min-h-0 flex-col gap-4">
          <div className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-lg font-semibold">Secrets</h1>
          </div>
          <SecretsTabsView />
          <SecretDetailsSheet />
          <Dialog
            open={Boolean(controller.usageDialogSecret)}
            onOpenChange={(open) => !open && controller.setUsageDialogSecretId(null)}
          >
            <DialogContent className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>Secret references</DialogTitle>
                <DialogDescription>
                  {controller.usageDialogSecret
                    ? `${controller.usageDialogSecret.name} is referenced by ${controller.usageDialogSecret.referenceCount ?? 0} ${
                        (controller.usageDialogSecret.referenceCount ?? 0) === 1 ? "place" : "places"
                      }.`
                    : null}
                </DialogDescription>
              </DialogHeader>
              <SecretUsageTab
                loading={controller.usageDialogQuery.isPending}
                bindings={controller.usageDialogQuery.data?.bindings ?? []}
              />
            </DialogContent>
          </Dialog>
          <SecretsImportDialog />
          <SecretEditorDialog />
          <ProviderVaultEditorDialog />
          <FormDialog
            open={controller.rotateOpen}
            onOpenChange={controller.setRotateOpen}
            contentClassName="sm:max-w-md"
            title={
              controller.selectedSecret?.managedMode === "external_reference"
                ? "Update external reference"
                : "Update secret value"
            }
            description={
              controller.selectedSecret?.managedMode === "external_reference"
                ? "Creates a new Paperclip metadata version that points at an existing provider secret. Paperclip does not write a new provider value."
                : "Creates a new provider-backed version. Consumers pinned to latest pick up the new value on the next run."
            }
            footer={
              <>
                <Button variant="outline" onClick={() => controller.setRotateOpen(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={() => {
                    controller.setRotateError(null);
                    controller.rotateMutation.mutate();
                  }}
                  disabled={
                    controller.rotateMutation.isPending ||
                    Boolean(controller.rotateProviderBlockReason) ||
                    (controller.selectedSecret?.managedMode === "external_reference"
                      ? !controller.rotateExternalRef.trim() && !controller.selectedSecret?.externalRef
                      : !controller.rotateValue)
                  }
                >
                  {controller.rotateMutation.isPending ? <Spinner className="mr-1 h-3.5 w-3.5" /> : null}
                  {controller.selectedSecret?.managedMode === "external_reference"
                    ? "Update reference"
                    : "Update value"}
                </Button>
              </>
            }
          >
            <LabeledFormField
              label="Provider vault"
              labelFor="rotate-secret-vault"
              description={
                controller.selectedRotateProviderConfig
                  ? undefined
                  : "This rotation uses the deployment-configured provider."
              }
            >
              <EntityCombobox
                value={controller.rotateProviderConfigId}
                options={controller.selectedRotateProviderConfigs.map((config) => {
                  const blockReason = getProviderConfigBlockReason(config);
                  return {
                    id: config.id,
                    label: `${config.displayName}${config.isDefault ? " (default)" : ""}${
                      blockReason ? ` (${blockReason})` : ""
                    }`,
                    disabled: Boolean(blockReason),
                  };
                })}
                onValueChange={controller.setRotateProviderConfigId}
                type="provider vault"
                ariaLabel="Provider vault"
                placeholder="Deployment default"
                noneLabel="Deployment default"
                triggerClassName="h-9 w-full"
                triggerProps={{ id: "rotate-secret-vault" }}
              />
              {controller.selectedRotateProviderConfig ? (
                rotateVaultMessage ? (
                  <Alert variant={rotateVaultBlockReason ? "destructive" : "default"}>
                    <AlertCircle />
                    <AlertDescription>{rotateVaultMessage}</AlertDescription>
                  </Alert>
                ) : (
                  <p className="mt-1 text-(length:--text-micro) text-muted-foreground">
                    {controller.selectedRotateProviderConfig.isDefault ? "Default vault" : "Vault"} ·{" "}
                    {controller.selectedRotateProviderConfig.status.replace("_", " ")}
                  </p>
                )
              ) : null}
            </LabeledFormField>
            {controller.selectedSecret?.managedMode === "external_reference" ? (
              <LabeledFormField
                label="External reference"
                labelFor="rotate-ref"
                description="Rotate the actual value in the provider before changing this Paperclip reference."
              >
                <Input
                  id="rotate-ref"
                  value={controller.rotateExternalRef}
                  onChange={(event) => controller.setRotateExternalRef(event.target.value)}
                  placeholder={controller.selectedSecret.externalRef ?? "Updated reference"}
                  className="font-mono text-xs"
                />
              </LabeledFormField>
            ) : (
              <LabeledFormField label="New value" labelFor="rotate-value">
                <Textarea
                  id="rotate-value"
                  value={controller.rotateValue}
                  onChange={(event) => controller.setRotateValue(event.target.value)}
                  rows={3}
                  className="font-mono text-xs"
                  placeholder="Paste the new value"
                />
              </LabeledFormField>
            )}
            {controller.rotateError ? (
              <p className="text-xs text-destructive">{controller.rotateError}</p>
            ) : null}
          </FormDialog>
          <DeleteSecretDialog />
          <DeleteUserSecretDialog />
          <SetMySecretDialog />
          <RemoveProviderVaultDialog />
        </div>
      </TooltipProvider>
    </SecretsPageProvider>
  );
}

export function SecretsTabsView() {
  const {
    activeTab,
    setActiveTab,
    companyId,
    providers,
    providerConfigs,
    providerConfigsQuery,
    openCreateVault,
    openEditVault,
    disableVaultMutation,
    setRemoveVaultConfirm,
    defaultVaultMutation,
    healthVaultMutation,
    removeVaultMutation,
    openImportFromVault,
  } = useSecretsPage();

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => setActiveTab(value as SecretsTab)}
      className="flex min-h-0 flex-1 flex-col gap-4"
    >
      <TabsList variant="line" className="justify-start">
        <TabsTrigger value="secrets">Secrets</TabsTrigger>
        <TabsTrigger value="my-secrets">My secrets</TabsTrigger>
        <TabsTrigger value="vaults">Provider vaults</TabsTrigger>
      </TabsList>
      <TabsContent value="secrets" className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
        <SecretsToolbar />
        <SecretsBrowser />
      </TabsContent>
      <TabsContent value="my-secrets" className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
        <MyUserSecretsTab companyId={companyId} />
      </TabsContent>
      <TabsContent value="vaults" className="min-h-0 flex-1 overflow-y-auto">
        <ProviderVaultsTab
          providers={providers}
          providerConfigs={providerConfigs}
          loading={providerConfigsQuery.isPending}
          error={providerConfigsQuery.error}
          onRetry={() => providerConfigsQuery.refetch()}
          onCreate={openCreateVault}
          onEdit={openEditVault}
          onDisable={(config) => disableVaultMutation.mutate(config.id)}
          onRemove={(config) => setRemoveVaultConfirm(config)}
          onSetDefault={(config) => defaultVaultMutation.mutate(config.id)}
          onHealthCheck={(config) => healthVaultMutation.mutate(config.id)}
          onImportSecrets={openImportFromVault}
          pendingActionId={
            disableVaultMutation.variables ??
            removeVaultMutation.variables ??
            defaultVaultMutation.variables ??
            healthVaultMutation.variables ??
            null
          }
        />
      </TabsContent>
    </Tabs>
  );
}
