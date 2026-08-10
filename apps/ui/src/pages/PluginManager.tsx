/**
 * @fileoverview Plugin Manager page — admin UI for discovering checkout-local
 * plugins and managing installed plugins.
 *
 * @see PLUGIN_SPEC.md §9 — Plugin Marketplace / Manager
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  PluginCatalogEntryDto,
  PluginInstallRequest,
  PluginRecordDto,
} from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { AlertTriangle, Plus, Power, Puzzle, Settings, Trash } from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { accessApi } from "@/api/access";
import { pluginsApi } from "@/api/plugins";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useToastActions } from "@/context/ToastContext";
import { cn } from "@/lib/utils";

function firstNonEmptyLine(value: string | null | undefined): string | null {
  if (!value) return null;
  const line = value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
  return line ?? null;
}

function getPluginErrorSummary(plugin: PluginRecordDto): string {
  return firstNonEmptyLine(plugin.lastError) ?? "Plugin entered an error state without a stored error message.";
}

function getCatalogKindLabel(kind: PluginCatalogEntryDto["kind"]): string {
  return kind === "first_party" ? "First-party" : "Example";
}

/**
 * PluginManager page component.
 *
 * Provides a management UI for the Paperclip plugin system:
 * - Lists repository-local plugins available to instance administrators.
 * - Lists all installed plugins with their status, version, and category badges.
 * - Allows installing new plugins by npm package name.
 * - Provides instance-admin actions: enable, disable, and navigate to settings.
 * - Uninstall with a two-step confirmation dialog to prevent accidental removal.
 *
 * Data flow:
 * - Reads from `GET /api/plugins` via `pluginsApi.list()`.
 * - Instance administrators read `GET /api/plugins/catalog` and can install a
 *   recognized entry through `POST /api/plugins/catalog/install`.
 * - Mutations (install / uninstall / enable / disable) invalidate
 *   `queryKeys.plugins.all` so the list refreshes automatically.
 *
 * @see PluginSettings — linked from the Settings icon on each plugin row.
 * @see doc/plugins/PLUGIN_SPEC.md §3 — Plugin Lifecycle for status semantics.
 */
