import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { SecretProvider, SecretProviderConfigStatus } from "@paperclipai/shared";
import { AwsProviderVaultDiscoveryPanel } from "./-ProviderVaultDiscovery";
import {
  PROVIDER_ORDER,
  emptyProviderVaultForm,
  providerLabel,
  type ProviderVaultForm,
} from "./-secrets-model";
import { useSecretsPage } from "./-SecretsPageContext";

type ProviderVaultTextFieldKey =
  | "region"
  | "namespace"
  | "secretNamePrefix"
  | "kmsKeyId"
  | "ownerTag"
  | "environmentTag"
  | "projectId"
  | "location"
  | "address"
  | "mountPath"
  | "secretPathPrefix";

const providerVaultFields = {
  aws_secrets_manager: [
    ["region", "AWS region", "us-east-1", true],
    ["namespace", "Namespace", "production", false],
    ["secretNamePrefix", "Secret name prefix", "paperclip", false],
    ["kmsKeyId", "KMS key id", "alias/paperclip-secrets", false],
    ["ownerTag", "Owner tag", "platform", false],
    ["environmentTag", "Environment tag", "prod", false],
  ],
  gcp_secret_manager: [
    ["projectId", "Project id", "paperclip-prod", false],
    ["location", "Location", "global", false],
    ["namespace", "Namespace", "production", false],
    ["secretNamePrefix", "Secret name prefix", "paperclip", false],
  ],
  vault: [
    ["address", "Address", "https://vault.example.com", false],
    ["namespace", "Namespace", "admin", false],
    ["mountPath", "Mount path", "secret", false],
    ["secretPathPrefix", "Secret path prefix", "paperclip/prod", false],
  ],
} satisfies Record<
  Exclude<ProviderVaultForm["provider"], "local_encrypted">,
  ReadonlyArray<readonly [ProviderVaultTextFieldKey, string, string, boolean]>
>;

