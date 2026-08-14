import {
  adapterRuntimeReadinessSchema,
  authUserIdSchema,
  canonicalUuidSchema,
  createChildTaskSchema,
  createTaskTreeHoldSchema,
  pluginCatalogInstallRequestSchema,
  pluginInstallRequestSchema,
  pluginListQuerySchema,
  previewTaskTreeControlSchema,
  releaseTaskTreeHoldSchema,
  resolveCliAuthChallengeSchema,
  updateCurrentUserProfileSchema,
  updateInboxAgentPolicySchema,
} from "@paperclipai/shared";
import { z } from "zod";
import {
  exactNonBlankQueryParameterSchema,
  exactPositiveIntegerQueryParameterSchema,
  jsonBody,
  publicAdapterInfoSchema,
  r,
  registry,
  taskExecutionRunEnvelopeRecordSchema,
} from "./openapi-catalog.js";
import { pluginInstallationParams } from "./openapi-path-schemas.js";

export function registerOpenApiPaths07(): void {
  registry.registerPath({
    method: "post",
    path: "/api/cli-auth/challenges/{id}/approve",
    tags: ["access"],
    summary: "Approve a CLI auth challenge",
    request: {
      params: z.object({ id: canonicalUuidSchema }),
      body: jsonBody(resolveCliAuthChallengeSchema),
    },
    responses: {
      200: r.ok(),
      400: r.badRequest,
      401: r.unauthorized,
      404: r.notFound,
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/cli-auth/challenges/{id}/cancel",
    tags: ["access"],
    summary: "Cancel a CLI auth challenge",
    request: {
      params: z.object({ id: canonicalUuidSchema }),
      body: jsonBody(resolveCliAuthChallengeSchema),
    },
    responses: { 200: r.ok(), 400: r.badRequest, 404: r.notFound },
  });

  registry.registerPath({
    method: "post",
    path: "/api/cli-auth/revoke-current",
    tags: ["access"],
    summary: "Revoke current CLI auth session",
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "get",
    path: "/api/admin/users",
    tags: ["admin"],
    summary: "List all users (admin)",
    responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
  });

  // ─── Auth / profile ──────────────────────────────────────────────────────────

  registry.registerPath({
    method: "get",
    path: "/api/auth/get-session",
    tags: ["auth"],
    summary: "Get current session",
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "post",
    path: "/api/auth/update-user",
    tags: ["auth"],
    summary: "Update the current Better Auth user",
    request: { body: jsonBody(updateCurrentUserProfileSchema) },
    responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/users/{userId}/profile",
    tags: ["auth"],
    summary: "Get a user profile by exact stored user ID within a company",
    request: {
      params: z.object({
        companyId: canonicalUuidSchema,
        userId: authUserIdSchema,
      }),
    },
    responses: {
      200: r.ok(),
      400: r.badRequest,
      401: r.unauthorized,
      404: r.notFound,
    },
  });

  // ─── Task execution runs ────────────────────────────────────────────────────

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/runs",
    tags: ["runs"],
    summary: "List canonical task execution run envelopes",
    request: {
      params: z.object({ companyId: canonicalUuidSchema }),
      query: z
        .object({
          agentId: canonicalUuidSchema.optional(),
          status: z.string().min(1).optional(),
          cursor: z.string().max(1000).optional(),
          limit: exactPositiveIntegerQueryParameterSchema(200).optional(),
        })
        .strict(),
    },
    responses: {
      200: r.ok(
        z
          .object({
            items: z.array(taskExecutionRunEnvelopeRecordSchema),
            nextCursor: z.string().nullable(),
          })
          .strict(),
      ),
      400: r.badRequest,
      401: r.unauthorized,
      403: r.forbidden,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/runs/{runId}",
    tags: ["runs"],
    summary: "Get the bounded joined detail for a task execution run",
    request: {
      params: z.object({ runId: canonicalUuidSchema }),
      query: z
        .object({
          limit: exactPositiveIntegerQueryParameterSchema(500).optional(),
          eventCursor: exactNonBlankQueryParameterSchema.optional(),
          messageCursor: exactNonBlankQueryParameterSchema.optional(),
        })
        .strict(),
    },
    responses: {
      200: r.ok(z.object({ run: taskExecutionRunEnvelopeRecordSchema }).passthrough()),
      401: r.unauthorized,
      403: r.forbidden,
      404: r.notFound,
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/runs/{runId}/runtime-readiness",
    tags: ["runs"],
    summary:
      "Inspect the exact persisted run revision, target, native authentication, and ACPX-resolved session initialization capability",
    request: {
      params: z.object({ runId: canonicalUuidSchema }),
    },
    responses: {
      200: r.ok(adapterRuntimeReadinessSchema),
      401: r.unauthorized,
      403: r.forbidden,
      404: r.notFound,
      422: r.unprocessable,
    },
  });

  // ─── Task tree ──────────────────────────────────────────────────────────────

  registry.registerPath({
    method: "post",
    path: "/api/tasks/{id}/children",
    tags: ["tasks"],
    summary: "Create child tasks",
    request: {
      params: z.object({ id: canonicalUuidSchema }),
      body: jsonBody(createChildTaskSchema),
    },
    responses: {
      200: r.ok(),
      201: r.ok(),
      400: r.badRequest,
      401: r.unauthorized,
      403: r.forbidden,
      404: r.notFound,
      409: r.conflict,
      422: r.unprocessable,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/tasks/{id}/tree-control/state",
    tags: ["tasks"],
    summary: "Get task tree control state",
    request: { params: z.object({ id: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "post",
    path: "/api/tasks/{id}/tree-control/preview",
    tags: ["tasks"],
    summary: "Preview task tree control changes",
    request: {
      params: z.object({ id: canonicalUuidSchema }),
      body: jsonBody(previewTaskTreeControlSchema),
    },
    responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });

  registry.registerPath({
    method: "get",
    path: "/api/tasks/{id}/tree-holds",
    tags: ["tasks"],
    summary: "List task tree holds",
    request: { params: z.object({ id: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "post",
    path: "/api/tasks/{id}/tree-holds",
    tags: ["tasks"],
    summary: "Create a task tree hold",
    request: {
      params: z.object({ id: canonicalUuidSchema }),
      body: jsonBody(createTaskTreeHoldSchema),
    },
    responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });

  registry.registerPath({
    method: "get",
    path: "/api/tasks/{id}/tree-holds/{holdId}",
    tags: ["tasks"],
    summary: "Get a task tree hold",
    request: {
      params: z.object({
        id: canonicalUuidSchema,
        holdId: canonicalUuidSchema,
      }),
    },
    responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
  });

  registry.registerPath({
    method: "post",
    path: "/api/tasks/{id}/tree-holds/{holdId}/release",
    tags: ["tasks"],
    summary: "Release a task tree hold",
    request: {
      params: z.object({
        id: canonicalUuidSchema,
        holdId: canonicalUuidSchema,
      }),
      body: jsonBody(releaseTaskTreeHoldSchema),
    },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  // ─── Attachments ──────────────────────────────────────────────────────────────

  registry.registerPath({
    method: "post",
    path: "/api/companies/{companyId}/tasks/{taskId}/attachments",
    tags: ["assets"],
    summary: "Upload an attachment to a task",
    request: {
      params: z.object({
        companyId: canonicalUuidSchema,
        taskId: canonicalUuidSchema,
      }),
    },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "get",
    path: "/api/attachments/{attachmentId}/content",
    tags: ["assets"],
    summary: "Download attachment content",
    request: { params: z.object({ attachmentId: canonicalUuidSchema }) },
    responses: {
      200: { description: "File content" },
      401: r.unauthorized,
      404: r.notFound,
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/attachments/{attachmentId}",
    tags: ["assets"],
    summary: "Delete an attachment",
    request: { params: z.object({ attachmentId: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  // ─── Assets ──────────────────────────────────────────────────────────────────

  registry.registerPath({
    method: "post",
    path: "/api/companies/{companyId}/assets/images",
    tags: ["assets"],
    summary: "Upload an image asset",
    request: { params: z.object({ companyId: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "post",
    path: "/api/companies/{companyId}/logo",
    tags: ["assets"],
    summary: "Upload company logo",
    request: { params: z.object({ companyId: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "get",
    path: "/api/assets/{assetId}/content",
    tags: ["assets"],
    summary: "Download asset content",
    request: { params: z.object({ assetId: canonicalUuidSchema }) },
    responses: {
      200: { description: "File content" },
      401: r.unauthorized,
      404: r.notFound,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/users/{userId}/inbox-agent-policy",
    tags: ["companies"],
    summary: "Get a company user's inbox agent policy",
    request: {
      params: z.object({
        companyId: canonicalUuidSchema,
        userId: z.string(),
      }),
    },
    responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
  });

  registry.registerPath({
    method: "put",
    path: "/api/companies/{companyId}/users/{userId}/inbox-agent-policy",
    tags: ["companies"],
    summary: "Update a company user's inbox agent policy",
    request: {
      params: z.object({
        companyId: canonicalUuidSchema,
        userId: z.string(),
      }),
      body: jsonBody(updateInboxAgentPolicySchema),
    },
    responses: {
      200: r.ok(),
      401: r.unauthorized,
      403: r.forbidden,
      422: r.unprocessable,
    },
  });

  // ─── Adapters (full) ──────────────────────────────────────────────────────────

  registry.registerPath({
    method: "get",
    path: "/api/adapters",
    tags: ["adapters"],
    summary: "List selectable ACPX agents and non-selectable local probe diagnostics",
    responses: {
      200: r.ok(z.array(publicAdapterInfoSchema)),
      401: r.unauthorized,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/plugins",
    tags: ["plugins"],
    summary: "List installed plugins",
    request: { query: pluginListQuerySchema },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "get",
    path: "/api/plugins/ui-contributions",
    tags: ["plugins"],
    summary: "List plugin UI contributions",
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "get",
    path: "/api/plugins/catalog",
    tags: ["plugins"],
    summary: "List plugins available from this source checkout",
    responses: {
      200: r.ok(),
      401: r.unauthorized,
      403: r.forbidden,
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/plugins/catalog/install",
    tags: ["plugins"],
    summary: "Build and install a plugin from this source checkout",
    request: {
      body: jsonBody(pluginCatalogInstallRequestSchema),
    },
    responses: {
      201: r.ok(),
      400: r.badRequest,
      401: r.unauthorized,
      403: r.forbidden,
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/plugins/install",
    tags: ["plugins"],
    summary: "Install a plugin",
    request: {
      body: jsonBody(pluginInstallRequestSchema),
    },
    responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });

  registry.registerPath({
    method: "get",
    path: "/api/plugins/{pluginId}",
    tags: ["plugins"],
    summary: "Get a plugin",
    request: { params: pluginInstallationParams },
    responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
  });
}
