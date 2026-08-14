import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import type { SecretProvider } from "@paperclipai/shared";
import { Pencil, X } from "lucide-react";
import { SecretCreateError } from "./-ProviderVaultErrors";
import {
  type CreateMode,
  type SecretValueProvider,
  deriveCompanySecretKey,
  deriveUserSecretKey,
  getCreateProviderBlockReason,
  getDefaultProviderConfigId,
  getProviderConfigBlockReason,
  getSelectableProviderConfig,
} from "./-secrets-model";
import { useSecretsPage } from "./-SecretsPageContext";

export function SecretEditorDialog() {
  const {
    awsManagedPathPreview,
    createError,
    createForm,
    createKeyDirty,
    createKeyEditable,
    createMode,
    createMutation,
    createNamePrefix,
    createOpen,
    createProviderBlockReason,
    createProviderConfigs,
    createProviderHealthText,
    editingDefinition,
    folderPath,
    providerConfigs,
    providerHealthQuery,
    providers,
    secretValueProvider,
    setCreateForm,
    setCreateError,
    setCreateKeyDirty,
    setCreateKeyEditable,
    setCreateMode,
    setCreateNamePrefix,
    setCreateOpen,
    setSecretValueProvider,
  } = useSecretsPage();
  const submitDisabled =
    createMutation.isPending ||
    !createForm.name.trim() ||
    (secretValueProvider === "user"
      ? !createForm.key.trim()
      : Boolean(createProviderBlockReason) ||
        (createMode === "managed" ? !createForm.value : !createForm.externalRef.trim()));
  return (
    <Dialog
      open={createOpen}
      onOpenChange={(open) => {
        setCreateOpen(open);
        if (!open) setCreateNamePrefix(null);
      }}
    >
      <DialogContent className="max-h-(--sz-calc-18) overflow-y-auto p-4 sm:max-w-lg sm:p-6">
        <DialogHeader>
          <DialogTitle>{editingDefinition ? "Edit user-provided secret" : "Create secret"}</DialogTitle>
          <DialogDescription>
            Choose who provides the value. Shared fields keep their values when you switch modes.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {!editingDefinition ? (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-foreground">Who provides the value?</p>
              <Tabs
                value={secretValueProvider}
                onValueChange={(value) => {
                  const next = value as SecretValueProvider;
                  setSecretValueProvider(next);
                  setCreateKeyEditable(false);
                  setCreateForm((current) => ({
                    ...current,
                    key: createKeyDirty
                      ? current.key
                      : next === "user"
                        ? deriveUserSecretKey(current.name)
                        : deriveCompanySecretKey(current.name),
                  }));
                }}
              >
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="company">Company</TabsTrigger>
                  <TabsTrigger value="user">Each user</TabsTrigger>
                </TabsList>
              </Tabs>
              <FieldDescription>
                Company stores one shared value. Each user lets every member supply their own value under My
                secrets.
              </FieldDescription>
            </div>
          ) : null}

          {secretValueProvider === "company" && !editingDefinition ? (
            <Tabs value={createMode} onValueChange={(value) => setCreateMode(value as CreateMode)}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="managed">Managed value</TabsTrigger>
                <TabsTrigger value="external">External reference</TabsTrigger>
              </TabsList>
            </Tabs>
          ) : null}

          <Field>
            <FieldLabel htmlFor="new-secret-name">Name</FieldLabel>
            {createNamePrefix && !editingDefinition ? (
              <InputGroup>
                <InputGroupAddon title={createNamePrefix}>
                  {createNamePrefix}
                  <InputGroupButton
                    type="button"
                    size="icon-xs"
                    aria-label="Remove folder prefix"
                    onClick={() => setCreateNamePrefix(null)}
                  >
                    <X />
                  </InputGroupButton>
                </InputGroupAddon>
                <InputGroupInput
                  id="new-secret-name"
                  value={createForm.name.slice(createNamePrefix.length)}
                  onChange={(event) => {
                    const name = createNamePrefix + event.target.value;
                    setCreateForm((current) => ({
                      ...current,
                      name,
                      key: createKeyDirty
                        ? current.key
                        : secretValueProvider === "user"
                          ? deriveUserSecretKey(name)
                          : deriveCompanySecretKey(name),
                    }));
                  }}
                  placeholder="clientsecret"
                  autoFocus
                />
              </InputGroup>
            ) : (
              <Input
                id="new-secret-name"
                value={createForm.name}
                onChange={(event) => {
                  const name = event.target.value;
                  setCreateForm((current) => ({
                    ...current,
                    name,
                    key: createKeyDirty
                      ? current.key
                      : secretValueProvider === "user"
                        ? deriveUserSecretKey(name)
                        : deriveCompanySecretKey(name),
                  }));
                }}
                placeholder={secretValueProvider === "user" ? "Personal GitHub token" : "/dev/foo/bar"}
                autoFocus
              />
            )}
            {createNamePrefix && !editingDefinition ? (
              <FieldDescription>
                Creating in {folderPath} — remove the chip to type a different path.
              </FieldDescription>
            ) : null}
          </Field>

          {secretValueProvider === "company" && createMode === "managed" ? (
            <Field>
              <FieldLabel htmlFor="new-secret-value">Value</FieldLabel>
              <Textarea
                id="new-secret-value"
                value={createForm.value}
                onChange={(event) =>
                  setCreateForm((current) => ({
                    ...current,
                    value: event.target.value,
                  }))
                }
                rows={3}
                className="min-w-0 overflow-x-hidden break-all font-mono text-xs"
                placeholder="Stored once, never re-displayed"
              />
            </Field>
          ) : null}
          {secretValueProvider === "company" && createMode === "external" ? (
            <Field>
              <FieldLabel htmlFor="new-secret-ref">External reference</FieldLabel>
              <Input
                id="new-secret-ref"
                value={createForm.externalRef}
                onChange={(event) =>
                  setCreateForm((current) => ({
                    ...current,
                    externalRef: event.target.value,
                  }))
                }
                placeholder="arn:aws:secretsmanager:..."
                className="font-mono text-xs"
              />
              <FieldDescription>
                Existing provider secrets are resolve-only in Paperclip. Rotate the value in the provider,
                then update this reference only if the path, ARN, or version changes.
              </FieldDescription>
            </Field>
          ) : null}
          {secretValueProvider === "user" ? (
            <>
              <Alert>
                <AlertDescription>
                  Every member supplies their own value under My secrets. Agents resolve the responsible
                  user&apos;s value at runtime.
                </AlertDescription>
              </Alert>
              <Field>
                <FieldLabel htmlFor="new-secret-usage-guidance">
                  Usage guidance <span className="text-muted-foreground/70">(optional)</span>
                </FieldLabel>
                <Textarea
                  id="new-secret-usage-guidance"
                  value={createForm.usageGuidance}
                  onChange={(event) =>
                    setCreateForm((current) => ({
                      ...current,
                      usageGuidance: event.target.value,
                    }))
                  }
                  placeholder="Tell members how to create their token, required scopes, etc."
                  className="min-h-(--sz-70px) text-sm"
                />
              </Field>
            </>
          ) : null}

          <Field>
            <div className="flex items-center justify-between">
              <FieldLabel htmlFor="new-secret-key">Key</FieldLabel>
              {!createKeyEditable && !editingDefinition ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => setCreateKeyEditable(true)}>
                  <Pencil /> Edit
                </Button>
              ) : null}
            </div>
            <Input
              id="new-secret-key"
              value={createForm.key}
              readOnly={!createKeyEditable}
              disabled={Boolean(editingDefinition)}
              onChange={(event) => {
                if (!createKeyEditable || editingDefinition) return;
                setCreateKeyDirty(true);
                setCreateForm((current) => ({
                  ...current,
                  key: event.target.value,
                }));
              }}
              placeholder={secretValueProvider === "user" ? "PERSONAL_GH_TOKEN" : "auto from name"}
            />
            <FieldDescription>
              {editingDefinition
                ? "Stable env binding key. Cannot be changed."
                : "Generated from the name; edit it if the runtime expects another key."}
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="new-secret-description">Description (optional)</FieldLabel>
            <Input
              id="new-secret-description"
              value={createForm.description}
              onChange={(event) =>
                setCreateForm((current) => ({
                  ...current,
                  description: event.target.value,
                }))
              }
              placeholder="What is this secret used for? (no values)"
            />
          </Field>

          {secretValueProvider === "company" ? (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="new-secret-provider">Provider</FieldLabel>
                  <Select
                    value={createForm.provider}
                    onValueChange={(v) => {
                      const provider = v as SecretProvider;
                      setCreateForm((current) => ({
                        ...current,
                        provider,
                        providerConfigId: getDefaultProviderConfigId(providerConfigs, provider),
                      }));
                    }}
                  >
                    <SelectTrigger id="new-secret-provider" className="h-9 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {providers.map((provider) => {
                        const blockReason = getCreateProviderBlockReason(
                          provider,
                          createMode,
                          providerHealthQuery.data ?? null,
                          getSelectableProviderConfig(providerConfigs, provider.id),
                        );
                        return (
                          <SelectItem key={provider.id} value={provider.id} disabled={Boolean(blockReason)}>
                            {provider.label}
                            {provider.configured === false &&
                            !getSelectableProviderConfig(providerConfigs, provider.id)
                              ? " (deployment default missing)"
                              : provider.requiresExternalRef
                                ? " (external only)"
                                : ""}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                  {createProviderBlockReason ? (
                    <FieldError>{createProviderBlockReason}</FieldError>
                  ) : createProviderHealthText ? (
                    <FieldDescription>{createProviderHealthText}</FieldDescription>
                  ) : null}
                </Field>
                <Field>
                  <FieldLabel htmlFor="new-secret-vault">Provider vault</FieldLabel>
                  <Select
                    value={createForm.providerConfigId || "__default__"}
                    onValueChange={(v) =>
                      setCreateForm((current) => ({
                        ...current,
                        providerConfigId: v === "__default__" ? "" : v,
                      }))
                    }
                  >
                    <SelectTrigger id="new-secret-vault" className="h-9 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__default__">Deployment default</SelectItem>
                      {createProviderConfigs.map((config) => {
                        const blockReason = getProviderConfigBlockReason(config);
                        return (
                          <SelectItem key={config.id} value={config.id} disabled={Boolean(blockReason)}>
                            {config.displayName}
                            {config.isDefault ? " (default)" : ""}
                            {blockReason ? ` (${blockReason})` : ""}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              {createMode === "managed" ? (
                <Alert>
                  <AlertDescription>
                    Paperclip-managed secrets are created in the selected provider and future rotations write
                    a new provider version through Paperclip.
                    {awsManagedPathPreview ? <p>AWS managed path: {awsManagedPathPreview}</p> : null}
                  </AlertDescription>
                </Alert>
              ) : null}
            </>
          ) : null}
          {createError ? (
            <SecretCreateError
              error={createError}
              provider={createForm.provider}
              providerConfigId={createForm.providerConfigId || null}
            />
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setCreateOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              setCreateError(null);
              createMutation.mutate();
            }}
            disabled={submitDisabled}
          >
            {createMutation.isPending ? <Spinner className="mr-1 h-3.5 w-3.5" /> : null}
            {editingDefinition
              ? "Save changes"
              : secretValueProvider === "user"
                ? "Create user-provided secret"
                : createMode === "managed"
                  ? "Create secret"
                  : "Link reference"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
