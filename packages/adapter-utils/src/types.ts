// ---------------------------------------------------------------------------
// Minimal adapter-facing interfaces (no drizzle dependency)
// ---------------------------------------------------------------------------

import type {
  AcpSessionConfigSelection,
} from "./acpx-runtime/contract.js";

/**
 * One model selection accepted by the ACP target's required model
 * configuration option. `value` is passed unchanged to
 * `session/set_config_option`; Paperclip never parses it as a provider id.
 */
export interface AdapterModel {
  /** Exact opaque value advertised and accepted by ACPX. */
  value: string;
  label: string;
}

export interface AcpAdapterSelectValue {
  readonly value: string;
  readonly label: string;
}

interface AcpAdapterConfigOptionBase {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

/** One native text setting advertised by ACPX. */
export interface AcpAdapterTextConfigOption
  extends AcpAdapterConfigOptionBase {
  readonly type: "text";
  readonly currentValue?: string;
}

/** One native closed string selection advertised by ACPX. */
export interface AcpAdapterSelectConfigOption
  extends AcpAdapterConfigOptionBase {
  readonly type: "select";
  readonly currentValue?: string;
  readonly values: readonly AcpAdapterSelectValue[];
}

/** One native boolean setting advertised by ACPX. */
export interface AcpAdapterToggleConfigOption
  extends AcpAdapterConfigOptionBase {
  readonly type: "toggle";
  readonly currentValue: boolean;
}

/**
 * The sole board-facing adapter option contract. It is a direct, closed
 * projection of ACPX session options and is also the source used to validate
 * immutable `sessionConfigSelections`.
 */
export type AcpAdapterConfigOption =
  | AcpAdapterTextConfigOption
  | AcpAdapterSelectConfigOption
  | AcpAdapterToggleConfigOption;

/**
 * Durable ACPX reference. Command argv belongs to ACPX and is resolved only
 * when a target is prepared, never copied into Paperclip configuration.
 */
export interface AcpAdapterLaunchProfile {
  readonly registryName: string;
}

/** Exact public ACPX controls observed during this agent's disposable probe. */
export interface AcpAdapterRuntimeContract {
  readonly controls: readonly string[];
}

export interface AcpAdapterUiMetadata {
  readonly label: string;
}

/**
 * Complete declarative AI-adapter definition. It owns no invocation callback,
 * prompt builder, parser, session codec, credential hook, or provider SDK.
 */
export interface AcpxAdapterDefinition {
  /**
   * Paperclip's durable contract is supplied and executed by ACPX. The
   * ACPX runtime fixtures remain private implementation
   * details and are not this public revision ABI.
   */
  readonly version: "acpx-runtime/v1";
  readonly launchProfile: AcpAdapterLaunchProfile;
  /** Dynamic ACPX runtime controls; never a Paperclip capability declaration. */
  readonly runtime: AcpAdapterRuntimeContract;
  readonly ui: AcpAdapterUiMetadata;
  readonly configOptions: readonly AcpAdapterConfigOption[];
  /** Null when the ACPX target does not expose a configurable model option. */
  readonly modelConfigOptionId: string | null;
  /** Selectable models, or one ACPX-reported fixed current model. */
  readonly models: readonly AdapterModel[];
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
  readonly definition: AcpxAdapterDefinition;
}

// ---------------------------------------------------------------------------
// UI config form values (moved from apps/ui/src/features/agents/configuration/AgentConfigForm.tsx)
// ---------------------------------------------------------------------------

export interface CreateConfigValues {
  adapterType: string;
  /** Exact ACPX session option values keyed by the advertised option id. */
  adapterSchemaValues?: Record<string, string | boolean>;
}
