/**
 * `definePlugin` — the top-level helper for authoring a Paperclip plugin.
 *
 * Plugin authors call `definePlugin()` and pass the result to `runWorker()` in
 * their worker entrypoint. Paperclip starts that worker as an isolated process
 * and communicates with it through the SDK's JSON-RPC bridge.
 *
 * @see PLUGIN_SPEC.md §14.1 — Example SDK Shape
 *
 * @example
 * ```ts
 * // dist/worker.ts
 * import { definePlugin } from "@paperclipai/plugin-sdk";
 *
 * export default definePlugin({
 *   async setup(ctx) {
 *     await ctx.logger.info("Linear sync plugin starting");
 *
 *     // Subscribe to events
 *     ctx.events.on("task.board.comment.created", async (event) => {
 *       const config = await ctx.config.get();
 *       const apiKey = String(config.apiKey ?? "");
 *       await ctx.http.fetch(`https://api.linear.app/...`, {
 *         method: "POST",
 *         headers: { Authorization: `Bearer ${apiKey}` },
 *         body: JSON.stringify({ title: event.payload.title }),
 *       });
 *     });
 *
 *     // Register a job handler
 *     ctx.jobs.register("full-sync", async (job) => {
 *       await ctx.logger.info("Running full-sync job", { runId: job.runId });
 *       // ... sync logic
 *     });
 *
 *     // Register data for the UI
 *     ctx.data.register("sync-health", async ({ companyId }) => {
 *       const state = await ctx.state.get({
 *         scopeKind: "company",
 *         scopeId: String(companyId),
 *         stateKey: "last-sync",
 *       });
 *       return { lastSync: state };
 *     });
 *   },
 *
 *   async onHealth() {
 *     return { status: "ok" };
 *   },
 * });
 * ```
 */

import type {
  PluginBeforePromptInput,
  PluginBeforePromptResult,
  PluginContext,
} from "./types.js";
// ---------------------------------------------------------------------------
// Health check result
// ---------------------------------------------------------------------------

/**
 * Optional plugin-reported diagnostics returned from the `health()` RPC method.
 *
 * @see PLUGIN_SPEC.md §13.2 — `health`
 */
export interface PluginHealthDiagnostics {
  /** Machine-readable status: `"ok"` | `"degraded"` | `"error"`. */
  status: "ok" | "degraded" | "error";
  /** Human-readable description of the current health state. */
  message?: string;
  /** Plugin-reported key-value diagnostics (e.g. connection status, queue depth). */
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Config validation result
// ---------------------------------------------------------------------------

/**
 * Result returned from the `validateConfig()` RPC method.
 *
 * @see PLUGIN_SPEC.md §13.3 — `validateConfig`
 */
export interface PluginConfigValidationResult {
  /** Whether the config is valid. */
  ok: boolean;
  /** Non-fatal warnings about the config. */
  warnings?: string[];
  /** Validation errors (populated when `ok` is `false`). */
  errors?: string[];
}

// ---------------------------------------------------------------------------
// Webhook handler input
// ---------------------------------------------------------------------------

/**
 * Input received by the plugin worker's `handleWebhook` handler.
 *
 * @see PLUGIN_SPEC.md §13.7 — `handleWebhook`
 */
export interface PluginWebhookInput {
  /** Endpoint key matching the manifest declaration. */
  endpointKey: string;
  /** Inbound request headers. */
  headers: Record<string, string | string[]>;
  /** Raw request body as a UTF-8 string. */
  rawBody: string;
  /** Parsed JSON body (if applicable and parseable). */
  parsedBody?: unknown;
  /** Unique request identifier for idempotency checks. */
  requestId: string;
}

export interface PluginApiRequestInput {
  routeKey: string;
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string | string[]>;
  body: unknown;
  actor: {
    type: "user";
    userId: string;
  };
  companyId: string;
  headers: Record<string, string>;
}

export interface PluginApiResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

/**
 * The plugin definition shape passed to `definePlugin()`.
 *
 * The required fields are `setup`, which receives the `PluginContext` and
 * registers handlers, and `onHealth`, which reports explicit diagnostics.
 * All other lifecycle hooks are optional.
 *
 * @see PLUGIN_SPEC.md §13 — Host-Worker Protocol
 */
export interface PluginDefinition {
  /**
   * Called once when the plugin worker starts up, after `initialize` completes.
   *
   * This is where the plugin registers all its handlers: event subscriptions,
   * job handlers, data/action handlers, and tool registrations. Registration
   * must be synchronous after `setup` resolves — do not register handlers
   * inside async callbacks that may resolve after `setup` returns.
   *
   * @param ctx - The full plugin context provided by the host
   */
  setup(ctx: PluginContext): Promise<void>;

