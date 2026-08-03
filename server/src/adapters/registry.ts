import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  sameAdapterModel,
  validateAdapterModel,
  validateServerAdapterModule,
  type AdapterModel,
  type AdapterModelProfileDefinition,
  type ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import {
  resolveApprovedAcpLaunch,
  sameApprovedAcpLaunch,
} from "@paperclipai/adapter-utils/acp-subprocess";
import {
  adapterImplementationIdentityKey,
  freezeAdapterImplementationIdentity,
  isAdapterImplementationIdentity,
  type AdapterImplementationIdentity,
} from "@paperclipai/shared";
import { getDisabledAdapterTypes } from "../services/adapter-plugin-store.js";
import { BUILTIN_ADAPTER_CATALOG } from "./builtin-adapter-catalog.js";
import { BUILTIN_ADAPTER_TYPES } from "./builtin-adapter-types.js";
import {
  buildExternalAdapters,
  buildRetainedExternalAdapters,
} from "./plugin-loader.js";
import {
  attachedAdapterImplementationIdentity,
  attachAdapterImplementationIdentity,
  createAdapterImplementationIdentity,
  digestAdapterArtifact,
  digestServerAdapterModule,
} from "./implementation-identity.js";

export interface RegisteredServerAdapterImplementation {
  readonly identity: Readonly<AdapterImplementationIdentity>;
  readonly identityKey: string;
  readonly adapter: ServerAdapterModule;
}

export interface RegisterServerAdapterOptions {
  /**
   * Tests and non-package hosts may supply a host-computed identity. Installed
   * packages receive one from plugin-loader and built-ins are registered by
   * the server build.
   */
  identity?: AdapterImplementationIdentity;
  /** Retained historical implementations register without changing selection. */
  selectable?: boolean;
}

const implementationsByIdentity = new Map<
  string,
  RegisteredServerAdapterImplementation
>();
const builtinIdentityByType = new Map<string, string>();
const selectedExternalIdentityByType = new Map<string, string>();
const pausedOverrides = new Set<string>();

function assertApprovedLaunch(adapter: ServerAdapterModule): void {
  const declared = adapter.definition.launchProfile;
  const approved = resolveApprovedAcpLaunch(declared.registryName);
  if (!sameApprovedAcpLaunch(declared, approved)) {
    throw new Error(
      `Adapter ${adapter.type} launch does not match its approved ACP registry entry`,
    );
  }
}

function freezeImplementationValue(
  value: unknown,
  seen = new WeakSet<object>(),
): void {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return;
  }
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      freezeImplementationValue(child, seen);
    }
    Object.freeze(value);
  }
}

function implementationByKey(
  key: string | undefined,
): RegisteredServerAdapterImplementation | null {
  return key ? implementationsByIdentity.get(key) ?? null : null;
}

function rawSelectedImplementation(
  type: string,
): RegisteredServerAdapterImplementation | null {
  return (
    implementationByKey(selectedExternalIdentityByType.get(type)) ??
    implementationByKey(builtinIdentityByType.get(type))
  );
}

function activeSelectedImplementation(
  type: string,
): RegisteredServerAdapterImplementation | null {
  if (pausedOverrides.has(type)) {
    return implementationByKey(builtinIdentityByType.get(type));
  }
  return rawSelectedImplementation(type);
}

function registerImplementation(
  adapter: ServerAdapterModule,
  identity: AdapterImplementationIdentity,
  options: {
    builtin: boolean;
    selectable: boolean;
  },
): RegisteredServerAdapterImplementation {
  const validated = validateServerAdapterModule(adapter);
  assertApprovedLaunch(validated);
  if (
    !isAdapterImplementationIdentity(identity) ||
    identity.adapterType !== validated.type ||
    (options.builtin ? identity.origin !== "builtin" : identity.origin !== "external")
  ) {
    throw new Error(
      `Adapter implementation identity does not match ${validated.type}`,
    );
  }
  const frozenIdentity = freezeAdapterImplementationIdentity(identity);
  attachAdapterImplementationIdentity(validated, frozenIdentity);
  freezeImplementationValue(validated);
  const identityKey = adapterImplementationIdentityKey(frozenIdentity);
  const existing = implementationsByIdentity.get(identityKey);
  const registered =
    existing ??
    Object.freeze({
      identity: frozenIdentity,
      identityKey,
      adapter: validated,
    });
  if (!existing) implementationsByIdentity.set(identityKey, registered);

  if (options.builtin) {
    const current = builtinIdentityByType.get(validated.type);
    if (current && current !== identityKey) {
      throw new Error(
        `Built-in adapter ${validated.type} was registered with two build identities`,
      );
    }
    builtinIdentityByType.set(validated.type, identityKey);
  } else if (options.selectable) {
    selectedExternalIdentityByType.set(validated.type, identityKey);
  }
  return registered;
}

