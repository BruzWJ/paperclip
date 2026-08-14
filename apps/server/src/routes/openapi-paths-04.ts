import {
  addApprovalCommentSchema,
  authUserIdSchema,
  canonicalUuidSchema,
  createApprovalSchema,
  createGoalSchema,
  createSecretSchema,
  createUserSecretDefinitionSchema,
  createUserSecretValueSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
  resubmitApprovalSchema,
  rotateSecretSchema,
  rotateUserSecretValueSchema,
  updateGoalSchema,
  updateSecretSchema,
  updateUserSecretDefinitionSchema,
  updateUserSecretValueSchema,
} from "@paperclipai/shared";
import { z } from "zod";
import { jsonBody, r, registry } from "./openapi-catalog.js";

export function registerOpenApiPaths04(): void {
  registry.registerPath({
    method: "post",
    path: "/api/routine-triggers/public/{publicId}/fire",
    tags: ["routines"],
    summary: "Fire a public routine trigger",
    request: { params: z.object({ publicId: z.string() }) },
    responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
  });

  // ─── Goals ───────────────────────────────────────────────────────────────────

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/goals",
    tags: ["goals"],
    summary: "List goals in a company",
    request: { params: z.object({ companyId: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "post",
    path: "/api/companies/{companyId}/goals",
    tags: ["goals"],
    summary: "Create a goal",
    request: {
      params: z.object({ companyId: canonicalUuidSchema }),
      body: jsonBody(createGoalSchema),
    },
    responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });

  registry.registerPath({
    method: "get",
    path: "/api/goals/{id}",
    tags: ["goals"],
    summary: "Get a goal",
    request: { params: z.object({ id: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/goals/{id}",
    tags: ["goals"],
    summary: "Update a goal",
    request: {
      params: z.object({ id: canonicalUuidSchema }),
      body: jsonBody(updateGoalSchema),
    },
    responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/goals/{id}",
    tags: ["goals"],
    summary: "Delete a goal",
    request: { params: z.object({ id: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  // ─── Secrets ─────────────────────────────────────────────────────────────────

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/secret-providers",
    tags: ["secrets"],
    summary: "List secret providers",
    request: { params: z.object({ companyId: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/secrets",
    tags: ["secrets"],
    summary: "List secrets in a company",
    request: { params: z.object({ companyId: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "post",
    path: "/api/companies/{companyId}/secrets",
    tags: ["secrets"],
    summary: "Create a secret",
    request: {
      params: z.object({ companyId: canonicalUuidSchema }),
      body: jsonBody(createSecretSchema),
    },
    responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/secrets/{id}",
    tags: ["secrets"],
    summary: "Update a secret",
    request: {
      params: z.object({ id: canonicalUuidSchema }),
      body: jsonBody(updateSecretSchema),
    },
    responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });

  registry.registerPath({
    method: "post",
    path: "/api/secrets/{id}/rotate",
    tags: ["secrets"],
    summary: "Rotate a secret",
    request: {
      params: z.object({ id: canonicalUuidSchema }),
      body: jsonBody(rotateSecretSchema),
    },
    responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/secrets/{id}",
    tags: ["secrets"],
    summary: "Delete a secret",
    request: { params: z.object({ id: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/user-secret-definitions",
    tags: ["secrets"],
    summary: "List user secret definitions",
    request: { params: z.object({ companyId: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
  });

  registry.registerPath({
    method: "post",
    path: "/api/companies/{companyId}/user-secret-definitions",
    tags: ["secrets"],
    summary: "Create a user secret definition",
    request: {
      params: z.object({ companyId: canonicalUuidSchema }),
      body: jsonBody(createUserSecretDefinitionSchema),
    },
    responses: {
      201: r.ok(),
      400: r.badRequest,
      401: r.unauthorized,
      403: r.forbidden,
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/companies/{companyId}/user-secret-definitions/{definitionId}",
    tags: ["secrets"],
    summary: "Update a user secret definition",
    request: {
      params: z.object({
        companyId: canonicalUuidSchema,
        definitionId: canonicalUuidSchema,
      }),
      body: jsonBody(updateUserSecretDefinitionSchema),
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
    method: "delete",
    path: "/api/companies/{companyId}/user-secret-definitions/{definitionId}",
    tags: ["secrets"],
    summary: "Delete a user secret definition",
    request: {
      params: z.object({
        companyId: canonicalUuidSchema,
        definitionId: canonicalUuidSchema,
      }),
    },
    responses: {
      200: r.ok(),
      401: r.unauthorized,
      403: r.forbidden,
      404: r.notFound,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/user-secret-definitions/{definitionId}/coverage",
    tags: ["secrets"],
    summary: "Get user secret definition coverage",
    request: {
      params: z.object({
        companyId: canonicalUuidSchema,
        definitionId: canonicalUuidSchema,
      }),
    },
    responses: {
      200: r.ok(),
      401: r.unauthorized,
      403: r.forbidden,
      404: r.notFound,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/users/{userId}/secrets",
    tags: ["secrets"],
    summary: "List the authenticated user's secret values",
    request: {
      params: z.object({
        companyId: canonicalUuidSchema,
        userId: authUserIdSchema,
      }),
    },
    responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
  });

  registry.registerPath({
    method: "post",
    path: "/api/companies/{companyId}/users/{userId}/secrets",
    tags: ["secrets"],
    summary: "Create the authenticated user's secret value",
    request: {
      params: z.object({
        companyId: canonicalUuidSchema,
        userId: authUserIdSchema,
      }),
      body: jsonBody(createUserSecretValueSchema),
    },
    responses: {
      201: r.ok(),
      400: r.badRequest,
      401: r.unauthorized,
      403: r.forbidden,
      404: r.notFound,
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/companies/{companyId}/users/{userId}/secrets/{secretId}",
    tags: ["secrets"],
    summary: "Update the authenticated user's secret value",
    request: {
      params: z.object({
        companyId: canonicalUuidSchema,
        userId: authUserIdSchema,
        secretId: canonicalUuidSchema,
      }),
      body: jsonBody(updateUserSecretValueSchema),
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
    path: "/api/companies/{companyId}/users/{userId}/secrets/{secretId}/rotate",
    tags: ["secrets"],
    summary: "Rotate the authenticated user's secret value",
    request: {
      params: z.object({
        companyId: canonicalUuidSchema,
        userId: authUserIdSchema,
        secretId: canonicalUuidSchema,
      }),
      body: jsonBody(rotateUserSecretValueSchema),
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
    method: "delete",
    path: "/api/companies/{companyId}/users/{userId}/secrets/{secretId}",
    tags: ["secrets"],
    summary: "Delete the authenticated user's secret value",
    request: {
      params: z.object({
        companyId: canonicalUuidSchema,
        userId: authUserIdSchema,
        secretId: canonicalUuidSchema,
      }),
    },
    responses: {
      200: r.ok(),
      401: r.unauthorized,
      403: r.forbidden,
      404: r.notFound,
    },
  });

  // ─── Approvals ───────────────────────────────────────────────────────────────

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/approvals",
    tags: ["approvals"],
    summary: "List approvals in a company",
    request: { params: z.object({ companyId: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "post",
    path: "/api/companies/{companyId}/approvals",
    tags: ["approvals"],
    summary: "Create an approval",
    request: {
      params: z.object({ companyId: canonicalUuidSchema }),
      body: jsonBody(createApprovalSchema),
    },
    responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });

  registry.registerPath({
    method: "get",
    path: "/api/approvals/{id}",
    tags: ["approvals"],
    summary: "Get an approval",
    request: { params: z.object({ id: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
  });

  registry.registerPath({
    method: "get",
    path: "/api/approvals/{id}/tasks",
    tags: ["approvals"],
    summary: "List tasks linked to an approval",
    request: { params: z.object({ id: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "post",
    path: "/api/approvals/{id}/approve",
    tags: ["approvals"],
    summary: "Approve an approval",
    request: {
      params: z.object({ id: canonicalUuidSchema }),
      body: jsonBody(resolveApprovalSchema),
    },
    responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });

  registry.registerPath({
    method: "post",
    path: "/api/approvals/{id}/reject",
    tags: ["approvals"],
    summary: "Reject an approval",
    request: {
      params: z.object({ id: canonicalUuidSchema }),
      body: jsonBody(resolveApprovalSchema),
    },
    responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });

  registry.registerPath({
    method: "post",
    path: "/api/approvals/{id}/request-revision",
    tags: ["approvals"],
    summary: "Request revision on an approval",
    request: {
      params: z.object({ id: canonicalUuidSchema }),
      body: jsonBody(requestApprovalRevisionSchema),
    },
    responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });

  registry.registerPath({
    method: "post",
    path: "/api/approvals/{id}/resubmit",
    tags: ["approvals"],
    summary: "Resubmit an approval",
    request: {
      params: z.object({ id: canonicalUuidSchema }),
      body: jsonBody(resubmitApprovalSchema),
    },
    responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });

  registry.registerPath({
    method: "get",
    path: "/api/approvals/{id}/comments",
    tags: ["approvals"],
    summary: "List approval comments",
    request: { params: z.object({ id: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "post",
    path: "/api/approvals/{id}/comments",
    tags: ["approvals"],
    summary: "Add a comment to an approval",
    request: {
      params: z.object({ id: canonicalUuidSchema }),
      body: jsonBody(addApprovalCommentSchema),
    },
    responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });
}
