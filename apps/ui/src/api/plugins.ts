/**
 * @fileoverview Frontend API client for the Paperclip plugin system.
 *
 * All functions in `pluginsApi` map 1:1 to REST endpoints on
 * `apps/server/src/routes/plugins.ts`. Call sites should consume these functions
 * through React Query query hooks and their mutation counterparts, and
 * reference cache keys from `queryKeys.plugins.*`. Interactive mutation
 * triggers must use pending state to prevent duplicate requests and visibly
 * describe work in progress.
 *
 * @see apps/ui/src/lib/queryKeys.ts for cache key definitions.
 * @see apps/server/src/routes/plugins.ts for endpoint implementation details.
 */

import type {
  PluginLauncherRenderContextSnapshot,
  PluginCatalogEntryDto,
  PluginLocalFolderProblem,
  PluginLocalFolderStatus,
  PluginRecordDto,
  PluginDetailDto,
  PluginUiContribution,
  PluginDashboardData,
  PluginConfigDto,
  PluginInstallRequest,
  PluginLocalFolderPathRequest,
  PluginLogDto,
  PluginLogLevel,
  PluginStatus,
} from "@paperclipai/shared";
import { api } from "./client";

export type { PluginLocalFolderProblem, PluginLocalFolderStatus };

export interface PluginLocalFoldersResponse {
  pluginId: string;
  companyId: string;
  folders: PluginLocalFolderStatus[];
}

/**
 * Plugin management API client.
 *
 * All methods are thin wrappers around the `api` base client. They return
 * promises that resolve to typed JSON responses or throw on HTTP errors.
 *
 * @example
 * ```tsx
 * // In a component:
 * const { data: plugins } = useQuery({
 *   queryKey: queryKeys.plugins.all,
 *   queryFn: () => pluginsApi.list(),
 * });
 * ```
 */
