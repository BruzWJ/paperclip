/**
 * Paperclip plugin UI SDK — types for plugin frontend components.
 *
 * Plugin UI bundles import from `@paperclipai/plugin-sdk/ui`.  This subpath
 * provides the bridge hooks, component prop interfaces, and error types that
 * plugin React components use to communicate with the host.
 *
 * Plugin UI bundles are loaded as ES modules into designated extension slots.
 * All communication with the plugin worker goes through the host bridge — plugin
 * components must NOT access host internals or call host APIs directly.
 *
 * @see PLUGIN_SPEC.md §19 — UI Extension Model
 * @see PLUGIN_SPEC.md §19.0.1 — Plugin UI SDK
 * @see PLUGIN_SPEC.md §29.2 — SDK Versioning
 */

import type {
  AnchorHTMLAttributes,
  MouseEvent as ReactMouseEvent,
} from "react";
import type {
  PluginBridgeError,
  PluginUiSlotEntityType,
} from "@paperclipai/shared";
import type {
  PluginLauncherRenderContextSnapshot,
  PluginModalBoundsRequest,
  PluginRenderCloseEvent,
} from "../protocol.js";

// Re-export canonical shared bridge and launcher types for plugin UI authors.
export type {
  PluginBridgeError,
  PluginBridgeErrorCode,
  PluginLauncherBounds,
  PluginLauncherRenderEnvironment,
} from "@paperclipai/shared";
export type {
  PluginLauncherRenderContextSnapshot,
  PluginModalBoundsRequest,
  PluginRenderCloseEvent,
} from "../protocol.js";

// ---------------------------------------------------------------------------
// Host context available to all plugin components
// ---------------------------------------------------------------------------

/**
 * Read-only host context passed to every plugin component via `useHostContext()`.
 *
 * Plugin components use this to know which company, project, or entity is
 * currently active so they can scope their data requests accordingly.
 *
 * @see PLUGIN_SPEC.md §19 — UI Extension Model
 */
export interface PluginHostContext {
  /** UUID of the currently active company, if any. */
  companyId: string | null;
  /** URL prefix for the current company (e.g. `"my-company"`). */
  companyPrefix: string | null;
  /** UUID of the currently active project, if any. */
  projectId: string | null;
  /** Canonical URL reference for the active project, if available. */
  projectRef: string | null;
  /** UUID of the current entity (for detail tab contexts), if any. */
  entityId: string | null;
  /** Type of the current entity when mounted on an entity-scoped surface. */
  entityType: PluginUiSlotEntityType | null;
  /** UUID of the current authenticated user. */
  userId: string | null;
  /** Runtime metadata for the host container currently rendering this plugin UI. */
  renderEnvironment: PluginRenderEnvironmentContext | null;
}

/**
 * Async-capable callback invoked during a host-managed close lifecycle.
 */
export type PluginRenderCloseHandler = (
  event: PluginRenderCloseEvent,
) => void | Promise<void>;

/**
 * Close lifecycle hooks available when the plugin UI is rendered inside a
 * host-managed launcher environment.
 */
export interface PluginRenderCloseLifecycle {
  /** Register a callback before the host closes the current environment. */
  onBeforeClose(handler: PluginRenderCloseHandler): () => void;
  /** Register a callback after the host closes the current environment. */
  onClose(handler: PluginRenderCloseHandler): () => void;
}

/**
 * Runtime information about the host container currently rendering a plugin UI.
 */
export interface PluginRenderEnvironmentContext
  extends PluginLauncherRenderContextSnapshot {
  /** Host callback for requesting new bounds while an overlay is open. */
  requestModalBounds(request: PluginModalBoundsRequest): Promise<void>;
  /** Close lifecycle callbacks for the host-managed overlay. */
  closeLifecycle: PluginRenderCloseLifecycle;
}

// ---------------------------------------------------------------------------
// Host navigation
// ---------------------------------------------------------------------------

/**
 * Options for host-managed Paperclip navigation from plugin UI.
 */
export interface HostNavigationOptions {
  /** Replace the current history entry instead of pushing a new one. */
  replace?: boolean;
  /** Optional state forwarded to the host router. */
  state?: unknown;
}

/**
 * Options for `useHostNavigation().linkProps()`.
 */
export interface HostNavigationLinkOptions extends HostNavigationOptions {
  /** Standard anchor target. Non-`_self` targets are not intercepted. */
  target?: AnchorHTMLAttributes<HTMLAnchorElement>["target"];
  /** Standard anchor rel attribute. */
  rel?: AnchorHTMLAttributes<HTMLAnchorElement>["rel"];
}

/**
 * Anchor props returned by `useHostNavigation().linkProps()`.
 *
 * The `href` is always real so browser affordances such as copy-link,
 * modifier-click, middle-click, and open-in-new-tab continue to work.
 */
export interface HostNavigationLinkProps
  extends Pick<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "target" | "rel"> {
  onClick: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
}

