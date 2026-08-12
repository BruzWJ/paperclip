import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { CANONICAL_UUID_RE } from "@paperclipai/shared";
import { errorHandler } from "../middleware/index.js";
import { buildOpenApiDocument, openApiRoutes } from "../routes/openapi.js";

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
  "built-in-agents.ts": "/api",
  "companies.ts": "/api/companies",
  "change-consents.ts": "/api",
  "costs.ts": "/api",
  "dashboard.ts": "/api",
  "folders.ts": "/api",
  "goals.ts": "/api",
  "health.ts": "/api/health",
  "inbox-agent-policy.ts": "/api",
  "inbox-dismissals.ts": "/api",
  "instance-settings.ts": "/api",
  "tasks.ts": "/api",
  "task-tree-control.ts": "/api",
  "task-ingress.ts": "/api",
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
  "user-profiles.ts": "/api",
};

const ROUTE_LITERAL_PATTERN = /router\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;
const ROUTER_METHOD_PATTERN = /router\.(get|post|put|patch|delete)\(/;
const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
/**
 * These are protocol/document delivery surfaces rather than Paperclip REST
 * operations. MCP publishes its own tools/list schema and the installer is a
 * public shell/PowerShell script endpoint, so neither belongs in OpenAPI.
 */
const explicitOpenApiCoverageExclusions = new Set<string>([
  "board-mcp.ts",
  "board-mcp-setup.ts",
]);
const betterAuthOwnedRuntimeRoutes = new Set([
  "GET /api/auth/get-session",
  "POST /api/auth/update-user",
]);
const retiredRoutePrefixes = [
  "/api/board/chat",
  "/api/cases/",
  "/api/cloud-upstreams",
  "/api/companies/{companyId}/cases",
  "/api/companies/{companyId}/decision-training",
  "/api/companies/{companyId}/environments",
  "/api/companies/{companyId}/execution-workspaces",
  "/api/companies/{companyId}/pipelines",
  "/api/companies/{companyId}/smoke-lab",
  "/api/companies/{companyId}/summary-slots",
  "/api/companies/{companyId}/tools",
  "/api/environments/",
  "/api/decision-training/",
  "/api/execution-workspaces/",
  "/api/tasks/{taskId}/external-object",
  "/api/mcp/gateways",
  "/api/runs/{runId}/watchdog-decisions",
  "/api/tool-gateway/",
] as const;

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

    if (file === "companies.ts" && source.includes("router.post(COMPANY_IMPORTS_ROUTE_PATH")) {
      routes.add("POST /api/companies/imports");
    }
  }

  return { routes, unknownRouteFiles: unknownRouteFiles.sort() };
}

