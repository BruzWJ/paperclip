import { createHash } from "node:crypto";
import {
  sameAdapterModel,
  validateAdapterModel,
  validateServerAdapterModule,
  type AdapterModel,
  type AdapterModelProfileDefinition,
  type ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import {
  assertAcpRegistryAgentName,
  loadAcpxAgentRegistry,
  type AcpAgentRegistry,
} from "@paperclipai/adapter-utils/acp-subprocess";
import {
  adapterImplementationIdentityKey,
  isAdapterImplementationIdentity,
  sameAdapterImplementationIdentity,
  type AdapterImplementationIdentity,
} from "@paperclipai/shared";
import {
  discoverLocalAcpxAdapterCatalog,
  type AcpxCatalogDiagnosticCode,
} from "./acpx-catalog.js";

export interface RegisteredServerAdapterImplementation {
  readonly identity: Readonly<AdapterImplementationIdentity>;
  readonly identityKey: string;
  readonly adapter: ServerAdapterModule;
}

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

/**
 * Kept as a source-compatible type for integrations compiled against older
 * Paperclip versions. ACPX is now the only selectable catalog supplier, so
 * runtime registration is intentionally rejected below.
 */
export interface RegisterServerAdapterOptions {
  readonly identity?: AdapterImplementationIdentity;
  readonly selectable?: boolean;
}

const ACPX_CATALOG_REFRESH_INTERVAL_MS = 30_000;

const currentByType = new Map<string, RegisteredServerAdapterImplementation>();
const currentProbeDiagnosticsByType = new Map<
  string,
  AcpxAdapterProbeDiagnostic
>();
let refreshInFlight: Promise<void> | null = null;
let lastSuccessfulRefreshAt = 0;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new Error("ACPX identity input must be JSON-serializable");
}

function acpxRuntimeIdentity(
  adapter: ServerAdapterModule,
): AdapterImplementationIdentity {
  const artifactDigest = createHash("sha256")
    .update(
      canonicalJson({
        version: "paperclip/acpx-runtime/v3",
        adapter: adapter.definition,
      }),
      "utf8",
    )
    .digest("hex");
  return Object.freeze({
    adapterType: adapter.type,
    definitionVersion: "acpx-runtime/v1",
    protocolVersion: 1,
    // ACPX owns the agent metadata, launch argv, settings, and execution
    // contract. `builtin` is legacy identity vocabulary for Paperclip's
    // supervisor, not a claim that this is a built-in agent catalog.
    origin: "builtin",
    packageName: "acpx",
    packageVersion: "runtime",
    buildIdentity: `acpx-runtime:${adapter.type}:${artifactDigest.slice(0, 16)}`,
    artifactDigest,
  });
}

function assertAcpxRegistryDefinition(
  adapter: ServerAdapterModule,
  registry: AcpAgentRegistry,
): ServerAdapterModule {
  const validated = validateServerAdapterModule(adapter);
  if (validated.type !== validated.definition.launchProfile.registryName) {
    throw new Error(
      `Adapter ${validated.type} must use its exact ACPX registry name`,
    );
  }
  // Exact membership prevents ACPX's raw-command fallback from becoming a
  // Paperclip surface. The runtime retains ownership of the resolved command
  // and argv; Paperclip fingerprints only ACPX's discovered definition.
  assertAcpRegistryAgentName(validated.type, registry);
  return validated;
}

function createDiscoveredAcpxAdapter(
  adapter: ServerAdapterModule,
  registry: AcpAgentRegistry,
): RegisteredServerAdapterImplementation {
  const validated = assertAcpxRegistryDefinition(adapter, registry);
  const identity = acpxRuntimeIdentity(validated);
  const registered = Object.freeze({
    identity,
    identityKey: adapterImplementationIdentityKey(identity),
    adapter: validated,
  });
  return registered;
}

function acpxCandidateDiagnostic(
  type: string,
  error: unknown,
): AcpxAdapterProbeDiagnostic {
  return Object.freeze({
    type,
    code: "acpx_catalog_invalid",
    message: error instanceof Error
      ? error.message
      : "ACPX candidate could not be admitted",
  });
}

