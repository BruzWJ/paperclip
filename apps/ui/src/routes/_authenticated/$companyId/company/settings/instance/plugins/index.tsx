import { accessApi } from "@/api/access";
import { pluginsApi } from "@/api/plugins";
import { InstalledPluginsSection } from "@/routes/_authenticated/$companyId/company/settings/instance/plugins/-InstalledPluginsSection";
import { PluginCatalogSection } from "@/routes/_authenticated/$companyId/company/settings/instance/plugins/-PluginCatalogSection";
import { CodeBlockPanel } from "@/components/patterns/CodeBlockPanel";
import { ConfirmActionDialog } from "@/components/patterns/ConfirmActionDialog";
import { FormDialog, LabeledFormField } from "@/components/patterns/FormPatterns";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useSettingsBreadcrumbs } from "@/hooks/useSettingsBreadcrumbs";
import { toast } from "sonner";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { useCurrentUserId } from "@/hooks/useCurrentUserId";
import { queryKeys } from "@/lib/queryKeys";
import type { PluginInstallRequest, PluginRecordDto } from "@paperclipai/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AlertTriangle, Plus, Puzzle } from "lucide-react";
import { useMemo, useState } from "react";

export const Route = createFileRoute("/_authenticated/$companyId/company/settings/instance/plugins/")({
  component: PluginManager,
});

function getPluginErrorSummary(plugin: PluginRecordDto): string {
  return (
    plugin.lastError
      ?.split(/\r?\n/)
      .map((entry) => entry.trim())
      .find(Boolean) ?? "Plugin entered an error state without a stored error message."
  );
}