/**
 * Snapshot of the host router location, exposed to plugin UI through
 * `useHostLocation()`. Mirrors the relevant subset of `Location` from
 * `react-router-dom` so plugins can react to URL changes without importing
 * router internals.
 *
 * @see PLUGIN_SPEC.md §19 — UI Extension Model
 */
export interface HostLocation {
  /** Current pathname, e.g. `/PAP/wiki`. */
  pathname: string;
  /** Current search string, e.g. `?tab=config` (includes the leading `?`). */
  search: string;
  /** Current hash, e.g. `#document-plan` (includes the leading `#`). */
  hash: string;
  /** Optional state forwarded by the host router for same-tab SPA navigation. */
  state?: unknown;
}

/**
 * Host-managed navigation helpers for plugin UI.
 */
export interface HostNavigation {
  /**
   * Resolve a Paperclip-internal path using the active company prefix.
   *
   * For example, in company `PAP`, `resolveHref("/wiki")` returns
   * `"/PAP/wiki"`, while `resolveHref("/PAP/wiki")` stays unchanged.
   */
  resolveHref(to: string): string;
  /** Navigate through the host router without reloading the document. */
  navigate(to: string, options?: HostNavigationOptions): void;
  /**
   * Build anchor props for host-managed links.
   *
   * Plain left-clicks are routed through the host SPA router. Browser-native
   * link gestures are left alone because the returned props include a real
   * `href`.
   */
  linkProps(to: string, options?: HostNavigationLinkOptions): HostNavigationLinkProps;
}

// ---------------------------------------------------------------------------
// Slot component prop interfaces
// ---------------------------------------------------------------------------

/** Props shared by plugin UI slots that receive only the current host context. */
export interface PluginHostContextProps {
  /** The current host context. */
  context: PluginHostContext;
}

/**
 * Props passed to a plugin detail tab component.
 *
 * A detail tab is rendered on a project or task detail page.
 *
 * @see PLUGIN_SPEC.md §19.3 — Detail Tabs
 */
export interface PluginDetailTabProps {
  /** The current host context, always including `entityId` and `entityType`. */
  context: PluginHostContext & {
    entityId: string;
    entityType: PluginUiSlotEntityType;
  };
}

/**
 * Props passed to a plugin project sidebar item component.
 *
 * A project sidebar item is rendered **once per project** under that project's
 * row in the sidebar Projects list. The host passes the current project's id
 * in `context.entityId` and `context.entityType` is `"project"`.
 *
 * Use this slot to add a link (e.g. "Files", "Linear Sync") that navigates to
 * the project detail with a plugin tab selected: `/projects/:projectRef?tab=plugin:key:slotId`.
 *
 * @see PLUGIN_SPEC.md §19.5.1 — Project sidebar items
 */
export interface PluginProjectSidebarItemProps {
  /** Host context plus entityId (project id) and entityType "project". */
  context: PluginHostContext & {
    entityId: string;
    entityType: "project";
  };
}

// ---------------------------------------------------------------------------
// usePluginData hook return type
// ---------------------------------------------------------------------------

/**
 * Return value of `usePluginData(key, params)`.
 *
 * Mirrors a standard async data-fetching hook pattern:
 * exactly one of `data` or `error` is non-null at any time (unless `loading`).
 *
 * @template T The type of the data returned by the worker handler
 *
 * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
 */
export interface PluginDataResult<T = unknown> {
  /** The data returned by the worker's `getData` handler. `null` while loading or on error. */
  data: T | null;
  /** `true` while the initial request or a refresh is in flight. */
  loading: boolean;
  /** Bridge error if the request failed. `null` on success or while loading. */
  error: PluginBridgeError | null;
  /**
   * Manually trigger a data refresh.
   * Useful for poll-based updates or post-action refreshes.
   */
  refresh(): void;
}

// ---------------------------------------------------------------------------
// usePluginToast hook types
// ---------------------------------------------------------------------------

export type PluginToastTone = "info" | "success" | "warn" | "error";

export interface PluginToastAction {
  label: string;
  href: string;
}

export interface PluginToastInput {
  id?: string;
  dedupeKey?: string;
  title: string;
  body?: string;
  tone?: PluginToastTone;
  ttlMs?: number;
  action?: PluginToastAction;
}

export type PluginToastFn = (input: PluginToastInput) => string | null;

// ---------------------------------------------------------------------------
// usePluginAction hook return type
// ---------------------------------------------------------------------------

/**
 * Return value of `usePluginAction(key)`.
 *
 * Returns an async function that, when called, sends an action request
 * to the worker's `performAction` handler and returns the result.
 *
 * On failure, the async function throws a `PluginBridgeError`.
 *
 * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
 *
 * @example
 * ```tsx
 * const resync = usePluginAction("resync");
 * <button onClick={() => resync({ companyId }).catch(err => console.error(err))}>
 *   Resync Now
 * </button>
 * ```
 */
export type PluginActionFn = (params?: Record<string, unknown>) => Promise<unknown>;
