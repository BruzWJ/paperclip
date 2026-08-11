/**
 * ACPX-supplied adapter catalog routes.
 *
 * ACPX supplies the exact agent names, model values, session settings, and
 * resolved execution contract at runtime. Paperclip exposes that observed
 * catalog but does not install, register, or maintain a parallel one.
 */

import { Router } from "express";
import {
  findServerAdapter,
  listAcpxAdapterProbeDiagnostics,
  listServerAdapters,
  refreshAcpxAdapters,
} from "../adapters/index.js";
import type { AcpxAdapterProbeDiagnostic } from "../adapters/index.js";
import type {
  AdapterConfigSchema,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import { validateAdapterConfigSchema } from "@paperclipai/adapter-utils";
import { assertBoardOrgAccess } from "./authz.js";

interface AdapterCapabilities {
  supportsModelProfiles: boolean;
  contractVersion: "acpx-runtime/v1";
  /** Exact public ACPX controls observed for this agent. */
  runtimeControls: readonly string[];
}

interface ReadyAdapterInfo {
  type: string;
  label: string;
  source: "acpx";
  modelsCount: number;
  loaded: true;
  capabilities: AdapterCapabilities;
  /** Exact registry name emitted by ACPX; always equal to `type`. */
  registryName: string;
  /**
   * Exact generic session-setting schema discovered with this catalog entry.
   * Keeping it in the catalog makes the picker and its fields one ACPX
   * snapshot instead of triggering a separate refresh after selection.
   */
  configSchema: AdapterConfigSchema;
}

interface UnavailableAdapterInfo {
  type: string;
  /** No ACPX display label is trusted until the candidate is admitted. */
  label: string;
  source: "acpx";
  modelsCount: 0;
  loaded: false;
  /** The candidate remains visible but cannot be selected or launched. */
  diagnostic: {
    code: "acpx_probe_failed" | "acpx_catalog_invalid";
    message: string;
  };
  /** Exact registry name emitted by ACPX; always equal to `type`. */
  registryName: string;
}

type AdapterInfo = ReadyAdapterInfo | UnavailableAdapterInfo;

function buildAdapterCapabilities(adapter: ServerAdapterModule): AdapterCapabilities {
  return {
    supportsModelProfiles: adapter.definition.modelProfiles.length > 0,
    contractVersion: adapter.definition.version,
    runtimeControls: [...adapter.definition.runtime.controls],
  };
}

function adapterConfigSchema(adapter: ServerAdapterModule): AdapterConfigSchema {
  const parsedSchema = validateAdapterConfigSchema(
    adapter.definition.configSchema,
  );
  if (!parsedSchema.success) {
    throw new Error(`Local agent "${adapter.type}" returned an invalid configuration schema`);
  }
  return parsedSchema.data;
}

function buildAdapterInfo(adapter: ServerAdapterModule): ReadyAdapterInfo {
  return {
    type: adapter.type,
    label: adapter.definition.ui.label,
    source: "acpx",
    modelsCount: adapter.definition.models.length,
    loaded: true,
    capabilities: buildAdapterCapabilities(adapter),
    registryName: adapter.definition.launchProfile.registryName,
    configSchema: adapterConfigSchema(adapter),
  };
}

function buildUnavailableAdapterInfo(
  diagnostic: AcpxAdapterProbeDiagnostic,
): UnavailableAdapterInfo {
  return {
    type: diagnostic.type,
    // The registry name is the only trustworthy presentation value when an
    // ACPX probe or projected dynamic contract cannot be admitted.
    label: diagnostic.type,
    source: "acpx",
    modelsCount: 0,
    loaded: false,
    diagnostic: {
      code: diagnostic.code,
      message: diagnostic.code === "acpx_catalog_invalid"
        ? "This local agent returned an invalid runtime configuration contract."
        : "This local agent did not pass its readiness check.",
    },
    registryName: diagnostic.type,
  };
}

export function adapterRoutes() {
  const router = Router();

  router.get("/adapters", async (req, res) => {
    assertBoardOrgAccess(req);
    await refreshAcpxAdapters();
    res.json(
      [
        ...listServerAdapters().map((adapter) => buildAdapterInfo(adapter)),
        ...listAcpxAdapterProbeDiagnostics().map(buildUnavailableAdapterInfo),
      ]
        .sort((left, right) => left.type.localeCompare(right.type)),
    );
  });

  router.get("/adapters/:type", async (req, res) => {
    assertBoardOrgAccess(req);
    await refreshAcpxAdapters();
    const adapter = findServerAdapter(req.params.type);
    if (!adapter) {
      res.status(404).json({ error: `Local agent "${req.params.type}" is not available.` });
      return;
    }
    res.json(buildAdapterInfo(adapter));
  });

  router.get("/adapters/:type/config-schema", async (req, res) => {
    assertBoardOrgAccess(req);
    await refreshAcpxAdapters();
    const adapter = findServerAdapter(req.params.type);
    if (!adapter) {
      res.status(404).json({ error: `Local agent "${req.params.type}" is not available.` });
      return;
    }
    res.json(adapterConfigSchema(adapter));
  });

  return router;
}
