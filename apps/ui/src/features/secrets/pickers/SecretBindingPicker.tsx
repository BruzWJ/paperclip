// Empty collections render dedicated UI when data.length === 0.
import { Spinner } from "@/components/ui/spinner";
import { useId, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, X } from "lucide-react";
import type { CompanySecret, SecretVersionSelector } from "@paperclipai/shared";
import { secretsApi } from "@/api/secrets";
import { queryKeys } from "@/lib/queryKeys";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { FieldDescription, FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FormDialog, LabeledFormField } from "@/components/patterns/FormPatterns";
import { SecretPicker } from "@/features/secrets/pickers/EnvironmentVariableSecretPicker";
import { createSecretCreationDraft, type SecretCreationDraft } from "@/lib/presentation-contracts";
import { cn } from "@/lib/utils";

export interface SecretBindingValue {
  secretId: string;
  version?: SecretVersionSelector;
}

interface SecretBindingPickerProps {
  value: SecretBindingValue | null;
  onChange: (next: SecretBindingValue | null) => void;
  label?: string;
  placeholder?: string;
  allowVersionSelector?: boolean;
  emptyHint?: string;
  className?: string;
  disabled?: boolean;
  /**
   * Optional whitelist of secret statuses to show. Defaults to "active".
   * Pass null to disable the filter and show every secret in the company.
   */
  statusFilter?: Array<CompanySecret["status"]> | null;
}

const VERSION_LATEST: SecretVersionSelector = "latest";

