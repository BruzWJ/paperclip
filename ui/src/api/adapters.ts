/**
 * @fileoverview Frontend client for the immutable ACPX-supplied agent catalog.
 */

import { api } from "./client";
import type { EnvironmentDriver } from "@paperclipai/shared";

export interface AdapterCapabilities {
  supportsModelProfiles: boolean;
  contractVersion: "acpx-runtime/v1";
  /** Exact public ACPX controls observed by the server's local probe. */
  runtimeControls: readonly string[];
}

export interface ReadyAdapterInfo {
  type: string;
  label: string;
  source: "acpx";
  modelsCount: number;
  loaded: true;
  capabilities: AdapterCapabilities;
  /** Exact execution transports admitted for this agent by ACPX. */
  drivers: readonly EnvironmentDriver[];
  registryName: string;
}

/**
 * A name listed by ACPX whose disposable local probe or dynamic-contract
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
  /** List the exact ACPX-supplied entries admitted by the server. */
  list: () => api.get<AdapterInfo[]>("/adapters"),
};
