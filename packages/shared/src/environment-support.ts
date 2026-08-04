import {
  ENVIRONMENT_DRIVERS,
  type AgentAdapterType,
  type EnvironmentDriver,
} from "./constants.js";
import type { SandboxEnvironmentProvider } from "./types/environment.js";
import type { JsonSchema, PluginEnvironmentTemplateConfigBinding } from "./types/plugin.js";

export type EnvironmentSupportStatus = "supported" | "unsupported";

/**
 * The exact environment transports admitted for each live adapter. This is a
 * runtime catalog projection supplied by ACPX through the server; it is not a
 * static statement that every Paperclip transport works for every agent.
 */
export type AdapterEnvironmentDriverCatalog = Readonly<
  Record<string, readonly EnvironmentDriver[]>
>;

export interface AdapterEnvironmentSupport {
  adapterType: AgentAdapterType;
  drivers: Record<EnvironmentDriver, EnvironmentSupportStatus>;
  sandboxProviders: Record<SandboxEnvironmentProvider, EnvironmentSupportStatus>;
}

export interface EnvironmentProviderCapability {
  status: EnvironmentSupportStatus;
  supportsSavedProbe: boolean;
  supportsUnsavedProbe: boolean;
  supportsRunExecution: boolean;
  supportsReusableLeases: boolean;
  supportsInteractiveSetup: boolean;
  interactiveSetupConnectionTypes: string[];
  supportsTemplateCapture: boolean;
  templateRefKind?: string;
  templateConfigBinding?: PluginEnvironmentTemplateConfigBinding;
  supportsTemplateDelete: boolean;
  displayName?: string;
  description?: string;
  source?: "builtin" | "plugin";
  pluginKey?: string;
  pluginId?: string;
  configSchema?: JsonSchema;
}

export interface EnvironmentCapabilities {
  adapters: AdapterEnvironmentSupport[];
  drivers: Record<EnvironmentDriver, EnvironmentSupportStatus>;
  sandboxProviders: Record<SandboxEnvironmentProvider, EnvironmentProviderCapability>;
}

export function adapterSupportsRemoteManagedEnvironments(
  adapterType: string,
  adapterDrivers: AdapterEnvironmentDriverCatalog = {},
): boolean {
  const drivers = supportedEnvironmentDriversForAdapter(adapterType, adapterDrivers);
  return drivers.includes("ssh") && drivers.includes("sandbox");
}

/**
 * Return only transports declared for this exact live ACPX adapter. Missing
 * catalog data deliberately means no supported driver: callers must refresh
 * ACPX rather than falling back to a Paperclip-maintained transport list.
 */
export function supportedEnvironmentDriversForAdapter(
  adapterType: string,
  adapterDrivers: AdapterEnvironmentDriverCatalog = {},
): EnvironmentDriver[] {
  const declared = adapterDrivers[adapterType] ?? [];
  // Preserve the platform's stable driver ordering and discard malformed or
  // future values until the shared environment contract explicitly supports
  // them. ACPX remains the only source of the membership decision.
  return ENVIRONMENT_DRIVERS.filter((driver) => declared.includes(driver));
}

export function supportedSandboxProvidersForAdapter(
  adapterType: string,
  additionalProviders: readonly string[] = [],
  adapterDrivers: AdapterEnvironmentDriverCatalog = {},
): SandboxEnvironmentProvider[] {
  return supportedEnvironmentDriversForAdapter(adapterType, adapterDrivers).includes("sandbox")
    ? Array.from(new Set(additionalProviders)) as SandboxEnvironmentProvider[]
    : [];
}

export function isEnvironmentDriverSupportedForAdapter(
  adapterType: string,
  driver: string,
  adapterDrivers: AdapterEnvironmentDriverCatalog = {},
): boolean {
  return supportedEnvironmentDriversForAdapter(adapterType, adapterDrivers).includes(driver as EnvironmentDriver);
}

export function isSandboxProviderSupportedForAdapter(
  adapterType: string,
  provider: string | null | undefined,
  additionalProviders: readonly string[] = [],
  adapterDrivers: AdapterEnvironmentDriverCatalog = {},
): boolean {
  if (!provider) return false;
  return supportedSandboxProvidersForAdapter(adapterType, additionalProviders, adapterDrivers).includes(
    provider as SandboxEnvironmentProvider,
  );
}

