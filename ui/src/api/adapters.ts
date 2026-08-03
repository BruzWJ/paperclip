/**
 * @fileoverview Frontend client for the immutable server-admitted ACP catalog.
 */

import { api } from "./client";

export interface AdapterCapabilities {
  supportsModelProfiles: boolean;
  contractVersion: "acp-subprocess/v1";
  protocolVersion: 1;
  resume: boolean;
  cancel: boolean;
  sessionConfig: boolean;
  sessionScopedMcpReplacement: boolean;
}

export interface AdapterInfo {
  type: string;
  label: string;
  modelsCount: number;
  loaded: boolean;
  capabilities: AdapterCapabilities;
  registryName: string;
  frontendPackage: string;
  frontendVersion: string;
  frontendDigest: string;
}

export const adaptersApi = {
  /** List the exact declarative ACP entries admitted by the server. */
  list: () => api.get<AdapterInfo[]>("/adapters"),
};
