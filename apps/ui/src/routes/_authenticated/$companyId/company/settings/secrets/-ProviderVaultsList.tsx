import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Item, ItemDescription, ItemGroup } from "@/components/ui/item";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import type {
  CompanySecretProviderConfig,
  SecretProvider,
  SecretProviderDescriptor,
} from "@paperclipai/shared";
import {
  AlertCircle,
  Ban,
  Cloud,
  Database,
  Edit3,
  KeyRound,
  Plus,
  RefreshCw,
  ShieldCheck,
  Star,
  Trash2,
} from "lucide-react";
import { relativeTime as formatRelative } from "@/lib/utils";

import { getProviderConfigBlockReason, PROVIDER_ORDER } from "./-secrets-model";

function providerFamilyIcon(provider: SecretProvider) {
  switch (provider) {
    case "local_encrypted":
      return Database;
    case "aws_secrets_manager":
      return Cloud;
    case "gcp_secret_manager":
      return ShieldCheck;
    case "vault":
      return KeyRound;
    default:
      return KeyRound;
  }
}

export function ProviderVaultsTab({
  providers,
  providerConfigs,
  loading,
  error,
  onRetry,
  onCreate,
  onEdit,
  onDisable,
  onRemove,
  onSetDefault,
  onHealthCheck,
  onImportSecrets,
  pendingActionId,
}: {
  providers: SecretProviderDescriptor[];
  providerConfigs: CompanySecretProviderConfig[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  onCreate: (provider: SecretProvider) => void;
  onEdit: (config: CompanySecretProviderConfig) => void;
  onDisable: (config: CompanySecretProviderConfig) => void;
  onRemove: (config: CompanySecretProviderConfig) => void;
  onSetDefault: (config: CompanySecretProviderConfig) => void;
  onHealthCheck: (config: CompanySecretProviderConfig) => void;
  onImportSecrets: (config: CompanySecretProviderConfig) => void;
  pendingActionId: string | null;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Spinner className="h-4 w-4" />
        Loading provider vaults
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertDescription>Failed to load provider vaults: {(error as Error).message}</AlertDescription>
        <Button variant="ghost" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </Alert>
    );
  }

  const providerMap = new Map(providers.map((provider) => [provider.id, provider]));
  const providerRows = PROVIDER_ORDER.map((providerId) => ({
    id: providerId,
    provider: providerMap.get(providerId),
    Icon: providerFamilyIcon(providerId),
    isComingSoonFamily: providerId === "gcp_secret_manager" || providerId === "vault",
    configs: providerConfigs.filter((config) => config.provider === providerId),
  }));

  return (
    <div className="flex min-h-full gap-6">
      <Sidebar
        collapsible="none"
        role="navigation"
        aria-label="Provider vault types"
        className="sticky top-0 hidden h-fit w-56 shrink-0 bg-transparent md:flex"
      >
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Providers</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {providerRows.map(({ id, provider, Icon }) => (
                  <SidebarMenuItem key={id}>
                    <SidebarMenuButton asChild>
                      <a href={`#provider-vaults-${id}`}>
                        <Icon />
                        <span>{provider?.label ?? id.replaceAll("_", " ")}</span>
                      </a>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>

      <div className="min-w-0 flex-1 space-y-6">
        {providerRows.map(({ id, provider, Icon, isComingSoonFamily, configs }) => (
          <section
            key={id}
            id={`provider-vaults-${id}`}
            className={cn("scroll-mt-6 space-y-2", isComingSoonFamily && "opacity-50")}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Icon className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">{provider?.label ?? id.replaceAll("_", " ")}</h2>
              {isComingSoonFamily ? (
                <DomainStatus status="coming_soon" className="ml-auto">
                  Coming soon
                </DomainStatus>
              ) : (
                <Button variant="outline" size="sm" className="ml-auto" onClick={() => onCreate(id)}>
                  <Plus data-icon="inline-start" className="h-3.5 w-3.5 mr-1" />
                  Add vault
                </Button>
              )}
            </div>
            {configs.length === 0 ? (
              <Empty className="py-6">
                <EmptyDescription>
                  {isComingSoonFamily
                    ? "Not yet supported."
                    : "No company-specific vaults yet. Secrets can still use the deployment default provider settings."}
                </EmptyDescription>
              </Empty>
            ) : (
              <div className="space-y-3">
                {configs.map((config) => {
                  const pending = pendingActionId === config.id;
                  const blockReason = getProviderConfigBlockReason(config);
                  const details = config.healthDetails;
                  return (
                    <Card key={config.id}>
                      <CardHeader>
                        <CardTitle>
                          {config.displayName}
                          {config.isDefault ? (
                            <Badge>
                              <Star />
                              Default
                            </Badge>
                          ) : null}
                        </CardTitle>
                        <CardDescription>
                          <DomainStatus status={config.status}>
                            {config.status.replace("_", " ")}
                          </DomainStatus>
                          {config.healthStatus ? (
                            <DomainStatus status={config.healthStatus}>
                              Health {config.healthStatus.replace("_", " ")} ·{" "}
                              {formatRelative(config.healthCheckedAt)}
                            </DomainStatus>
                          ) : (
                            <span>Health not checked</span>
                          )}
                        </CardDescription>
                        <CardAction>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => onEdit(config)}
                            aria-label="Edit secret provider configuration"
                          >
                            <Edit3 />
                          </Button>
                        </CardAction>
                      </CardHeader>
                      {config.healthMessage || blockReason ? (
                        <CardContent>
                          <Alert variant={blockReason ? "destructive" : "default"}>
                            <AlertDescription>
                              {blockReason ?? config.healthMessage}
                              {details?.guidance?.length ? (
                                <ItemGroup className="mt-2 gap-1">
                                  {details.guidance.map((item) => (
                                    <Item key={item} size="sm" className="border-0 p-0">
                                      <ItemDescription>{item}</ItemDescription>
                                    </Item>
                                  ))}
                                </ItemGroup>
                              ) : null}
                            </AlertDescription>
                          </Alert>
                        </CardContent>
                      ) : null}
                      <CardFooter className="flex-wrap gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => onHealthCheck(config)}
                          disabled={pending}
                        >
                          {pending ? (
                            <Spinner className="mr-1 h-3.5 w-3.5" />
                          ) : (
                            <RefreshCw className="mr-1 h-3.5 w-3.5" />
                          )}
                          Check health
                        </Button>
                        {config.provider === "aws_secrets_manager" ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => onImportSecrets(config)}
                            disabled={pending || Boolean(blockReason)}
                            title={blockReason ?? "Refresh AWS metadata and import existing secrets"}
                            data-testid={`provider-vault-refresh-secrets-${config.id}`}
                          >
                            <Cloud data-icon="inline-start" className="mr-1 h-3.5 w-3.5" />
                            Refresh secrets
                          </Button>
                        ) : null}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => onSetDefault(config)}
                          disabled={pending || Boolean(blockReason) || config.isDefault}
                        >
                          <Star data-icon="inline-start" className="mr-1 h-3.5 w-3.5" />
                          Make default
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => onDisable(config)}
                          disabled={pending || config.status === "disabled"}
                        >
                          <Ban data-icon="inline-start" className="mr-1 h-3.5 w-3.5" />
                          Disable
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => onRemove(config)}
                          disabled={pending}
                        >
                          <Trash2 data-icon="inline-start" className="mr-1 h-3.5 w-3.5" />
                          Remove
                        </Button>
                      </CardFooter>
                    </Card>
                  );
                })}
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
