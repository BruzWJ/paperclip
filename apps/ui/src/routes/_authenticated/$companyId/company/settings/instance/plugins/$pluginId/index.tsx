import { pluginsApi } from "@/api/plugins";
import type { JsonSchemaNode } from "./-json-schema/-JsonSchemaForm";
import { PluginConfigForm } from "@/routes/_authenticated/$companyId/company/settings/instance/plugins/$pluginId/-PluginConfigForm";
import { PluginLocalFoldersSettings } from "@/routes/_authenticated/$companyId/company/settings/instance/plugins/$pluginId/-PluginLocalFoldersSettings";
import { PluginRuntimeStatus } from "@/routes/_authenticated/$companyId/company/settings/instance/plugins/$pluginId/-PluginRuntimeStatus";
import { Badge } from "@/components/ui/badge";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSettingsBreadcrumbs } from "@/hooks/useSettingsBreadcrumbs";
import { queryKeys } from "@/lib/queryKeys";
import { PluginSlotMount, usePluginSlots } from "@/plugins/slots";
import { isCanonicalUuid } from "@paperclipai/shared";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, getRouteApi, Link, notFound } from "@tanstack/react-router";
import { ArrowLeft, Puzzle } from "lucide-react";
import { useEffect, useState } from "react";

export const Route = createFileRoute(
  "/_authenticated/$companyId/company/settings/instance/plugins/$pluginId/",
)({
  loader: ({ params }) => {
    if (!isCanonicalUuid(params.pluginId)) throw notFound();
  },
  component: PluginSettings,
});

