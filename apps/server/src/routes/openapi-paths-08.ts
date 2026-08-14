import {
  boardTaskCommentSchema,
  boardTaskCommentThreadPageSchema,
  canonicalUuidSchema,
  companyPortabilityImportSchema,
  companyPortabilityPreviewSchema,
  createBoardApiKeySchema,
  pluginBridgeRequestSchema,
  pluginConfigRequestSchema,
  pluginDisableRequestSchema,
  pluginJobRunsQuerySchema,
  pluginLogsQuerySchema,
  pluginUpgradeRequestSchema,
  updateUserCompanyAccessSchema,
} from "@paperclipai/shared";
import { z } from "zod";
import {
  exactNonBlankQueryParameterSchema,
  exactPositiveIntegerQueryParameterSchema,
  jsonBody,
  pluginBridgeErrorResponse,
  r,
  registry,
} from "./openapi-catalog.js";
import { pluginInstallationParams } from "./openapi-path-schemas.js";
import { registerCurrentRoute } from "./openapi-security.js";

export function registerOpenApiPaths08(): void {
  registry.registerPath({
    method: "delete",
    path: "/api/plugins/{pluginId}",
    tags: ["plugins"],
    summary: "Delete a plugin",
    request: {
      params: pluginInstallationParams,
    },
    responses: {
      204: r.noContent,
      400: r.badRequest,
      401: r.unauthorized,
      403: r.forbidden,
      404: r.notFound,
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/plugins/{pluginId}/enable",
    tags: ["plugins"],
    summary: "Enable a plugin",
    request: { params: pluginInstallationParams },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "post",
    path: "/api/plugins/{pluginId}/disable",
    tags: ["plugins"],
    summary: "Disable a plugin",
    request: {
      params: pluginInstallationParams,
      body: jsonBody(pluginDisableRequestSchema),
    },
    responses: {
      200: r.ok(),
      400: r.badRequest,
      401: r.unauthorized,
      403: r.forbidden,
      404: r.notFound,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/plugins/{pluginId}/logs",
    tags: ["plugins"],
    summary: "Get plugin logs",
    request: {
      params: pluginInstallationParams,
      query: pluginLogsQuerySchema,
    },
    responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
  });

  registry.registerPath({
    method: "post",
    path: "/api/plugins/{pluginId}/upgrade",
    tags: ["plugins"],
    summary: "Upgrade a plugin",
    request: {
      params: pluginInstallationParams,
      body: jsonBody(pluginUpgradeRequestSchema),
    },
    responses: {
      200: r.ok(),
      400: r.badRequest,
      401: r.unauthorized,
      403: r.forbidden,
      404: r.notFound,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/plugins/{pluginId}/config",
    tags: ["plugins"],
    summary: "Get instance-scoped plugin config",
    request: {
      params: pluginInstallationParams,
    },
    responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
  });

  registry.registerPath({
    method: "post",
    path: "/api/plugins/{pluginId}/config",
    tags: ["plugins"],
    summary: "Set instance-scoped plugin config",
    request: {
      params: pluginInstallationParams,
      body: jsonBody(pluginConfigRequestSchema),
    },
    responses: {
      200: r.ok(),
      400: r.badRequest,
      401: r.unauthorized,
      403: r.forbidden,
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/plugins/{pluginId}/config/test",
    tags: ["plugins"],
    summary: "Test instance-scoped plugin config",
    request: {
      params: pluginInstallationParams,
      body: jsonBody(pluginConfigRequestSchema),
    },
    responses: {
      200: r.ok(),
      400: r.badRequest,
      401: r.unauthorized,
      403: r.forbidden,
      502: pluginBridgeErrorResponse,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/plugins/{pluginId}/jobs",
    tags: ["plugins"],
    summary: "List plugin jobs",
    request: {
      params: pluginInstallationParams,
    },
    responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
  });

  registry.registerPath({
    method: "get",
    path: "/api/plugins/{pluginId}/jobs/{jobId}/runs",
    tags: ["plugins"],
    summary: "List runs for a plugin job",
    request: {
      params: pluginInstallationParams.extend({
        jobId: canonicalUuidSchema,
      }),
      query: pluginJobRunsQuerySchema,
    },
    responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
  });

  registry.registerPath({
    method: "post",
    path: "/api/plugins/{pluginId}/jobs/{jobId}/trigger",
    tags: ["plugins"],
    summary: "Trigger a plugin job",
    request: {
      params: pluginInstallationParams.extend({
        jobId: canonicalUuidSchema,
      }),
    },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "post",
    path: "/api/plugins/{pluginId}/webhooks/{endpointKey}",
    tags: ["plugins"],
    summary: "Deliver an external webhook payload to a plugin",
    request: {
      params: pluginInstallationParams.extend({ endpointKey: z.string() }),
    },
    responses: {
      200: r.ok(),
      400: r.badRequest,
      404: r.notFound,
      502: pluginBridgeErrorResponse,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/plugins/{pluginId}/dashboard",
    tags: ["plugins"],
    summary: "Get plugin dashboard data",
    request: { params: pluginInstallationParams },
    responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
  });

  registry.registerPath({
    method: "post",
    path: "/api/plugins/{pluginId}/data/{key}",
    tags: ["plugins"],
    summary: "Get plugin data by key",
    request: {
      params: pluginInstallationParams.extend({ key: z.string() }),
      body: jsonBody(pluginBridgeRequestSchema),
    },
    responses: {
      200: r.ok(),
      401: r.unauthorized,
      502: pluginBridgeErrorResponse,
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/plugins/{pluginId}/actions/{key}",
    tags: ["plugins"],
    summary: "Invoke a plugin action",
    request: {
      params: pluginInstallationParams.extend({ key: z.string() }),
      body: jsonBody(pluginBridgeRequestSchema),
    },
    responses: {
      200: r.ok(),
      401: r.unauthorized,
      502: pluginBridgeErrorResponse,
    },
  });

  // ─── Task comment reads ──────────────────────────────────────────────────────

  registry.registerPath({
    method: "get",
    path: "/api/tasks/{id}/comments/{commentId}",
    tags: ["tasks"],
    summary: "Get a single task comment",
    request: {
      params: z.object({
        id: canonicalUuidSchema,
        commentId: canonicalUuidSchema,
      }),
    },
    responses: {
      200: r.ok(boardTaskCommentSchema),
      401: r.unauthorized,
      404: r.notFound,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/tasks/{id}/comments/{rootCommentId}/thread",
    tags: ["tasks"],
    summary: "Page one root comment group",
    request: {
      params: z.object({
        id: canonicalUuidSchema,
        rootCommentId: canonicalUuidSchema,
      }),
      query: z
        .object({
          cursor: exactNonBlankQueryParameterSchema.optional(),
          limit: exactPositiveIntegerQueryParameterSchema(500).optional(),
        })
        .strict(),
    },
    responses: {
      200: r.ok(boardTaskCommentThreadPageSchema),
      401: r.unauthorized,
      404: r.notFound,
    },
  });

  // ─── Org chart images ─────────────────────────────────────────────────────────

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/org.svg",
    tags: ["companies"],
    summary: "Get org chart as SVG",
    request: { params: z.object({ companyId: canonicalUuidSchema }) },
    responses: { 200: { description: "SVG image" }, 401: r.unauthorized },
  });

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/org.png",
    tags: ["companies"],
    summary: "Get org chart as PNG",
    request: { params: z.object({ companyId: canonicalUuidSchema }) },
    responses: { 200: { description: "PNG image" }, 401: r.unauthorized },
  });

  // ─── Company portability ─────────────────────────────────────────────────────

  registry.registerPath({
    method: "post",
    path: "/api/companies/imports/preview",
    tags: ["companies"],
    summary: "Preview a new-company import",
    request: { body: jsonBody(companyPortabilityPreviewSchema) },
    responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });

  registry.registerPath({
    method: "post",
    path: "/api/companies/imports",
    tags: ["companies"],
    summary: "Apply a new-company import",
    request: { body: jsonBody(companyPortabilityImportSchema) },
    responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });

  // ─── CLI auth ─────────────────────────────────────────────────────────────────

  registry.registerPath({
    method: "get",
    path: "/api/cli-auth/challenges/{id}",
    tags: ["access"],
    summary: "Get a CLI auth challenge",
    request: { params: z.object({ id: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 404: r.notFound },
  });

  // ─── Invite assets ────────────────────────────────────────────────────────────

  registry.registerPath({
    method: "get",
    path: "/api/invites/{token}/logo",
    tags: ["access"],
    summary: "Get company logo for an invite",
    request: { params: z.object({ token: z.string() }) },
    responses: { 200: { description: "Image file" }, 404: r.notFound },
  });

  // ─── Admin ────────────────────────────────────────────────────────────────────

  registry.registerPath({
    method: "get",
    path: "/api/admin/users/{userId}/company-access",
    tags: ["admin"],
    summary: "Get company access for a user (admin)",
    request: { params: z.object({ userId: z.string() }) },
    responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
  });

  registry.registerPath({
    method: "put",
    path: "/api/admin/users/{userId}/company-access",
    tags: ["admin"],
    summary: "Set company access for a user (admin)",
    request: {
      params: z.object({ userId: z.string() }),
      body: jsonBody(updateUserCompanyAccessSchema),
    },
    responses: {
      200: r.ok(),
      400: r.badRequest,
      401: r.unauthorized,
      403: r.forbidden,
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/admin/users/{userId}/promote-instance-admin",
    tags: ["admin"],
    summary: "Promote a user to instance admin",
    request: { params: z.object({ userId: z.string() }) },
    responses: {
      200: r.ok(),
      401: r.unauthorized,
      403: r.forbidden,
      404: r.notFound,
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/admin/users/{userId}/demote-instance-admin",
    tags: ["admin"],
    summary: "Demote a user from instance admin",
    request: { params: z.object({ userId: z.string() }) },
    responses: {
      200: r.ok(),
      401: r.unauthorized,
      403: r.forbidden,
      404: r.notFound,
    },
  });

  // ─── Plugin UI static ─────────────────────────────────────────────────────────

  registry.registerPath({
    method: "get",
    path: "/api/_plugins/{pluginId}/ui/{filePath}",
    tags: ["plugins"],
    summary: "Serve plugin UI static file",
    request: {
      params: pluginInstallationParams.extend({ filePath: z.string() }),
    },
    responses: { 200: { description: "Static file content" }, 404: r.notFound },
  });

  // ─── Current route coverage ─────────────────────────────────────────────────

  registerCurrentRoute({
    method: "post",
    path: "/api/health/dev-server/restart",
    tags: ["health"],
    summary: "Request a managed dev-server restart",
    responses: {
      202: r.ok(),
      403: r.forbidden,
      404: r.notFound,
      409: { description: "Restart is not required" },
    },
  });

  registerCurrentRoute({
    method: "post",
    path: "/api/bootstrap/claim",
    tags: ["access"],
    summary: "Claim first instance admin from a browser session",
    responses: {
      200: r.ok(),
      401: r.unauthorized,
      404: r.notFound,
      409: { description: "Instance admin already claimed" },
    },
  });

  registerCurrentRoute({
    method: "get",
    path: "/api/board-api-keys",
    tags: ["access"],
    summary: "List board API keys",
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registerCurrentRoute({
    method: "post",
    path: "/api/board-api-keys",
    tags: ["access"],
    summary: "Create a named board API key",
    body: createBoardApiKeySchema,
    responses: { 201: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });
}