function serverBuildMetadata(): { packageName: string; version: string } {
  const adaptersDir = path.dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = path.resolve(adaptersDir, "../../package.json");
  const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  if (
    typeof parsed.name !== "string" ||
    !parsed.name ||
    typeof parsed.version !== "string" ||
    !parsed.version
  ) {
    throw new Error("Server package metadata cannot identify built-in adapters");
  }
  return { packageName: parsed.name, version: parsed.version };
}

function registerBuiltInAdapters(): void {
  const serverMetadata = serverBuildMetadata();
  for (const entry of BUILTIN_ADAPTER_CATALOG) {
    if (entry.adapterType !== entry.adapter.type) {
      throw new Error(
        `Built-in adapter catalog type mismatch: ${entry.adapterType}`,
      );
    }
    const metadata =
      entry.packageName === serverMetadata.packageName
        ? serverMetadata
        : (() => {
            const parsed = JSON.parse(
              fs.readFileSync(
                path.join(entry.packageRoot, "package.json"),
                "utf8",
              ),
            ) as { name?: unknown; version?: unknown };
            if (
              parsed.name !== entry.packageName ||
              typeof parsed.version !== "string" ||
              !parsed.version
            ) {
              throw new Error(
                `Built-in adapter package metadata does not match ${entry.adapterType}`,
              );
            }
            return {
              packageName: entry.packageName,
              version: parsed.version,
            };
          })();
    const identity = createAdapterImplementationIdentity({
      adapterType: entry.adapterType,
      origin: "builtin",
      packageName: metadata.packageName,
      packageVersion: metadata.version,
      buildIdentity: `${metadata.packageName}@${metadata.version}:${entry.adapterType}`,
      artifactDigest: digestAdapterArtifact(entry.packageRoot),
    });
    registerImplementation(entry.adapter, identity, {
      builtin: true,
      selectable: true,
    });
  }
}

registerBuiltInAdapters();

function getDisabledAdapterTypesFromStore(): string[] {
  return getDisabledAdapterTypes();
}

const externalAdaptersReady: Promise<void> = (async () => {
  try {
    const retainedAdapters = await buildRetainedExternalAdapters();
    for (const retainedAdapter of retainedAdapters) {
      registerServerAdapter(retainedAdapter, { selectable: false });
    }
    const externalAdapters = await buildExternalAdapters();
    for (const externalAdapter of externalAdapters) {
      const overriding = BUILTIN_ADAPTER_TYPES.has(
        externalAdapter.type,
      );
      if (overriding) {
        console.log(
          `[paperclip] External adapter "${externalAdapter.type}" overrides built-in adapter`,
        );
      }
      registerServerAdapter(externalAdapter);
    }
  } catch (error) {
    console.error(
      "[paperclip] Failed to load external adapters:",
      error,
    );
  }
})();

export function waitForExternalAdapters(): Promise<void> {
  return externalAdaptersReady;
}

export function registerServerAdapter(
  adapter: ServerAdapterModule,
  options: RegisterServerAdapterOptions = {},
): RegisteredServerAdapterImplementation {
  const validated = validateServerAdapterModule(adapter);
  const attached = attachedAdapterImplementationIdentity(validated);
  const identity =
    options.identity ??
    attached ??
    createAdapterImplementationIdentity({
      adapterType: validated.type,
      origin: "external",
      packageName: `runtime-registration:${validated.type}`,
      packageVersion: "0.0.0-unpackaged",
      buildIdentity: `runtime-registration:${validated.type}`,
      artifactDigest: digestServerAdapterModule(validated),
    });
  if (identity.origin !== "external") {
    throw new Error("Public adapter registration accepts only external implementations");
  }
  return registerImplementation(validated, identity, {
    builtin: false,
    selectable: options.selectable !== false,
  });
}

export function unregisterServerAdapter(type: string): void {
  selectedExternalIdentityByType.delete(type);
  pausedOverrides.delete(type);
}

export function requireServerAdapter(
  type: string,
): ServerAdapterModule {
  const adapter = findActiveServerAdapter(type);
  if (!adapter) {
    throw new Error(`Unknown adapter type: ${type}`);
  }
  return adapter;
}

export function findServerAdapterImplementation(
  adapterType: string,
  identity: AdapterImplementationIdentity,
): RegisteredServerAdapterImplementation | null {
  if (
    !isAdapterImplementationIdentity(identity) ||
    identity.adapterType !== adapterType
  ) {
    return null;
  }
  return (
    implementationsByIdentity.get(
      adapterImplementationIdentityKey(identity),
    ) ?? null
  );
}

