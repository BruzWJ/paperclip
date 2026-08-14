import {
  TASK_STATUSES,
  agentAdapterConfigurationTestInputSchema,
  agentAdapterConfigurationTestResultSchema,
  canonicalUuidSchema,
  commitTaskCreatorFormSchema,
  commitTaskOwnerFormSchema,
  createTaskSchema,
  createTaskWorkProductSchema,
  decideTaskExecutionStageSchema,
  reassignTaskSchema,
  reopenTaskSchema,
  selfAssignTaskWithdrawalSchema,
  updateTaskExecutionPolicySchema,
  updateTaskTitleSchema,
  updateTaskWorkProductSchema,
} from "@paperclipai/shared";
import { z } from "zod";
import { jsonBody, r, registry } from "./openapi-catalog.js";

export function registerOpenApiPaths02(): void {
  registry.registerPath({
    method: "post",
    path: "/api/agents/{id}/clear-error",
    tags: ["agents"],
    summary: "Clear an agent error",
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
    path: "/api/agents/{id}/terminate",
    tags: ["agents"],
    summary: "Terminate an agent",
    request: { params: z.object({ id: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  // ─── Adapters ────────────────────────────────────────────────────────────────

  registry.registerPath({
    method: "post",
    path: "/api/companies/{companyId}/adapters/{type}/test-configuration",
    tags: ["adapters"],
    summary: "Test an unsaved adapter configuration through a disposable ACPX session",
    description:
      "Validates the exact active ACPX adapter and its generic session selections, then opens and removes a no-prompt local test session. This does not claim execution-workspace readiness and persists no agent, revision, or run.",
    request: {
      params: z.object({
        companyId: canonicalUuidSchema,
        type: z.string(),
      }),
      body: jsonBody(agentAdapterConfigurationTestInputSchema),
    },
    responses: {
      200: r.ok(agentAdapterConfigurationTestResultSchema),
      400: r.badRequest,
      401: r.unauthorized,
      403: r.forbidden,
      422: r.unprocessable,
    },
  });

  // ─── Tasks ──────────────────────────────────────────────────────────────────

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/tasks",
    tags: ["tasks"],
    summary: "List tasks in a company",
    description:
      "Use `view=compact` for the compact board task-list row contract. The default response is the canonical full task-list contract.",
    request: {
      params: z.object({ companyId: canonicalUuidSchema }),
      query: z
        .object({
          attention: z.literal("blocked").optional(),
          descendantOf: canonicalUuidSchema.optional(),
          excludeRoutineExecutions: z.enum(["true", "false"]).optional(),
          hasPlanDocument: z.enum(["true", "false"]).optional(),
          inboxArchivedByUserId: z
            .string()
            .min(1)
            .refine(
              (value) => value.trim() === value,
              "inboxArchivedByUserId must be an exact non-blank user ID",
            )
            .optional(),
          includeBlockedBy: z.enum(["true", "false"]).optional(),
          includeBlockedInboxAttention: z.enum(["true", "false"]).optional(),
          includeLiveDescendantSummary: z.enum(["true", "false"]).optional(),
          labelId: canonicalUuidSchema.optional(),
          limit: z
            .string()
            .regex(/^[1-9]\d*$/)
            .transform(Number)
            .pipe(z.number().int().max(1000))
            .optional(),
          offset: z
            .string()
            .regex(/^(?:0|[1-9]\d*)$/)
            .transform(Number)
            .optional(),
          originId: z
            .string()
            .min(1)
            .refine((value) => value.trim() === value, "originId must not contain surrounding whitespace")
            .optional(),
          originKind: z
            .string()
            .min(1)
            .refine((value) => value.trim() === value, "originKind must not contain surrounding whitespace")
            .optional(),
          ownerAgentId: canonicalUuidSchema.optional(),
          ownerUserId: z
            .string()
            .min(1)
            .refine((value) => value.trim() === value, "ownerUserId must be an exact non-blank user ID")
            .optional(),
          parentId: canonicalUuidSchema.optional(),
          participantAgentId: canonicalUuidSchema.optional(),
          projectId: canonicalUuidSchema.optional(),
          q: z
            .string()
            .min(1)
            .refine((value) => value.trim() === value, "q must not contain surrounding whitespace")
            .optional(),
          sortDir: z.enum(["asc", "desc"]).optional(),
          sortField: z.literal("updated").optional(),
          status: z.union([z.enum(TASK_STATUSES), z.array(z.enum(TASK_STATUSES)).min(1)]).optional(),
          touchedByUserId: z
            .string()
            .min(1)
            .refine((value) => value.trim() === value, "touchedByUserId must be an exact non-blank user ID")
            .optional(),
          unreadForUserId: z
            .string()
            .min(1)
            .refine((value) => value.trim() === value, "unreadForUserId must be an exact non-blank user ID")
            .optional(),
          view: z.literal("compact").optional(),
        })
        .strict(),
    },
    responses: {
      200: r.ok(),
      304: { description: "Not Modified" },
      401: r.unauthorized,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/tasks/{taskNumber}",
    tags: ["tasks"],
    summary: "Read a task by its company-scoped task number",
    request: {
      params: z.object({
        companyId: canonicalUuidSchema,
        taskNumber: z.string().regex(/^[1-9]\d*$/),
      }),
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
    method: "post",
    path: "/api/companies/{companyId}/tasks",
    tags: ["tasks"],
    summary: "Create a task",
    request: {
      params: z.object({ companyId: canonicalUuidSchema }),
      body: jsonBody(createTaskSchema),
    },
    responses: {
      200: r.ok(),
      201: r.ok(),
      400: r.badRequest,
      401: r.unauthorized,
      403: r.forbidden,
      409: r.conflict,
      422: r.unprocessable,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/tasks/{id}",
    tags: ["tasks"],
    summary: "Get a task",
    request: { params: z.object({ id: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/tasks/{id}",
    tags: ["tasks"],
    summary: "Update board-editable task title metadata",
    request: {
      params: z.object({ id: canonicalUuidSchema }),
      body: jsonBody(updateTaskTitleSchema),
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
    method: "put",
    path: "/api/tasks/{id}/execution-policy",
    tags: ["tasks"],
    summary: "Configure the board-owned execution policy for a task",
    request: {
      params: z.object({ id: canonicalUuidSchema }),
      body: jsonBody(updateTaskExecutionPolicySchema),
    },
    responses: {
      200: r.ok(),
      400: r.badRequest,
      401: r.unauthorized,
      403: r.forbidden,
      404: r.notFound,
      409: r.conflict,
      422: r.unprocessable,
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/tasks/{id}/execution-policy/decisions",
    tags: ["tasks"],
    summary: "Append a decision for the active board execution-policy stage",
    request: {
      params: z.object({ id: canonicalUuidSchema }),
      body: jsonBody(decideTaskExecutionStageSchema),
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
    method: "post",
    path: "/api/tasks/{id}/reassign",
    tags: ["tasks"],
    summary: "Reassign a task through the separately audited board entrance",
    request: {
      params: z.object({ id: canonicalUuidSchema }),
      body: jsonBody(reassignTaskSchema),
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
    method: "post",
    path: "/api/tasks/{id}/creator-reassign",
    tags: ["tasks"],
    summary: "Reassign a task as its immutable named-user creator",
    request: {
      params: z.object({ id: canonicalUuidSchema }),
      body: jsonBody(reassignTaskSchema),
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
    method: "post",
    path: "/api/tasks/{id}/withdrawal-self-assignment",
    tags: ["tasks"],
    summary: "Let the immutable named-user creator self-assign for cancellation only",
    request: {
      params: z.object({ id: canonicalUuidSchema }),
      body: jsonBody(selfAssignTaskWithdrawalSchema),
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
    method: "post",
    path: "/api/task-creator-form-updates",
    tags: ["tasks"],
    summary: "Commit an exact authenticated named-creator form update",
    request: {
      body: jsonBody(commitTaskCreatorFormSchema),
    },
    responses: {
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
    method: "post",
    path: "/api/task-owner-form-updates",
    tags: ["tasks"],
    summary: "Commit a documented human escalation or withdrawal owner form update",
    request: {
      body: jsonBody(commitTaskOwnerFormSchema),
    },
    responses: {
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
    method: "post",
    path: "/api/tasks/{id}/reopen",
    tags: ["tasks"],
    summary: "Reopen a terminal task through the audited board command",
    request: {
      params: z.object({ id: canonicalUuidSchema }),
      body: jsonBody(reopenTaskSchema),
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
    path: "/api/tasks/{id}/work-products",
    tags: ["tasks"],
    summary: "List task work products",
    request: { params: z.object({ id: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "post",
    path: "/api/tasks/{id}/work-products",
    tags: ["tasks"],
    summary: "Create a task work product",
    request: {
      params: z.object({ id: canonicalUuidSchema }),
      body: jsonBody(createTaskWorkProductSchema),
    },
    responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/work-products/{id}",
    tags: ["tasks"],
    summary: "Update a work product",
    request: {
      params: z.object({ id: canonicalUuidSchema }),
      body: jsonBody(updateTaskWorkProductSchema),
    },
    responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/work-products/{id}",
    tags: ["tasks"],
    summary: "Delete a work product",
    request: { params: z.object({ id: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });
}
