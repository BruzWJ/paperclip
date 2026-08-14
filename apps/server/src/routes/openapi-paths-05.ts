import {
  budgetCurrencySchema,
  canonicalUuidSchema,
  createFinanceEventSchema,
  resolveBudgetIncidentSchema,
  updateCompanyBudgetSchema,
  upsertBudgetPolicySchema,
} from "@paperclipai/shared";
import { z } from "zod";
import {
  exactPositiveIntegerQueryParameterSchema,
  jsonBody,
  r,
  registry,
  taskExecutionRunEnvelopeRecordSchema,
} from "./openapi-catalog.js";
import * as pathSchemas from "./openapi-path-schemas.js";

export function registerOpenApiPaths05(): void {
  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/costs/summary",
    tags: ["costs"],
    summary: "Get canonical AI cost summary",
    request: {
      params: z.object({ companyId: canonicalUuidSchema }),
      query: pathSchemas.costRangeQuerySchema,
    },
    responses: {
      200: r.ok(pathSchemas.costSummaryResponseSchema),
      401: r.unauthorized,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/costs/by-agent",
    tags: ["costs"],
    summary: "Get canonical AI costs by agent",
    request: {
      params: z.object({ companyId: canonicalUuidSchema }),
      query: pathSchemas.costRangeQuerySchema,
    },
    responses: {
      200: r.ok(pathSchemas.costByAgentResponseSchema),
      401: r.unauthorized,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/costs/by-project",
    tags: ["costs"],
    summary: "Get canonical AI costs by project",
    request: {
      params: z.object({ companyId: canonicalUuidSchema }),
      query: pathSchemas.costRangeQuerySchema,
    },
    responses: {
      200: r.ok(pathSchemas.costByProjectResponseSchema),
      401: r.unauthorized,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/cost-events",
    tags: ["costs"],
    summary: "List canonical settled-prompt cost facts",
    request: {
      params: z.object({ companyId: canonicalUuidSchema }),
      query: pathSchemas.costListQuerySchema,
    },
    responses: {
      200: r.ok(z.array(pathSchemas.canonicalCostEventResponseSchema)),
      401: r.unauthorized,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/costs/finance-summary",
    tags: ["costs"],
    summary: "Get finance totals grouped by currency",
    request: {
      params: z.object({ companyId: canonicalUuidSchema }),
      query: pathSchemas.costRangeQuerySchema,
    },
    responses: {
      200: r.ok(
        z
          .object({
            companyId: canonicalUuidSchema,
            currencies: z.array(pathSchemas.financeSummaryRowResponseSchema),
          })
          .strict(),
      ),
      401: r.unauthorized,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/costs/finance-by-biller",
    tags: ["costs"],
    summary: "Get finance totals by biller and currency",
    request: {
      params: z.object({ companyId: canonicalUuidSchema }),
      query: pathSchemas.costRangeQuerySchema,
    },
    responses: {
      200: r.ok(
        z.array(
          pathSchemas.financeSummaryRowResponseSchema
            .extend({
              biller: z.string(),
              kindCount: z.number().int().nonnegative(),
            })
            .strict(),
        ),
      ),
      401: r.unauthorized,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/costs/finance-by-kind",
    tags: ["costs"],
    summary: "Get finance totals by kind and currency",
    request: {
      params: z.object({ companyId: canonicalUuidSchema }),
      query: pathSchemas.costRangeQuerySchema,
    },
    responses: {
      200: r.ok(
        z.array(
          pathSchemas.financeSummaryRowResponseSchema
            .extend({
              eventKind: z.string(),
              billerCount: z.number().int().nonnegative(),
            })
            .strict(),
        ),
      ),
      401: r.unauthorized,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/costs/finance-events",
    tags: ["costs"],
    summary: "List finance events",
    request: {
      params: z.object({ companyId: canonicalUuidSchema }),
      query: pathSchemas.costListQuerySchema,
    },
    responses: {
      200: r.ok(z.array(pathSchemas.financeEventResponseSchema)),
      401: r.unauthorized,
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/companies/{companyId}/finance-events",
    tags: ["costs"],
    summary: "Record a finance event",
    request: {
      params: z.object({ companyId: canonicalUuidSchema }),
      body: jsonBody(createFinanceEventSchema),
    },
    responses: {
      201: r.ok(pathSchemas.financeEventResponseSchema),
      400: r.badRequest,
      401: r.unauthorized,
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/companies/{companyId}/budgets/policies",
    tags: ["costs"],
    summary: "Create or update a budget policy",
    request: {
      params: z.object({ companyId: canonicalUuidSchema }),
      body: jsonBody(upsertBudgetPolicySchema),
    },
    responses: {
      200: r.ok(pathSchemas.budgetPolicySummaryResponseSchema),
      400: r.badRequest,
      401: r.unauthorized,
      404: r.notFound,
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/companies/{companyId}/budget-incidents/{incidentId}/resolve",
    tags: ["costs"],
    summary: "Resolve a budget incident",
    request: {
      params: z.object({
        companyId: canonicalUuidSchema,
        incidentId: canonicalUuidSchema,
      }),
      body: jsonBody(resolveBudgetIncidentSchema),
    },
    responses: {
      200: r.ok(pathSchemas.budgetIncidentResponseSchema),
      400: r.badRequest,
      401: r.unauthorized,
      404: r.notFound,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/budgets/overview",
    tags: ["costs"],
    summary: "Get budget overview",
    request: { params: z.object({ companyId: canonicalUuidSchema }) },
    responses: {
      200: r.ok(
        z
          .object({
            companyId: canonicalUuidSchema,
            budgetCurrency: budgetCurrencySchema,
            policies: z.array(pathSchemas.budgetPolicySummaryResponseSchema),
            activeIncidents: z.array(pathSchemas.budgetIncidentResponseSchema),
            pausedAgentCount: z.number().int().nonnegative(),
            pausedProjectCount: z.number().int().nonnegative(),
            pendingApprovalCount: z.number().int().nonnegative(),
          })
          .strict(),
      ),
      401: r.unauthorized,
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/companies/{companyId}/budgets",
    tags: ["costs"],
    summary: "Update company budget",
    request: {
      params: z.object({ companyId: canonicalUuidSchema }),
      body: jsonBody(updateCompanyBudgetSchema),
    },
    responses: {
      200: r.ok(pathSchemas.budgetPolicySummaryResponseSchema),
      400: r.badRequest,
      401: r.unauthorized,
    },
  });

  // ─── Activity ────────────────────────────────────────────────────────────────

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/activity",
    tags: ["activity"],
    summary: "List company activity",
    request: { params: z.object({ companyId: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "post",
    path: "/api/companies/{companyId}/activity",
    tags: ["activity"],
    summary: "Create an activity entry",
    request: {
      params: z.object({ companyId: canonicalUuidSchema }),
      body: jsonBody(
        z.object({
          actorType: z.enum(["agent", "user", "system", "plugin"]).optional(),
          actorId: z.string().min(1),
          action: z.string().min(1),
          entityType: z.string().min(1),
          entityId: z.string().min(1),
          agentId: canonicalUuidSchema.optional().nullable(),
          details: z.record(z.unknown()).optional().nullable(),
        }),
      ),
    },
    responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });

  registry.registerPath({
    method: "get",
    path: "/api/tasks/{id}/activity",
    tags: ["activity"],
    summary: "List activity for a task",
    request: { params: z.object({ id: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "get",
    path: "/api/tasks/{id}/runs",
    tags: ["runs"],
    summary: "List canonical task execution run envelopes for a task",
    request: {
      params: z.object({ id: canonicalUuidSchema }),
      query: z
        .object({
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
      404: r.notFound,
    },
  });
}
