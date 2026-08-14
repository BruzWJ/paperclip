import { Spinner } from "@/components/ui/spinner";
import { useId, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, KeyRound, Plus, X } from "lucide-react";
import type { CompanySecret, SecretVersionSelector } from "@paperclipai/shared";
import { secretsApi } from "../api/secrets";
import { queryKeys } from "../lib/queryKeys";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "../lib/utils";

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

function describeSecret(secret: CompanySecret): string {
  const provider = secret.provider.replaceAll("_", " ");
  if (secret.managedMode === "external_reference") {
    return `External · ${provider}`;
  }
  return provider;
}

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
  const queryClient = useQueryClient();
  const companyId = useCompanyRouteId();
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createValue, setCreateValue] = useState("");
  const [createDescription, setCreateDescription] = useState("");
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

  const createMutation = useMutation({
    mutationFn: () =>
      secretsApi.create(companyId, {
        name: createName.trim(),
        value: createValue,
        description: createDescription.trim() || null,
      }),
    onSuccess: (created) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.secrets.list(companyId),
      });
      onChange({ secretId: created.id, version: VERSION_LATEST });
      setCreateOpen(false);
      setCreateName("");
      setCreateValue("");
      setCreateDescription("");
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
      <Field>
        {label ? (
          <div className="flex items-center justify-between">
            <FieldLabel htmlFor={secretSelectId}>{label}</FieldLabel>
            {value ? (
              <Button
                type="button"
                variant="link"
                size="xs"
                onClick={() => onChange(null)}
                disabled={disabled}
              >
                <X className="h-3 w-3" /> Clear
              </Button>
            ) : null}
          </div>
        ) : null}
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1">
            <KeyRound className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground z-10" />
            <Select
              value={value?.secretId ?? ""}
              onValueChange={(next) => {
                if (!next) {
                  onChange(null);
                  return;
                }
                onChange({
                  secretId: next,
                  version: value?.version ?? VERSION_LATEST,
                });
              }}
              disabled={disabled || secretsQuery.isPending}
            >
              <SelectTrigger
                id={secretSelectId}
                className={cn("h-9 w-full pl-7", selectedMissing && "border-destructive text-destructive")}
              >
                <SelectValue placeholder={secretsQuery.isPending ? "Loading…" : placeholder} />
              </SelectTrigger>
              <SelectContent>
                {selectedMissing && value ? (
                  <SelectItem value={value.secretId}>
                    Missing secret ({value.secretId.slice(0, 8)}…)
                  </SelectItem>
                ) : null}
                {filteredSecrets.map((secret) => (
                  <SelectItem key={secret.id} value={secret.id}>
                    {secret.name} — {describeSecret(secret)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setCreateOpen(true)}
            disabled={disabled}
            aria-label="Create secret"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>

        {selectedSecret ? (
          <FieldDescription>
            {selectedSecret.status !== "active" ? (
              <Badge variant="outline">{selectedSecret.status}</Badge>
            ) : null}{" "}
            Bound to {versionDisplay(value?.version)} · {selectedSecret.key}
          </FieldDescription>
        ) : selectedMissing ? (
          <Alert variant="destructive">
            <AlertCircle className="h-3 w-3" />
            <AlertDescription>
              The previously selected secret is no longer available. Pick another or remove the binding.
            </AlertDescription>
          </Alert>
        ) : filteredSecrets.length === 0 && !secretsQuery.isPending ? (
          <FieldDescription>{emptyHint}</FieldDescription>
        ) : null}
      </Field>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          {createMutation.isPending ? (
            <p className="sr-only" role="status">
              Creating and binding secret.
            </p>
          ) : null}
          <DialogHeader>
            <DialogTitle>Create new secret</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Field>
              <FieldLabel htmlFor="secret-name">Name</FieldLabel>
              <Input
                id="secret-name"
                value={createName}
                onChange={(event) => setCreateName(event.target.value)}
                placeholder="OPENAI_API_KEY"
                autoFocus
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="secret-value">Value</FieldLabel>
              <Textarea
                id="secret-value"
                value={createValue}
                onChange={(event) => setCreateValue(event.target.value)}
                rows={3}
                placeholder="Paste the secret value"
                className="font-mono text-xs"
              />
              <FieldDescription>
                The value is stored once and never re-displayed. Rotate to replace.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="secret-description">Description</FieldLabel>
              <Input
                id="secret-description"
                value={createDescription}
                onChange={(event) => setCreateDescription(event.target.value)}
                placeholder="Optional notes (no values)"
              />
            </Field>
            <FieldError>{createError}</FieldError>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => createMutation.mutate()}
              disabled={!createName.trim() || !createValue || createMutation.isPending}
            >
              {createMutation.isPending ? <Spinner className="h-3.5 w-3.5" /> : null}
              Create &amp; bind
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
