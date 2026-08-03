// ---------------------------------------------------------------------------
// Minimal adapter-facing interfaces (no drizzle dependency)
// ---------------------------------------------------------------------------

import type {
  AcpSessionConfigSelection,
  AcpSessionConfigValue,
} from "./acp-subprocess/contract.js";

export interface AdapterRuntimeServiceReport {
  id?: string | null;
  projectId?: string | null;
  projectWorkspaceId?: string | null;
  issueId?: string | null;
  scopeType?: "project_workspace" | "execution_workspace" | "run" | "agent";
  scopeId?: string | null;
  serviceName: string;
  status?: "starting" | "running" | "stopped" | "failed";
  lifecycle?: "shared" | "ephemeral";
  reuseKey?: string | null;
  command?: string | null;
  cwd?: string | null;
  port?: number | null;
  url?: string | null;
  providerRef?: string | null;
  ownerAgentId?: string | null;
  stopPolicy?: Record<string, unknown> | null;
  healthStatus?: "unknown" | "healthy" | "unhealthy";
}

/** Immutable token limits for one advertised ACP model selection. */
export interface AdapterModelLimits {
  contextTokenLimit: number;
  /**
   * Present only when the ACP target advertises an independent input cap.
   * Absence is retained and never reconstructed from another limit.
   */
  inputTokenLimit?: number;
  outputTokenLimit: number;
}

/**
 * One model/profile selection accepted by the ACP target's required model
 * configuration option. `value` is passed unchanged to
 * `session/set_config_option`; Paperclip never parses it as a provider id.
 */
export interface AdapterModel {
  id: string;
  label: string;
  value: string;
  limits: AdapterModelLimits;
}

export type AdapterModelProfileKey = "cheap";

export interface AdapterModelProfileDefinition {
  key: AdapterModelProfileKey;
  label: string;
  description?: string;
  modelId: string;
}

// ---------------------------------------------------------------------------
// Adapter config schema — declarative UI config for server-admitted ACP adapters
// ---------------------------------------------------------------------------

export interface ConfigFieldOption {
  label: string;
  value: string;
  /** Optional group key for categorizing options (e.g. provider name) */
  group?: string;
}

export interface ConfigFieldSchema {
  key: string;
  label: string;
  type: "text" | "select" | "toggle" | "number" | "textarea" | "combobox";
  options?: readonly ConfigFieldOption[];
  default?: unknown;
  hint?: string;
  required?: boolean;
  group?: string;
  /** Optional metadata — not rendered, but available to custom UI logic */
  meta?: Record<string, unknown>;
}

export interface AdapterConfigSchema {
  fields: readonly ConfigFieldSchema[];
}

export interface AcpAdapterConfigValue {
  readonly value: AcpSessionConfigValue;
  readonly label: string;
}

/** One closed mapping from an operator-visible field to a stable ACP option. */
export interface AcpAdapterConfigOption {
  readonly id: string;
  readonly configKey: string;
  readonly label: string;
  readonly required: true;
  readonly values: readonly AcpAdapterConfigValue[];
}

/** Immutable command facts admitted by the ACPX registry wrapper. */
export interface AcpAdapterLaunchProfile {
  readonly registryName: string;
  /** Exact executable name resolved natively on the selected target. */
  readonly targetNativeCli: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly frontendPackage: string;
  readonly frontendVersion: string;
  readonly frontendDigest: string;
}

export interface AcpAdapterEnvironmentRequirements {
  readonly cwd: "execution-workspace";
  readonly additionalDirectories: "authorized-workspace-only";
  readonly drivers: readonly ("local" | "ssh" | "sandbox" | "plugin")[];
  /** Exact non-secret variables required by the frontend; empty is valid. */
  readonly environmentKeys: readonly string[];
}

export interface AcpAdapterReadinessFacts {
  readonly protocolVersion: 1;
  readonly resume: true;
  readonly cancel: true;
  readonly sessionConfig: true;
  readonly sessionScopedMcpReplacement: true;
  readonly cliNativeAuthentication: true;
}

export interface AcpAdapterUiMetadata {
  readonly label: string;
  readonly description: string;
  readonly recommended?: boolean;
}

/**
 * Complete declarative AI-adapter definition. It owns no invocation callback,
 * prompt builder, parser, session codec, credential hook, or provider SDK.
 */
export interface AcpSubprocessAdapterDefinition {
  readonly version: "acp-subprocess/v1";
  readonly launchProfile: AcpAdapterLaunchProfile;
  readonly environment: AcpAdapterEnvironmentRequirements;
  readonly readiness: AcpAdapterReadinessFacts;
  readonly ui: AcpAdapterUiMetadata;
  readonly configSchema: AdapterConfigSchema;
  readonly configOptions: readonly AcpAdapterConfigOption[];
  readonly modelConfigOptionId: string;
  readonly models: readonly AdapterModel[];
  readonly modelProfiles: readonly AdapterModelProfileDefinition[];
  readonly configurationDoc: string;
}

/** Canonical immutable adapter/config portion of one execution revision. */
export interface AcpAdapterRevisionConfiguration {
  readonly contractVersion: "acp-subprocess/v1";
  readonly launchProfile: AcpAdapterLaunchProfile;
  readonly sessionConfigSelections: readonly AcpSessionConfigSelection[];
  readonly model: AdapterModel;
}

/** The adapter ABI contains one closed declarative ACP definition and nothing else. */
export interface ServerAdapterModule {
  readonly type: string;
  readonly definition: AcpSubprocessAdapterDefinition;
}

// ---------------------------------------------------------------------------
// UI config form values (moved from ui/src/components/AgentConfigForm.tsx)
// ---------------------------------------------------------------------------

export interface CreateConfigValues {
  adapterType: string;
  /**
   * Optional cheap model profile config for new agents on adapters that
   * support model profiles. Persisted under
   * `runtimeConfig.modelProfiles.cheap.adapterConfig`, never on the primary
   * `adapterConfig`.
  */
  cheapModel?: string;
  cheapModelEnabled?: boolean;
  workspaceStrategyType?: string;
  workspaceBaseRef?: string;
  workspaceBranchTemplate?: string;
  worktreeParentDir?: string;
  runtimeServicesJson?: string;
  defaultEnvironmentId?: string;
  /** Arbitrary key-value pairs populated by schema-driven config fields. */
  adapterSchemaValues?: Record<string, unknown>;
  timeoutSec?: number;
}
