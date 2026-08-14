/**
 * PluginEventBus — typed in-process event bus for the Paperclip plugin system.
 *
 * Responsibilities:
 * - Deliver core domain events to subscribing plugin workers (server-side).
 * - Apply `EventFilter` server-side so filtered-out events never reach the handler.
 * - Namespace plugin-emitted events as `plugin.<pluginKey>.<eventName>`.
 * - Guard the core namespace: plugins may not emit events with the `plugin.` prefix.
 * - Isolate subscriptions per plugin — a plugin cannot enumerate or interfere with
 *   another plugin's subscriptions.
 * - Support wildcard subscriptions via prefix matching (e.g. `plugin.acme.linear.*`).
 *
 * The bus operates in-process. Explicit post-commit producers call the app-owned
 * publisher, which awaits this router while each subscription handler proxies the
 * event to its worker over IPC. Events are not durable, replayed, or retried.
 *
 * @see PLUGIN_SPEC.md §16 — Event System
 * @see PLUGIN_SPEC.md §16.1 — Event Filtering
 * @see PLUGIN_SPEC.md §16.2 — Plugin-to-Plugin Events
 */

import {
  assertPluginEventSubscription,
  pluginEventMatchesFilter,
  type PluginEvent,
  type EventFilter,
  type PluginEventPattern,
} from "@paperclipai/plugin-sdk";
import { isCanonicalUuid } from "@paperclipai/shared";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * A registered subscription record stored per plugin.
 */
interface Subscription {
  /** The event name or prefix pattern this subscription matches. */
  eventPattern: string;
  /** Optional server-side filter applied before delivery. */
  filter: EventFilter | null;
  /** Stable identity so worker restarts replace rather than duplicate delivery. */
  key: string;
  /** Async handler to invoke when a matching event passes the filter. */
  handler: (event: PluginEvent) => Promise<void>;
}

function stableFilterKey(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableFilterKey).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableFilterKey(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

// ---------------------------------------------------------------------------
// Pattern matching helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the event type matches the subscription pattern.
 *
 * Matching rules:
 * - Exact match: `"task.board.comment.created"` matches `"task.board.comment.created"`.
 * - Wildcard suffix: `"plugin.acme.*"` matches any event type that starts with
 *   `"plugin.acme."`. The wildcard `*` is only supported as a trailing token.
 *
 * No full glob syntax is supported — only trailing `*` after a `.` separator.
 */
function matchesPattern(eventType: string, pattern: string): boolean {
  if (pattern === eventType) return true;

  // Trailing wildcard: "plugin.foo.*" → prefix is "plugin.foo."
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -1); // remove the trailing "*", keep the "."
    return eventType.startsWith(prefix);
  }

  return false;
}

/**
 * Returns true if the event passes all fields of the filter.
 * A `null` or empty filter object passes all events.
 *
 * **Resolution strategy per field:**
 *
 * - `companyId` — resolved from the required top-level event company ID.
 *
 * - `agentId` — resolved from the canonical terminal-run `payload.agentId`.
 *
 * Multiple filter fields are ANDed — all specified fields must match.
 */
// ---------------------------------------------------------------------------
// Event bus factory
// ---------------------------------------------------------------------------

/**
 * Creates and returns a new `PluginEventBus` instance.
 *
 * A single bus instance should be shared across the server process. Each
 * plugin interacts with the bus through a scoped handle obtained via
 * {@link PluginEventBus.forPlugin}.
 *
 * @example
 * ```ts
 * const bus = createPluginEventBus();
 *
 * // Give the Linear plugin a scoped handle
 * const linearBus = bus.forPlugin("acme.linear");
 *
 * // Subscribe from the plugin's perspective
 * linearBus.subscribe("task.board.comment.created", async (event) => {
 *   // handle event
 * });
 *
 * // Emit a core domain event (called by the host, not the plugin)
 * await bus.emit({
 *   eventId: "evt-1",
 *   eventType: "task.board.comment.created",
 *   occurredAt: new Date().toISOString(),
 *   entityId: "comment-1",
 *   entityType: "task_comment",
 *   payload: { taskId: "task-1", commentId: "comment-1" },
 * });
 * ```
 */