export function PluginManager() {
  const { selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();

  const [installPackage, setInstallPackage] = useState("");
  const [installDialogOpen, setInstallDialogOpen] = useState(false);
  const [uninstallPluginId, setUninstallPluginId] = useState<string | null>(null);
  const [uninstallPluginName, setUninstallPluginName] = useState<string>("");
  const [errorDetailsPlugin, setErrorDetailsPlugin] = useState<PluginRecordDto | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "Instance settings", href: "/company/settings/instance/general" },
      { label: "Plugins" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const boardAccessQuery = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
  });
  const isInstanceAdmin = boardAccessQuery.data?.isInstanceAdmin === true;

  const { data: plugins, isLoading, error } = useQuery({
    queryKey: queryKeys.plugins.all,
    queryFn: () => pluginsApi.list(),
  });

  const catalogQuery = useQuery({
    queryKey: queryKeys.plugins.catalog,
    queryFn: () => pluginsApi.listCatalog(),
    enabled: isInstanceAdmin,
    retry: false,
  });

  const invalidatePluginQueries = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.plugins.all }),
    queryClient.invalidateQueries({ queryKey: queryKeys.plugins.catalog }),
    queryClient.invalidateQueries({ queryKey: queryKeys.plugins.uiContributions }),
  ]);

  const installMutation = useMutation({
    mutationFn: (params: PluginInstallRequest) => pluginsApi.install(params),
    onSuccess: async () => {
      await invalidatePluginQueries();
      setInstallDialogOpen(false);
      setInstallPackage("");
      pushToast({ title: "Plugin installed successfully", tone: "success" });
    },
    onError: (err: Error) => {
      pushToast({ title: "Failed to install plugin", body: err.message, tone: "error" });
    },
  });

  const catalogInstallMutation = useMutation({
    mutationFn: (packageName: string) => pluginsApi.installCatalog(packageName),
    onSuccess: async () => {
      await invalidatePluginQueries();
      pushToast({ title: "Plugin installed successfully", tone: "success" });
    },
    onError: (err: Error) => {
      pushToast({ title: "Failed to install plugin", body: err.message, tone: "error" });
    },
  });

  const uninstallMutation = useMutation({
    mutationFn: (pluginId: string) => pluginsApi.uninstall(pluginId),
    onSuccess: async () => {
      await invalidatePluginQueries();
      pushToast({ title: "Plugin uninstalled successfully", tone: "success" });
    },
    onError: (err: Error) => {
      pushToast({ title: "Failed to uninstall plugin", body: err.message, tone: "error" });
    },
  });

  const enableMutation = useMutation({
    mutationFn: (pluginId: string) => pluginsApi.enable(pluginId),
    onSuccess: async () => {
      await invalidatePluginQueries();
      pushToast({ title: "Plugin enabled", tone: "success" });
    },
    onError: (err: Error) => {
      pushToast({ title: "Failed to enable plugin", body: err.message, tone: "error" });
    },
  });

  const disableMutation = useMutation({
    mutationFn: (pluginId: string) => pluginsApi.disable(pluginId),
    onSuccess: async () => {
      await invalidatePluginQueries();
      pushToast({ title: "Plugin disabled", tone: "info" });
    },
    onError: (err: Error) => {
      pushToast({ title: "Failed to disable plugin", body: err.message, tone: "error" });
    },
  });

  const installedPlugins = plugins ?? [];
  const catalogPlugins = catalogQuery.data ?? [];
  const installedByPackageName = useMemo(
    () => new Map(installedPlugins.map((plugin) => [plugin.packageName, plugin])),
    [installedPlugins],
  );
  const catalogEntryBeingInstalled = useMemo(
    () =>
      catalogPlugins.find(
        (entry) => entry.packageName === catalogInstallMutation.variables,
      ) ?? null,
    [catalogInstallMutation.variables, catalogPlugins],
  );
  const errorSummaryByPluginId = useMemo(
    () =>
      new Map(
        installedPlugins.map((plugin) => [plugin.id, getPluginErrorSummary(plugin)])
      ),
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
        : enableMutation.isPending
          ? "Enabling plugin…"
          : disableMutation.isPending
            ? "Disabling plugin…"
            : null;

  if (isLoading) return <div className="p-4 text-sm text-muted-foreground" role="status">Loading plugins...</div>;
  if (error) return <div className="p-4 text-sm text-destructive" role="alert">Failed to load plugins.</div>;

  return (
    <div className="max-w-5xl space-y-6">
      {pluginActionStatus ? <p className="sr-only" role="status">{pluginActionStatus}</p> : null}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Puzzle className="h-6 w-6 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Plugin Manager</h1>
        </div>

        {isInstanceAdmin ? (
          <Dialog open={installDialogOpen} onOpenChange={setInstallDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm" className="gap-2">
                <Plus data-icon="inline-start" className="h-4 w-4" />
                Install Plugin
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Install Plugin</DialogTitle>
                <DialogDescription>
                  Enter the npm package name of the plugin you wish to install.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-4 py-4">
                <div className="grid gap-2">
                  <Label htmlFor="packageName">npm Package Name</Label>
                  <Input
                    id="packageName"
                    placeholder="@paperclipai/plugin-example"
                    value={installPackage}
                    onChange={(e) => setInstallPackage(e.target.value)}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setInstallDialogOpen(false)}>Cancel</Button>
                <Button
                  onClick={() =>
                    installMutation.mutate({
                      source: "npm",
                      packageName: installPackage.trim(),
                    })
                  }
                  disabled={!installPackage.trim() || installMutation.isPending}
                >
                  {installMutation.isPending ? "Installing..." : "Install"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : null}
      </div>

      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
          <div className="space-y-1 text-sm">
            <p className="font-medium text-foreground">Plugins are alpha.</p>
            <p className="text-muted-foreground">
              The plugin runtime and API surface are still changing. Expect breaking changes while this feature settles.
            </p>
          </div>
        </div>
      </div>

      {boardAccessQuery.error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive" role="alert">
          Instance-admin access could not be verified. Plugin management actions are unavailable.
        </div>
      ) : boardAccessQuery.isSuccess && !isInstanceAdmin ? (
        <div className="rounded-lg border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          Plugin installation and lifecycle controls are available only to instance admins.
        </div>
      ) : null}

      {isInstanceAdmin ? (
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <Puzzle className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-base font-semibold">Available Plugins</h2>
            <Badge variant="outline">Local catalog</Badge>
          </div>

          {catalogInstallMutation.error ? (
            <div
              className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
              role="alert"
            >
              {catalogInstallMutation.error.message}
            </div>
          ) : null}

          {catalogQuery.isLoading ? (
            <div className="text-sm text-muted-foreground" role="status">
              Loading available plugins…
            </div>
          ) : catalogQuery.error ? (
            <div className="text-sm text-destructive" role="alert">
              Failed to load available plugins.
            </div>
          ) : catalogPlugins.length === 0 ? (
            <div className="rounded-md border border-dashed px-4 py-3 text-sm text-muted-foreground">
              No local plugins are available in this installation.
            </div>
          ) : (
            <Card className="block py-0">
              <ul className="divide-y">
                {catalogPlugins.map((catalogPlugin) => {
                  const installedPlugin = installedByPackageName.get(catalogPlugin.packageName);
                  const installPending = catalogInstallMutation.isPending
                    && catalogInstallMutation.variables === catalogPlugin.packageName;

                  return (
                    <li key={catalogPlugin.packageName}>
                      <div className="flex items-center gap-4 px-4 py-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{catalogPlugin.displayName}</span>
                            <Badge variant="outline">
                              {getCatalogKindLabel(catalogPlugin.kind)}
                            </Badge>
                            {installedPlugin ? (
                              <Badge
                                variant={
                                  installedPlugin.status === "ready"
                                    ? "default"
                                    : installedPlugin.status === "error"
                                      ? "destructive"
                                      : "secondary"
                                }
                              >
                                {installedPlugin.status}
                              </Badge>
                            ) : (
                              <Badge variant="secondary">Available</Badge>
                            )}
                            {!catalogPlugin.built && !installedPlugin ? (
                              <Badge variant="outline">Builds on install</Badge>
                            ) : null}
                          </div>
                          <p className="mt-1 text-sm text-muted-foreground">
                            {catalogPlugin.description}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {catalogPlugin.packageName} · v{catalogPlugin.version}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {catalogPlugin.relativePath}
                          </p>
                          {!catalogPlugin.built && !installedPlugin ? (
                            <p className="mt-2 text-xs text-muted-foreground">
                              Paperclip will build this package automatically before installing it.
                            </p>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {installedPlugin ? (
                            <Button variant="outline" size="sm" asChild>
                              <Link to={`/company/settings/instance/plugins/${installedPlugin.id}`}>
                                {installedPlugin.status === "ready" ? "Configure" : "Review configuration"}
                              </Link>
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              aria-label={`Install ${catalogPlugin.displayName}`}
                              disabled={catalogInstallMutation.isPending}
                              onClick={() => catalogInstallMutation.mutate(catalogPlugin.packageName)}
                            >
                              {installPending
                                ? catalogPlugin.built
                                  ? "Installing…"
                                  : "Building and installing…"
                                : "Install"}
                            </Button>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </section>
      ) : null}

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Puzzle className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-base font-semibold">Installed Plugins</h2>
        </div>

        {!installedPlugins.length ? (
          <Card className="bg-muted/30">
            <CardContent className="flex flex-col items-center justify-center py-10">
              <Puzzle className="h-10 w-10 text-muted-foreground mb-4" />
              <p className="text-sm font-medium">No plugins installed</p>
              <p className="text-xs text-muted-foreground mt-1">
                {isInstanceAdmin
                  ? "Install a plugin to extend functionality."
                  : "No plugins are installed on this instance."}
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card className="block py-0">
            <ul className="divide-y">
              {installedPlugins.map((plugin) => (
                <li key={plugin.id}>
                  <div className="flex items-start gap-4 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {isInstanceAdmin ? (
                          <Link
                            to={`/company/settings/instance/plugins/${plugin.id}`}
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
                      </div>
                      <div>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground" title={plugin.packageName}>
                          {plugin.packageName} · v{plugin.manifestJson.version}
                        </p>
                      </div>
                      <p className="mt-0.5 truncate text-sm text-muted-foreground" title={plugin.manifestJson.description}>
                        {plugin.manifestJson.description}
                      </p>
                      {plugin.status === "error" && (
                        <div className="mt-3 rounded-md border border-red-500/25 bg-red-500/[0.06] px-3 py-2" role="alert">
                          <div className="flex flex-wrap items-start gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 text-sm font-medium text-red-700 dark:text-red-300">
                                <AlertTriangle className="h-4 w-4 shrink-0" />
                                <span>Plugin error</span>
                              </div>
                              <p
                                className="mt-1 break-words text-sm text-red-700/90 dark:text-red-200/90"
                                title={plugin.lastError ?? undefined}
                              >
                                {errorSummaryByPluginId.get(plugin.id)}
                              </p>
                            </div>
                            <Button
                              variant="outline"
                              size="sm"
                              className="border-red-500/30 bg-background/60 text-red-700 hover:bg-red-500/10 hover:text-red-800 dark:text-red-200 dark:hover:text-red-100"
                              onClick={() => setErrorDetailsPlugin(plugin)}
                            >
                              View full error
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 self-center">
                      <div className="flex flex-col items-end gap-2">
                        <div className="flex items-center gap-2">
                          <Badge
                            variant={
                              plugin.status === "ready"
                                ? "default"
                                : plugin.status === "error"
                                  ? "destructive"
                                  : "secondary"
                            }
                            className={cn(
                              "shrink-0",
                              plugin.status === "ready" ? "bg-green-600 hover:bg-green-700" : ""
                            )}
                          >
                            {plugin.status}
                          </Badge>
                          {isInstanceAdmin ? (
                            <>
                              <Button
                                variant="outline"
                                size="icon-sm"
                                className="h-8 w-8"
                                title={plugin.status === "ready" ? "Disable" : "Enable"}
                                onClick={() => {
                                  if (plugin.status === "ready") {
                                    disableMutation.mutate(plugin.id);
                                  } else {
                                    enableMutation.mutate(plugin.id);
                                  }
                                }}
                                disabled={enableMutation.isPending || disableMutation.isPending}
                              >
                                <Power className={cn("h-4 w-4", plugin.status === "ready" ? "text-green-600" : "")} />
                              </Button>
                              <Button
                                variant="outline"
                                size="icon-sm"
                                className="h-8 w-8 text-destructive hover:text-destructive"
                                title="Uninstall"
                                onClick={() => {
                                  setUninstallPluginId(plugin.id);
                                  setUninstallPluginName(plugin.manifestJson.displayName);
                                }}
                                disabled={uninstallMutation.isPending}
                              >
                                <Trash className="h-4 w-4" />
                              </Button>
                            </>
                          ) : null}
                        </div>
                        {isInstanceAdmin ? (
                          <Button variant="outline" size="sm" className="mt-2 h-8" asChild>
                            <Link to={`/company/settings/instance/plugins/${plugin.id}`}>
                              <Settings data-icon="inline-start" className="h-4 w-4" />
                              Configure
                            </Link>
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>

      {isInstanceAdmin ? (
        <Dialog
          open={uninstallPluginId !== null}
          onOpenChange={(open) => { if (!open) setUninstallPluginId(null); }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Uninstall Plugin</DialogTitle>
              <DialogDescription>
                Are you sure you want to uninstall <strong>{uninstallPluginName}</strong>? This action cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setUninstallPluginId(null)}>Cancel</Button>
              <Button
                variant="destructive"
                disabled={uninstallMutation.isPending}
                onClick={() => {
                  if (uninstallPluginId) {
                    uninstallMutation.mutate(uninstallPluginId, {
                      onSettled: () => setUninstallPluginId(null),
                    });
                  }
                }}
              >
                {uninstallMutation.isPending ? "Uninstalling..." : "Uninstall"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      <Dialog
        open={errorDetailsPlugin !== null}
        onOpenChange={(open) => { if (!open) setErrorDetailsPlugin(null); }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Error Details</DialogTitle>
            <DialogDescription>
              {errorDetailsPlugin?.manifestJson.displayName ?? "Plugin"} hit an error state.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-md border border-red-500/25 bg-red-500/[0.06] px-4 py-3">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-700 dark:text-red-300" />
                <div className="space-y-1 text-sm">
                  <p className="font-medium text-red-700 dark:text-red-300">
                    What errored
                  </p>
                  <p className="text-red-700/90 dark:text-red-200/90 break-words">
                    {errorDetailsPlugin ? getPluginErrorSummary(errorDetailsPlugin) : "No error summary available."}
                  </p>
                </div>
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium">Full error output</p>
              <pre className="max-h-(--sz-50vh) overflow-auto rounded-md border bg-muted/40 p-3 text-xs leading-5 whitespace-pre-wrap break-words">
                {errorDetailsPlugin?.lastError ?? "No stored error message."}
              </pre>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setErrorDetailsPlugin(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
