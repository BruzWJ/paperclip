import {
  boardTaskCommentGroupPageSchema,
  canonicalUuidSchema,
  createProjectSchema,
  createRoutineSchema,
  createRoutineTriggerSchema,
  createTaskLabelSchema,
  createTaskUserCommentSchema,
  linkTaskApprovalSchema,
  projectCodebaseSchema,
  restoreTaskDocumentRevisionSchema,
  rotateRoutineTriggerSecretSchema,
  runRoutineSchema,
  updateProjectCodebaseSchema,
  updateProjectSchema,
  updateRoutineSchema,
  updateRoutineTriggerSchema,
  upsertTaskDocumentSchema,
} from "@paperclipai/shared";
import { z } from "zod";
import {
  exactNonBlankQueryParameterSchema,
  exactPositiveIntegerQueryParameterSchema,
  jsonBody,
  r,
  registry,
} from "./openapi-catalog.js";

export function registerOpenApiPaths03(): void {
  registry.registerPath({
    method: "get",
    path: "/api/tasks/{id}/documents",
    tags: ["tasks"],
    summary: "List task documents",
    request: { params: z.object({ id: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "get",
    path: "/api/tasks/{id}/documents/{key}",
    tags: ["tasks"],
    summary: "Get a task document",
    request: {
      params: z.object({ id: canonicalUuidSchema, key: z.string() }),
    },
    responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
  });

  registry.registerPath({
    method: "put",
    path: "/api/tasks/{id}/documents/{key}",
    tags: ["tasks"],
    summary: "Upsert a task document",
    request: {
      params: z.object({ id: canonicalUuidSchema, key: z.string() }),
      body: jsonBody(upsertTaskDocumentSchema),
    },
    responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/tasks/{id}/documents/{key}",
    tags: ["tasks"],
    summary: "Delete a task document",
    request: {
      params: z.object({ id: canonicalUuidSchema, key: z.string() }),
    },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "get",
    path: "/api/tasks/{id}/documents/{key}/revisions",
    tags: ["tasks"],
    summary: "List task document revisions",
    request: {
      params: z.object({ id: canonicalUuidSchema, key: z.string() }),
    },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "post",
    path: "/api/tasks/{id}/documents/{key}/revisions/{revisionId}/restore",
    tags: ["tasks"],
    summary: "Restore a document revision",
    request: {
      params: z.object({
        id: canonicalUuidSchema,
        key: z.string(),
        revisionId: canonicalUuidSchema,
      }),
      body: jsonBody(restoreTaskDocumentRevisionSchema),
    },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "get",
    path: "/api/tasks/{id}/comments",
    tags: ["tasks"],
    summary: "Page root-grouped task comments",
    request: {
      params: z.object({ id: canonicalUuidSchema }),
      query: z
        .object({
          cursor: exactNonBlankQueryParameterSchema.optional(),
          limit: exactPositiveIntegerQueryParameterSchema(500).optional(),
          entryLimit: exactPositiveIntegerQueryParameterSchema(500).optional(),
        })
        .strict(),
    },
    responses: {
      200: r.ok(boardTaskCommentGroupPageSchema),
      401: r.unauthorized,
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/tasks/{id}/comments",
    tags: ["tasks"],
    summary: "Add a typed user comment with an optional explicit current-owner mention",
    request: {
      params: z.object({ id: canonicalUuidSchema }),
      body: jsonBody(createTaskUserCommentSchema),
    },
    responses: {
      200: r.ok(),
      201: r.ok(),
      400: r.badRequest,
      401: r.unauthorized,
      403: r.forbidden,
      404: r.notFound,
      409: r.conflict,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/tasks/{id}/approvals",
    tags: ["tasks"],
    summary: "List task approvals",
    request: { params: z.object({ id: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "post",
    path: "/api/tasks/{id}/approvals",
    tags: ["tasks"],
    summary: "Link an approval to a task",
    request: {
      params: z.object({ id: canonicalUuidSchema }),
      body: jsonBody(linkTaskApprovalSchema),
    },
    responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/tasks/{id}/approvals/{approvalId}",
    tags: ["tasks"],
    summary: "Unlink an approval from a task",
    request: {
      params: z.object({
        id: canonicalUuidSchema,
        approvalId: canonicalUuidSchema,
      }),
    },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "post",
    path: "/api/tasks/{id}/read",
    tags: ["tasks"],
    summary: "Mark a task as read",
    request: { params: z.object({ id: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/tasks/{id}/read",
    tags: ["tasks"],
    summary: "Mark a task as unread",
    request: { params: z.object({ id: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "post",
    path: "/api/tasks/{id}/inbox-archive",
    tags: ["tasks"],
    summary: "Archive task from inbox",
    request: {
      params: z.object({ id: canonicalUuidSchema }),
      body: jsonBody(z.object({ userId: z.string().min(1).optional() })),
    },
    responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/tasks/{id}/inbox-archive",
    tags: ["tasks"],
    summary: "Un-archive task from inbox",
    request: {
      params: z.object({ id: canonicalUuidSchema }),
      body: jsonBody(z.object({ userId: z.string().min(1).optional() })),
    },
    responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
  });

  registry.registerPath({
    method: "get",
    path: "/api/tasks/{id}/attachments",
    tags: ["tasks"],
    summary: "List task attachments",
    request: { params: z.object({ id: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/labels",
    tags: ["tasks"],
    summary: "List labels in a company",
    request: { params: z.object({ companyId: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "post",
    path: "/api/companies/{companyId}/labels",
    tags: ["tasks"],
    summary: "Create a label",
    request: {
      params: z.object({ companyId: canonicalUuidSchema }),
      body: jsonBody(createTaskLabelSchema),
    },
    responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/labels/{labelId}",
    tags: ["tasks"],
    summary: "Delete a label",
    request: { params: z.object({ labelId: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  // ─── Projects ────────────────────────────────────────────────────────────────

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/projects",
    tags: ["projects"],
    summary: "List projects in a company",
    request: { params: z.object({ companyId: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "post",
    path: "/api/companies/{companyId}/projects",
    tags: ["projects"],
    summary: "Create a project",
    request: {
      params: z.object({ companyId: canonicalUuidSchema }),
      body: jsonBody(createProjectSchema),
    },
    responses: {
      201: r.ok(),
      400: r.badRequest,
      401: r.unauthorized,
      422: r.unprocessable,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/projects/{id}",
    tags: ["projects"],
    summary: "Get a project",
    request: { params: z.object({ id: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
  });

  registry.registerPath({
    method: "get",
    path: "/api/projects/{id}/codebase",
    tags: ["projects"],
    summary: "Get the board-managed project codebase",
    request: { params: z.object({ id: canonicalUuidSchema }) },
    responses: {
      200: r.ok(projectCodebaseSchema),
      401: r.unauthorized,
      403: r.forbidden,
      404: r.notFound,
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/projects/{id}/codebase",
    tags: ["projects"],
    summary: "Update the board-managed project codebase",
    request: {
      params: z.object({ id: canonicalUuidSchema }),
      body: jsonBody(updateProjectCodebaseSchema),
    },
    responses: {
      200: r.ok(projectCodebaseSchema),
      400: r.badRequest,
      401: r.unauthorized,
      403: r.forbidden,
      404: r.notFound,
      422: r.unprocessable,
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/projects/{id}",
    tags: ["projects"],
    summary: "Update a project",
    request: {
      params: z.object({ id: canonicalUuidSchema }),
      body: jsonBody(updateProjectSchema),
    },
    responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/projects/{id}",
    tags: ["projects"],
    summary: "Delete a project",
    request: { params: z.object({ id: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  // ─── Routines ────────────────────────────────────────────────────────────────

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/routines",
    tags: ["routines"],
    summary: "List routines in a company",
    request: { params: z.object({ companyId: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "post",
    path: "/api/companies/{companyId}/routines",
    tags: ["routines"],
    summary: "Create a routine",
    request: {
      params: z.object({ companyId: canonicalUuidSchema }),
      body: jsonBody(createRoutineSchema),
    },
    responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });

  registry.registerPath({
    method: "get",
    path: "/api/routines/{id}",
    tags: ["routines"],
    summary: "Get a routine",
    request: { params: z.object({ id: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/routines/{id}",
    tags: ["routines"],
    summary: "Update a routine",
    request: {
      params: z.object({ id: canonicalUuidSchema }),
      body: jsonBody(updateRoutineSchema),
    },
    responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });

  registry.registerPath({
    method: "get",
    path: "/api/routines/{id}/runs",
    tags: ["routines"],
    summary: "List runs for a routine",
    request: { params: z.object({ id: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "post",
    path: "/api/routines/{id}/run",
    tags: ["routines"],
    summary: "Manually run a routine",
    request: {
      params: z.object({ id: canonicalUuidSchema }),
      body: jsonBody(runRoutineSchema),
    },
    responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });

  registry.registerPath({
    method: "post",
    path: "/api/routines/{id}/triggers",
    tags: ["routines"],
    summary: "Create a routine trigger",
    request: {
      params: z.object({ id: canonicalUuidSchema }),
      body: jsonBody(createRoutineTriggerSchema),
    },
    responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/routine-triggers/{id}",
    tags: ["routines"],
    summary: "Update a routine trigger",
    request: {
      params: z.object({ id: canonicalUuidSchema }),
      body: jsonBody(updateRoutineTriggerSchema),
    },
    responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/routine-triggers/{id}",
    tags: ["routines"],
    summary: "Delete a routine trigger",
    request: { params: z.object({ id: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "post",
    path: "/api/routine-triggers/{id}/rotate-secret",
    tags: ["routines"],
    summary: "Rotate a routine trigger secret",
    request: {
      params: z.object({ id: canonicalUuidSchema }),
      body: jsonBody(rotateRoutineTriggerSecretSchema),
    },
    responses: {
      200: r.ok(),
      400: r.badRequest,
      401: r.unauthorized,
      404: r.notFound,
    },
  });
}