/** Installed-plugin configuration and runtime diagnostics. */
function PluginSettings() {
  const { companyId, pluginId } = getRouteApi(
    "/_authenticated/$companyId/company/settings/instance/plugins/$pluginId/",
  ).useParams();
  const [activeTab, setActiveTab] = useState<"configuration" | "status">("configuration");

  const { data: plugin, isLoading: pluginLoading } = useQuery({
    queryKey: queryKeys.plugins.detail(pluginId!),
    queryFn: () => pluginsApi.get(pluginId!),
    enabled: !!pluginId,
  });

  const { data: dashboardData, isLoading: dashboardLoading } = useQuery({
    queryKey: queryKeys.plugins.dashboard(pluginId!),
    queryFn: () => pluginsApi.dashboard(pluginId!),
    enabled: !!pluginId,
    // Instance-admin diagnostics include companyId=null worker/log rows, so a
    // company-room live event cannot represent this projection without leaks.
    refetchInterval: 30_000,
  });

  const { data: recentLogs } = useQuery({
    queryKey: queryKeys.plugins.logs(pluginId!),
    queryFn: () => pluginsApi.logs(pluginId!, { limit: 50 }),
    enabled: !!pluginId && plugin?.status === "ready",
    refetchInterval: 30_000,
  });

  // Fetch existing config for the plugin
  const configSchema = plugin?.manifestJson?.instanceConfigSchema as JsonSchemaNode | undefined;
  const hasConfigSchema =
    configSchema && configSchema.properties && Object.keys(configSchema.properties).length > 0;

  const configQueryKey = pluginId
    ? queryKeys.plugins.config(pluginId)
    : (["plugins", "__missing_plugin__", "config"] as const);

  const { data: configData, isLoading: configLoading } = useQuery({
    queryKey: configQueryKey,
    queryFn: () => pluginsApi.getConfig(pluginId!),
    enabled: !!pluginId && !!hasConfigSchema,
  });

  const { slots } = usePluginSlots({
    slotTypes: ["settingsPage"],
    enabled: !!pluginId,
  });

  // Filter slots to only show settings pages for this specific plugin
  const pluginSlots = slots.filter((slot) => slot.pluginId === pluginId);

  // If the plugin has a custom settingsPage slot, prefer that over auto-generated form
  const hasCustomSettingsPage = pluginSlots.length > 0;

  useSettingsBreadcrumbs({
    companyId,
    instance: true,
    parent: "plugins",
    page: plugin ? plugin.manifestJson.displayName : "Plugin Details",
  });

  useEffect(() => {
    setActiveTab("configuration");
  }, [pluginId]);

  if (pluginLoading) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Spinner /> Loading plugin details...
      </div>
    );
  }

  if (!plugin) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Plugin not found</EmptyTitle>
          <EmptyDescription>This plugin is not installed on the instance.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const displayStatus = plugin.status;
  const pluginDescription = plugin.manifestJson.description;
  const pluginCapabilities = plugin.manifestJson.capabilities;
  const localFolderDeclarations = plugin.manifestJson.localFolders ?? [];
  const hasLocalFolders = localFolderDeclarations.length > 0;

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center gap-4">
        <Button variant="outline" size="icon-sm" asChild aria-label="Back to plugins">
          <Link
            to="/$companyId/company/settings/instance/plugins"
            params={{ companyId }}
            aria-label="Back to plugins"
          >
            <ArrowLeft className="h-4 w-4"  data-icon="inline-start"/>
          </Link>
        </Button>
        <div className="flex items-center gap-2">
          <Puzzle className="h-6 w-6 text-muted-foreground"  data-icon="inline-start"/>
          <h1 className="text-xl font-semibold">{plugin.manifestJson.displayName}</h1>
          <DomainStatus status={displayStatus} className="ml-2">
            {displayStatus}
          </DomainStatus>
          <Badge variant="outline" className="ml-1">
            v{plugin.manifestJson.version}
          </Badge>
        </div>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as "configuration" | "status")}
        className="space-y-6"
      >
        <TabsList variant="line" className="justify-start">
          <TabsTrigger value="configuration">Configuration</TabsTrigger>
          <TabsTrigger value="status">Status</TabsTrigger>
        </TabsList>

        <TabsContent value="configuration" className="space-y-6">
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>About</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-8 lg:grid-cols-(--gtc-52)">
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-muted-foreground">Description</h3>
                  <p className="text-sm leading-6 text-foreground/90">{pluginDescription}</p>
                </div>
                <div className="space-y-4 text-sm">
                  <div className="space-y-1.5">
                    <h3 className="font-medium text-muted-foreground">Author</h3>
                    <p className="text-foreground">{plugin.manifestJson.author}</p>
                  </div>
                  <div className="space-y-2">
                    <h3 className="font-medium text-muted-foreground">Categories</h3>
                    <div className="flex flex-wrap gap-2">
                      {plugin.manifestJson.categories.length > 0 ? (
                        plugin.manifestJson.categories.map((category) => (
                          <Badge key={category} variant="outline" className="capitalize">
                            {category}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-foreground">None</span>
                      )}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Settings</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {hasLocalFolders ? (
                  <PluginLocalFoldersSettings
                    pluginId={pluginId!}
                    companyId={companyId}
                    declarations={localFolderDeclarations}
                  />
                ) : null}
                {hasCustomSettingsPage ? (
                  <div className="space-y-3">
                    {pluginSlots.map((slot) => (
                      <PluginSlotMount
                        key={`${slot.pluginKey}:${slot.id}`}
                        slot={slot}
                        context={{
                          companyId: null,
                        }}
                        missingBehavior="placeholder"
                      />
                    ))}
                  </div>
                ) : hasConfigSchema ? (
                  <PluginConfigForm
                    pluginId={pluginId!}
                    schema={configSchema!}
                    initialValues={configData?.configJson}
                    isLoading={configLoading}
                    pluginStatus={plugin.status}
                    supportsConfigTest={plugin.supportsConfigTest}
                  />
                ) : !hasLocalFolders ? (
                  <Empty>
                    <EmptyHeader>
                      <EmptyTitle>No settings required</EmptyTitle>
                      <EmptyDescription>This plugin works without additional configuration.</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : null}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="status" className="space-y-6">
          <PluginRuntimeStatus
            dashboardData={dashboardData}
            dashboardLoading={dashboardLoading}
            recentLogs={recentLogs}
            plugin={plugin}
            displayStatus={displayStatus}
            pluginCapabilities={pluginCapabilities}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
