/**
 * ACPX-supplied adapter catalog routes.
 *
 * ACPX supplies the exact agent names, model values, session settings, and
 * resolved execution contract at runtime. Paperclip exposes that observed
 * catalog but does not install, register, or maintain a parallel one.
 */

import { Router } from "express";
import {
  listAcpxAdapterProbeDiagnostics,
  listServerAdapters,
  refreshAcpxAdapters,
  type AcpxAdapterProbeDiagnostic,
} from "../adapters/index.js";
import type { AcpAdapterConfigOption, ServerAdapterModule } from "@paperclipai/adapter-utils";
import { assertBoardOrgAccess } from "./authz.js";

interface AdapterCapabilities {
  contractVersion: "acpx-runtime/v1";
  /** Exact public ACPX controls observed for this agent. */
  runtimeControls: readonly string[];
}

interface ReadyAdapterInfo {
  type: string;
  label: string;
  modelsCount: number;
  loaded: true;
  capabilities: AdapterCapabilities;
  /** Exact native ACPX session options from this catalog snapshot. */
  configOptions: readonly AcpAdapterConfigOption[];
}

interface UnavailableAdapterInfo {
  type: string;
  /** No ACPX display label is trusted until the candidate is admitted. */
  label: string;
  modelsCount: 0;
  loaded: false;
  /** The candidate remains visible but cannot be selected or launched. */
  diagnostic: {
    code: "acpx_probe_failed" | "acpx_catalog_invalid";
    message: string;
  };
}

function buildAdapterCapabilities(adapter: ServerAdapterModule): AdapterCapabilities {
  return {
    contractVersion: adapter.definition.version,
    runtimeControls: [...adapter.definition.runtime.controls],
  };
}

function buildAdapterInfo(adapter: ServerAdapterModule): ReadyAdapterInfo {
  return {
    type: adapter.type,
    label: adapter.definition.ui.label,
    modelsCount: adapter.definition.models.length,
    loaded: true,
    capabilities: buildAdapterCapabilities(adapter),
    configOptions: adapter.definition.configOptions,
  };
}

function buildUnavailableAdapterInfo(diagnostic: AcpxAdapterProbeDiagnostic): UnavailableAdapterInfo {
  return {
    type: diagnostic.type,
    // The registry name is the only trustworthy presentation value when an
    // ACPX probe or projected dynamic contract cannot be admitted.
    label: diagnostic.type,
    modelsCount: 0,
    loaded: false,
    diagnostic: {
      code: diagnostic.code,
      message:
        diagnostic.code === "acpx_catalog_invalid"
          ? "This local agent returned an invalid runtime configuration contract."
          : "This local agent did not pass its readiness check.",
    },
  };
}

export function adapterRoutes() {
  const router = Router({ caseSensitive: true, strict: true });

  router.get("/adapters", async (req, res) => {
    assertBoardOrgAccess(req);
    await refreshAcpxAdapters();
    res.json(
      [
        ...listServerAdapters().map((adapter) => buildAdapterInfo(adapter)),
        ...listAcpxAdapterProbeDiagnostics().map(buildUnavailableAdapterInfo),
      ].sort((left, right) => left.type.localeCompare(right.type)),
    );
  });

  return router;
}