/**
 * Re-probes locally installed agents supplied by ACPX's registry. A short successful-snapshot cache
 * prevents every board repaint from opening temporary ACPX-resolved sessions
 * while still making newly configured/authenticated CLIs appear automatically.
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
      const cwd = process.cwd();
      const registry = await loadAcpxAgentRegistry({ cwd });
      const snapshot = await discoverLocalAcpxAdapterCatalog(cwd, registry);
      const next = new Map<string, RegisteredServerAdapterImplementation>();
      const nextDiagnostics = new Map<string, AcpxAdapterProbeDiagnostic>();
      for (const adapter of snapshot.adapters) {
        try {
          const registered = createDiscoveredAcpxAdapter(adapter, registry);
          next.set(registered.adapter.type, registered);
        } catch (error) {
          // The discovery projection validates each candidate already. Keep
          // this admission fence as a second containment boundary so an
          // unexpected malformed candidate never hides healthy ACPX agents.
          nextDiagnostics.set(
            adapter.type,
            acpxCandidateDiagnostic(adapter.type, error),
          );
        }
      }
      for (const [type, diagnostic] of Object.entries(snapshot.unavailable)) {
        // A successful probe always wins should an upstream supplier ever emit
        // contradictory data for one exact registry name.
        if (next.has(type) || nextDiagnostics.has(type)) continue;
        nextDiagnostics.set(
          type,
          Object.freeze({ type, ...diagnostic }),
        );
      }
      currentByType.clear();
      for (const [type, implementation] of next) {
        currentByType.set(type, implementation);
      }
      currentProbeDiagnosticsByType.clear();
      for (const [type, diagnostic] of nextDiagnostics) {
        currentProbeDiagnosticsByType.set(type, diagnostic);
      }
      lastSuccessfulRefreshAt = Date.now();
    } catch (error) {
      // A registry/config reload is part of the ACPX authority boundary. Do
      // not keep a stale successful snapshot selectable if ACPX can no longer
      // supply the current catalog.
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

/** Historical startup name. It now initializes the ACPX-supplied catalog. */
export function waitForExternalAdapters(): Promise<void> {
  return refreshAcpxAdapters({ force: true });
}

/**
 * Paperclip no longer accepts declarative adapter packages as catalog input.
 * Agent names, models, and configuration must be observed from ACPX instead.
 */
export function registerServerAdapter(
  _adapter: ServerAdapterModule,
  _options: RegisterServerAdapterOptions = {},
): RegisteredServerAdapterImplementation {
  throw new Error(
    "Paperclip discovers compatible local agents automatically; install and authenticate the local CLI instead of registering an adapter package",
  );
}

/** No-op compatibility shim: ACPX discovery owns the current catalog. */
export function unregisterServerAdapter(_type: string): void {}

function currentImplementation(
  type: string,
): RegisteredServerAdapterImplementation | null {
  return currentByType.get(type) ?? null;
}

function dynamicIdentityMatches(
  type: string,
  identity: AdapterImplementationIdentity,
): boolean {
  const current = currentImplementation(type);
  return (
    current !== null &&
    sameAdapterImplementationIdentity(current.identity, identity)
  );
}

export function findServerAdapterImplementation(
  adapterType: string,
  identity: AdapterImplementationIdentity,
): RegisteredServerAdapterImplementation | null {
  if (
    !isAdapterImplementationIdentity(identity) ||
    !dynamicIdentityMatches(adapterType, identity)
  ) {
    return null;
  }
  return currentImplementation(adapterType);
}

export function requireServerAdapterImplementation(
  adapterType: string,
  identity: AdapterImplementationIdentity,
): ServerAdapterModule {
  const implementation = findServerAdapterImplementation(adapterType, identity);
  if (!implementation) {
    const digest = isAdapterImplementationIdentity(identity)
      ? identity.artifactDigest
      : "invalid-identity";
    throw new Error(
      `Unavailable local agent implementation: ${adapterType} (${digest})`,
    );
  }
  return implementation.adapter;
}

