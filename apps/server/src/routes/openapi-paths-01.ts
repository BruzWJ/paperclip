import {
  agentAdapterRevisionConfigurationSchema,
  agentOperationalConfigurationUpdateSchema,
  boardTaskCommentSchema,
  canonicalUuidSchema,
  companyArtifactsQuerySchema,
  companyArtifactsResponseSchema,
  createCompanySchema,
  runtimeAgentCreateConfigurationSchema,
  runtimeAgentUpdateConfigurationSchema,
  updateCompanyBrandingSchema,
  updateCompanySchema,
} from "@paperclipai/shared";
import { z } from "zod";
import {
  ErrorSchema,
  jsonBody,
  publicAgentAdapterRevisionCreateResponseSchema,
  publicAgentAdapterRevisionSchema,
  r,
  registry,
  workTimelineQuerySchema,
  workTimelineResponseSchema,
} from "./openapi-catalog.js";

export function registerOpenApiPaths01(): void {
  // ─── Health ──────────────────────────────────────────────────────────────────

  registry.registerPath({
    method: "get",
    path: "/api/health",
    tags: ["health"],
    summary: "Health check",
    responses: {
      200: r.ok(
        z.object({
          status: z.enum(["ok", "unhealthy"]),
          version: z.string().optional(),
          bootstrapStatus: z.enum(["ready", "bootstrap_pending"]).optional(),
          bootstrapInviteActive: z.boolean().optional(),
        }),
      ),
      503: {
        description: "Service unavailable",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/openapi.json",
    tags: ["health"],
    summary: "Get the generated OpenAPI document",
    responses: { 200: r.ok() },
  });

  // ─── Companies ───────────────────────────────────────────────────────────────

  registry.registerPath({
    method: "get",
    path: "/api/companies",
    tags: ["companies"],
    summary: "List companies",
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "post",
    path: "/api/companies",
    tags: ["companies"],
    summary: "Create a company",
    request: { body: jsonBody(createCompanySchema) },
    responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });

  registry.registerPath({
    method: "get",
    path: "/api/companies/stats",
    tags: ["companies"],
    summary: "Company stats",
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}",
    tags: ["companies"],
    summary: "Get a company",
    request: { params: z.object({ companyId: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
  });

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/artifacts",
    tags: ["companies"],
    summary: "List company artifacts",
    request: {
      params: z.object({ companyId: canonicalUuidSchema }),
      query: companyArtifactsQuerySchema,
    },
    responses: {
      200: {
        description: "Company artifact projection",
        content: {
          "application/json": {
            schema: companyArtifactsResponseSchema,
          },
        },
      },
      401: r.unauthorized,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/timeline",
    tags: ["companies"],
    summary: "Get company work timeline",
    request: {
      params: z.object({ companyId: canonicalUuidSchema }),
      query: workTimelineQuerySchema,
    },
    responses: {
      200: r.ok(workTimelineResponseSchema),
      400: r.badRequest,
      401: r.unauthorized,
      403: r.forbidden,
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/companies/{companyId}",
    tags: ["companies"],
    summary: "Update a company",
    request: {
      params: z.object({ companyId: canonicalUuidSchema }),
      body: jsonBody(updateCompanySchema.partial()),
    },
    responses: {
      200: r.ok(),
      400: r.badRequest,
      401: r.unauthorized,
      404: r.notFound,
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/companies/{companyId}/branding",
    tags: ["companies"],
    summary: "Update company branding",
    request: {
      params: z.object({ companyId: canonicalUuidSchema }),
      body: jsonBody(updateCompanyBrandingSchema),
    },
    responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });

  registry.registerPath({
    method: "post",
    path: "/api/companies/{companyId}/archive",
    tags: ["companies"],
    summary: "Archive a company",
    request: { params: z.object({ companyId: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/companies/{companyId}",
    tags: ["companies"],
    summary: "Delete a company",
    request: { params: z.object({ companyId: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
  });

  registry.registerPath({
    method: "post",
    path: "/api/companies/{companyId}/exports",
    tags: ["companies"],
    summary: "Export company data",
    request: { params: z.object({ companyId: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "post",
    path: "/api/companies/{companyId}/exports/preview",
    tags: ["companies"],
    summary: "Preview company export",
    request: { params: z.object({ companyId: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "post",
    path: "/api/companies/{companyId}/imports/preview",
    tags: ["companies"],
    summary: "Preview company import",
    request: { params: z.object({ companyId: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });

  registry.registerPath({
    method: "post",
    path: "/api/companies/{companyId}/imports/apply",
    tags: ["companies"],
    summary: "Apply company import",
    request: { params: z.object({ companyId: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });

  // ─── Agents ──────────────────────────────────────────────────────────────────

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/agents",
    tags: ["agents"],
    summary: "List agents in a company",
    request: { params: z.object({ companyId: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/task-owner-catalog",
    tags: ["agents"],
    summary: "List control-plane-eligible agents with current revisions for task ownership",
    request: { params: z.object({ companyId: canonicalUuidSchema }) },
    responses: {
      200: r.ok(
        z.array(
          z
            .object({
              id: canonicalUuidSchema,
              name: z.string(),
              title: z.string().nullable(),
              icon: z.string().nullable(),
            })
            .strict(),
        ),
      ),
      401: r.unauthorized,
      403: r.forbidden,
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/companies/{companyId}/runtime-agents",
    tags: ["agents"],
    summary: "Create a fully explicit runtime-agent configuration",
    request: {
      params: z.object({ companyId: canonicalUuidSchema }),
      body: jsonBody(runtimeAgentCreateConfigurationSchema),
    },
    responses: {
      200: r.ok(
        z
          .object({
            comment: boardTaskCommentSchema,
            retried: z.boolean(),
          })
          .strict(),
      ),
      201: r.ok(
        z
          .object({
            comment: boardTaskCommentSchema,
            retried: z.boolean(),
          })
          .strict(),
      ),
      400: r.badRequest,
      401: r.unauthorized,
      403: r.forbidden,
      409: r.conflict,
      422: r.unprocessable,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/org",
    tags: ["agents"],
    summary: "Get org chart data",
    request: { params: z.object({ companyId: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "get",
    path: "/api/agents/{id}",
    tags: ["agents"],
    summary: "Get an agent",
    request: { params: z.object({ id: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
  });

  registry.registerPath({
    method: "get",
    path: "/api/agents/{id}/runtime-state",
    tags: ["agents"],
    summary: "Get canonical operational runtime state for an agent",
    request: { params: z.object({ id: canonicalUuidSchema }) },
    responses: {
      200: r.ok(),
      401: r.unauthorized,
      403: r.forbidden,
      404: r.notFound,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/agents/{id}/runtime-configuration",
    tags: ["agents"],
    summary: "Read explicit agent context, action, and mention grants",
    request: { params: z.object({ id: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/agents/{id}/runtime-configuration",
    tags: ["agents"],
    summary: "Update explicit agent context, action, and mention grants",
    request: {
      params: z.object({ id: canonicalUuidSchema }),
      body: jsonBody(runtimeAgentUpdateConfigurationSchema),
    },
    responses: {
      200: r.ok(),
      400: r.badRequest,
      401: r.unauthorized,
      403: r.forbidden,
      404: r.notFound,
      409: r.conflict,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/agents/{id}/adapter-config-revisions",
    tags: ["agents"],
    summary: "List immutable adapter configuration revisions, newest first",
    request: { params: z.object({ id: canonicalUuidSchema }) },
    responses: {
      200: r.ok(z.array(publicAgentAdapterRevisionSchema)),
      401: r.unauthorized,
      403: r.forbidden,
      404: r.notFound,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/agents/{id}/adapter-config-revisions/current",
    tags: ["agents"],
    summary: "Get the current immutable adapter configuration revision",
    request: { params: z.object({ id: canonicalUuidSchema }) },
    responses: {
      200: r.ok(publicAgentAdapterRevisionSchema),
      401: r.unauthorized,
      403: r.forbidden,
      404: r.notFound,
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/agents/{id}/adapter-config-revisions",
    tags: ["agents"],
    summary: "Append and select an adapter configuration revision",
    request: {
      params: z.object({ id: canonicalUuidSchema }),
      body: jsonBody(agentAdapterRevisionConfigurationSchema),
    },
    responses: {
      200: r.ok(publicAgentAdapterRevisionCreateResponseSchema),
      201: r.ok(publicAgentAdapterRevisionCreateResponseSchema),
      400: r.badRequest,
      401: r.unauthorized,
      403: r.forbidden,
      404: r.notFound,
      409: r.conflict,
      422: r.unprocessable,
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/agents/{id}/operational-configuration",
    tags: ["agents"],
    summary: "Update board-owned display and operational configuration",
    request: {
      params: z.object({ id: canonicalUuidSchema }),
      body: jsonBody(agentOperationalConfigurationUpdateSchema),
    },
    responses: {
      200: r.ok(),
      400: r.badRequest,
      401: r.unauthorized,
      403: r.forbidden,
      404: r.notFound,
      422: r.unprocessable,
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/agents/{id}/plugin-management/adopt",
    tags: ["agents"],
    summary: "Adopt a paused plugin-managed agent into board management",
    request: { params: z.object({ id: canonicalUuidSchema }) },
    responses: {
      200: r.ok(),
      401: r.unauthorized,
      403: r.forbidden,
      404: r.notFound,
      409: r.conflict,
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/agents/{id}/pause",
    tags: ["agents"],
    summary: "Pause an agent",
    request: { params: z.object({ id: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "post",
    path: "/api/agents/{id}/resume",
    tags: ["agents"],
    summary: "Resume an agent",
    request: { params: z.object({ id: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });
}