/** Manage installed plugins, catalog installation, and lifecycle actions. */
function PluginManager() {
  const currentUserId = useCurrentUserId();
  const companyId = useCompanyRouteId();
  const queryClient = useQueryClient();

  const [installPackage, setInstallPackage] = useState("");
  const [installDialogOpen, setInstallDialogOpen] = useState(false);
  const [uninstallPluginId, setUninstallPluginId] = useState<string | null>(null);
  const [uninstallPluginName, setUninstallPluginName] = useState<string>("");
  const [errorDetailsPlugin, setErrorDetailsPlugin] = useState<PluginRecordDto | null>(null);

  useSettingsBreadcrumbs({
    companyId,
    instance: true,
    page: "Plugins",
  });

  const boardAccessQuery = useQuery({
    queryKey: currentUserId
      ? queryKeys.access.currentBoardAccess(currentUserId)
      : (["access", "current-board-access", null] as const),
    queryFn: () => accessApi.getCurrentBoardAccess(currentUserId!),
    enabled: Boolean(currentUserId),
    retry: false,
  });
  const isInstanceAdmin = boardAccessQuery.data?.isInstanceAdmin === true;

  const {
    data: plugins,
    isLoading,
    error,
  } = useQuery({
    queryKey: queryKeys.plugins.all,
    queryFn: () => pluginsApi.list(),
  });

  const catalogQuery = useQuery({
    queryKey: queryKeys.plugins.catalog,
    queryFn: () => pluginsApi.listCatalog(),
    enabled: isInstanceAdmin,
    retry: false,
  });

  const invalidatePluginQueries = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.plugins.all }),
      queryClient.invalidateQueries({ queryKey: queryKeys.plugins.catalog }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.plugins.uiContributions,
      }),
    ]);

  const installMutation = useMutation({
    mutationFn: (params: PluginInstallRequest) => pluginsApi.install(params),
    onSuccess: async () => {
      await invalidatePluginQueries();
      setInstallDialogOpen(false);
      setInstallPackage("");
      toast.success("Plugin installed successfully");
    },
    onError: (err: Error) => {
      toast.error("Failed to install plugin", { description: err.message });
    },
  });

  const catalogInstallMutation = useMutation({
    mutationFn: (packageName: string) => pluginsApi.installCatalog(packageName),
    onSuccess: async () => {
      await invalidatePluginQueries();
      toast.success("Plugin installed successfully");
    },
    onError: (err: Error) => {
      toast.error("Failed to install plugin", { description: err.message });
    },
  });

  const uninstallMutation = useMutation({
    mutationFn: (pluginId: string) => pluginsApi.uninstall(pluginId),
    onSuccess: async () => {
      await invalidatePluginQueries();
      toast.success("Plugin uninstalled successfully");
    },
    onError: (err: Error) => {
      toast.error("Failed to uninstall plugin", { description: err.message });
    },
  });

  const lifecycleMutation = useMutation({
    mutationFn: ({ pluginId, enable }: { pluginId: string; enable: boolean }) =>
      enable ? pluginsApi.enable(pluginId) : pluginsApi.disable(pluginId),
    onSuccess: async (_, { enable }) => {
      await invalidatePluginQueries();
      if (enable) toast.success("Plugin enabled");
      else toast.info("Plugin disabled");
    },
    onError: (err: Error, { enable }) => {
      toast.error(`Failed to ${enable ? "enable" : "disable"} plugin`, {
        description: err.message,
      });
    },
  });

  const installedPlugins = plugins ?? [];
  const catalogPlugins = catalogQuery.data ?? [];
  const installedByPackageName = useMemo(
    () => new Map(installedPlugins.map((plugin) => [plugin.packageName, plugin])),
    [installedPlugins],
  );
  const catalogEntryBeingInstalled = useMemo(
    () => catalogPlugins.find((entry) => entry.packageName === catalogInstallMutation.variables) ?? null,
    [catalogInstallMutation.variables, catalogPlugins],
  );
  const errorSummaryByPluginId = useMemo(
    () => new Map(installedPlugins.map((plugin) => [plugin.id, getPluginErrorSummary(plugin)])),
    [installedPlugins],
  );
  const pluginActionStatus = catalogInstallMutation.isPending
    ? catalogEntryBeingInstalled?.built === false
      ? `Building and installing ${catalogEntryBeingInstalled.displayName}…`
      : `Installing ${catalogEntryBeingInstalled?.displayName ?? "plugin"}…`
    : installMutation.isPending
      ? "Installing plugin…"
      : uninstallMutation.isPending
        ? "Uninstalling plugin…"
        : lifecycleMutation.isPending
          ? `${lifecycleMutation.variables?.enable ? "Enabling" : "Disabling"} plugin…`
          : null;

  if (isLoading)
    return (
      <div className="flex items-center gap-2 p-4" role="status">
        <Spinner />
        <span>Loading plugins...</span>
      </div>
    );
  if (error)
    return (
      <Alert variant="destructive">
        <AlertDescription>Failed to load plugins.</AlertDescription>
      </Alert>
    );

  return (
    <div className="max-w-5xl space-y-6">
      {pluginActionStatus ? (
        <p className="sr-only" role="status">
          {pluginActionStatus}
        </p>
      ) : null}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Puzzle className="h-6 w-6 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Plugin Manager</h1>
        </div>

        {isInstanceAdmin ? (
          <FormDialog
            open={installDialogOpen}
            onOpenChange={setInstallDialogOpen}
            title="Install Plugin"
            description="Enter the npm package name of the plugin you wish to install."
            triggerAsChild
            trigger={
              <Button size="sm" className="gap-2">
                <Plus data-icon="inline-start" className="h-4 w-4" />
                Install Plugin
              </Button>
            }
            footer={
              <>
                <Button variant="outline" onClick={() => setInstallDialogOpen(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={() =>
                    installMutation.mutate({
                      source: "npm",
                      packageName: installPackage,
                    })
                  }
                  disabled={installPackage.length === 0 || installMutation.isPending}
                >
                  {installMutation.isPending ? "Installing..." : "Install"}
                </Button>
              </>
            }
          >
            <div className="py-4">
              <LabeledFormField label="npm Package Name" labelFor="packageName">
                <Input
                  id="packageName"
                  placeholder="@paperclipai/plugin-example"
                  value={installPackage}
                  onChange={(e) => setInstallPackage(e.target.value)}
                />
              </LabeledFormField>
            </div>
          </FormDialog>
        ) : null}
      </div>

      <Alert>
        <AlertTriangle />
        <AlertTitle>Plugins are alpha.</AlertTitle>
        <AlertDescription>
          The plugin runtime and API surface are still changing. Expect breaking changes while this feature
          settles.
        </AlertDescription>
      </Alert>

      {boardAccessQuery.error ? (
        <Alert variant="destructive">
          <AlertDescription>
            Instance-admin access could not be verified. Plugin management actions are unavailable.
          </AlertDescription>
        </Alert>
      ) : boardAccessQuery.isSuccess && !isInstanceAdmin ? (
        <Alert>
          <AlertDescription>
            Plugin installation and lifecycle controls are available only to instance admins.
          </AlertDescription>
        </Alert>
      ) : null}

      {isInstanceAdmin ? (
        <PluginCatalogSection
          companyId={companyId}
          catalogPlugins={catalogPlugins}
          installedByPackageName={installedByPackageName}
          isLoading={catalogQuery.isLoading}
          loadError={catalogQuery.error}
          installError={catalogInstallMutation.error}
          isInstallPending={catalogInstallMutation.isPending}
          installingPackage={catalogInstallMutation.variables}
          onInstall={(packageName) => catalogInstallMutation.mutate(packageName)}
        />
      ) : null}

      <InstalledPluginsSection
        companyId={companyId}
        installedPlugins={installedPlugins}
        isInstanceAdmin={isInstanceAdmin}
        errorSummaryByPluginId={errorSummaryByPluginId}
        lifecyclePending={lifecycleMutation.isPending}
        uninstallPending={uninstallMutation.isPending}
        onToggle={(plugin) =>
          lifecycleMutation.mutate({
            pluginId: plugin.id,
            enable: plugin.status !== "ready",
          })
        }
        onUninstall={(plugin) => {
          setUninstallPluginId(plugin.id);
          setUninstallPluginName(plugin.manifestJson.displayName);
        }}
        onShowError={setErrorDetailsPlugin}
      />

      {isInstanceAdmin ? (
        <ConfirmActionDialog
          open={uninstallPluginId !== null}
          onOpenChange={(open) => {
            if (!open) setUninstallPluginId(null);
          }}
          title="Uninstall Plugin"
          description={
            <>
              Are you sure you want to uninstall <strong>{uninstallPluginName}</strong>? This action cannot be
              undone.
            </>
          }
          confirmLabel="Uninstall"
          pendingLabel="Uninstalling..."
          variant="destructive"
          disabled={!uninstallPluginId}
          pending={uninstallMutation.isPending}
          onConfirm={() => {
            if (uninstallPluginId) {
              uninstallMutation.mutate(uninstallPluginId, {
                onSettled: () => setUninstallPluginId(null),
              });
            }
          }}
        />
      ) : null}

      <FormDialog
        open={errorDetailsPlugin !== null}
        onOpenChange={(open) => !open && setErrorDetailsPlugin(null)}
        contentClassName="sm:max-w-2xl"
        title="Error Details"
        description={`${errorDetailsPlugin?.manifestJson.displayName ?? "Plugin"} hit an error state.`}
        footer={
          <Button variant="outline" onClick={() => setErrorDetailsPlugin(null)}>
            Close
          </Button>
        }
      >
        <div className="space-y-4">
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>What errored</AlertTitle>
            <AlertDescription className="break-words">
              {errorDetailsPlugin ? getPluginErrorSummary(errorDetailsPlugin) : "No error summary available."}
            </AlertDescription>
          </Alert>
          <div className="space-y-2">
            <p className="text-sm font-medium">Full error output</p>
            <CodeBlockPanel
              bodyClassName="max-h-(--sz-50vh)"
              code={errorDetailsPlugin?.lastError ?? "No stored error message."}
              filename="plugin-error.txt"
              syntaxHighlighting={false}
            />
          </div>
        </div>
      </FormDialog>
    </div>
  );
}
