/**
 * ACPX-supplied adapter catalog routes.
 *
 * ACPX supplies the exact agent names, model values, session settings, and
 * resolved execution contract at runtime. Paperclip exposes that observed
 * catalog but does not install, register, or maintain a parallel one.
 */

import { Router, type Response } from "express";
import {
  findActiveServerAdapter,
  findServerAdapter,
  listAcpxAdapterProbeDiagnostics,
  listServerAdapters,
  refreshAcpxAdapters,
} from "../adapters/index.js";
import type { AcpxAdapterProbeDiagnostic } from "../adapters/index.js";
import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { validateAdapterConfigSchema } from "@paperclipai/adapter-utils";
import type { EnvironmentDriver } from "@paperclipai/shared";
import { assertBoardOrgAccess, assertInstanceAdmin } from "./authz.js";

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
  /** Exact ACPX-admitted execution transports for this agent. */
  drivers: readonly EnvironmentDriver[];
  /** Exact registry name emitted by ACPX; always equal to `type`. */
  registryName: string;
}

interface UnavailableAdapterInfo {
  type: string;
  /** No label is available until ACPX successfully initializes the agent. */
  label: string;
  source: "acpx";
  modelsCount: 0;
  loaded: false;
  /** The candidate remains visible but cannot be selected or launched. */
  diagnostic: {
    code: "acpx_probe_failed";
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

function buildAdapterInfo(adapter: ServerAdapterModule): ReadyAdapterInfo {
  return {
    type: adapter.type,
    label: adapter.definition.ui.label,
    source: "acpx",
    modelsCount: adapter.definition.models.length,
    loaded: true,
    capabilities: buildAdapterCapabilities(adapter),
    drivers: [...adapter.definition.environment.drivers],
    registryName: adapter.definition.launchProfile.registryName,
  };
}

function buildUnavailableAdapterInfo(
  diagnostic: AcpxAdapterProbeDiagnostic,
): UnavailableAdapterInfo {
  return {
    type: diagnostic.type,
    // The registry name is the only trustworthy presentation value when a
    // failed probe has no ACPX-provided UI metadata.
    label: diagnostic.type,
    source: "acpx",
    modelsCount: 0,
    loaded: false,
    diagnostic: {
      code: "acpx_probe_failed",
      message: diagnostic.message,
    },
    registryName: diagnostic.type,
  };
}

function acpxCatalogOnly(res: Response): void {
  res.status(410).json({
    error:
      "Paperclip's agent catalog is supplied exclusively by ACPX. Install or authenticate an ACPX-compatible local CLI, then let the catalog refresh automatically.",
  });
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
      res.status(404).json({ error: `ACPX agent "${req.params.type}" is not available.` });
      return;
    }
    res.json(buildAdapterInfo(adapter));
  });

  /**
   * Retired: changing local-agent availability would make Paperclip a second
   * authority beside ACPX. ACPX probing is the sole admission decision.
   */
  router.patch("/adapters/:type", (req, res) => {
    assertInstanceAdmin(req);
    acpxCatalogOnly(res);
  });

  router.get("/adapters/:type/config-schema", async (req, res) => {
    assertBoardOrgAccess(req);
    await refreshAcpxAdapters();
    const adapter = findActiveServerAdapter(req.params.type);
    if (!adapter) {
      res.status(404).json({ error: `ACPX agent "${req.params.type}" is not available.` });
      return;
    }
    const parsedSchema = validateAdapterConfigSchema(
      adapter.definition.configSchema,
    );
    if (!parsedSchema.success) {
      throw new Error(`ACPX agent "${req.params.type}" returned an invalid configuration schema`);
    }
    res.json(parsedSchema.data);
  });

  // These legacy management operations would make Paperclip a second catalog
  // authority, so retain explicit migration guidance rather than silently
  // accepting package-defined agent metadata.
  router.post("/adapters/install", (req, res) => {
    assertInstanceAdmin(req);
    acpxCatalogOnly(res);
  });
  router.patch("/adapters/:type/override", (req, res) => {
    assertInstanceAdmin(req);
    acpxCatalogOnly(res);
  });
  router.delete("/adapters/:type", (req, res) => {
    assertInstanceAdmin(req);
    acpxCatalogOnly(res);
  });
  router.post("/adapters/:type/reload", (req, res) => {
    assertInstanceAdmin(req);
    acpxCatalogOnly(res);
  });
  router.post("/adapters/:type/reinstall", (req, res) => {
    assertInstanceAdmin(req);
    acpxCatalogOnly(res);
  });

  return router;
}