export function ProviderVaultEditorDialog() {
  const {
    applyVaultDiscoveryCandidate,
    discoverVaultMutation,
    editingVault,
    providers,
    saveVaultMutation,
    setVaultDialogOpen,
    setVaultDiscovery,
    setVaultDiscoveryError,
    setVaultError,
    setVaultForm,
    vaultDialogOpen,
    vaultDiscovery,
    vaultDiscoveryError,
    vaultError,
    vaultForm,
  } = useSecretsPage();
  const setVaultField = (key: keyof ProviderVaultForm, value: string | boolean) => {
    setVaultForm((current) => ({ ...current, [key]: value }));
  };
  return (
    <Dialog open={vaultDialogOpen} onOpenChange={setVaultDialogOpen}>
      <DialogContent className="max-h-(--sz-85vh) overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editingVault ? "Edit provider vault" : "Create provider vault"}</DialogTitle>
          <DialogDescription>
            Save only non-sensitive routing metadata. Credentials stay in the runtime environment or provider
            identity.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="vault-provider">Provider</FieldLabel>
              <Select
                value={vaultForm.provider}
                onValueChange={(v) => {
                  const provider = v as SecretProvider;
                  setVaultForm(emptyProviderVaultForm(provider));
                  setVaultDiscovery(null);
                  setVaultDiscoveryError(null);
                }}
                disabled={Boolean(editingVault)}
              >
                <SelectTrigger id="vault-provider" className="h-9 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDER_ORDER.map((provider) => (
                    <SelectItem key={provider} value={provider}>
                      {providerLabel(providers, provider)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="vault-name">Display name</FieldLabel>
              <Input
                id="vault-name"
                value={vaultForm.displayName}
                onChange={(event) =>
                  setVaultForm((current) => ({
                    ...current,
                    displayName: event.target.value,
                  }))
                }
                placeholder="Production local vault"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="vault-status">Status</FieldLabel>
              <Select
                value={vaultForm.status}
                onValueChange={(v) => {
                  const status = v as SecretProviderConfigStatus;
                  setVaultForm((current) => ({
                    ...current,
                    status,
                    isDefault: status === "coming_soon" || status === "disabled" ? false : current.isDefault,
                  }));
                }}
              >
                <SelectTrigger id="vault-status" className="h-9 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem
                    value="ready"
                    disabled={vaultForm.provider === "gcp_secret_manager" || vaultForm.provider === "vault"}
                  >
                    Ready
                  </SelectItem>
                  <SelectItem
                    value="warning"
                    disabled={vaultForm.provider === "gcp_secret_manager" || vaultForm.provider === "vault"}
                  >
                    Warning
                  </SelectItem>
                  <SelectItem value="coming_soon">Coming soon</SelectItem>
                  <SelectItem value="disabled">Disabled</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field orientation="horizontal" className="self-end">
              <Checkbox
                id="vault-default"
                checked={vaultForm.isDefault}
                disabled={vaultForm.status === "coming_soon" || vaultForm.status === "disabled"}
                onCheckedChange={(checked) =>
                  setVaultForm((current) => ({
                    ...current,
                    isDefault: checked === true,
                  }))
                }
              />
              <FieldLabel htmlFor="vault-default">
                Default for {providerLabel(providers, vaultForm.provider)}
              </FieldLabel>
            </Field>
          </div>

          {vaultForm.provider === "local_encrypted" ? (
            <Field orientation="horizontal">
              <Checkbox
                id="provider-vault-backup-acknowledgement"
                checked={vaultForm.backupReminderAcknowledged}
                onCheckedChange={(checked) => setVaultField("backupReminderAcknowledged", checked === true)}
              />
              <FieldContent>
                <FieldLabel htmlFor="provider-vault-backup-acknowledgement">
                  Backup and restore acknowledgement
                </FieldLabel>
                <FieldDescription>
                  Backup and restore require both the database metadata and the local encrypted master key
                  file.
                </FieldDescription>
              </FieldContent>
            </Field>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {providerVaultFields[vaultForm.provider].map(([key, label, placeholder, required]) => {
                const id = `provider-vault-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
                return (
                  <Field key={key}>
                    <FieldLabel htmlFor={id}>
                      {label}
                      {required ? null : <span className="text-muted-foreground/70"> (optional)</span>}
                    </FieldLabel>
                    <Input
                      id={id}
                      value={vaultForm[key]}
                      onChange={(event) => setVaultField(key, event.target.value)}
                      placeholder={placeholder}
                    />
                  </Field>
                );
              })}
            </div>
          )}

          {!editingVault && vaultForm.provider === "aws_secrets_manager" ? (
            <AwsProviderVaultDiscoveryPanel
              form={vaultForm}
              preview={vaultDiscovery}
              error={vaultDiscoveryError}
              loading={discoverVaultMutation.isPending}
              onDiscover={() => {
                setVaultDiscovery(null);
                setVaultDiscoveryError(null);
                discoverVaultMutation.mutate();
              }}
              onApply={applyVaultDiscoveryCandidate}
            />
          ) : null}

          {vaultForm.provider === "gcp_secret_manager" || vaultForm.provider === "vault" ? (
            <Alert>
              <AlertDescription>
                This provider can save draft routing metadata, but runtime writes and resolution stay disabled
                until the provider module is implemented and reviewed.
              </AlertDescription>
            </Alert>
          ) : null}
          {vaultError ? <p className="text-xs text-destructive">{vaultError}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setVaultDialogOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              setVaultError(null);
              saveVaultMutation.mutate();
            }}
            disabled={
              saveVaultMutation.isPending ||
              !vaultForm.displayName.trim() ||
              (vaultForm.provider === "aws_secrets_manager" && !vaultForm.region.trim())
            }
          >
            {saveVaultMutation.isPending ? <Spinner className="h-3.5 w-3.5 mr-1" /> : null}
            {editingVault ? "Save vault" : "Create vault"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
