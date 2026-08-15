import { Badge } from "@/components/ui/badge";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import type { PluginCatalogEntryDto, PluginRecordDto } from "@paperclipai/shared";
import { Link } from "@tanstack/react-router";
import { Puzzle } from "lucide-react";
function getCatalogKindLabel(kind: PluginCatalogEntryDto["kind"]) {
  return kind === "first_party" ? "First-party" : "Example";
}
export function PluginCatalogSection({
  companyId,
  catalogPlugins,
  installedByPackageName,
  isLoading,
  loadError,
  installError,
  isInstallPending,
  installingPackage,
  onInstall,
}: {
  companyId: string;
  catalogPlugins: PluginCatalogEntryDto[];
  installedByPackageName: Map<string, PluginRecordDto>;
  isLoading: boolean;
  loadError: unknown;
  installError: Error | null;
  isInstallPending: boolean;
  installingPackage: string | undefined;
  onInstall: (value: string) => void;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Puzzle className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-base font-semibold">Available Plugins</h2>
        <Badge variant="outline">Local catalog</Badge>
      </div>

      {installError ? (
        <Alert variant="destructive">
          <AlertTitle>Plugin installation failed</AlertTitle>
          <AlertDescription>{installError.message}</AlertDescription>
        </Alert>
      ) : null}

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Spinner /> Loading available plugins…
        </div>
      ) : loadError ? (
        <Alert variant="destructive">
          <AlertTitle>Available plugins could not be loaded</AlertTitle>
          <AlertDescription>Try refreshing this page.</AlertDescription>
        </Alert>
      ) : catalogPlugins.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Puzzle />
            </EmptyMedia>
            <EmptyTitle>No plugins available</EmptyTitle>
            <EmptyDescription>No local plugins are available in this installation.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup>
          {catalogPlugins.map((catalogPlugin) => {
            const installedPlugin = installedByPackageName.get(catalogPlugin.packageName);
            const installPending = isInstallPending && installingPackage === catalogPlugin.packageName;

            return (
              <Item key={catalogPlugin.packageName} variant="outline">
                <ItemContent>
                  <ItemTitle>
                    <span className="font-medium">{catalogPlugin.displayName}</span>
                    <Badge variant="outline">{getCatalogKindLabel(catalogPlugin.kind)}</Badge>
                    {installedPlugin ? (
                      <DomainStatus status={installedPlugin.status}>{installedPlugin.status}</DomainStatus>
                    ) : (
                      <Badge variant="secondary">Available</Badge>
                    )}
                    {!catalogPlugin.built && !installedPlugin ? (
                      <Badge variant="outline">Builds on install</Badge>
                    ) : null}
                  </ItemTitle>
                  <ItemDescription>{catalogPlugin.description}</ItemDescription>
                  <ItemDescription>
                    {catalogPlugin.packageName} · v{catalogPlugin.version}
                  </ItemDescription>
                  <ItemDescription>{catalogPlugin.relativePath}</ItemDescription>
                  {!catalogPlugin.built && !installedPlugin ? (
                    <ItemDescription>
                      Paperclip will build this package automatically before installing it.
                    </ItemDescription>
                  ) : null}
                </ItemContent>
                <ItemActions>
                  {installedPlugin ? (
                    <Button variant="outline" size="sm" asChild>
                      <Link
                        to="/$companyId/company/settings/instance/plugins/$pluginId"
                        params={{
                          companyId,
                          pluginId: installedPlugin.id,
                        }}
                      >
                        {installedPlugin.status === "ready" ? "Configure" : "Review configuration"}
                      </Link>
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      aria-label={`Install ${catalogPlugin.displayName}`}
                      disabled={isInstallPending}
                      onClick={() => onInstall(catalogPlugin.packageName)}
                    >
                      {installPending
                        ? catalogPlugin.built
                          ? "Installing…"
                          : "Building and installing…"
                        : "Install"}
                    </Button>
                  )}
                </ItemActions>
              </Item>
            );
          })}
        </ItemGroup>
      )}
    </section>
  );
}
