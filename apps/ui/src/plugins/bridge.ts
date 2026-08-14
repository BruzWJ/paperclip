/**
 * Plugin UI bridge runtime — concrete implementations of the bridge hooks.
 *
 * Plugin UI bundles import `usePluginData`, `usePluginAction`, and
 * `useHostContext` from `@paperclipai/plugin-sdk/ui`. The host module shim
 * binds those SDK runtime exports to these concrete implementations through
 * the initialized bridge registry.
 *
 * The bridge runtime communicates with plugin workers via HTTP REST endpoints:
 * - `POST /api/plugins/:pluginId/data/:key`     — proxies `getData` RPC
 * - `POST /api/plugins/:pluginId/actions/:key`   — proxies `performAction` RPC
 *
 * ## How it works
 *
 * 1. Before loading a plugin's UI module, the host creates a scoped bridge via
 *    `createPluginBridge(pluginId)`.
 * 2. The bridge's hook implementations are registered in a global bridge
 *    registry keyed by `pluginId`.
 * 3. The "ambient" hooks (`usePluginData`, `usePluginAction`, `useHostContext`)
 *    look up the current plugin context from a React context provider and
 *    delegate to the appropriate bridge instance.
 *
 * @see PLUGIN_SPEC.md §13.8 — `getData`
 * @see PLUGIN_SPEC.md §13.9 — `performAction`
 * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
 */

export type {
  HostLocation,
  HostNavigation,
  HostNavigationLinkOptions,
  HostNavigationLinkProps,
  HostNavigationOptions,
  PluginDataResult,
  PluginHostContext,
  PluginModalBoundsRequest,
  PluginRenderCloseEvent,
  PluginRenderCloseHandler,
  PluginRenderEnvironmentContext,
  PluginToastFn,
  PluginToastInput,
} from "@paperclipai/plugin-sdk/ui";
export type { PluginBridgeError } from "@paperclipai/shared";
export * from "./bridge-core";
export * from "./bridge-data";
export * from "./bridge-navigation";