export function getAdapterEnvironmentSupport(
  adapterType: AgentAdapterType,
  additionalSandboxProviders: readonly string[] = [],
  adapterDrivers: AdapterEnvironmentDriverCatalog = {},
): AdapterEnvironmentSupport {
  const supportedDrivers = new Set(
    supportedEnvironmentDriversForAdapter(adapterType, adapterDrivers),
  );
  const supportedProviders = new Set(
    supportedSandboxProvidersForAdapter(
      adapterType,
      additionalSandboxProviders,
      adapterDrivers,
    ),
  );
  const sandboxProviders: Record<SandboxEnvironmentProvider, EnvironmentSupportStatus> = {
    fake: "unsupported",
  };
  for (const provider of additionalSandboxProviders) {
    sandboxProviders[provider as SandboxEnvironmentProvider] = supportedProviders.has(provider as SandboxEnvironmentProvider)
      ? "supported"
      : "unsupported";
  }
  return {
    adapterType,
    drivers: {
      local: supportedDrivers.has("local") ? "supported" : "unsupported",
      ssh: supportedDrivers.has("ssh") ? "supported" : "unsupported",
      sandbox: supportedDrivers.has("sandbox") ? "supported" : "unsupported",
      plugin: supportedDrivers.has("plugin") ? "supported" : "unsupported",
    },
    sandboxProviders,
  };
}

export function getEnvironmentCapabilities(
  adapterTypes: readonly AgentAdapterType[],
  options: {
    adapterDrivers?: AdapterEnvironmentDriverCatalog;
    sandboxProviders?: Record<string, Partial<EnvironmentProviderCapability>>;
  } = {},
): EnvironmentCapabilities {
  const pluginProviderKeys = Object.keys(options.sandboxProviders ?? {});
  const sandboxProviders: Record<SandboxEnvironmentProvider, EnvironmentProviderCapability> = {
    fake: {
      status: "unsupported",
      supportsSavedProbe: true,
      supportsUnsavedProbe: true,
      supportsRunExecution: false,
      supportsReusableLeases: true,
      supportsInteractiveSetup: false,
      interactiveSetupConnectionTypes: [],
      supportsTemplateCapture: false,
      supportsTemplateDelete: false,
      displayName: "Fake",
      source: "builtin",
    },
  };
  for (const [provider, capability] of Object.entries(options.sandboxProviders ?? {})) {
    sandboxProviders[provider as SandboxEnvironmentProvider] = {
      status: capability.status ?? "supported",
      supportsSavedProbe: capability.supportsSavedProbe ?? true,
      supportsUnsavedProbe: capability.supportsUnsavedProbe ?? true,
      supportsRunExecution: capability.supportsRunExecution ?? true,
      supportsReusableLeases: capability.supportsReusableLeases ?? true,
      supportsInteractiveSetup: capability.supportsInteractiveSetup ?? false,
      interactiveSetupConnectionTypes: capability.interactiveSetupConnectionTypes ?? [],
      supportsTemplateCapture: capability.supportsTemplateCapture ?? false,
      templateRefKind: capability.templateRefKind,
      templateConfigBinding: capability.templateConfigBinding,
      supportsTemplateDelete: capability.supportsTemplateDelete ?? false,
      displayName: capability.displayName,
      description: capability.description,
      source: capability.source ?? "plugin",
      pluginKey: capability.pluginKey,
      pluginId: capability.pluginId,
      configSchema: capability.configSchema,
    };
  }
  const adapters = adapterTypes.map((adapterType) =>
    getAdapterEnvironmentSupport(
      adapterType,
      pluginProviderKeys,
      options.adapterDrivers,
    ),
  );
  const supportedDrivers = new Set<EnvironmentDriver>();
  for (const adapter of adapters) {
    for (const driver of ENVIRONMENT_DRIVERS) {
      if (adapter.drivers[driver] === "supported") {
        supportedDrivers.add(driver);
      }
    }
  }
  return {
    adapters,
    drivers: {
      local: supportedDrivers.has("local") ? "supported" : "unsupported",
      ssh: supportedDrivers.has("ssh") ? "supported" : "unsupported",
      sandbox: supportedDrivers.has("sandbox") ? "supported" : "unsupported",
      plugin: supportedDrivers.has("plugin") ? "supported" : "unsupported",
    },
    sandboxProviders,
  };
}
