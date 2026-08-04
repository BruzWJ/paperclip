import {
  listAcpRegistryAgentNames,
  loadConfiguredAcpRegistry,
  type AcpxAgentDiscovery,
  type AcpxDiscoveredConfigOption,
  type AcpxDiscoveredConfigOptionValue,
  type AcpAgentRegistry,
  probeAcpxAgent,
} from "@paperclipai/adapter-utils/acp-subprocess";
import type {
  AcpAdapterConfigOption,
  AdapterModel,
  ConfigFieldOption,
  ConfigFieldSchema,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import { validateServerAdapterModule } from "@paperclipai/adapter-utils";

const DISCOVERY_CONCURRENCY = 4;

type SelectableOption = {
  readonly kind: "select";
  readonly source: AcpxDiscoveredConfigOption;
  readonly values: readonly AcpxDiscoveredConfigOptionValue[];
} | {
  readonly kind: "toggle";
  readonly source: AcpxDiscoveredConfigOption;
  readonly values: readonly [];
  readonly booleanCurrentValue: boolean;
} | {
  readonly kind: "text";
  readonly source: AcpxDiscoveredConfigOption;
  readonly values: readonly [];
  readonly stringCurrentValue?: string;
};

function exactValues(option: AcpxDiscoveredConfigOption): readonly AcpxDiscoveredConfigOptionValue[] {
  const seen = new Set<string>();
  const values: AcpxDiscoveredConfigOptionValue[] = [];
  for (const entry of option.options) {
    const candidates = entry.kind === "group" ? entry.options : [entry];
    for (const candidate of candidates) {
      if (seen.has(candidate.value)) continue;
      seen.add(candidate.value);
      values.push(candidate);
    }
  }
  return Object.freeze(values);
}

function selectableOptions(
  discovery: AcpxAgentDiscovery,
): readonly SelectableOption[] {
  return Object.freeze(
    discovery.configOptions
      .flatMap((source): readonly SelectableOption[] => {
        if (
          source.type === "boolean" &&
          typeof source.currentValue === "boolean"
        ) {
          return [{
            kind: "toggle",
            source,
            values: [],
            booleanCurrentValue: source.currentValue,
          }];
        }
        // ACPX's public option ABI may grow new string-valued types. A closed
        // value list is still a select regardless of its upstream type name;
        // otherwise preserve it as generic text instead of dropping a setting
        // or assigning provider-specific semantics in Paperclip.
        const values = exactValues(source);
        if (values.length > 0) {
          return [{ kind: "select", source, values }];
        }
        if (source.type !== "boolean") {
          return [{
            kind: "text",
            source,
            values: [],
            ...(typeof source.currentValue === "string"
              ? { stringCurrentValue: source.currentValue }
              : {}),
          }];
        }
        return [];
      }),
  );
}

function modelOption(
  discovery: AcpxAgentDiscovery,
  options: readonly SelectableOption[],
): SelectableOption | null {
  // Prefer ACPX's own semantic annotation when it supplies one. This remains
  // entirely dynamic, while allowing an ACPX-resolved frontend to expose a model option
  // whose visible values are a stricter subset of status.models.
  const categorised = options.filter(
    (option) =>
      option.kind === "select" && option.source.category === "model",
  );
  if (categorised.length === 1) return categorised[0]!;
  if (discovery.models.length === 0) return null;
  const expected = new Set(discovery.models);
  const matches = options.filter((option) => {
    if (option.kind !== "select") return false;
    const { values } = option;
    const actual = new Set(values.map((value) => value.value));
    return (
      actual.size === expected.size &&
      [...expected].every((value) => actual.has(value))
    );
  });
  return matches.length === 1 ? matches[0]! : null;
}

function fieldOptions(
  option: SelectableOption,
): readonly ConfigFieldOption[] {
  if (option.kind !== "select") return Object.freeze([]);
  return Object.freeze(
    option.values.map((value) =>
      Object.freeze({
        label: value.name,
        value: value.value,
      }),
    ),
  );
}

function configSchemaField(option: SelectableOption): ConfigFieldSchema {
  if (option.kind === "toggle") {
    return Object.freeze({
      key: option.source.id,
      label: option.source.name,
      type: "toggle",
      default: option.booleanCurrentValue,
      ...(option.source.description ? { hint: option.source.description } : {}),
      required: true,
    });
  }
  if (option.kind === "text") {
    return Object.freeze({
      key: option.source.id,
      label: option.source.name,
      type: "text",
      ...(option.stringCurrentValue === undefined
        ? {}
        : { default: option.stringCurrentValue }),
      ...(option.source.description ? { hint: option.source.description } : {}),
      required: true,
    });
  }
  const defaultValue =
    typeof option.source.currentValue === "string" &&
    option.values.some((value) => value.value === option.source.currentValue)
      ? option.source.currentValue
      : undefined;
  return Object.freeze({
    key: option.source.id,
    label: option.source.name,
    type: "select",
    options: fieldOptions(option),
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
    ...(option.source.description ? { hint: option.source.description } : {}),
    required: true,
  });
}

function configOption(option: SelectableOption): AcpAdapterConfigOption {
  if (option.kind === "toggle") {
    return Object.freeze({
      id: option.source.id,
      configKey: option.source.id,
      label: option.source.name,
      required: true,
      values: Object.freeze([
        Object.freeze({ value: false, label: "Disabled" }),
        Object.freeze({ value: true, label: "Enabled" }),
      ]),
    });
  }
  if (option.kind === "text") {
    return Object.freeze({
      id: option.source.id,
      configKey: option.source.id,
      label: option.source.name,
      required: true,
      values: Object.freeze([]),
      freeform: true,
    });
  }
  return Object.freeze({
    id: option.source.id,
    configKey: option.source.id,
    label: option.source.name,
    required: true,
    values: Object.freeze(
      option.values.map((value) =>
        Object.freeze({ label: value.name, value: value.value }),
      ),
    ),
  });
}

function modelsFor(
  model: SelectableOption | null,
): readonly AdapterModel[] {
  if (!model || model.kind !== "select") return Object.freeze([]);
  return Object.freeze(
    model.values.map((value) =>
      Object.freeze({
        id: value.value,
        label: value.name,
        value: value.value,
        // ACPX supplies no portable context-window contract. Never infer one.
        limits: null,
      }),
    ),
  );
}

/**
 * Converts an ACPX probe result into Paperclip's data-only UI/configuration
 * contract. Every agent name, option, option value, model, and default comes
 * from ACPX; Paperclip only supervises the ACPX-supplied execution boundary.
 */
export function acpxDiscoveryToServerAdapter(
  discovery: AcpxAgentDiscovery,
): ServerAdapterModule {
  const options = selectableOptions(discovery);
  const selectedModelOption = modelOption(discovery, options);
  const models = modelsFor(selectedModelOption);
  return Object.freeze({
    type: discovery.agentName,
    definition: Object.freeze({
      version: "acpx-runtime/v1",
      launchProfile: Object.freeze({ registryName: discovery.agentName }),
      environment: Object.freeze({
        cwd: "execution-workspace",
        additionalDirectories: "authorized-workspace-only",
        // ACPX's public runtime owns the local provider-CLI lifecycle. It has
        // no Paperclip-managed remote transport contract, so advertise only
        // the execution target ACPX can actually launch from this host.
        drivers: Object.freeze(["local"] as const),
        environmentKeys: Object.freeze([]),
      }),
      runtime: Object.freeze({
        // This is the exact public control list ACPX returned for the
        // temporary agent session. It intentionally makes no Paperclip claim
        // about provider-native resume, cancellation, or authentication.
        controls: Object.freeze([...discovery.controls]),
      }),
      ui: Object.freeze({
        label: discovery.agentName,
        description: "Discovered from the local ACPX runtime.",
      }),
      configSchema: Object.freeze({
        fields: Object.freeze(options.map(configSchemaField)),
      }),
      configOptions: Object.freeze(options.map(configOption)),
      modelConfigOptionId: selectedModelOption?.source.id ?? null,
      models,
      modelProfiles: Object.freeze([]),
      configurationDoc:
        "This agent and its configuration are supplied by ACPX at runtime.",
    }),
  });
}

async function mapConcurrent<T, U>(
  values: readonly T[],
  mapper: (value: T) => Promise<U>,
): Promise<readonly U[]> {
  const results: U[] = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = cursor;
      cursor += 1;
      const value = values[index];
      if (value === undefined) return;
      results[index] = await mapper(value);
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(DISCOVERY_CONCURRENCY, values.length) },
      () => worker(),
    ),
  );
  return Object.freeze(results);
}

