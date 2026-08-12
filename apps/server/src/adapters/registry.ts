import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import {
  discoverLocalAcpxAdapterCatalog,
  type AcpxCatalogDiagnosticCode,
} from "./acpx-catalog.js";

/**
 * An ACPX-supplied local candidate that was intentionally not admitted as an
 * executable Paperclip adapter because its disposable local probe or generic
 * dynamic-contract validation failed. This is observability only: it never
 * participates in selection or launch.
 */
export interface AcpxAdapterProbeDiagnostic {
  readonly type: string;
  readonly code: AcpxCatalogDiagnosticCode;
  readonly message: string;
}

const ACPX_CATALOG_REFRESH_INTERVAL_MS = 30_000;

const currentByType = new Map<string, ServerAdapterModule>();
const currentProbeDiagnosticsByType = new Map<
  string,
  AcpxAdapterProbeDiagnostic
>();
let refreshInFlight: Promise<void> | null = null;
let lastSuccessfulRefreshAt = 0;

/**
 * Re-probes locally installed agents supplied by ACPX's registry. A short
 * successful-snapshot cache avoids opening a temporary session for every
 * board repaint while newly available local agents still appear promptly.
 */
export function refreshAcpxAdapters(input: { force?: boolean } = {}): Promise<void> {
  const now = Date.now();
  if (
    !input.force &&
    lastSuccessfulRefreshAt > 0 &&
    now - lastSuccessfulRefreshAt < ACPX_CATALOG_REFRESH_INTERVAL_MS
  ) {
    return Promise.resolve();
  }
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const snapshot = await discoverLocalAcpxAdapterCatalog(process.cwd());
      const next = new Map<string, ServerAdapterModule>();
      const nextDiagnostics = new Map<string, AcpxAdapterProbeDiagnostic>();
      for (const adapter of snapshot.adapters) {
        next.set(adapter.type, adapter);
      }
      for (const [type, diagnostic] of Object.entries(snapshot.unavailable)) {
        if (next.has(type) || nextDiagnostics.has(type)) continue;
        nextDiagnostics.set(type, Object.freeze({ type, ...diagnostic }));
      }
      currentByType.clear();
      for (const [type, adapter] of next) currentByType.set(type, adapter);
      currentProbeDiagnosticsByType.clear();
      for (const [type, diagnostic] of nextDiagnostics) {
        currentProbeDiagnosticsByType.set(type, diagnostic);
      }
      lastSuccessfulRefreshAt = Date.now();
    } catch (error) {
      currentByType.clear();
      currentProbeDiagnosticsByType.clear();
      lastSuccessfulRefreshAt = 0;
      throw error;
    }
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/** Failed ACPX candidates from the most recent successful discovery snapshot. */
export function listAcpxAdapterProbeDiagnostics(): readonly AcpxAdapterProbeDiagnostic[] {
  return [...currentProbeDiagnosticsByType.values()].sort((left, right) =>
    left.type.localeCompare(right.type),
  );
}

export function listServerAdapters(): ServerAdapterModule[] {
  return [...currentByType.values()].sort((left, right) =>
    left.type.localeCompare(right.type),
  );
}

export function findServerAdapter(type: string): ServerAdapterModule | null {
  return currentByType.get(type) ?? null;
}