export const pluginsApi = {
  /**
   * List all installed plugins, optionally filtered by lifecycle status.
   *
   * @param status - Optional filter; must be a valid `PluginStatus` value.
   *   Invalid values are rejected by the server with HTTP 400.
   */
  list: (status?: PluginStatus) =>
    api.get<PluginRecordDto[]>(`/plugins${status ? `?status=${status}` : ""}`),

  /**
   * List repository-local plugins that this Paperclip instance can install.
   *
   * The server owns catalog discovery and returns only recognized packages;
   * the browser never supplies or resolves a filesystem path.
   */
  listCatalog: () =>
    api.get<PluginCatalogEntryDto[]>("/plugins/catalog"),

  /**
   * Install one recognized repository-local plugin by its exact package name.
   *
   * The server resolves the catalog entry, builds it when necessary, and then
   * passes the trusted local package to the ordinary plugin lifecycle.
   */
  installCatalog: (packageName: string) =>
    api.post<PluginRecordDto>("/plugins/catalog/install", { packageName }),

  /**
   * Fetch a single plugin record by its installation UUID.
   *
   * @param pluginId - The plugin installation UUID from `PluginRecordDto.id`.
   */
  get: (pluginId: string) =>
    api.get<PluginDetailDto>(`/plugins/${pluginId}`),

  /**
   * Install a plugin from npm or a local path.
   *
   * On success, the plugin is registered as `ready` when its empty instance
   * configuration is valid; otherwise it remains `disabled` until configured.
   * The response is the newly created `PluginRecordDto`.
   *
   * npm installs use `{ source: "npm", packageName, version? }`. Local installs
   * use `{ source: "local", path }`.
   */
  install: (params: PluginInstallRequest) =>
    api.post<PluginRecordDto>("/plugins/install", params),

  /**
   * Uninstall a plugin and delete all installation-owned operational data.
   *
   * @param pluginId - Immutable installation UUID of the plugin to uninstall.
   */
  uninstall: (pluginId: string) =>
    api.delete<void>(`/plugins/${pluginId}`),

  /**
   * Transition a `disabled` or `error` plugin to `ready` and activate it.
   * Other lifecycle states are rejected.
   *
   * @param pluginId - UUID of the plugin to enable.
   */
  enable: (pluginId: string) =>
    api.post<PluginRecordDto>(`/plugins/${pluginId}/enable`, {}),

  /**
   * Disable a plugin (transition to the `disabled` lifecycle state).
   * The plugin's worker is stopped; it will not process events until re-enabled.
   *
   * @param pluginId - UUID of the plugin to disable.
   * @param reason - Optional human-readable reason recorded in lifecycle activity.
   */
  disable: (pluginId: string, reason?: string) =>
    api.post<PluginRecordDto>(`/plugins/${pluginId}/disable`, reason ? { reason } : {}),

  /**
   * Fetch aggregated health dashboard data for a plugin.
   *
   * Returns worker diagnostics, recent job runs, recent webhook deliveries,
   * and the current health check result in a single request. Used by the
   * {@link PluginSettings} page to render the runtime dashboard section.
   *
   * @param pluginId - UUID of the plugin.
   */
  dashboard: (pluginId: string) =>
    api.get<PluginDashboardData>(`/plugins/${pluginId}/dashboard`),

  /**
   * Fetch recent log entries for a plugin.
   *
   * @param pluginId - UUID of the plugin.
   * @param options - Optional filters: limit, level, since.
   */
  logs: (pluginId: string, options?: { limit?: number; level?: PluginLogLevel; since?: string }) => {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.level) params.set("level", options.level);
    if (options?.since) params.set("since", options.since);
    const qs = params.toString();
    return api.get<PluginLogDto[]>(
      `/plugins/${pluginId}/logs${qs ? `?${qs}` : ""}`,
    );
  },

  /**
   * Returns normalized UI contribution declarations for ready plugins.
   * Used by the slot host runtime and launcher discovery surfaces.
   *
   * Response shape:
   * - `slots`: concrete React mount declarations from `manifest.ui.slots`
   * - `launchers`: host-owned entry points from `manifest.ui.launchers`
   *
   * @example
   * ```ts
   * const rows = await pluginsApi.listUiContributions();
   * const toolbarLaunchers = rows.flatMap((row) =>
   *   row.launchers.filter((launcher) => launcher.placementZone === "toolbarButton"),
   * );
   * ```
   */
  listUiContributions: () =>
    api.get<PluginUiContribution[]>("/plugins/ui-contributions"),

  // ===========================================================================
  // Plugin configuration endpoints
  // ===========================================================================

  /**
   * Fetch the current configuration for a plugin.
   *
   * Returns the `PluginConfigDto` if one exists, or `null` if the plugin
   * has not yet been configured.
   *
   * @param pluginId - UUID of the plugin.
   */
  getConfig: (pluginId: string) =>
    api.get<PluginConfigDto | null>(`/plugins/${pluginId}/config`),

  /**
   * Save (create or update) the configuration for a plugin.
   *
   * The server validates `configJson` against the plugin's `instanceConfigSchema`
   * and returns the persisted `PluginConfigDto` on success.
   *
   * @param pluginId - UUID of the plugin.
   * @param configJson - Configuration values matching the plugin's `instanceConfigSchema`.
   */
  saveConfig: (pluginId: string, configJson: Record<string, unknown>) =>
    api.post<PluginConfigDto>(`/plugins/${pluginId}/config`, { configJson }),

  /**
   * Call the plugin's `validateConfig` RPC method to test the configuration
   * without persisting it.
   *
   * Returns `{ valid: true }` on success, or `{ valid: false, message: string }`
   * when the plugin reports a validation failure.
   *
   * Only available when the plugin declares a `validateConfig` RPC handler.
   *
   * @param pluginId - UUID of the plugin.
   * @param configJson - Configuration values to validate.
   */
  testConfig: (pluginId: string, configJson: Record<string, unknown>) =>
    api.post<{ valid: boolean; message?: string }>(`/plugins/${pluginId}/config/test`, { configJson }),

  /**
   * List manifest-declared and stored company-scoped local folders for a plugin.
   */
  listLocalFolders: (pluginId: string, companyId: string) =>
    api.get<PluginLocalFoldersResponse>(`/plugins/${pluginId}/companies/${companyId}/local-folders`),

  /**
   * Persist a company-scoped local folder path and return its inspected status.
   */
  configureLocalFolder: (
    pluginId: string,
    companyId: string,
    folderKey: string,
    input: PluginLocalFolderPathRequest,
  ) =>
    api.put<PluginLocalFolderStatus>(
      `/plugins/${pluginId}/companies/${companyId}/local-folders/${encodeURIComponent(folderKey)}`,
      input,
    ),

  // ===========================================================================
  // Bridge proxy endpoints — used by the plugin UI bridge runtime
  // ===========================================================================

  bridgeGetData: (
    pluginId: string,
    key: string,
    params?: Record<string, unknown>,
    companyId?: string | null,
    renderEnvironment?: PluginLauncherRenderContextSnapshot | null,
  ) =>
    api.post<{ data: unknown }>(`/plugins/${pluginId}/data/${encodeURIComponent(key)}`, {
      companyId: companyId ?? undefined,
      params,
      renderEnvironment: renderEnvironment ?? undefined,
    }),

  /**
   * Proxy a `performAction` call from a plugin UI component to its worker backend.
   *
   * This is the HTTP transport for `usePluginAction(key)`. The bridge runtime
   * calls this method when the action function is invoked.
   *
   * On success, the response is `{ data: T }`.
   * On failure, the response body is a `PluginBridgeError`-shaped object
   * with `code`, `message`, and optional `details`.
   *
   * @param pluginId - UUID of the plugin whose worker should handle the request
   * @param key - Plugin-defined action key (e.g. `"resync"`)
   * @param params - Optional parameters forwarded to the worker handler
   * @param companyId - Optional company scope used for board/company access checks.
   * @param renderEnvironment - Optional launcher/page snapshot forwarded for
   *   launcher-backed UI so workers can distinguish modal, drawer, popover, and
   *   page execution.
   *
   * Error responses:
   * - `401`/`403` when auth or company access checks fail
   * - `404` when the plugin or handler key does not exist
   * - `409` when the plugin is not in a callable runtime state
   * - `5xx` with a `PluginBridgeError`-shaped body when the worker throws
   *
   * @see PLUGIN_SPEC.md §13.9 — `performAction`
   * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
   */
  bridgePerformAction: (
    pluginId: string,
    key: string,
    params?: Record<string, unknown>,
    companyId?: string | null,
    renderEnvironment?: PluginLauncherRenderContextSnapshot | null,
  ) =>
    api.post<{ data: unknown }>(`/plugins/${pluginId}/actions/${encodeURIComponent(key)}`, {
      companyId: companyId ?? undefined,
      params,
      renderEnvironment: renderEnvironment ?? undefined,
    }),
};
