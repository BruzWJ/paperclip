import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { buildOpenApiSpec, openApiRoutes } from "../routes/openapi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = path.resolve(__dirname, "../routes");

const apiPrefixes: Record<string, string> = {
  "access.ts": "/api",
  "activity.ts": "/api",
  "adapters.ts": "/api",
  "agents.ts": "/api",
  "attention.ts": "/api",
  "approvals.ts": "/api",
  "assets.ts": "/api",
  "board-chat.ts": "/api",
  "built-in-agents.ts": "/api",
  "cloud-upstreams.ts": "/api",
  "companies.ts": "/api/companies",
  "company-skills.ts": "/api",
  "company-skill-policy.ts": "/api",
  "change-consents.ts": "/api",
  "costs.ts": "/api",
  "dashboard.ts": "/api",
  "decision-training.ts": "/api",
  "environments.ts": "/api",
  "execution-workspaces.ts": "/api",
  "file-resources.ts": "/api",
  "folders.ts": "/api",
  "goals.ts": "/api",
  "health.ts": "/api/health",
  "inbox-agent-policy.ts": "/api",
  "inbox-dismissals.ts": "/api",
  "instance-database-backups.ts": "/api",
  "instance-settings.ts": "/api",
  "issues.ts": "/api",
  "issue-tree-control.ts": "/api",
  "issue-ingress.ts": "/api",
  "llms.ts": "/api",
  "openapi.ts": "/api",
  "plugin-ui-static.ts": "/api",
  "plugins.ts": "/api",
  "projects.ts": "/api",
  "resource-memberships.ts": "/api",
  "routines.ts": "/api",
  "run-tools.ts": "/api",
  "runs.ts": "/api",
  "secrets.ts": "/api",
  "sidebar-badges.ts": "/api",
  "sidebar-preferences.ts": "/api",
  "summary-slots.ts": "/api",
  "session-compactions.ts": "/api",
  "teams-catalog.ts": "/api",
  "tool-access.ts": "/api",
  "tool-gateway.ts": "/api",
  "user-profiles.ts": "/api",
};

