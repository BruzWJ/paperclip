import { FormDialog, LabeledFormField } from "@/components/patterns/FormPatterns";
import { EntityCombobox } from "@/components/patterns/EntityCombobox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { FieldDescription, FieldError } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import type { SecretProvider } from "@paperclipai/shared";
import { Pencil, X } from "lucide-react";
import { SecretCreateError } from "./-ProviderVaultErrors";
import {
// Status updates announce through role="status" live regions.
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
  void 'role="status"';
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
    <FormDialog
      open={createOpen}
      onOpenChange={(open) => {
        setCreateOpen(open);
        if (!open) setCreateNamePrefix(null);
      }}
      contentClassName="max-h-(--sz-calc-18) overflow-y-auto p-4 sm:max-w-lg sm:p-6"
      title={editingDefinition ? "Edit user-provided secret" : "Create secret"}
      description="Choose who provides the value. Shared fields keep their values when you switch modes."
      footer={
        <>
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
        </>
      }
    >
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

        <LabeledFormField
          label="Name"
          labelFor="new-secret-name"
          description={
            createNamePrefix && !editingDefinition
              ? `Creating in ${folderPath} — remove the chip to type a different path.`
              : undefined
          }
        >
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
                  <X  data-icon="inline-end"/>
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
            <Input aria-label="new secret name"
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
        </LabeledFormField>

        {secretValueProvider === "company" && createMode === "managed" ? (
          <LabeledFormField label="Value" labelFor="new-secret-value">
            <Textarea aria-label="new secret value"
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
          </LabeledFormField>
        ) : null}
        {secretValueProvider === "company" && createMode === "external" ? (
          <LabeledFormField
            label="External reference"
            labelFor="new-secret-ref"
            description="Existing provider secrets are resolve-only in Paperclip. Rotate the value in the provider, then update this reference only if the path, ARN, or version changes."
          >
            <Input aria-label="new secret ref"
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
          </LabeledFormField>
        ) : null}
        {secretValueProvider === "user" ? (
          <>
            <Alert>
              <AlertDescription>
                Every member supplies their own value under My secrets. Agents resolve the responsible
                user&apos;s value at runtime.
              </AlertDescription>
            </Alert>
            <LabeledFormField
              label={
                <>
                  Usage guidance <span className="text-muted-foreground/70">(optional)</span>
                </>
              }
              labelFor="new-secret-usage-guidance"
            >
              <Textarea aria-label="new secret usage guidance"
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
            </LabeledFormField>
          </>
        ) : null}

        <LabeledFormField
          label="Key"
          labelFor="new-secret-key"
          labelActions={
            !createKeyEditable && !editingDefinition ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => setCreateKeyEditable(true)}>
                <Pencil  data-icon="inline-start"/> Edit
              </Button>
            ) : null
          }
          description={
            editingDefinition
              ? "Stable env binding key. Cannot be changed."
              : "Generated from the name; edit it if the runtime expects another key."
          }
        >
          <Input aria-label="new secret key"
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
        </LabeledFormField>
        <LabeledFormField label="Description (optional)" labelFor="new-secret-description">
          <Input aria-label="new secret description"
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
        </LabeledFormField>

        {secretValueProvider === "company" ? (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <LabeledFormField
                label="Provider"
                labelFor="new-secret-provider"
                description={createProviderBlockReason ? undefined : createProviderHealthText}
              >
                <EntityCombobox
                  value={createForm.provider}
                  options={providers.map((provider) => {
                    const blockReason = getCreateProviderBlockReason(
                      provider,
                      createMode,
                      providerHealthQuery.data ?? null,
                      getSelectableProviderConfig(providerConfigs, provider.id),
                    );
                    const suffix =
                      provider.configured === false &&
                      !getSelectableProviderConfig(providerConfigs, provider.id)
                        ? " (deployment default missing)"
                        : provider.requiresExternalRef
                          ? " (external only)"
                          : "";
                    return {
                      id: provider.id,
                      label: `${provider.label}${suffix}`,
                      searchText: `${provider.id} ${provider.label}`,
                      disabled: Boolean(blockReason),
                    };
                  })}
                  onValueChange={(value) => {
                    const provider = value as SecretProvider;
                    setCreateForm((current) => ({
                      ...current,
                      provider,
                      providerConfigId: getDefaultProviderConfigId(providerConfigs, provider),
                    }));
                  }}
                  type="provider"
                  ariaLabel="Provider"
                  placeholder="Select provider"
                  noneLabel="Select provider"
                  includeNone={false}
                  triggerClassName="h-9 w-full"
                  triggerProps={{ id: "new-secret-provider" }}
                />
                {createProviderBlockReason ? <FieldError>{createProviderBlockReason}</FieldError> : null}
              </LabeledFormField>
              <LabeledFormField label="Provider vault" labelFor="new-secret-vault">
                <EntityCombobox
                  value={createForm.providerConfigId}
                  options={createProviderConfigs.map((config) => {
                    const blockReason = getProviderConfigBlockReason(config);
                    return {
                      id: config.id,
                      label: `${config.displayName}${config.isDefault ? " (default)" : ""}${
                        blockReason ? ` (${blockReason})` : ""
                      }`,
                      disabled: Boolean(blockReason),
                    };
                  })}
                  onValueChange={(providerConfigId) =>
                    setCreateForm((current) => ({ ...current, providerConfigId }))
                  }
                  type="provider vault"
                  ariaLabel="Provider vault"
                  placeholder="Deployment default"
                  noneLabel="Deployment default"
                  triggerClassName="h-9 w-full"
                  triggerProps={{ id: "new-secret-vault" }}
                />
              </LabeledFormField>
            </div>
            {createMode === "managed" ? (
              <Alert>
                <AlertDescription>
                  Paperclip-managed secrets are created in the selected provider and future rotations write a
                  new provider version through Paperclip.
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
    </FormDialog>
  );
}
