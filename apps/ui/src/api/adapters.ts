/**
 * @fileoverview Frontend client for the immutable local-agent catalog.
 */

import { api } from "./client";
import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import type {
  AgentAdapterConfigurationTestInput,
  AgentAdapterConfigurationTestResult,
  EnvironmentDriver,
} from "@paperclipai/shared";

export interface AdapterCapabilities {
  supportsModelProfiles: boolean;
  contractVersion: "acpx-runtime/v1";
  /** Exact public runtime controls observed by the server's local check. */
  runtimeControls: readonly string[];
}

export interface ReadyAdapterInfo {
  type: string;
  label: string;
  source: "acpx";
  modelsCount: number;
  loaded: true;
  capabilities: AdapterCapabilities;
  /** Exact execution transports admitted for this agent by the server. */
  drivers: readonly EnvironmentDriver[];
  registryName: string;
  /** Exact generic session settings discovered in the same ACPX snapshot. */
  configSchema: AdapterConfigSchema;
}

/**
 * A listed name whose disposable local check or dynamic-contract
 * admission failed. It is intentionally visible for operator diagnosis but
 * never becomes a picker option or executable adapter in Paperclip.
 */
export interface UnavailableAdapterInfo {
  type: string;
  label: string;
  source: "acpx";
  modelsCount: 0;
  loaded: false;
  diagnostic: {
    code: "acpx_probe_failed" | "acpx_catalog_invalid";
    message: string;
  };
  registryName: string;
}

export type AdapterInfo = ReadyAdapterInfo | UnavailableAdapterInfo;

export const adaptersApi = {
  /** List the exact local-agent entries admitted by the server. */
  list: () => api.get<AdapterInfo[]>("/adapters"),
  /**
   * Apply one unsaved generic configuration to a disposable, no-prompt runtime
   * session. This does not persist an agent or claim workspace readiness.
   */
  testConfiguration: (
    companyId: string,
    adapterType: string,
    input: AgentAdapterConfigurationTestInput,
  ) =>
    api.post<AgentAdapterConfigurationTestResult>(
      `/companies/${encodeURIComponent(companyId)}/adapters/${encodeURIComponent(adapterType)}/test-configuration`,
      input,
    ),
};