const ROUTE_LITERAL_PATTERN = /router\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;
const ROUTER_METHOD_PATTERN = /router\.(get|post|put|patch|delete)\(/;
const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
const explicitOpenApiCoverageExclusions = new Set([
  // Pipeline routes are experimental and not yet represented in the public OpenAPI document.
  "pipelines.ts",
  // Case routes are experimental (enableCases flag) and not yet in the public OpenAPI document.
  "cases.ts",
  // Smoke lab routes are experimental and not yet represented in the public OpenAPI document.
  "smoke-lab.ts",
]);
const betterAuthOwnedRuntimeRoutes = new Set([
  "GET /api/auth/get-session",
  "POST /api/auth/update-user",
]);

function createApp() {
  const app = express();
  app.use("/api", openApiRoutes());
  app.use(errorHandler);
  return app;
}

function normalizeExpressPath(routePath: string) {
  return routePath
    .replace(/\*([A-Za-z0-9_]+)/g, "{$1}")
    .replace(/:([A-Za-z0-9_]+)/g, "{$1}")
    .replace(/\/+/g, "/");
}

function resolveMountedPath(file: string, prefix: string, routePath: string) {
  if (file === "tool-gateway.ts" && routePath.startsWith("/mcp/gateways/")) {
    return routePath;
  }
  if ((file === "companies.ts" || file === "health.ts") && routePath === "/") {
    return prefix;
  }
  if (file === "companies.ts" || file === "health.ts") {
    return `${prefix}${routePath}`;
  }
  return `${prefix}${routePath}`;
}

function loadActualRoutes() {
  // Better Auth owns the wildcard mounted by app.ts. These documented
  // operations intentionally have no competing Paperclip route module.
  const routes = new Set<string>(betterAuthOwnedRuntimeRoutes);
  const unknownRouteFiles: string[] = [];

  for (const file of fs.readdirSync(ROUTES_DIR).filter((entry) => entry.endsWith(".ts"))) {
    if (explicitOpenApiCoverageExclusions.has(file)) continue;
    const prefix = apiPrefixes[file];
    const source = fs.readFileSync(path.join(ROUTES_DIR, file), "utf8");
    if (!prefix) {
      if (ROUTER_METHOD_PATTERN.test(source)) {
        unknownRouteFiles.push(file);
      }
      continue;
    }

    for (const match of source.matchAll(ROUTE_LITERAL_PATTERN)) {
      const method = match[1].toUpperCase();
      const routePath = match[2];
      routes.add(`${method} ${normalizeExpressPath(resolveMountedPath(file, prefix, routePath))}`);
    }

    if (file === "companies.ts" && source.includes("router.post(COMPANY_IMPORT_ROUTE_PATH")) {
      routes.add("POST /api/companies/import");
    }
  }

  return { routes, unknownRouteFiles: unknownRouteFiles.sort() };
}

function loadSpecRoutes() {
  const spec = buildOpenApiSpec();
  const routes = new Set<string>();

  for (const [routePath, pathItem] of Object.entries<Record<string, Record<string, unknown>>>(spec.paths ?? {})) {
    for (const method of Object.keys(pathItem)) {
      if (HTTP_METHODS.has(method)) {
        routes.add(`${method.toUpperCase()} ${routePath}`);
      }
    }
  }

  return { spec, routes };
}

describe("openapi routes", () => {
  it("serves the generated OpenAPI document", async () => {
    const res = await request(createApp()).get("/api/openapi.json");

    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.0.0");
    expect(res.body.info.title).toBe("Paperclip API");
    expect(res.body.paths["/api/openapi.json"].get.summary).toBe("Get the generated OpenAPI document");
    expect(res.body.paths["/api/companies/{companyId}/agents"].get.summary).toBe("List agents in a company");
    expect(
      res.body.paths["/api/companies/{companyId}/runtime-agents"].post
        .requestBody.content["application/json"].schema.required,
    ).toEqual(expect.arrayContaining([
      "name",
      "title",
      "capabilities",
      "reportsTo",
      "contextGrants",
      "actionGrants",
      "mentionReachGrants",
      "companyToolIds",
    ]));
    const createToolOptionsSchema =
      res.body.paths[
        "/api/companies/{companyId}/runtime-agent-tool-options"
      ].get.responses["200"].content["application/json"].schema;
    expect(createToolOptionsSchema.items).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: expect.arrayContaining([
        "catalogEntryId",
        "connectionId",
        "connectionName",
        "title",
        "description",
        "catalogVersionHash",
      ]),
    });
    expect(
      createToolOptionsSchema.items.properties,
    ).not.toHaveProperty("connectionInstallId");
    expect(
      res.body.paths[
        "/api/agents/{id}/runtime-configuration/tool-options"
      ].get["x-paperclip-authorization"],
    ).toEqual({ actor: "board" });
    expect(
      res.body.paths["/api/agents/{id}/adapter-config-revisions"].post
        ["x-paperclip-authorization"],
    ).toEqual({ actor: "board" });
    const companySkillPinsPath =
      res.body.paths["/api/agents/{id}/company-skill-pins"];
    expect(companySkillPinsPath.get["x-paperclip-authorization"]).toEqual({
      actor: "board",
    });
    expect(companySkillPinsPath.put["x-paperclip-authorization"]).toEqual({
      actor: "board",
    });
    const companySkillPinsSchema =
      companySkillPinsPath.get.responses["200"].content[
        "application/json"
      ].schema;
    expect(companySkillPinsSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["entries", "skillChannel"],
      properties: {
        entries: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["key", "versionId"],
          },
        },
        skillChannel: {
          type: "string",
          enum: ["isolated_skills_home", "operator_native"],
        },
      },
    });
    expect(
      companySkillPinsPath.put.requestBody.content["application/json"]
        .schema,
    ).toEqual(companySkillPinsSchema);
    const adapterInfoSchema =
      res.body.paths["/api/adapters/{type}"].get.responses["200"].content[
        "application/json"
      ].schema;
    expect(adapterInfoSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: expect.arrayContaining([
        "type",
        "label",
        "source",
        "modelsCount",
        "loaded",
        "disabled",
        "capabilities",
        "registryName",
        "frontendPackage",
        "frontendVersion",
        "frontendDigest",
      ]),
      properties: {
        capabilities: {
          type: "object",
          additionalProperties: false,
          required: [
            "supportsModelProfiles",
            "contractVersion",
            "protocolVersion",
            "resume",
            "cancel",
            "sessionConfig",
            "sessionScopedMcpReplacement",
          ],
          properties: {
            supportsModelProfiles: { type: "boolean" },
            contractVersion: {
              type: "string",
              enum: ["acp-subprocess/v1"],
            },
            protocolVersion: { type: "number", enum: [1] },
            resume: { type: "boolean", enum: [true] },
            cancel: { type: "boolean", enum: [true] },
            sessionConfig: { type: "boolean", enum: [true] },
            sessionScopedMcpReplacement: {
              type: "boolean",
              enum: [true],
            },
          },
        },
      },
    });
    expect(
      res.body.paths["/api/adapters"].get.responses["200"].content[
        "application/json"
      ].schema.items,
    ).toEqual(adapterInfoSchema);

    const adapterRevisionSchema =
      res.body.paths[
        "/api/agents/{id}/adapter-config-revisions/current"
      ].get.responses["200"].content["application/json"].schema;
    expect(adapterRevisionSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        acpConfiguration: expect.any(Object),
      },
      required: expect.arrayContaining(["acpConfiguration"]),
    });
    expect(
      res.body.paths[
        "/api/agents/{id}/adapter-config-revisions"
      ].get.responses["200"].content["application/json"].schema.items,
    ).toEqual(adapterRevisionSchema);
    const createRevisionSchema =
      res.body.paths[
        "/api/agents/{id}/adapter-config-revisions"
      ].post.responses["201"].content["application/json"].schema;
    expect(createRevisionSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        revision: adapterRevisionSchema,
      },
      required: ["revision", "current", "appended"],
    });
    for (const schema of [
      adapterInfoSchema,
      adapterRevisionSchema,
      createRevisionSchema,
    ]) {
      const serialized = JSON.stringify(schema);
      expect(serialized).not.toContain("nativeCorrelationKind");
      expect(serialized).not.toContain("nativeCorrelation");
      expect(serialized).not.toContain("issue-execution-native/v1");
      expect(serialized).not.toContain("providerSelectors");
      expect(serialized).not.toContain("providerInputKind");
    }
    expect(
      res.body.paths["/api/agents/{id}/operational-configuration"].patch
        ["x-paperclip-authorization"],
    ).toEqual({ actor: "board" });
    expect(res.body.paths["/api/agents/{id}/keys"]).toBeUndefined();
    expect(res.body.paths["/api/join-requests/{requestId}/claim-api-key"]).toBeUndefined();
    expect(res.body.components.securitySchemes).toMatchObject({
      BoardSessionAuth: { type: "apiKey", in: "cookie" },
      BoardApiKeyAuth: { type: "http", scheme: "bearer" },
    });
    expect(res.body.components.securitySchemes.AgentBearerAuth).toBeUndefined();
    expect(res.body.paths["/api/health"].get.security).toEqual([]);
    expect(res.body.paths["/mcp/gateways/{gatewayPublicId}"].post.security).toEqual([]);
    expect(res.body.paths["/api/mcp/gateways/{gatewayPublicId}"]).toBeUndefined();
    expect(res.body.paths["/api/companies"].post.responses["201"]).toBeDefined();
    expect(res.body.paths["/api/companies"].post.requestBody.content["application/json"].schema).toMatchObject({
      type: "object",
      properties: {
        name: { type: "string", minLength: 1 },
      },
      required: ["name"],
    });
    expect(JSON.stringify(res.body.paths["/api/companies"].post.responses)).not.toContain("candidates");
    expect(res.body.paths["/api/companies/{companyId}/skills/scan-projects"].post.responses["200"].content[
      "application/json"
    ].schema).toMatchObject({
      type: "object",
      properties: {
        candidates: { type: "array" },
      },
      required: expect.arrayContaining(["candidates"]),
    });
    expect(res.body.paths["/api/companies/{companyId}/folders"].post.responses["201"]).toBeDefined();
    expect(res.body.paths["/api/companies/{companyId}/folders/items/move"].post.summary).toBe(
      "Move an item into or out of a folder",
    );
    // PAPERCLIP_REMOVAL_NEGATIVE_FIXTURE: /api/tool-gateway/sessions, /api/tool-gateway/sessions/{sessionId}/revoke
    expect(res.body.paths["/api/tool-gateway/sessions"]).toBeUndefined();
    expect(res.body.paths["/api/tool-gateway/sessions/{sessionId}/revoke"]).toBeUndefined();
    expect(res.body.paths["/api/tool-gateway/tools"]).toBeUndefined();
    expect(res.body.paths["/api/tool-gateway/tools/call"]).toBeUndefined();
  });

  it("covers the mounted server routes exactly", () => {
    const { routes: actualRoutes, unknownRouteFiles } = loadActualRoutes();
    const { routes: specRoutes } = loadSpecRoutes();

    const missingInSpec = [...actualRoutes].filter((route) => !specRoutes.has(route)).sort();
    const extraInSpec = [...specRoutes].filter((route) => !actualRoutes.has(route)).sort();

    expect({ unknownRouteFiles, missingInSpec, extraInSpec }).toEqual({
      unknownRouteFiles: [],
      missingInSpec: [],
      extraInSpec: [],
    });
  });

  it("documents auth and reviewed response-code invariants", () => {
    const { spec } = loadSpecRoutes();

    expect(spec.paths["/api/openapi.json"].get.security).toEqual([]);
    expect(spec.paths["/api/plugins/install"].post.security).toEqual([
      { BoardSessionAuth: [] },
      { BoardApiKeyAuth: [] },
    ]);
    expect(spec.paths["/api/plugins/install"].post["x-paperclip-authorization"]).toEqual({
      actor: "board",
      instanceAdmin: true,
    });
    expect(spec.paths["/api/execution-workspaces/{id}/reconcile-branch"].post.security).toEqual([
      { BoardSessionAuth: [] },
      { BoardApiKeyAuth: [] },
    ]);
    expect(spec.paths["/api/execution-workspaces/{id}/reconcile-branch"].post["x-paperclip-authorization"]).toEqual({
      actor: "board",
    });
    const costEventsPath =
      spec.paths["/api/companies/{companyId}/cost-events"];
    expect(costEventsPath.get.responses["200"]).toBeDefined();
    expect(costEventsPath.get.responses["401"]).toBeDefined();
    expect(costEventsPath.post).toBeUndefined();
    expect(spec.paths["/api/instance/database-backups"].post.responses["201"]).toBeDefined();
    expect(spec.paths["/api/invites/{token}/accept"].post.responses["202"]).toBeDefined();
    expect(spec.paths["/api/board-api-keys"].post.responses["201"]).toBeDefined();
    expect(spec.paths["/api/companies/import"].post.responses["202"]).toBeDefined();
  });
});