export function createPluginEventBus(): PluginEventBus {
  // Subscription registry: pluginKey → list of subscriptions
  const registry = new Map<string, Subscription[]>();

  /**
   * Retrieve or create the subscription list for a plugin.
   */
  function subsFor(pluginKey: string): Subscription[] {
    let subs = registry.get(pluginKey);
    if (!subs) {
      subs = [];
      registry.set(pluginKey, subs);
    }
    return subs;
  }

  /**
   * Emit an event envelope to all matching subscribers across all plugins.
   *
   * Unique matching handlers are called concurrently. Registering the same
   * handler under overlapping patterns or filters never duplicates delivery.
   * Each handler's errors are collected so one plugin cannot interrupt others.
   */
  async function emit(event: PluginEvent): Promise<PluginEventBusEmitResult> {
    if (!isCanonicalUuid(event.eventId)) {
      throw new Error("Plugin eventId must be an exact canonical UUID");
    }
    if (!isCanonicalUuid(event.companyId)) {
      throw new Error("Plugin event companyId must be an exact canonical UUID");
    }
    const errors: Array<{ pluginKey: string; error: unknown }> = [];
    const promises: Promise<void>[] = [];

    for (const [pluginKey, subs] of registry) {
      const handlers = new Set<(event: PluginEvent) => Promise<void>>();
      for (const sub of subs) {
        if (!matchesPattern(event.eventType, sub.eventPattern)) continue;
        if (!pluginEventMatchesFilter(event, sub.filter)) continue;
        handlers.add(sub.handler);
      }

      for (const handler of handlers) {
        // Use Promise.resolve().then() so that synchronous throws from handlers
        // are also caught inside the promise chain. Calling
        // Promise.resolve(syncThrowingFn()) does NOT catch sync throws — the
        // throw escapes before Promise.resolve() can wrap it. Using .then()
        // ensures the call is deferred into the microtask queue where all
        // exceptions become rejections. Each .catch() swallows the rejection
        // and records it — the promise always resolves, so Promise.all never rejects.
        promises.push(
          Promise.resolve()
            .then(() => handler(event))
            .catch((error: unknown) => {
              errors.push({ pluginKey, error });
            }),
        );
      }
    }

    await Promise.all(promises);
    return { errors };
  }

  /**
   * Remove all subscriptions for a plugin (e.g. on worker shutdown or uninstall).
   */
  function clearPlugin(pluginKey: string): void {
    registry.delete(pluginKey);
  }

  /**
   * Return a scoped handle for a specific plugin. The handle exposes only the
   * plugin's own subscription list and enforces the plugin namespace on `emit`.
   */
  function forPlugin(pluginKey: string): ScopedPluginEventBus {
    if (pluginKey.length === 0 || pluginKey !== pluginKey.trim()) {
      throw new Error("Plugin identity must be an exact non-empty string");
    }
    return {
      /**
       * Subscribe to a core domain event or a plugin-namespaced event.
       *
       * For wildcard subscriptions use a trailing `.*` pattern, e.g.
       * `"plugin.acme.linear.*"`.
       *
       * Requires the `events.subscribe` capability (capability enforcement is
       * done by the host layer before calling this method).
       */
      subscribe(
        eventPattern: PluginEventPattern,
        fnOrFilter: EventFilter | ((event: PluginEvent) => Promise<void>),
        maybeFn?: (event: PluginEvent) => Promise<void>,
      ): void {
        let filter: EventFilter | null = null;
        let handler: (event: PluginEvent) => Promise<void>;

        if (typeof fnOrFilter === "function") {
          handler = fnOrFilter;
        } else {
          filter = fnOrFilter;
          if (!maybeFn) throw new Error("Handler function is required when a filter is provided");
          handler = maybeFn;
        }

        assertPluginEventSubscription(eventPattern, filter);

        const subscriptions = subsFor(pluginKey);
        const key = `${eventPattern}\0${stableFilterKey(filter)}`;
        const existing = subscriptions.find((subscription) => subscription.key === key);
        if (existing) {
          existing.filter = filter;
          existing.handler = handler;
        } else {
          subscriptions.push({ eventPattern, filter, handler, key });
        }
      },

      /**
       * Emit a plugin-namespaced event. The event type is automatically
       * prefixed with `plugin.<pluginKey>.` so:
       * - `emit("sync-done", payload)` becomes `"plugin.acme.linear.sync-done"`.
       *
       * Requires the `events.emit` capability (enforced by the host layer).
       *
       * @throws {Error} if `name` already contains the `plugin.` prefix
       *   (prevents cross-namespace spoofing).
       */
      async emit(name: string, companyId: string, payload: unknown): Promise<PluginEventBusEmitResult> {
        if (name.length === 0 || name !== name.trim()) {
          throw new Error(`Plugin "${pluginKey}" must provide an exact non-empty event name.`);
        }

        if (!isCanonicalUuid(companyId)) {
          throw new Error(
            `Plugin "${pluginKey}" must provide an exact canonical company UUID when emitting events.`,
          );
        }

        if (name.startsWith("plugin.")) {
          throw new Error(
            `Plugin "${pluginKey}" must not include the "plugin." prefix when emitting events. ` +
              `Emit the bare event name (e.g. "sync-done") and the bus will namespace it automatically.`,
          );
        }

        const eventType = `plugin.${pluginKey}.${name}` as const;
        const event: PluginEvent = {
          eventId: crypto.randomUUID(),
          eventType,
          companyId,
          occurredAt: new Date().toISOString(),
          actorType: "plugin",
          actorId: pluginKey,
          payload,
        };

        return emit(event);
      },

      /** Remove all subscriptions registered by this plugin. */
      clear(): void {
        clearPlugin(pluginKey);
      },
    };
  }

  return {
    emit,
    forPlugin,
    clearPlugin,
    /** Expose subscription count for a plugin (useful for tests and diagnostics). */
    subscriptionCount(pluginKey?: string): number {
      if (pluginKey !== undefined) {
        return registry.get(pluginKey)?.length ?? 0;
      }
      let total = 0;
      for (const subs of registry.values()) total += subs.length;
      return total;
    },
  };
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Result returned from `emit()`. Handler errors are collected and returned
 * rather than thrown so a single misbehaving plugin cannot block delivery to
 * other plugins.
 */
interface PluginEventBusEmitResult {
  /** Errors thrown by individual handlers, keyed by the plugin that failed. */
  errors: Array<{ pluginKey: string; error: unknown }>;
}

/**
 * The full event bus — held by the host process.
 *
 * Call `forPlugin(id)` to obtain a `ScopedPluginEventBus` for each plugin worker.
 */
export interface PluginEventBus {
  /**
   * Emit a typed domain event to all matching subscribers.
   *
   * Called by the app-owned post-commit publisher. All registered subscriptions
   * across all plugins are checked.
   */
  emit(event: PluginEvent): Promise<PluginEventBusEmitResult>;

  /**
   * Get a scoped handle for a specific plugin worker.
   *
   * The scoped handle isolates the plugin's subscriptions and enforces the
   * plugin namespace on outbound events.
   */
  forPlugin(pluginKey: string): ScopedPluginEventBus;

  /**
   * Remove all subscriptions for a plugin (called on worker shutdown/uninstall).
   */
  clearPlugin(pluginKey: string): void;

  /**
   * Return the total number of active subscriptions, or the count for a
   * specific plugin if `pluginKey` is provided.
   */
  subscriptionCount(pluginKey?: string): number;
}

/**
 * A plugin-scoped view of the event bus. Handed to the plugin worker (or its
 * host-side proxy) during initialisation.
 *
 * Plugins use this to:
 * 1. Subscribe to domain events (with optional server-side filter).
 * 2. Emit plugin-namespaced events for other plugins to consume.
 *
 * Note: `subscribe` overloads mirror the `PluginEventsClient.on()` interface
 * from the SDK. `emit` intentionally returns `PluginEventBusEmitResult` rather
 * than `void` so the host layer can inspect handler errors; the SDK-facing
 * `PluginEventsClient.emit()` wraps this and returns `void`.
 */
export interface ScopedPluginEventBus {
  /**
   * Subscribe to a core domain event or a plugin-namespaced event.
   *
   * **Pattern syntax:**
   * - Exact match: `"task.board.comment.created"` — receives only that event type.
   * - Wildcard suffix: `"plugin.acme.linear.*"` — receives all events emitted by
   *   the `acme.linear` plugin. The `*` is supported only as a trailing token after
   *   a `.` separator; no other glob syntax is supported.
   * - Top-level plugin wildcard: `"plugin.*"` — receives all plugin-emitted events
   *   regardless of which plugin emitted them.
   *
   * Wildcards apply only to the `plugin.*` namespace. Core domain events must be
   * subscribed to by exact name (e.g. `"task.board.comment.created"`, not `"task.*"`).
   *
   * An optional `EventFilter` can be passed as the second argument to perform
   * server-side pre-filtering; filtered-out events are never delivered to the handler.
   */
  subscribe(eventPattern: PluginEventPattern, fn: (event: PluginEvent) => Promise<void>): void;
  subscribe(
    eventPattern: PluginEventPattern,
    filter: EventFilter,
    fn: (event: PluginEvent) => Promise<void>,
  ): void;

  /**
   * Emit a plugin-namespaced event. The bus automatically prepends
   * `plugin.<pluginKey>.` to the `name`, so passing `"sync-done"` from plugin
   * `"acme.linear"` produces the event type `"plugin.acme.linear.sync-done"`.
   *
   * @param name  Bare event name (e.g. `"sync-done"`). Must be non-empty and
   *   must not include the `plugin.` prefix — the bus adds that automatically.
   * @param companyId  UUID of the company this event belongs to.
   * @param payload  Arbitrary JSON-serializable data to attach to the event.
   *
   * @throws {Error} if `name` is empty or whitespace-only.
   * @throws {Error} if `name` starts with `"plugin."` (namespace spoofing guard).
   */
  emit(name: string, companyId: string, payload: unknown): Promise<PluginEventBusEmitResult>;

  /**
   * Remove all subscriptions registered by this plugin.
   */
  clear(): void;
}
