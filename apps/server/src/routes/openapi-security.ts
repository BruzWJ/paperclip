import { z } from "zod";
import { jsonBody, paramsSchemaFromPath, r, registry } from "./openapi-catalog.js";
import type { OpenApiResponse } from "./openapi-schema.js";

export function registerCurrentRoute(input: {
  method: string;
  path: string;
  tags: string[];
  summary: string;
  query?: z.ZodTypeAny;
  body?: z.ZodTypeAny;
  responses?: Record<string, OpenApiResponse>;
}) {
  const params = paramsSchemaFromPath(input.path);
  const request =
    params || input.query || input.body
      ? {
          ...(params ? { params } : {}),
          ...(input.query ? { query: input.query } : {}),
          ...(input.body ? { body: jsonBody(input.body) } : {}),
        }
      : undefined;
  registry.registerPath({
    method: input.method,
    path: input.path,
    tags: input.tags,
    summary: input.summary,
    ...(request ? { request } : {}),
    responses: input.responses ?? {
      200: r.ok(),
      400: r.badRequest,
      401: r.unauthorized,
      404: r.notFound,
    },
  });
}

export type OpenApiAuthLevel = "public" | "authenticated" | "board" | "instance_admin" | "run_interface";

export const BOARD_SESSION_AUTH_SCHEME = "BoardSessionAuth";
export const BOARD_API_KEY_AUTH_SCHEME = "BoardApiKeyAuth";
export const RUN_INTERFACE_AUTH_SCHEME = "RunInterfaceBearerAuth";

export function securityRequirement(name: string): Record<string, string[]> {
  return { [name]: [] };
}

export const BOARD_SECURITY: Array<Record<string, string[]>> = [
  securityRequirement(BOARD_SESSION_AUTH_SCHEME),
  securityRequirement(BOARD_API_KEY_AUTH_SCHEME),
];

export const AUTHENTICATED_SECURITY: Array<Record<string, string[]>> = [...BOARD_SECURITY];

export const RUN_INTERFACE_SECURITY: Array<Record<string, string[]>> = [
  securityRequirement(RUN_INTERFACE_AUTH_SCHEME),
];

export const RUN_INTERFACE_OPERATIONS = new Set(["POST /api/run-tools"]);

export const PUBLIC_OPERATIONS = new Set([
  "GET /api/health",
  "GET /api/openapi.json",
  "POST /api/cli-auth/challenges",
  "GET /api/cli-auth/challenges/{id}",
  "POST /api/cli-auth/challenges/{id}/cancel",
  "GET /api/invites/{token}",
  "GET /api/invites/{token}/logo",
  "POST /api/invites/{token}/accept",
  "POST /api/plugins/{pluginId}/webhooks/{endpointKey}",
]);

export const BOARD_ONLY_PREFIXES = ["/api/auth/", "/api/admin/", "/api/plugins", "/api/instance/"];