export type AcpxCatalogDiagnosticCode =
  | "acpx_probe_failed"
  | "acpx_catalog_invalid";

export interface AcpxCatalogDiagnostic {
  readonly code: AcpxCatalogDiagnosticCode;
  readonly message: string;
}

export interface AcpxCatalogSnapshot {
  readonly adapters: readonly ServerAdapterModule[];
  readonly unavailable: Readonly<Record<string, AcpxCatalogDiagnostic>>;
}

type AcpxCatalogCandidate = {
  readonly agentName: string;
  readonly adapter: ServerAdapterModule | null;
  readonly diagnostic: AcpxCatalogDiagnostic | null;
};

function candidateDiagnostic(
  code: AcpxCatalogDiagnosticCode,
  error: unknown,
): AcpxCatalogDiagnostic {
  return Object.freeze({
    code,
    message: error instanceof Error
      ? error.message
      : "ACPX candidate could not be admitted",
  });
}

/**
 * Probes every explicitly configured ACPX agent and retains only successful
 * ACPX-resolved session initialization. Failed candidates remain diagnostic metadata rather
 * than selectable Paperclip agents.
 */
export async function discoverLocalAcpxAdapterCatalog(
  cwd = process.cwd(),
  suppliedRegistry?: AcpAgentRegistry,
): Promise<AcpxCatalogSnapshot> {
  const registry = suppliedRegistry ?? await loadConfiguredAcpRegistry({ cwd });
  const names = listAcpRegistryAgentNames(registry);
  const probes = await mapConcurrent<
    string,
    AcpxCatalogCandidate
  >(names, async (agentName) => {
    let discovery: AcpxAgentDiscovery;
    try {
      discovery = await probeAcpxAgent({
        cwd,
        agentName,
        dependencies: { createAgentRegistry: () => registry },
      });
      if (!discovery.controls.includes("session/status")) {
        throw new Error("ACPX runtime does not advertise session/status");
      }
      if (
        discovery.configOptions.length > 0 &&
        !discovery.controls.includes("session/set_config_option")
      ) {
        throw new Error(
          "ACPX runtime does not advertise session/set_config_option for its discovered settings",
        );
      }
    } catch (error) {
      return {
        agentName,
        adapter: null,
        diagnostic: candidateDiagnostic("acpx_probe_failed", error),
      };
    }

    try {
      // Validate the generated, data-only Paperclip projection while this
      // candidate is still isolated. A malformed ACPX advertisement must not
      // erase otherwise healthy dynamically discovered agents.
      const adapter = validateServerAdapterModule(
        acpxDiscoveryToServerAdapter(discovery),
      );
      return {
        agentName,
        adapter,
        diagnostic: null,
      };
    } catch (error) {
      return {
        agentName,
        adapter: null,
        diagnostic: candidateDiagnostic("acpx_catalog_invalid", error),
      };
    }
  });
  const unavailable: Record<string, AcpxCatalogDiagnostic> = {};
  const adapters: ServerAdapterModule[] = [];
  for (const probe of probes) {
    if (probe.adapter) {
      adapters.push(probe.adapter);
    } else if (probe.diagnostic) {
      unavailable[probe.agentName] = probe.diagnostic;
    }
  }
  return Object.freeze({
    adapters: Object.freeze(
      adapters.sort((left, right) => left.type.localeCompare(right.type)),
    ),
    unavailable: Object.freeze(unavailable),
  });
}