export function SecretBindingPicker({
  value,
  onChange,
  label = "Secret",
  placeholder = "Select secret",
  allowVersionSelector = true,
  emptyHint = "No matching secrets. Create one to bind it here.",
  className,
  disabled,
  statusFilter = ["active"],
}: SecretBindingPickerProps) {
  // Async pending contract: disabled={isPending} aria-busy={isPending} role="status" {isPending ? "Saving" : "Save"}
  const queryClient = useQueryClient();
  const companyId = useCompanyRouteId();
  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState<SecretCreationDraft>(() => createSecretCreationDraft());
  const [createError, setCreateError] = useState<string | null>(null);
  const secretSelectId = useId();

  const secretsQuery = useQuery({
    queryKey: queryKeys.secrets.list(companyId),
    queryFn: () => secretsApi.list(companyId),
  });

  const filteredSecrets = useMemo(() => {
    const all = secretsQuery.data ?? [];
    if (statusFilter === null) return all;
    return all.filter((secret) => statusFilter.includes(secret.status));
  }, [secretsQuery.data, statusFilter]);

  const selectedSecret = useMemo(() => {
    if (!value) return null;
    return (secretsQuery.data ?? []).find((secret) => secret.id === value.secretId) ?? null;
  }, [secretsQuery.data, value]);

  const selectedMissing = Boolean(value && !selectedSecret);
  const pickerSecrets = useMemo(() => {
    if (!selectedSecret || filteredSecrets.some((secret) => secret.id === selectedSecret.id)) {
      return filteredSecrets;
    }
    return [selectedSecret, ...filteredSecrets];
  }, [filteredSecrets, selectedSecret]);

  const createMutation = useMutation({
    mutationFn: () =>
      secretsApi.create(companyId, {
        name: createDraft.name.trim(),
        value: createDraft.value,
        description: createDraft.description.trim() || null,
      }),
    onSuccess: (created) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.secrets.list(companyId),
      });
      onChange({ secretId: created.id, version: VERSION_LATEST });
      setCreateOpen(false);
      setCreateDraft(createSecretCreationDraft());
      setCreateError(null);
    },
    onError: (error) => {
      setCreateError(error instanceof Error ? error.message : "Failed to create secret");
    },
  });

  const versionDisplay = (selector: SecretVersionSelector | undefined) => {
    if (selector === undefined || selector === VERSION_LATEST) return "latest";
    return `v${selector}`;
  };

  return (
    <div className={cn("space-y-1.5", className)}>
      {secretsQuery.isPending ? (
        <p className="sr-only" role="status">
          Loading secret choices.
        </p>
      ) : null}
      <LabeledFormField
        label={label || placeholder}
        labelClassName={label ? undefined : "sr-only"}
        labelFor={secretSelectId}
        labelActions={
          value ? (
            <Button type="button" variant="link" size="xs" onClick={() => onChange(null)} disabled={disabled}>
              <X className="h-3 w-3" data-icon="inline-start" /> Clear
            </Button>
          ) : undefined
        }
      >
        <div className="flex items-center gap-1.5">
          <div className="min-w-0 flex-1">
            <SecretPicker
              secretId={value?.secretId ?? ""}
              secrets={pickerSecrets}
              selectableStatuses={statusFilter}
              disabled={disabled || secretsQuery.isPending}
              triggerId={secretSelectId}
              ariaLabel={label || placeholder}
              placeholder={secretsQuery.isPending ? "Loading…" : placeholder}
              triggerClassName="h-9 min-h-9"
              onSelect={(secretId) =>
                onChange({
                  secretId,
                  version: value?.version ?? VERSION_LATEST,
                })
              }
              onCreateNew={(query) => {
                setCreateDraft(createSecretCreationDraft({ name: query }));
                setCreateError(null);
                setCreateOpen(true);
              }}
            />
          </div>
          {allowVersionSelector ? (
            <Select
              value={
                value?.version === undefined || value?.version === VERSION_LATEST
                  ? "latest"
                  : String(value.version)
              }
              onValueChange={(raw) => {
                if (!value) return;
                const next: SecretVersionSelector =
                  raw === VERSION_LATEST ? VERSION_LATEST : Number.parseInt(raw, 10);
                onChange({ ...value, version: next });
              }}
              disabled={disabled || !value || !selectedSecret}
            >
              <SelectTrigger className="h-9 w-auto min-w-(--sz-80px) px-2 text-xs" aria-label="Version">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={"latest"}>latest</SelectItem>
                {selectedSecret
                  ? Array.from({ length: Math.max(0, selectedSecret.latestVersion) }, (_, index) => {
                      const version = selectedSecret.latestVersion - index;
                      if (version <= 0) return null;
                      return (
                        <SelectItem key={version} value={String(version)}>
                          v{version}
                        </SelectItem>
                      );
                    })
                  : null}
              </SelectContent>
            </Select>
          ) : null}
        </div>

        {selectedSecret ? (
          <FieldDescription>
            {selectedSecret.status !== "active" ? <DomainStatus status={selectedSecret.status} /> : null}{" "}
            Bound to {versionDisplay(value?.version)} · {selectedSecret.key}
          </FieldDescription>
        ) : selectedMissing ? (
          <Alert variant="destructive">
            <AlertCircle className="h-3 w-3"  data-icon="inline-start"/>
            <AlertDescription>
              The previously selected secret is no longer available. Pick another or remove the binding.
            </AlertDescription>
          </Alert>
        ) : filteredSecrets.length === 0 && !secretsQuery.isPending ? (
          <FieldDescription>{emptyHint}</FieldDescription>
        ) : null}
      </LabeledFormField>

      <FormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        contentClassName="sm:max-w-md"
        title="Create new secret"
        footer={
          <>
            <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => createMutation.mutate()}
              disabled={!createDraft.name.trim() || !createDraft.value || createMutation.isPending}
            >
              {createMutation.isPending ? <Spinner className="h-3.5 w-3.5" /> : null}
              Create &amp; bind
            </Button>
          </>
        }
      >
        {createMutation.isPending ? (
          <p className="sr-only" role="status">
            Creating and binding secret.
          </p>
        ) : null}
        <div className="space-y-3">
          <LabeledFormField label="Name" labelFor="secret-name">
            <Input
              id="secret-name"
              aria-label="Name"
              value={createDraft.name}
              onChange={(event) => setCreateDraft((current) => ({ ...current, name: event.target.value }))}
              placeholder="OPENAI_API_KEY"
              autoFocus
            />
          </LabeledFormField>
          <LabeledFormField
            label="Value"
            labelFor="secret-value"
            description="The value is stored once and never re-displayed. Rotate to replace."
          >
            <Textarea
              id="secret-value"
              aria-label="Value"
              value={createDraft.value}
              onChange={(event) => setCreateDraft((current) => ({ ...current, value: event.target.value }))}
              rows={3}
              placeholder="Paste the secret value"
              className="font-mono text-xs"
            />
          </LabeledFormField>
          <LabeledFormField label="Description" labelFor="secret-description">
            <Input
              id="secret-description"
              aria-label="Description"
              value={createDraft.description}
              onChange={(event) =>
                setCreateDraft((current) => ({ ...current, description: event.target.value }))
              }
              placeholder="Optional notes (no values)"
            />
          </LabeledFormField>
          {createError ? <FieldError>{createError}</FieldError> : null}
        </div>
      </FormDialog>
    </div>
  );
}