function loadSpecRoutes() {
  const spec = buildOpenApiDocument();
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
      "instruction",
      "contextGrants",
      "actionGrants",
      "mentionReachGrants",
    ]));
    expect(
      res.body.paths["/api/agents/{id}/adapter-config-revisions"].post
        ["x-paperclip-authorization"],
    ).toEqual({ actor: "board" });
    const [readyAdapterInfoSchema, unavailableAdapterInfoSchema] =
      res.body.paths["/api/adapters"].get.responses["200"].content[
        "application/json"
      ].schema.items.oneOf;
    expect(readyAdapterInfoSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: expect.arrayContaining([
        "type",
        "label",
        "modelsCount",
        "loaded",
        "capabilities",
        "configOptions",
      ]),
      properties: {
        configOptions: expect.objectContaining({
          type: "array",
        }),
        capabilities: {
          type: "object",
          additionalProperties: false,
          required: [
            "contractVersion",
            "runtimeControls",
          ],
          properties: {
            contractVersion: {
              type: "string",
              enum: ["acpx-runtime/v1"],
            },
            runtimeControls: {
              type: "array",
              items: {
                type: "string",
                minLength: 1,
              },
            },
          },
        },
      },
    });
    expect(
      readyAdapterInfoSchema.required,
    ).not.toContain("disabled");
    expect(unavailableAdapterInfoSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: expect.arrayContaining([
        "type",
        "label",
        "modelsCount",
        "loaded",
        "diagnostic",
      ]),
      properties: {
        loaded: { type: "boolean", enum: [false] },
        diagnostic: {
          type: "object",
          additionalProperties: false,
          required: ["code", "message"],
          properties: {
            code: { type: "string", enum: ["acpx_probe_failed", "acpx_catalog_invalid"] },
            message: { type: "string" },
          },
        },
      },
    });
    expect(res.body.paths["/api/adapters/{type}"]).toBeUndefined();

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
      adapterRevisionSchema,
      createRevisionSchema,
    ]) {
      const serialized = JSON.stringify(schema);
      expect(serialized).not.toContain("nativeCorrelationKind");
      expect(serialized).not.toContain("nativeCorrelation");
      expect(serialized).not.toContain("task-execution-native/v1");
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
    expect(res.body.paths["/api/companies"].post.responses["201"]).toBeDefined();
    expect(
      res.body.paths["/api/companies/{companyId}/users/{userId}/profile"].get
        .summary,
    ).toBe("Get a user profile by exact stored user ID within a company");
    expect(res.body.paths["/api/companies"].post.requestBody.content["application/json"].schema).toMatchObject({
      type: "object",
      properties: {
        name: { type: "string", minLength: 1 },
      },
      required: ["name"],
    });
    expect(JSON.stringify(res.body.paths["/api/companies"].post.responses)).not.toContain("candidates");
    for (const prefix of retiredRoutePrefixes) {
      expect(Object.keys(res.body.paths).some((routePath) => routePath.startsWith(prefix))).toBe(false);
    }
    expect(res.body.paths["/api/companies/{companyId}/folders"].post.responses["201"]).toBeDefined();
    expect(res.body.paths["/api/companies/{companyId}/folders/items/move"].post.summary).toBe(
      "Move an item into or out of a folder",
    );
    const resolveBudgetIncidentOperation =
      res.body.paths[
        "/api/companies/{companyId}/budget-incidents/{incidentId}/resolve"
      ].post;
    const incidentIdParameter = resolveBudgetIncidentOperation.parameters.find(
      (parameter: { name?: string }) => parameter.name === "incidentId",
    );
    expect(incidentIdParameter).toMatchObject({
      in: "path",
      required: true,
      schema: {
        type: "string",
        pattern: CANONICAL_UUID_RE.source,
      },
    });
    expect(resolveBudgetIncidentOperation.responses).toHaveProperty("404");
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
    expect(spec.paths["/api/plugins/catalog"].get["x-paperclip-authorization"]).toEqual({
      actor: "board",
      instanceAdmin: true,
    });
    expect(spec.paths["/api/plugins/catalog/install"].post["x-paperclip-authorization"]).toEqual({
      actor: "board",
      instanceAdmin: true,
    });
    expect(spec.paths["/api/plugins/catalog/install"].post.responses).toHaveProperty("201");
    expect(spec.paths["/api/plugins/catalog/install"].post.responses).not.toHaveProperty("200");
    const instanceAdminPluginOperations = [
      ["delete", "/api/plugins/{pluginId}"],
      ["post", "/api/plugins/{pluginId}/enable"],
      ["post", "/api/plugins/{pluginId}/disable"],
      ["get", "/api/plugins/{pluginId}/logs"],
      ["post", "/api/plugins/{pluginId}/upgrade"],
      ["get", "/api/plugins/{pluginId}/config"],
      ["post", "/api/plugins/{pluginId}/config"],
      ["post", "/api/plugins/{pluginId}/config/test"],
      ["get", "/api/plugins/{pluginId}/jobs"],
      ["get", "/api/plugins/{pluginId}/jobs/{jobId}/runs"],
      ["post", "/api/plugins/{pluginId}/jobs/{jobId}/trigger"],
      ["get", "/api/plugins/{pluginId}/dashboard"],
    ] as const;
    for (const [method, path] of instanceAdminPluginOperations) {
      expect(spec.paths[path][method]["x-paperclip-authorization"]).toEqual({
        actor: "board",
        instanceAdmin: true,
      });
    }
    expect(spec.paths["/api/plugins/{pluginId}/health"]).toBeUndefined();
    const costEventsPath =
      spec.paths["/api/companies/{companyId}/cost-events"];
    expect(costEventsPath.get.responses["200"]).toBeDefined();
    expect(costEventsPath.get.responses["401"]).toBeDefined();
    expect(costEventsPath.post).toBeUndefined();
    expect(spec.paths["/api/instance/database-backups"]).toBeUndefined();
    expect(spec.paths["/api/invites/{token}/accept"].post.responses["202"]).toBeDefined();
    expect(spec.paths["/api/board-api-keys"].post.responses["201"]).toBeDefined();
    expect(spec.paths["/api/companies/imports"].post.responses["202"]).toBeDefined();
  });
});