  /**
   * Called when the host wants to know if the plugin is healthy.
   *
   * The host polls this on a regular interval and surfaces the result in the
   * plugin health dashboard.
   *
   * @see PLUGIN_SPEC.md §13.2 — `health`
   */
  onHealth(): Promise<PluginHealthDiagnostics>;

  /**
   * Called immediately before Paperclip sends one exact message to a provider.
   * The hook is a blocking barrier. It may return one prompt prelude without
   * mutating or replacing the canonical source message, or `null` when it has
   * no text to contribute.
   * Requires `runtime.prompt.observe`.
   */
  onBeforePrompt?(
    input: PluginBeforePromptInput,
  ): Promise<PluginBeforePromptResult>;

  /**
   * Called when the host is about to shut down the plugin worker.
   *
   * The worker manager owns the bounded stop deadline. The SDK drains the
   * already-accepted handlers before invoking this hook; after the manager's
   * deadline the host sends SIGTERM, then SIGKILL.
   *
   * @see PLUGIN_SPEC.md §12.5 — Graceful Shutdown Policy
   */
  onShutdown?(): Promise<void>;

  /**
   * Called when an instance administrator explicitly validates a draft.
   *
   * @param config - The configuration to validate
   * @see PLUGIN_SPEC.md §13.3 — `validateConfig`
   */
  onValidateConfig?(config: Record<string, unknown>): Promise<PluginConfigValidationResult>;

  /**
   * Called to handle an inbound webhook delivery.
   *
   * The host routes `POST /api/plugins/:pluginId/webhooks/:endpointKey` to
   * this handler. The plugin is responsible for signature verification using
   * its configured credentials.
   *
   * A plugin that declares webhooks must implement this hook, and a plugin
   * with no webhook declarations must omit it. The worker rejects activation
   * when the declaration and handler do not agree.
   *
   * @param input - Webhook delivery metadata and payload
   * @see PLUGIN_SPEC.md §13.7 — `handleWebhook`
   */
  onWebhook?(input: PluginWebhookInput): Promise<void>;

  /**
   * Called for manifest-declared scoped JSON API routes under
   * `/api/plugins/:pluginId/api/*` after the host has enforced auth, company
   * access, capabilities, and route scope.
   * A plugin that declares API routes must implement this hook, and a plugin
   * with no API route declarations must omit it.
   */
  onApiRequest?(input: PluginApiRequestInput): Promise<PluginApiResponse>;

}

// ---------------------------------------------------------------------------
// PaperclipPlugin — the sealed object returned by definePlugin()
// ---------------------------------------------------------------------------

/**
 * The sealed plugin object returned by `definePlugin()`.
 *
 * Plugin authors pass this object to `runWorker()` in their worker entrypoint.
 *
 * @see PLUGIN_SPEC.md §14 — SDK Surface
 */
export interface PaperclipPlugin {
  /** The original plugin definition passed to `definePlugin()`. */
  readonly definition: PluginDefinition;
}

// ---------------------------------------------------------------------------
// definePlugin — top-level factory
// ---------------------------------------------------------------------------

/**
 * Define a Paperclip plugin.
 *
 * Call this function in your worker entrypoint and export the result as the
 * default export. The host will import the module and call lifecycle methods
 * on the returned object.
 *
 * @param definition - Plugin lifecycle handlers
 * @returns A sealed `PaperclipPlugin` object for the host to consume
 *
 * @example
 * ```ts
 * import { definePlugin } from "@paperclipai/plugin-sdk";
 *
 * export default definePlugin({
 *   async setup(ctx) {
 *     await ctx.logger.info("Plugin started");
 *     ctx.events.on("task.board.comment.created", async (event) => {
 *       // handle event
 *     });
 *   },
 *
 *   async onHealth() {
 *     return { status: "ok" };
 *   },
 * });
 * ```
 *
 * @see PLUGIN_SPEC.md §14.1 — Example SDK Shape
 */
export function definePlugin(definition: PluginDefinition): PaperclipPlugin {
  return Object.freeze({ definition });
}
