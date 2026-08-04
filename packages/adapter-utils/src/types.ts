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
  /**
   * `null` preserves the target's explicit absence of token-limit metadata.
   * Paperclip must not infer limits from a model name or another catalog.
   */
  limits: AdapterModelLimits | null;
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
  /**
   * ACPX advertised a string setting without a closed value list. Paperclip
   * preserves its generic value verbatim and lets ACPX validate it at
   * readiness/execution time; it never invents provider-specific choices.
   */
  readonly freeform?: true;
}

/**
 * Durable ACPX reference. Command argv belongs to ACPX and is resolved only
 * when a target is prepared, never copied into Paperclip configuration.
 */
export interface AcpAdapterLaunchProfile {
  readonly registryName: string;
}

export interface AcpAdapterEnvironmentRequirements {
  readonly cwd: "execution-workspace";
  readonly additionalDirectories: "authorized-workspace-only";
  readonly drivers: readonly ("local" | "ssh" | "sandbox" | "plugin")[];
  /** Exact non-secret variables required by the frontend; empty is valid. */
  readonly environmentKeys: readonly string[];
}

/** Exact public ACPX controls observed during this agent's disposable probe. */
export interface AcpAdapterRuntimeContract {
  readonly controls: readonly string[];
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
  /**
   * Paperclip's durable contract is supplied and executed by ACPX. The
   * historical ACP subprocess wire fixtures remain private implementation
   * details and are not this public revision ABI.
   */
  readonly version: "acpx-runtime/v1";
  readonly launchProfile: AcpAdapterLaunchProfile;
  readonly environment: AcpAdapterEnvironmentRequirements;
  /** Dynamic ACPX runtime controls; never a Paperclip capability declaration. */
  readonly runtime: AcpAdapterRuntimeContract;
  readonly ui: AcpAdapterUiMetadata;
  readonly configSchema: AdapterConfigSchema;
  readonly configOptions: readonly AcpAdapterConfigOption[];
  /** Null when the ACPX target does not expose a configurable model option. */
  readonly modelConfigOptionId: string | null;
  readonly models: readonly AdapterModel[];
  readonly modelProfiles: readonly AdapterModelProfileDefinition[];
  readonly configurationDoc: string;
}

/** Canonical immutable adapter/config portion of one execution revision. */
export interface AcpAdapterRevisionConfiguration {
  readonly contractVersion: "acpx-runtime/v1";
  readonly launchProfile: AcpAdapterLaunchProfile;
  readonly sessionConfigSelections: readonly AcpSessionConfigSelection[];
  /** Null when ACPX does not report a selected model for this agent. */
  readonly model: AdapterModel | null;
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
