import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { AGENT_ICON_NAMES } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { listServerAdapters, refreshAcpxAdapters } from "../adapters/index.js";
import { assertBoard } from "./authz.js";

export function llmRoutes(_db: Db) {
  const router = Router();

  async function assertCanRead(req: Request) {
    assertBoard(req);
  }

  router.get("/llms/agent-configuration.txt", async (req, res) => {
    await assertCanRead(req);
    await refreshAcpxAdapters();
    const adapters = listServerAdapters().sort((a, b) => a.type.localeCompare(b.type));
    const lines = [
      "# Paperclip Agent Configuration Index",
      "",
      "ACPX-discovered agents:",
      ...adapters.map((adapter) => `- ${adapter.type}: /llms/agent-configuration/${adapter.type}.txt`),
      "",
      "Related API endpoints:",
      "- GET /api/companies/:companyId/agent-configurations",
      "- GET /api/agents/:id/configuration",
      "- POST /api/companies/:companyId/runtime-agents",
      "- GET /api/companies/:companyId/runtime-agent-tool-options",
      "- GET/PATCH /api/agents/:id/runtime-configuration",
      "- GET /api/agents/:id/runtime-configuration/tool-options",
      "- GET/POST /api/agents/:id/adapter-config-revisions",
      "- PATCH /api/agents/:id/operational-configuration",
      "",
      "Agent identity references:",
      "- GET /llms/agent-icons.txt",
      "",
      "Notes:",
      "- Sensitive values are redacted in configuration read APIs.",
      "- Runtime-agent identity and grants, adapter/provider revisions, and operational fields have separate write contracts.",
      "- Agents run only from persisted issue-execution references. Recurring work must be modeled as a routine that creates ordinary issues.",
      "",
    ];
    res.type("text/plain").send(lines.join("\n"));
  });

  router.get("/llms/agent-icons.txt", async (req, res) => {
    await assertCanRead(req);
    const lines = [
      "# Paperclip Agent Icon Names",
      "",
      "Set `icon` through PATCH /api/agents/:id/operational-configuration to one of:",
      ...AGENT_ICON_NAMES.map((name) => `- ${name}`),
      "",
      "Example:",
      '{ "name": "SearchOps", "title": "Researcher", "icon": "search" }',
      "",
    ];
    res.type("text/plain").send(lines.join("\n"));
  });

  router.get("/llms/agent-configuration/:adapterType.txt", async (req, res) => {
    await assertCanRead(req);
    await refreshAcpxAdapters();
    const adapterType = req.params.adapterType as string;
    const adapter = listServerAdapters().find((entry) => entry.type === adapterType);
    if (!adapter) {
      res.status(404).type("text/plain").send(`Unknown adapter type: ${adapterType}`);
      return;
    }
    res
      .type("text/plain")
      .send(adapter.definition.configurationDoc);
  });

  return router;
}
