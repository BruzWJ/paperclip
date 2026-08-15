import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import type { PluginRecordDto } from "@paperclipai/shared";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Power, Puzzle, Settings, Trash } from "lucide-react";
export function InstalledPluginsSection({
  companyId,
  installedPlugins,
  isInstanceAdmin,
  errorSummaryByPluginId,
  lifecyclePending,
  uninstallPending,
  onToggle,
  onUninstall,
  onShowError,
}: {
  companyId: string;
  installedPlugins: PluginRecordDto[];
  isInstanceAdmin: boolean;
  errorSummaryByPluginId: Map<string, string>;
  lifecyclePending: boolean;
  uninstallPending: boolean;
  onToggle: (plugin: PluginRecordDto) => void;
  onUninstall: (plugin: PluginRecordDto) => void;
  onShowError: (plugin: PluginRecordDto) => void;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Puzzle className="h-5 w-5 text-muted-foreground"  data-icon="inline-start"/>
        <h2 className="text-base font-semibold">Installed Plugins</h2>
      </div>

      {!installedPlugins.length ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Puzzle  data-icon="inline-start"/>
            </EmptyMedia>
            <EmptyTitle>No plugins installed</EmptyTitle>
            <EmptyDescription>
              {isInstanceAdmin
                ? "Install a plugin to extend functionality."
                : "No plugins are installed on this instance."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup>
          {installedPlugins.map((plugin) => (
            <Item key={plugin.id} variant="outline">
              <ItemContent>
                <ItemTitle>
                  {isInstanceAdmin ? (
                    <Link
                      to="/$companyId/company/settings/instance/plugins/$pluginId"
                      params={{ companyId, pluginId: plugin.id }}
                      className="block truncate font-medium hover:underline"
                      title={plugin.manifestJson.displayName}
                    >
                      {plugin.manifestJson.displayName}
                    </Link>
                  ) : (
                    <span className="block truncate font-medium" title={plugin.manifestJson.displayName}>
                      {plugin.manifestJson.displayName}
                    </span>
                  )}
                </ItemTitle>
                <ItemDescription title={plugin.packageName}>
                  {plugin.packageName} · v{plugin.manifestJson.version}
                </ItemDescription>
                <ItemDescription title={plugin.manifestJson.description}>
                  {plugin.manifestJson.description}
                </ItemDescription>
                {plugin.status === "error" && (
                  <Alert variant="destructive">
                    <AlertTriangle aria-hidden  data-icon="inline-start"/>
                    <AlertTitle>Plugin error</AlertTitle>
                    <AlertDescription title={plugin.lastError ?? undefined}>
                      {errorSummaryByPluginId.get(plugin.id)}
                    </AlertDescription>
                    <Button variant="outline" size="sm" onClick={() => onShowError(plugin)}>
                      View full error
                    </Button>
                  </Alert>
                )}
              </ItemContent>
              <ItemActions className="flex-col items-end">
                <div className="flex items-center gap-2">
                  <DomainStatus status={plugin.status}>{plugin.status}</DomainStatus>
                  {isInstanceAdmin ? (
                    <>
                      <Button
                        variant="outline"
                        size="icon-sm"
                        className="h-8 w-8"
                        title={plugin.status === "ready" ? "Disable" : "Enable"}
                        onClick={() => onToggle(plugin)}
                        disabled={lifecyclePending}
                      >
                        <Power className="size-4"  data-icon="inline-start"/>
                      </Button>
                      <Button
                        variant="outline"
                        size="icon-sm"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        title="Uninstall"
                        onClick={() => onUninstall(plugin)}
                        disabled={uninstallPending}
                      >
                        <Trash className="h-4 w-4"  data-icon="inline-start"/>
                      </Button>
                    </>
                  ) : null}
                </div>
                {isInstanceAdmin ? (
                  <Button variant="outline" size="sm" className="mt-2 h-8" asChild>
                    <Link
                      to="/$companyId/company/settings/instance/plugins/$pluginId"
                      params={{ companyId, pluginId: plugin.id }}
                    >
                      <Settings data-icon="inline-start" className="h-4 w-4" />
                      Configure
                    </Link>
                  </Button>
                ) : null}
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      )}
    </section>
  );
}