export function requireServerAdapterImplementation(
  adapterType: string,
  identity: AdapterImplementationIdentity,
): ServerAdapterModule {
  const implementation = findServerAdapterImplementation(
    adapterType,
    identity,
  );
  if (!implementation) {
    const digest =
      isAdapterImplementationIdentity(identity)
        ? identity.artifactDigest
        : "invalid-identity";
    throw new Error(
      `Unavailable pinned adapter implementation: ${adapterType} (${digest})`,
    );
  }
  return implementation.adapter;
}

export function isServerAdapterImplementationAvailable(
  adapterType: string,
  identity: AdapterImplementationIdentity,
): boolean {
  return findServerAdapterImplementation(adapterType, identity) !== null;
}

export function findSelectableServerAdapterImplementation(
  type: string,
): RegisteredServerAdapterImplementation | null {
  if (getDisabledAdapterTypesFromStore().includes(type)) return null;
  return activeSelectedImplementation(type);
}

export function listServerAdapterImplementations():
  readonly RegisteredServerAdapterImplementation[] {
  return Array.from(implementationsByIdentity.values());
}

export async function listAdapterModels(
  type: string,
): Promise<AdapterModel[]> {
  const implementation = activeSelectedImplementation(type);
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

/**
 * Resolve one exact model selection from the active declarative ACP catalog.
 */
export async function resolveAvailableAdapterModel(
  modelId: string,
): Promise<AdapterModel> {
  if (!modelId || modelId !== modelId.trim()) {
    throw new Error(
      "Company model id must be an exact non-empty catalog key",
    );
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
    throw new Error(
      "Company model id is not available in the registered ACP catalog",
    );
  }
  const model = candidates[0]!;
  if (
    candidates.some(
      (candidate) => !sameAdapterModel(candidate, model),
    )
  ) {
    throw new Error(
      "Company model id is ambiguous across registered ACP catalogs",
    );
  }
  return model;
}

export async function listAdapterModelProfiles(
  type: string,
): Promise<AdapterModelProfileDefinition[]> {
  const adapter = findActiveServerAdapter(type);
  if (!adapter) return [];
  return [...adapter.definition.modelProfiles];
}

export function listServerAdapters(): ServerAdapterModule[] {
  const types = new Set([
    ...builtinIdentityByType.keys(),
    ...selectedExternalIdentityByType.keys(),
  ]);
  return Array.from(types)
    .map((type) => rawSelectedImplementation(type)?.adapter ?? null)
    .filter((adapter): adapter is ServerAdapterModule => adapter !== null);
}

export function listEnabledServerAdapters(): ServerAdapterModule[] {
  const disabled = getDisabledAdapterTypesFromStore();
  const disabledSet =
    disabled.length > 0 ? new Set(disabled) : null;
  return listServerAdapters()
    .map((adapter) => activeSelectedImplementation(adapter.type)?.adapter ?? null)
    .filter(
      (adapter): adapter is ServerAdapterModule =>
        adapter !== null && (!disabledSet || !disabledSet.has(adapter.type)),
    );
}

export function setOverridePaused(
  type: string,
  paused: boolean,
): boolean {
  if (
    !builtinIdentityByType.has(type) ||
    !selectedExternalIdentityByType.has(type)
  ) {
    return false;
  }
  const wasPaused = pausedOverrides.has(type);
  if (paused && !wasPaused) {
    pausedOverrides.add(type);
    console.log(
      `[paperclip] Override paused for "${type}" — builtin adapter restored`,
    );
    return true;
  }
  if (!paused && wasPaused) {
    pausedOverrides.delete(type);
    console.log(
      `[paperclip] Override resumed for "${type}" — external adapter active`,
    );
    return true;
  }
  return false;
}

export function isOverridePaused(type: string): boolean {
  return pausedOverrides.has(type);
}

export function getPausedOverrides(): Set<string> {
  return pausedOverrides;
}

export function findServerAdapter(
  type: string,
): ServerAdapterModule | null {
  return rawSelectedImplementation(type)?.adapter ?? null;
}

export function findActiveServerAdapter(
  type: string,
): ServerAdapterModule | null {
  return activeSelectedImplementation(type)?.adapter ?? null;
}

/**
 * Disabled adapters remain addressable for already-persisted revisions but
 * cannot be selected for new canonical configuration.
 */
export function findSelectableServerAdapter(
  type: string,
): ServerAdapterModule | null {
  return findSelectableServerAdapterImplementation(type)?.adapter ?? null;
}
