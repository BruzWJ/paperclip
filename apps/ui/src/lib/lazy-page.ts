import { lazy, type ComponentType, type LazyExoticComponent } from "react";

/**
 * sessionStorage key guarding the automatic reload after a failed dynamic
 * import (stale-chunk recovery). Present means this tab already spent its one
 * recovery reload.
 */
export const STALE_CHUNK_RELOAD_FLAG = "paperclip.stale-chunk-reloaded";

export type StaleChunkReloadStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

function defaultStorage(): StaleChunkReloadStorage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.sessionStorage;
  } catch {
    // Storage access itself can throw (privacy settings, sandboxed frames);
    // treat it as unavailable.
    return null;
  }
}

function defaultReload(): void {
  window.location.reload();
}

/**
 * Recovery path for a failed dynamic page-chunk import.
 *
 * index.html is served no-cache, but a long-lived tab can hold an asset
 * manifest from before a redeploy; its hashed chunk URLs then 404 and the
 * dynamic import rejects. One full page reload picks up the fresh manifest.
 * The sessionStorage flag caps this at a single automatic reload per tab: if
 * the flag is already set — or storage is unusable, so a loop could not be
 * ruled out — the original error is rethrown and surfaces through the route
 * error boundary instead.
 *
 * After triggering the reload this returns a forever-pending promise so the
 * Suspense fallback stays up until the browser navigates away.
 */
export function recoverFromChunkLoadError(
  error: unknown,
  storage: StaleChunkReloadStorage | null = defaultStorage(),
  reload: () => void = defaultReload,
): Promise<never> {
  let shouldReload = false;
  if (storage) {
    try {
      if (storage.getItem(STALE_CHUNK_RELOAD_FLAG) === null) {
        storage.setItem(STALE_CHUNK_RELOAD_FLAG, "1");
        shouldReload = true;
      }
    } catch {
      shouldReload = false;
    }
  }
  if (!shouldReload) throw error;
  reload();
  return new Promise<never>(() => {});
}

/**
 * Clears the reload guard once a dynamic import succeeds, re-arming
 * stale-chunk recovery for the next redeploy this tab lives through.
 */
export function clearStaleChunkReloadFlag(
  storage: StaleChunkReloadStorage | null = defaultStorage(),
): void {
  try {
    storage?.removeItem(STALE_CHUNK_RELOAD_FLAG);
  } catch {
    // Best effort — an unclearable flag only means the next stale-chunk
    // failure shows the error boundary instead of auto-reloading.
  }
}

/**
 * React.lazy for modules with NAMED exports:
 *
 *   const Tasks = lazyPage(() => import("../pages/Tasks"), "Tasks");
 *
 * Multiple lazyPage() calls over the same import share one chunk. Failed
 * imports go through stale-chunk recovery (see recoverFromChunkLoadError).
 */
export function lazyPage<
  TModule extends Record<TExport, ComponentType<any>>,
  TExport extends keyof TModule & string,
>(
  load: () => Promise<TModule>,
  exportName: TExport,
): LazyExoticComponent<TModule[TExport]> {
  return lazy(async () => {
    let module: TModule;
    try {
      module = await load();
    } catch (error) {
      return recoverFromChunkLoadError(error);
    }
    clearStaleChunkReloadFlag();
    return { default: module[exportName] };
  });
}
