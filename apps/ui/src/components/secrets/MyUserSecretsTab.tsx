import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CompanySecret } from "@paperclipai/shared";
import { AlertCircle, KeyRound, Trash2, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { FieldLegend, FieldSet } from "@/components/ui/field";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { secretsApi, type MyUserSecretEntry } from "@/api/secrets";
import { queryKeys } from "@/lib/queryKeys";
import { toast } from "sonner";
import { useCurrentUserId } from "@/hooks/useCurrentUserId";
import { SetMyUserSecretDialog } from "./SetMyUserSecretDialog";
import { getRelativeSecretPath } from "./secret-path";
import { myValueLabel, myValueState } from "./my-value-state";

/**
 * Secrets → My secrets tab. Lists every company user-secret definition paired
 * with the current user's own value state, and lets the user set / update /
 * clear their value. This is the owner-facing counterpart to the admin
 * "User secret definitions" tab.
 */
export function MyUserSecretsTab({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const userId = useCurrentUserId();
  const [dialogFor, setDialogFor] = useState<MyUserSecretEntry | null>(null);
  const clearInFlightRef = useRef(false);

  const mySecretsQuery = useQuery({
    queryKey: userId
      ? queryKeys.secrets.userSecrets(companyId, userId)
      : (["user-secrets", companyId, null] as const),
    queryFn: () => secretsApi.listUserSecrets(companyId, userId!),
    enabled: Boolean(userId),
  });
  const entries = mySecretsQuery.data ?? [];

  const clear = useMutation({
    mutationFn: (secret: CompanySecret) => {
      if (!userId) throw new Error("Sign in before clearing a user secret");
      return secretsApi.removeUserSecret(companyId, userId, secret.id);
    },
    onMutate: () => {
      clearInFlightRef.current = true;
    },
    onSuccess: () => {
      if (userId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.secrets.userSecrets(companyId, userId),
        });
      }
      toast.info("Value cleared");
    },
    onError: (err) =>
      toast.error("Could not clear value", {
        description: err instanceof Error ? err.message : undefined,
      }),
    onSettled: () => {
      clearInFlightRef.current = false;
    },
  });
  const isPending = clear.isPending;
  const handleClear = (secret: CompanySecret) => {
    if (isPending || clearInFlightRef.current) {
      return;
    }

    clearInFlightRef.current = true;
    clear.mutate(secret);
  };

  const missingCount = entries.filter(
    (entry) => entry.definition.status === "active" && !entry.secret,
  ).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden" aria-busy={isPending}>
      {mySecretsQuery.isPending || isPending ? (
        <p className="text-xs text-muted-foreground" role="status">
          {isPending
            ? "Clearing your secret value. Other secret actions are temporarily locked."
            : "Loading your secret values."}
        </p>
      ) : null}
      <Alert>
        <UserRound />
        <AlertTitle>Your secret values</AlertTitle>
        <AlertDescription>
          These are credentials only you provide. Each value is yours alone — used when you are the user
          responsible for a run — and is never shown back to anyone, including admins.
          {missingCount > 0 ? (
            <span className="font-medium">
              {" "}
              {missingCount} required secret
              {missingCount === 1 ? " still needs" : "s still need"} your value.
            </span>
          ) : null}
        </AlertDescription>
      </Alert>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {mySecretsQuery.isError ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Failed to load your secrets</AlertTitle>
            <AlertDescription>
              {(mySecretsQuery.error as Error).message}
              <Button size="sm" onClick={() => mySecretsQuery.refetch()}>
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : entries.length === 0 && !mySecretsQuery.isPending ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <KeyRound />
              </EmptyMedia>
              <EmptyTitle>
                No user secrets are defined for this company yet. An admin defines which credentials each
                member supplies.
              </EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <FieldSet className="contents" disabled={isPending}>
            <FieldLegend className="sr-only">Your secret values</FieldLegend>
            <ItemGroup>
              {entries.map((entry) => (
                <MyUserSecretRow
                  key={entry.definition.id}
                  entry={entry}
                  onSet={() => setDialogFor(entry)}
                  onClear={() => {
                    if (entry.secret) {
                      handleClear(entry.secret);
                    }
                  }}
                  clearing={isPending}
                />
              ))}
            </ItemGroup>
          </FieldSet>
        )}
      </div>

      <SetMyUserSecretDialog
        companyId={companyId}
        userId={userId}
        definition={dialogFor?.definition ?? null}
        existingSecret={dialogFor?.secret ?? null}
        open={dialogFor !== null}
        onOpenChange={(open) => {
          if (!open) setDialogFor(null);
        }}
      />
    </div>
  );
}

function MyUserSecretRow({
  entry,
  onSet,
  onClear,
  clearing,
}: {
  entry: MyUserSecretEntry;
  onSet: () => void;
  onClear: () => void;
  clearing: boolean;
}) {
  const { definition, secret } = entry;
  const state = myValueState(definition, secret);
  const disabledDefinition = definition.status !== "active";
  const { directory, leaf } = getRelativeSecretPath(definition.name);

  return (
    <Item asChild variant="outline">
      <li>
        <ItemContent>
          <ItemTitle>
            <span className="min-w-0 truncate">
              {directory ? <span className="text-muted-foreground">{directory}/</span> : null}
              <span className="font-medium text-foreground">{leaf}</span>
            </span>
            <Badge variant="secondary">{definition.key}</Badge>
            {disabledDefinition ? <Badge variant="outline">{definition.status}</Badge> : null}
          </ItemTitle>
          {definition.description ? <ItemDescription>{definition.description}</ItemDescription> : null}
          {definition.usageGuidance ? <ItemDescription>{definition.usageGuidance}</ItemDescription> : null}
        </ItemContent>

        <ItemActions>
          <Badge variant="outline">{myValueLabel(state)}</Badge>
          {!disabledDefinition ? (
            <Button size="sm" variant={secret ? "outline" : "default"} onClick={onSet}>
              {secret ? "Update" : "Set value"}
            </Button>
          ) : null}
          {secret ? (
            <Button
              size="icon-sm"
              variant="destructive"
              onClick={onClear}
              disabled={clearing}
              aria-label="Clear my value"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </ItemActions>
      </li>
    </Item>
  );
}