export const BOARD_ONLY_OPERATIONS = new Set([
  "GET /api/companies",
  "POST /api/companies",
  "GET /api/companies/stats",
  "GET /api/cli-auth/me",
  "GET /api/cli-auth/users/{userId}",
  "POST /api/companies/{companyId}/invites",
  "GET /api/companies/{companyId}/invites",
  "GET /api/companies/{companyId}/join-requests",
  "POST /api/companies/{companyId}/join-requests/{requestId}/approve",
  "POST /api/companies/{companyId}/join-requests/{requestId}/reject",
  "GET /api/companies/{companyId}/members",
  "POST /api/companies/{companyId}/runtime-agents",
  "POST /api/companies/{companyId}/adapters/{type}/test-configuration",
  "GET /api/agents/{id}/runtime-configuration",
  "PATCH /api/agents/{id}/runtime-configuration",
  "GET /api/agents/{id}/adapter-config-revisions",
  "GET /api/agents/{id}/adapter-config-revisions/current",
  "POST /api/agents/{id}/adapter-config-revisions",
  "PATCH /api/agents/{id}/operational-configuration",
  "POST /api/agents/{id}/plugin-management/adopt",
  "GET /api/projects/{id}/codebase",
  "PATCH /api/projects/{id}/codebase",
  "PATCH /api/companies/{companyId}/members/{memberId}",
  "PATCH /api/companies/{companyId}/members/{memberId}/role-and-grants",
  "POST /api/companies/{companyId}/members/{memberId}/archive",
  "PATCH /api/companies/{companyId}/members/{memberId}/permissions",
  "GET /api/companies/{companyId}/user-directory",
  "POST /api/runs/{runId}/runtime-readiness",
  "GET /api/board-api-keys",
  "POST /api/board-api-keys",
  "DELETE /api/board-api-keys/{keyId}",
  "POST /api/bootstrap/claim",
  "GET /api/companies/{companyId}/users/{userId}/resource-memberships",
  "PUT /api/companies/{companyId}/users/{userId}/resource-memberships/agents/{agentId}",
  "PUT /api/companies/{companyId}/users/{userId}/resource-memberships/projects/{projectId}",
  "GET /api/companies/{companyId}/secret-provider-configs",
  "POST /api/companies/{companyId}/secret-provider-configs",
  "GET /api/companies/{companyId}/secret-providers/health",
  "POST /api/companies/{companyId}/secret-provider-configs/discovery/preview",
  "GET /api/secret-provider-configs/{id}",
  "PATCH /api/secret-provider-configs/{id}",
  "DELETE /api/secret-provider-configs/{id}",
  "POST /api/secret-provider-configs/{id}/default",
  "POST /api/secret-provider-configs/{id}/health",
  "GET /api/companies/{companyId}/user-secret-definitions",
  "POST /api/companies/{companyId}/user-secret-definitions",
  "PATCH /api/companies/{companyId}/user-secret-definitions/{definitionId}",
  "DELETE /api/companies/{companyId}/user-secret-definitions/{definitionId}",
  "GET /api/companies/{companyId}/user-secret-definitions/{definitionId}/coverage",
  "GET /api/companies/{companyId}/users/{userId}/secrets",
  "POST /api/companies/{companyId}/users/{userId}/secrets",
  "PATCH /api/companies/{companyId}/users/{userId}/secrets/{secretId}",
  "POST /api/companies/{companyId}/users/{userId}/secrets/{secretId}/rotate",
  "DELETE /api/companies/{companyId}/users/{userId}/secrets/{secretId}",
  "POST /api/companies/{companyId}/secrets/remote-import",
  "POST /api/companies/{companyId}/secrets/remote-import/preview",
  "GET /api/secrets/{id}/usage",
  "GET /api/secrets/{id}/access-events",
  "POST /api/health/dev-server/restart",
]);

export const INSTANCE_ADMIN_OPERATIONS = new Set([
  "POST /api/companies",
  "GET /api/plugins/catalog",
  "POST /api/plugins/catalog/install",
  "POST /api/plugins/install",
  "DELETE /api/plugins/{pluginId}",
  "POST /api/plugins/{pluginId}/enable",
  "POST /api/plugins/{pluginId}/disable",
  "GET /api/plugins/{pluginId}/logs",
  "POST /api/plugins/{pluginId}/upgrade",
  "GET /api/plugins/{pluginId}/config",
  "POST /api/plugins/{pluginId}/config",
  "POST /api/plugins/{pluginId}/config/test",
  "GET /api/plugins/{pluginId}/jobs",
  "GET /api/plugins/{pluginId}/jobs/{jobId}/runs",
  "POST /api/plugins/{pluginId}/jobs/{jobId}/trigger",
  "GET /api/plugins/{pluginId}/dashboard",
  "POST /api/admin/users/{userId}/promote-instance-admin",
  "POST /api/admin/users/{userId}/demote-instance-admin",
  "PUT /api/admin/users/{userId}/company-access",
]);

export const CREATED_OPERATIONS = new Set([
  "POST /api/companies/{companyId}/runtime-agents",
  "POST /api/agents/{id}/adapter-config-revisions",
  "POST /api/companies/{companyId}/approvals",
  "POST /api/approvals/{id}/comments",
  "POST /api/companies/{companyId}/assets/images",
  "POST /api/companies/{companyId}/logo",
  "POST /api/cli-auth/challenges",
  "POST /api/board-api-keys",
  "POST /api/companies",
  "POST /api/companies/{companyId}/invites",
  "POST /api/companies/{companyId}/finance-events",
  "POST /api/companies/{companyId}/secret-provider-configs",
  "POST /api/companies/{companyId}/labels",
  "POST /api/tasks/{id}/documents/{key}/annotations",
  "POST /api/tasks/{id}/documents/{key}/annotations/{threadId}/comments",
  "POST /api/routines/{id}/description/annotations",
  "POST /api/routines/{id}/description/annotations/{threadId}/comments",
  "POST /api/tasks/{id}/work-products",
  "POST /api/tasks/{id}/low-trust/promotions",
  "POST /api/tasks/{id}/approvals",
  "POST /api/companies/{companyId}/tasks",
  "POST /api/tasks/{id}/children",
  "POST /api/tasks/{id}/comments",
  "POST /api/companies/{companyId}/tasks/{taskId}/attachments",
  "POST /api/companies/{companyId}/projects",
  "POST /api/companies/{companyId}/routines",
  "POST /api/companies/{companyId}/folders",
  "POST /api/routines/{id}/triggers",
  "POST /api/companies/{companyId}/secrets",
  "POST /api/companies/{companyId}/user-secret-definitions",
  "POST /api/companies/{companyId}/users/{userId}/secrets",
  "POST /api/admin/users/{userId}/promote-instance-admin",
  "POST /api/plugins/catalog/install",
  "POST /api/plugins/install",
  "POST /api/companies/{companyId}/goals",
]);

