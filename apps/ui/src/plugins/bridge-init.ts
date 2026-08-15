/**
 * Plugin bridge initialization.
 *
 * Registers the host's React instances and bridge hook implementations
 * on a global object so that the plugin module loader can inject them
 * into plugin UI bundles at load time.
 *
 * Call `initPluginBridge()` once during app startup (in `main.tsx`), before
 * any plugin UI modules are loaded.
 *
 * @see PLUGIN_SPEC.md §19.0.1 — Plugin UI SDK
 * @see PLUGIN_SPEC.md §19.0.2 — Bundle Isolation
 */

import { ManagedRoutinesList as HostManagedRoutinesList } from "@/features/routines/list/ManagedRoutinesList";
import { MarkdownBody } from "@/features/markdown/MarkdownBody";
import type { MarkdownBlockProps } from "@paperclipai/plugin-sdk/ui";
import { createElement } from "react";
import {
  useHostContext,
  useHostLocation,
  useHostNavigation,
  usePluginAction,
  usePluginData,
  usePluginToast,
} from "./bridge";
import {
  PluginSdkDataTable,
  PluginSdkErrorBoundary,
  PluginSdkJsonTree,
  PluginSdkKeyValueList,
  PluginSdkMetricCard,
  PluginSdkSpinner,
  PluginSdkStatusBadge,
} from "./bridge-sdk-display";
import { PluginSdkOwnerPicker, PluginSdkProjectPicker } from "./bridge-sdk-pickers";
import { PluginSdkFileTree, PluginSdkMarkdownEditor, PluginSdkTasksList } from "./bridge-sdk-tasks";

// ---------------------------------------------------------------------------
// Global bridge registry
// ---------------------------------------------------------------------------

/**
 * The global bridge registry shape.
 *
 * This is placed on `globalThis.__paperclipPluginBridge__` and consumed by
 * the plugin module loader to provide implementations for external imports.
 */
type PluginSdkUiRuntime = typeof import("@paperclipai/plugin-sdk/ui");

export interface PluginBridgeRegistry {
  react: unknown;
  reactDom: unknown;
  reactDomClient: unknown;
  sdkUi: PluginSdkUiRuntime;
}

declare global {
  // eslint-disable-next-line no-var
  var __paperclipPluginBridge__: PluginBridgeRegistry | undefined;
}

/**
 * Initialize the plugin bridge global registry.
 *
 * Registers the host's React, ReactDOM, ReactDOM client, and SDK UI bridge implementations
 * on `globalThis.__paperclipPluginBridge__` so the plugin module loader
 * can provide them to plugin bundles.
 *
 * @param react - The host's React module
 * @param reactDom - The host's ReactDOM module
 * @param reactDomClient - The host's ReactDOM client module
 */
export function initPluginBridge(
  react: typeof import("react"),
  reactDom: typeof import("react-dom"),
  reactDomClient: typeof import("react-dom/client"),
): void {
  globalThis.__paperclipPluginBridge__ = {
    react,
    reactDom,
    reactDomClient,
    sdkUi: {
      usePluginData,
      usePluginAction,
      useHostContext,
      useHostLocation,
      useHostNavigation,
      usePluginToast,
      MarkdownBlock: ({
        content,
        className,
        enableWikiLinks,
        wikiLinkRoot,
        resolveWikiLinkHref,
      }: MarkdownBlockProps) =>
        createElement(MarkdownBody, {
          className,
          softBreaks: false,
          enableWikiLinks,
          wikiLinkRoot,
          resolveWikiLinkHref,
          children: content,
        }),
      MetricCard: PluginSdkMetricCard,
      StatusBadge: PluginSdkStatusBadge,
      DataTable: PluginSdkDataTable,
      KeyValueList: PluginSdkKeyValueList,
      JsonTree: PluginSdkJsonTree,
      Spinner: PluginSdkSpinner,
      ErrorBoundary: PluginSdkErrorBoundary,
      MarkdownEditor: PluginSdkMarkdownEditor,
      FileTree: PluginSdkFileTree,
      TasksList: PluginSdkTasksList,
      OwnerPicker: PluginSdkOwnerPicker,
      ProjectPicker: PluginSdkProjectPicker,
      ManagedRoutinesList: HostManagedRoutinesList,
    },
  };
}
