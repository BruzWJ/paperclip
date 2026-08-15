import { accessApi, type CompanyUserDirectoryEntry } from "@/api/access";
import { CompanyBoardLink } from "@/features/navigation/CompanyBoardLink";
import { Badge } from "@/components/ui/badge";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { DetailList } from "@/components/patterns/DetailList";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemHeader, ItemTitle } from "@/components/ui/item";
import { queryKeys } from "@/lib/queryKeys";
import { consumerTypeLabel, deliveryModeForConfigPath, deliveryModeLabel } from "@/lib/secret-delivery";
import type {
  CompanySecret,
  CompanySecretProviderConfig,
  CompanySecretUsageBinding,
  SecretAccessEvent,
  SecretProviderDescriptor,
} from "@paperclipai/shared";
import { useQuery } from "@tanstack/react-query";
import { relativeTime as formatRelative } from "@/lib/utils";

import { modeDescription, modeLabel, providerLabel, providerVaultLabel } from "./-secrets-model";

export function SecretDetailsTab({
  secret,
  providers,
  providerConfigs,
  onViewUsage,
}: {
  secret: CompanySecret;
  providers: SecretProviderDescriptor[];
  providerConfigs: CompanySecretProviderConfig[];
  onViewUsage: () => void;
}) {
  const bindingLabel =
    (secret.referenceCount ?? 0) === 1 ? "1 binding" : `${secret.referenceCount ?? 0} bindings`;
  const details = [
    {
      label: "Description",
      value: secret.description ?? <span className="text-muted-foreground">—</span>,
    },
    { label: "Provided by", value: "Company" },
    { label: "Custody", value: modeLabel(secret.managedMode) },
    { label: "Provider", value: providerLabel(providers, secret.provider) },
    {
      label: "Provider vault",
      value: providerVaultLabel(providerConfigs, secret.providerConfigId),
    },
    {
      label: "External ARN",
      value: secret.externalRef ? (
        <span className="break-all font-mono">{secret.externalRef}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
    },
    { label: "Latest version", value: `v${secret.latestVersion}` },
    {
      label: "References",
      value: (
        <Button type="button" variant="link" className="h-auto p-0" onClick={onViewUsage}>
          {bindingLabel}
          <span className="text-muted-foreground">· View in Usage</span>
        </Button>
      ),
    },
    { label: "Created", value: formatRelative(secret.createdAt) },
    { label: "Updated", value: formatRelative(secret.updatedAt) },
    { label: "Last rotated", value: formatRelative(secret.lastRotatedAt) },
    { label: "Last resolved", value: formatRelative(secret.lastResolvedAt) },
  ];

  return (
    <>
      <DetailList items={details} />
      <Alert className="mt-3">
        <AlertDescription>
          {modeDescription(secret.managedMode)} Paperclip never re-displays stored values.
        </AlertDescription>
      </Alert>
    </>
  );
}

export function SecretUsageTab({
  loading,
  bindings,
}: {
  loading: boolean;
  bindings: CompanySecretUsageBinding[];
}) {
  if (loading) {
    return (
      <div className="flex justify-center py-6">
        <Spinner aria-label="Loading secret bindings" />
      </div>
    );
  }
  if (bindings.length === 0) {
    return (
      <Empty className="py-6">
        <EmptyDescription>
          No active bindings. Add this secret in agent, project, or environment config to start using it.
        </EmptyDescription>
      </Empty>
    );
  }
  return (
    <ItemGroup>
      {bindings.map((binding) => {
        const deliveryMode = deliveryModeForConfigPath(binding.configPath);
        return (
          <Item key={binding.id} variant="outline">
            <ItemContent>
              <ItemHeader>
                <ItemTitle>{binding.target.type}</ItemTitle>
                <Badge variant="outline">{deliveryModeLabel(deliveryMode)}</Badge>
              </ItemHeader>
              {binding.target.routeTarget ? (
                <CompanyBoardLink routeTarget={binding.target.routeTarget}>
                  {binding.target.label}
                </CompanyBoardLink>
              ) : (
                <ItemTitle>{binding.target.label}</ItemTitle>
              )}
              {binding.target.status ? (
                <DomainStatus status={binding.target.status}>
                  {binding.target.status.replaceAll("_", " ")}
                </DomainStatus>
              ) : null}
              <ItemDescription>{binding.targetId}</ItemDescription>
              <ItemDescription>
                {binding.configPath} · v{binding.versionSelector}{" "}
                {binding.required ? "· required" : "· optional"}
              </ItemDescription>
            </ItemContent>
          </Item>
        );
      })}
    </ItemGroup>
  );
}

export function SecretEventsTab({
  loading,
  events,
  companyId,
}: {
  loading: boolean;
  events: SecretAccessEvent[];
  companyId: string;
}) {
  // Resolve responsible/owner user ids to human names for user-scoped events.
  const anyUserScoped = events.some(
    (event) => event.secretScope === "user" || event.responsibleUserId || event.credentialOwnerUserId,
  );
  const { data: directory } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId),
    queryFn: () => accessApi.listUserDirectory(companyId),
    enabled: anyUserScoped,
    staleTime: 60_000,
  });
  const userLabel = (userId: string | null): string => {
    if (!userId) return "—";
    const entry: CompanyUserDirectoryEntry | undefined = directory?.users.find(
      (u) => u.principalId === userId,
    );
    return entry?.user?.name?.trim() || entry?.user?.email?.trim() || `${userId.slice(0, 8)}…`;
  };

  if (loading) {
    return (
      <div className="flex justify-center py-6">
        <Spinner aria-label="Loading secret access events" />
      </div>
    );
  }
  if (events.length === 0) {
    return (
      <Empty className="py-6">
        <EmptyDescription>
          No access events recorded yet. Each runtime resolution writes a redacted entry here.
        </EmptyDescription>
      </Empty>
    );
  }
  return (
    <ItemGroup>
      {events.map((event) => (
        <Item key={event.id} variant="outline">
          <ItemContent>
            <ItemHeader>
              <ItemTitle>
                {consumerTypeLabel(event.consumerType)} · {event.outcome}
                {event.secretScope === "user" ? <Badge variant="secondary">User secret</Badge> : null}
              </ItemTitle>
              <span>{formatRelative(event.createdAt)}</span>
            </ItemHeader>
            <ItemDescription>{event.consumerId}</ItemDescription>
            {event.responsibleUserId ? (
              <ItemDescription>Responsible user: {userLabel(event.responsibleUserId)}</ItemDescription>
            ) : null}
            {event.credentialOwnerUserId && event.credentialOwnerUserId !== event.responsibleUserId ? (
              <ItemDescription>Credential owner: {userLabel(event.credentialOwnerUserId)}</ItemDescription>
            ) : null}
            {event.errorCode ? <ItemDescription>{event.errorCode}</ItemDescription> : null}
          </ItemContent>
        </Item>
      ))}
    </ItemGroup>
  );
}