export const ACCEPTED_OPERATIONS = new Set([
  "POST /api/companies/imports",
  "POST /api/health/dev-server/restart",
  "POST /api/invites/{token}/accept",
]);

export const FORBIDDEN_RESPONSE = {
  description: "Forbidden",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/Error" },
    },
  },
};

export function operationKey(method: string, path: string) {
  return `${method.toUpperCase()} ${path}`;
}

export function isBoardOnlyOperation(method: string, path: string) {
  const key = operationKey(method, path);
  if (BOARD_ONLY_OPERATIONS.has(key)) return true;
  return BOARD_ONLY_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function resolveOperationAuthLevel(method: string, path: string): OpenApiAuthLevel {
  const key = operationKey(method, path);
  if (PUBLIC_OPERATIONS.has(key)) return "public";
  if (RUN_INTERFACE_OPERATIONS.has(key)) return "run_interface";
  if (INSTANCE_ADMIN_OPERATIONS.has(key)) return "instance_admin";
  if (isBoardOnlyOperation(method, path)) return "board";
  return "authenticated";
}

export function applyOperationStatusOverride(
  operation: Record<string, unknown>,
  fromStatus: string,
  toStatus: string,
) {
  const responses = operation.responses as Record<string, unknown> | undefined;
  if (!responses || !responses[fromStatus] || responses[toStatus]) return;
  responses[toStatus] = responses[fromStatus];
  delete responses[fromStatus];
}

export function applyDocumentFixups(document: any): any {
  document.components ??= {};
  document.components.securitySchemes = {
    [BOARD_SESSION_AUTH_SCHEME]: {
      type: "apiKey",
      in: "cookie",
      name: "paperclip_session",
      description:
        "Board session cookie in authenticated mode. Paperclip uses Better Auth; cookie transport may vary by deployment.",
    },
    [BOARD_API_KEY_AUTH_SCHEME]: {
      type: "http",
      scheme: "bearer",
      bearerFormat: "Board API Key",
      description: "Board API key presented in the Authorization bearer header.",
    },
    [RUN_INTERFACE_AUTH_SCHEME]: {
      type: "http",
      scheme: "bearer",
      bearerFormat: "Run Interface Bearer",
      description: "Single-run bearer accepted only by the compiled paperclip.run-tools/v1 endpoint.",
    },
  };
  document.security = AUTHENTICATED_SECURITY;

  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem as Record<string, any>)) {
      const authLevel = resolveOperationAuthLevel(method, path);
      if (authLevel === "public") {
        operation.security = [];
      } else if (authLevel === "run_interface") {
        operation.security = RUN_INTERFACE_SECURITY;
      } else if (authLevel === "authenticated") {
        operation.security = AUTHENTICATED_SECURITY;
      } else {
        operation.security = BOARD_SECURITY;
      }

      operation["x-paperclip-authorization"] =
        authLevel === "instance_admin"
          ? { actor: "board", instanceAdmin: true }
          : authLevel === "run_interface"
            ? { actor: "run_interface" }
            : authLevel === "board"
              ? { actor: "board" }
              : authLevel === "authenticated"
                ? { actor: "board" }
                : { actor: "public" };

      const key = operationKey(method, path);
      if (authLevel !== "public") {
        const responses = (operation.responses ??= {}) as Record<string, unknown>;
        if (!responses["403"]) {
          responses["403"] = FORBIDDEN_RESPONSE;
        }
      }
      if (CREATED_OPERATIONS.has(key)) {
        applyOperationStatusOverride(operation, "200", "201");
      }
      if (ACCEPTED_OPERATIONS.has(key)) {
        applyOperationStatusOverride(operation, "200", "202");
      }
    }
  }

  return document;
}
