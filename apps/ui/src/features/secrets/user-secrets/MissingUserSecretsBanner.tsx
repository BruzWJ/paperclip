// Empty collections render dedicated UI when data.length === 0.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { secretsApi, type MyUserSecretEntry } from "@/api/secrets";
import { queryKeys } from "@/lib/queryKeys";
import { SetMyUserSecretDialog } from "./SetMyUserSecretDialog";

/**
 * Warning surface for user secrets the current user has not yet set. Renders
 * nothing when there is nothing missing, so it is safe to embed on task
 * creation / run and task-failure surfaces. Lets the user satisfy a missing
 * required secret inline via the shared value dialog.
 *
 * Pass `definitionKeys` to scope the warning to a specific set (e.g. the user
 * secrets a blocked run reported as missing); omit it to warn about every
 * active definition the user has not set.
 */
export function MissingUserSecretsBanner({
  companyId,
  userId,
  definitionKeys,
  title = "Set your user secrets",
  className,
}: {
  companyId: string;
  userId: string | null;
  definitionKeys?: string[];
  title?: string;
  className?: string;
}) {
  const [dialogFor, setDialogFor] = useState<MyUserSecretEntry | null>(null);

  const mySecretsQuery = useQuery({
    queryKey: userId
      ? queryKeys.secrets.userSecrets(companyId, userId)
      : (["user-secrets", companyId, null] as const),
    queryFn: () => secretsApi.listUserSecrets(companyId, userId!),
    enabled: Boolean(userId),
    retry: false,
  });

  const keyFilter = definitionKeys ? new Set(definitionKeys) : null;
  const missing = (mySecretsQuery.data ?? []).filter(
    (entry) =>
      entry.definition.status === "active" &&
      !entry.secret &&
      (!keyFilter || keyFilter.has(entry.definition.key)),
  );

  if (missing.length === 0) return null;

  return (
    <Alert className={className}>
      <AlertTriangle aria-hidden="true"  data-icon="inline-start"/>
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>
          {missing.length} user secret{missing.length === 1 ? "" : "s"} you are responsible for
          {missing.length === 1 ? " has" : " have"} no value yet. Runs that require
          {missing.length === 1 ? " it" : " them"} will fail until you set your value.
        </p>
        <ItemGroup>
          {missing.map((entry) => (
            <Item key={entry.definition.id} variant="outline" size="sm">
              <ItemContent>
                <ItemTitle>{entry.definition.name}</ItemTitle>
                <ItemDescription>
                  <code>{entry.definition.key}</code>
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button size="sm" onClick={() => setDialogFor(entry)}>
                  Set value
                </Button>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>

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
      </AlertDescription>
    </Alert>
  );
}