/**
 * A historical revision remains executable only when the exact current
 * ACPX-supplied launch-and-settings identity still matches. ACPX decides
 * whether the CLI is available and what it executes; the immutable identity
 * prevents a stale or tampered revision from silently
 * becoming executable merely because its registry name reappeared.
 */
export function isServerAdapterImplementationAvailable(
  adapterType: string,
  identity: AdapterImplementationIdentity,
): boolean {
  return (
    isAdapterImplementationIdentity(identity) &&
    dynamicIdentityMatches(adapterType, identity)
  );
}

export function findSelectableServerAdapterImplementation(
  type: string,
): RegisteredServerAdapterImplementation | null {
  return currentImplementation(type);
}

export function listServerAdapterImplementations(): readonly RegisteredServerAdapterImplementation[] {
  return [...currentByType.values()];
}

/**
 * Lists failed ACPX candidates from the most recent successful discovery
 * snapshot. They are intentionally separate from executable adapter entries.
 */
export function listAcpxAdapterProbeDiagnostics(): readonly AcpxAdapterProbeDiagnostic[] {
  return [...currentProbeDiagnosticsByType.values()].sort((left, right) =>
    left.type.localeCompare(right.type),
  );
}

export async function listAdapterModels(type: string): Promise<AdapterModel[]> {
  const implementation = currentImplementation(type);
  if (!implementation) return [];
  return implementation.adapter.definition.models.map((model) =>
    validateAdapterModel(model),
  );
}

export async function listAdapterModelsForImplementation(
  type: string,
  identity: AdapterImplementationIdentity,
): Promise<AdapterModel[]> {
  const implementation = findServerAdapterImplementation(type, identity);
  if (!implementation) return [];
  return implementation.adapter.definition.models.map((model) =>
    validateAdapterModel(model),
  );
}

/** Resolve one exact model selection from the current ACPX catalog. */
export async function resolveAvailableAdapterModel(
  modelId: string,
): Promise<AdapterModel> {
  if (!modelId || modelId !== modelId.trim()) {
    throw new Error("Company model id must be an exact non-empty catalog key");
  }
  const candidates = (
    await Promise.all(
      listEnabledServerAdapters().map(async (adapter) =>
        (await listAdapterModels(adapter.type)).filter(
          (model) => model.id === modelId,
        ),
      ),
    )
  ).flat();
  if (candidates.length === 0) {
    throw new Error("Company model id is not available in the current local agent catalog");
  }
  const model = candidates[0]!;
  if (candidates.some((candidate) => !sameAdapterModel(candidate, model))) {
    throw new Error("Company model id is ambiguous across local agents");
  }
  return model;
}

export async function listAdapterModelProfiles(
  type: string,
): Promise<AdapterModelProfileDefinition[]> {
  const adapter = findServerAdapter(type);
  return adapter ? [...adapter.definition.modelProfiles] : [];
}

export function listServerAdapters(): ServerAdapterModule[] {
  return [...currentByType.values()]
    .map((implementation) => implementation.adapter)
    .sort((left, right) => left.type.localeCompare(right.type));
}

export function listEnabledServerAdapters(): ServerAdapterModule[] {
  return listServerAdapters();
}

/** ACPX has no Paperclip override layer. */
export function setOverridePaused(_type: string, _paused: boolean): boolean {
  return false;
}

/** ACPX has no Paperclip override layer. */
export function isOverridePaused(_type: string): boolean {
  return false;
}

/** ACPX has no Paperclip override layer. */
export function getPausedOverrides(): Set<string> {
  return new Set();
}

export function findServerAdapter(type: string): ServerAdapterModule | null {
  return currentImplementation(type)?.adapter ?? null;
}

export function findActiveServerAdapter(type: string): ServerAdapterModule | null {
  return findServerAdapter(type);
}

export function findSelectableServerAdapter(type: string): ServerAdapterModule | null {
  return findSelectableServerAdapterImplementation(type)?.adapter ?? null;
}

export function requireServerAdapter(type: string): ServerAdapterModule {
  const adapter = findActiveServerAdapter(type);
  if (!adapter) throw new Error(`Unknown local agent type: ${type}`);
  return adapter;
}
