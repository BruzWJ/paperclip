/**
 * Serializes one structurally keyed drain while allowing unrelated scopes to
 * execute concurrently. Notifications coalesce into one successor drain and
 * interruption waits for the owned drain to release its resources.
 */
export interface TargetLaneRunCoordinator<Scope> {
  active(): ReadonlySet<Scope>;
  isActive(scope: Scope): boolean;
  run(scope: Scope): Promise<void>;
  wake(scope: Scope): void;
  interrupt(scope: Scope): Promise<void>;
}

interface Entry<Scope> {
  readonly scope: Scope;
  readonly controller: AbortController;
  promise: Promise<void>;
  pendingDrain: boolean;
  stopping: boolean;
}

export function createTargetLaneRunCoordinator<Scope, Key>(options: {
  keyOf(scope: Scope): Key;
  drain(scope: Scope, force: boolean, signal: AbortSignal): Promise<void>;
}): TargetLaneRunCoordinator<Scope> {
  const active = new Map<Key, Entry<Scope>>();

  const start = (scope: Scope, force: boolean): Entry<Scope> => {
    const key = options.keyOf(scope);
    const entry: Entry<Scope> = {
      scope,
      controller: new AbortController(),
      promise: Promise.resolve(),
      pendingDrain: false,
      stopping: false,
    };
    active.set(key, entry);
    entry.promise = (async () => {
      let nextForce = force;
      try {
        do {
          entry.pendingDrain = false;
          await options.drain(entry.scope, nextForce, entry.controller.signal);
          nextForce = false;
          if (entry.pendingDrain && !entry.stopping) {
            await Promise.resolve();
          }
        } while (entry.pendingDrain && !entry.stopping);
      } finally {
        if (active.get(key) === entry) active.delete(key);
        if (entry.pendingDrain && !entry.stopping && !active.has(key)) {
          observeDetached(start(entry.scope, false));
        }
      }
    })();
    return entry;
  };

  function observeDetached(entry: Entry<Scope>): void {
    void entry.promise.catch(() => {
      // A notified drain has no direct waiter. Persisted retry/terminal state
      // remains the recovery authority; reconciliation may notify it again.
    });
  }

  const run = async (scope: Scope): Promise<void> => {
    const key = options.keyOf(scope);
    const existing = active.get(key);
    if (existing) {
      if (!existing.stopping) existing.pendingDrain = true;
      try {
        await existing.promise;
      } catch (error) {
        if (!existing.stopping) throw error;
      }
      if (existing.stopping) return run(scope);
      return;
    }
    await start(scope, true).promise;
  };

  return {
    active: () => new Set([...active.values()].map((entry) => entry.scope)),
    isActive: (scope) => active.has(options.keyOf(scope)),
    run,
    wake(scope) {
      const key = options.keyOf(scope);
      const existing = active.get(key);
      if (existing) {
        existing.pendingDrain = true;
        return;
      }
      observeDetached(start(scope, false));
    },
    async interrupt(scope) {
      const key = options.keyOf(scope);
      const existing = active.get(key);
      if (!existing) return;
      existing.stopping = true;
      existing.pendingDrain = false;
      existing.controller.abort();
      try {
        await existing.promise;
      } catch {
        // Interruption owns cancellation; callers do not inherit drain errors.
      }
    },
  };
}
