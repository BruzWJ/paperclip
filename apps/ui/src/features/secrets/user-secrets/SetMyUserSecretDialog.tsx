import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CompanySecret, UserSecretDefinition } from "@paperclipai/shared";
import { FormDialog, LabeledFormField } from "@/components/patterns/FormPatterns";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FieldError } from "@/components/ui/field";
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { secretsApi } from "@/api/secrets";
import { ApiError } from "@/api/client";
import { queryKeys } from "@/lib/queryKeys";
import { toast } from "sonner";
import { UserRound } from "lucide-react";

/**
 * Shared "set my value" dialog for a user-secret definition. Used both from the
 * Secrets → My secrets tab and from the missing-required-secret warning surfaces
 * (task run / task failure), so a user can satisfy a required secret from either
 * place with identical behavior.
 */
export function SetMyUserSecretDialog({
  companyId,
  userId,
  definition,
  existingSecret,
  open,
  onOpenChange,
  onSaved,
}: {
  companyId: string;
  userId: string | null;
  definition: UserSecretDefinition | null;
  existingSecret?: CompanySecret | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (secret: CompanySecret) => void;
}) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState("");
  const [externalRef, setExternalRef] = useState("");
  const [error, setError] = useState<string | null>(null);

  const isExternal = definition?.managedMode === "external_reference";

  useEffect(() => {
    if (open) {
      setValue("");
      setExternalRef("");
      setError(null);
    }
  }, [open, definition?.id]);

  const save = useMutation({
    mutationFn: async () => {
      if (!definition) throw new Error("No definition selected");
      if (!userId) throw new Error("Sign in before setting a user secret");
      const payload = isExternal ? { externalRef } : { value };
      if (existingSecret) {
        // A stored value already exists → rotate it in place.
        return secretsApi.rotateUserSecret(companyId, userId, existingSecret.id, payload);
      }
      return secretsApi.createUserSecret(companyId, userId, {
        definitionId: definition.id,
        ...payload,
      });
    },
    onSuccess: (secret) => {
      if (userId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.secrets.userSecrets(companyId, userId),
        });
      }
      queryClient.invalidateQueries({
        queryKey: queryKeys.secrets.userDefinitions(companyId),
      });
      toast.success(existingSecret ? "Value updated" : "Value saved", {
        description: definition?.name,
      });
      onSaved?.(secret);
      onOpenChange(false);
    },
    onError: (err) => {
      setError(
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : "Failed to save value",
      );
    },
  });

  const canSave = isExternal ? externalRef.length > 0 : value.length > 0;

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        <>
          {existingSecret ? "Update your value" : "Set your value"}
          <Badge variant="secondary">
            <UserRound />
            User secret
          </Badge>
        </>
      }
      titleClassName="flex items-center gap-2"
      description={
        definition ? (
          <>
            This value is yours only. It is used when you are the user responsible for a run that needs{" "}
            <span className="font-mono">{definition.key}</span>.
          </>
        ) : null
      }
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={!canSave || save.isPending}>
            {save.isPending ? "Saving…" : existingSecret ? "Update value" : "Save value"}
          </Button>
        </>
      }
    >
      {save.isPending ? (
        <p className="sr-only" role="status">
          Saving your secret value.
        </p>
      ) : null}

      {definition ? (
        <div className="space-y-3">
          <Item variant="outline">
            <ItemContent>
              <ItemTitle>{definition.name}</ItemTitle>
              {definition.description ? <ItemDescription>{definition.description}</ItemDescription> : null}
              {definition.usageGuidance ? (
                <ItemDescription>{definition.usageGuidance}</ItemDescription>
              ) : null}
            </ItemContent>
          </Item>

          {isExternal ? (
            <LabeledFormField
              label="External reference"
              description="Points at your own credential in the configured provider. Paperclip stores the reference, not the value."
            >
              <Input
                aria-label="External secret reference"
                value={externalRef}
                onChange={(event) => setExternalRef(event.target.value)}
                placeholder="provider reference or ARN"
                className="font-mono text-sm"
                autoFocus
              />
            </LabeledFormField>
          ) : (
            <LabeledFormField
              label="Your value"
              description="Stored encrypted. Never shown back to anyone, including admins."
            >
              <Textarea
                aria-label="Secret value"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder="Paste your token or credential"
                className="font-mono text-sm min-h-(--sz-80px)"
                autoFocus
              />
            </LabeledFormField>
          )}

          {error ? <FieldError>{error}</FieldError> : null}
        </div>
      ) : null}
    </FormDialog>
  );
}
