import {
  canonicalUuidSchema,
  createDocumentAnnotationCommentSchema,
  createDocumentAnnotationThreadSchema,
  createFolderSchema,
  createSecretProviderConfigSchema,
  folderKindSchema,
  moveFolderItemSchema,
  moveFolderSchema,
  pluginLocalFolderPathRequestSchema,
  remoteSecretImportPreviewSchema,
  remoteSecretImportSchema,
  secretProviderConfigDiscoveryPreviewSchema,
  updateDocumentAnnotationThreadSchema,
  updateFolderSchema,
  updateResourceMembershipSchema,
  updateSecretProviderConfigSchema,
} from "@paperclipai/shared";
import { z } from "zod";
import { r } from "./openapi-catalog.js";
import { taskCostSummaryResponseSchema } from "./openapi-path-schemas.js";
import { registerCurrentRoute } from "./openapi-security.js";

export function registerOpenApiPaths09(): void {
  registerCurrentRoute({
    method: "delete",
    path: "/api/board-api-keys/{keyId}",
    tags: ["access"],
    summary: "Revoke a board API key",
  });

  for (const route of [
    ["get", "/api/companies/{companyId}/search", "Search company data"],
    ["get", "/api/companies/{companyId}/search/extract", "Extract company search matches"],
  ] as const) {
    registerCurrentRoute({
      method: route[0],
      path: route[1],
      tags: ["companies"],
      summary: route[2],
    });
  }

  registerCurrentRoute({
    method: "get",
    path: "/api/companies/{companyId}/folders",
    tags: ["folders"],
    summary: "List folders for a company item kind",
    query: z.object({ kind: folderKindSchema }),
  });

  registerCurrentRoute({
    method: "post",
    path: "/api/companies/{companyId}/folders",
    tags: ["folders"],
    summary: "Create a folder",
    body: createFolderSchema,
  });

  registerCurrentRoute({
    method: "patch",
    path: "/api/companies/{companyId}/folders/{folderId}",
    tags: ["folders"],
    summary: "Update a folder",
    body: updateFolderSchema,
  });

  registerCurrentRoute({
    method: "post",
    path: "/api/companies/{companyId}/folders/items/move",
    tags: ["folders"],
    summary: "Move an item into or out of a folder",
    body: moveFolderItemSchema,
  });

  registerCurrentRoute({
    method: "post",
    path: "/api/companies/{companyId}/folders/{folderId}/move",
    tags: ["folders"],
    summary: "Move or reorder a folder",
    body: moveFolderSchema,
  });

  registerCurrentRoute({
    method: "delete",
    path: "/api/companies/{companyId}/folders/{folderId}",
    tags: ["folders"],
    summary: "Delete a folder",
  });

  registerCurrentRoute({
    method: "get",
    path: "/api/tasks/{id}/cost-summary",
    tags: ["costs"],
    summary: "Get task cost summary",
    query: z
      .object({
        excludeRoot: z.enum(["true", "false"]).optional(),
      })
      .strict(),
    responses: {
      200: r.ok(taskCostSummaryResponseSchema),
      400: r.badRequest,
      401: r.unauthorized,
      404: r.notFound,
    },
  });

  for (const route of [
    [
      "get",
      "/api/companies/{companyId}/users/{userId}/resource-memberships",
      "List current user's resource memberships",
    ],
    [
      "put",
      "/api/companies/{companyId}/users/{userId}/resource-memberships/agents/{agentId}",
      "Join or leave an agent resource",
    ],
    [
      "put",
      "/api/companies/{companyId}/users/{userId}/resource-memberships/projects/{projectId}",
      "Join or leave a project resource",
    ],
  ] as const) {
    registerCurrentRoute({
      method: route[0],
      path: route[1],
      tags: ["resource-memberships"],
      summary: route[2],
      ...(route[0] === "put" ? { body: updateResourceMembershipSchema } : {}),
    });
  }

  for (const route of [
    ["get", "/api/companies/{companyId}/secret-providers/health", "Check configured secret providers"],
    ["get", "/api/companies/{companyId}/secret-provider-configs", "List secret provider configurations"],
    ["get", "/api/secret-provider-configs/{id}", "Get a secret provider configuration"],
    ["delete", "/api/secret-provider-configs/{id}", "Delete a secret provider configuration"],
    ["post", "/api/secret-provider-configs/{id}/default", "Set the default secret provider configuration"],
    ["post", "/api/secret-provider-configs/{id}/health", "Check a secret provider configuration"],
    ["get", "/api/secrets/{id}/usage", "Get secret usage"],
    ["get", "/api/secrets/{id}/access-events", "List secret access events"],
  ] as const) {
    registerCurrentRoute({
      method: route[0],
      path: route[1],
      tags: ["secrets"],
      summary: route[2],
    });
  }

  registerCurrentRoute({
    method: "post",
    path: "/api/companies/{companyId}/secret-provider-configs",
    tags: ["secrets"],
    summary: "Create a secret provider configuration",
    body: createSecretProviderConfigSchema,
    responses: {
      201: r.ok(),
      400: r.badRequest,
      401: r.unauthorized,
      404: r.notFound,
    },
  });

  registerCurrentRoute({
    method: "patch",
    path: "/api/secret-provider-configs/{id}",
    tags: ["secrets"],
    summary: "Update a secret provider configuration",
    body: updateSecretProviderConfigSchema,
  });

  registerCurrentRoute({
    method: "post",
    path: "/api/companies/{companyId}/secret-provider-configs/discovery/preview",
    tags: ["secrets"],
    summary: "Preview secret provider discovery",
    body: secretProviderConfigDiscoveryPreviewSchema,
  });

  registerCurrentRoute({
    method: "post",
    path: "/api/companies/{companyId}/secrets/remote-import/preview",
    tags: ["secrets"],
    summary: "Preview remote secret import",
    body: remoteSecretImportPreviewSchema,
  });

  registerCurrentRoute({
    method: "post",
    path: "/api/companies/{companyId}/secrets/remote-import",
    tags: ["secrets"],
    summary: "Import remote secrets",
    body: remoteSecretImportSchema,
  });

  for (const route of [
    ["get", "/api/tasks/{id}/documents/{key}/annotations", "List document annotation threads"],
    ["get", "/api/tasks/{id}/documents/{key}/annotations/{threadId}", "Get a document annotation thread"],
    ["post", "/api/tasks/{id}/documents/{key}/lock", "Lock a task document"],
    ["post", "/api/tasks/{id}/documents/{key}/unlock", "Unlock a task document"],
  ] as const) {
    registerCurrentRoute({
      method: route[0],
      path: route[1],
      tags: ["tasks"],
      summary: route[2],
    });
  }

  registerCurrentRoute({
    method: "post",
    path: "/api/tasks/{id}/documents/{key}/annotations",
    tags: ["tasks"],
    summary: "Create a document annotation thread",
    body: createDocumentAnnotationThreadSchema,
    responses: {
      201: r.ok(),
      400: r.badRequest,
      401: r.unauthorized,
      404: r.notFound,
    },
  });

  registerCurrentRoute({
    method: "post",
    path: "/api/tasks/{id}/documents/{key}/annotations/{threadId}/comments",
    tags: ["tasks"],
    summary: "Add a document annotation comment",
    body: createDocumentAnnotationCommentSchema,
    responses: {
      201: r.ok(),
      400: r.badRequest,
      401: r.unauthorized,
      404: r.notFound,
    },
  });

  registerCurrentRoute({
    method: "post",
    path: "/api/tasks/{id}/low-trust/promotions",
    tags: ["tasks"],
    summary: "Promote quarantined low-trust output",
    body: z.object({
      sourceArtifactKind: z.enum(["comment", "document", "work_product", "task"]),
      sourceArtifactId: canonicalUuidSchema,
      title: z.string().trim().min(1).max(200),
      summary: z.string().trim().min(1).max(8_000),
    }),
    responses: {
      201: r.ok(),
      400: r.badRequest,
      401: r.unauthorized,
      403: r.forbidden,
      404: r.notFound,
      422: r.unprocessable,
    },
  });

  registerCurrentRoute({
    method: "patch",
    path: "/api/tasks/{id}/documents/{key}/annotations/{threadId}",
    tags: ["tasks"],
    summary: "Update a document annotation thread",
    body: updateDocumentAnnotationThreadSchema,
  });

  for (const route of [
    ["get", "/api/routines/{id}/description/annotations", "List routine description annotation threads"],
    [
      "get",
      "/api/routines/{id}/description/annotations/{threadId}",
      "Get a routine description annotation thread",
    ],
  ] as const) {
    registerCurrentRoute({
      method: route[0],
      path: route[1],
      tags: ["routines"],
      summary: route[2],
    });
  }

  registerCurrentRoute({
    method: "post",
    path: "/api/routines/{id}/description/annotations",
    tags: ["routines"],
    summary: "Create a routine description annotation thread",
    body: createDocumentAnnotationThreadSchema,
    responses: {
      201: r.ok(),
      400: r.badRequest,
      401: r.unauthorized,
      404: r.notFound,
    },
  });

  registerCurrentRoute({
    method: "post",
    path: "/api/routines/{id}/description/annotations/{threadId}/comments",
    tags: ["routines"],
    summary: "Add a routine description annotation comment",
    body: createDocumentAnnotationCommentSchema,
    responses: {
      201: r.ok(),
      400: r.badRequest,
      401: r.unauthorized,
      404: r.notFound,
    },
  });

  registerCurrentRoute({
    method: "patch",
    path: "/api/routines/{id}/description/annotations/{threadId}",
    tags: ["routines"],
    summary: "Update a routine description annotation thread",
    body: updateDocumentAnnotationThreadSchema,
  });

  registerCurrentRoute({
    method: "get",
    path: "/api/tasks/{id}/diagnostics/blockers",
    tags: ["tasks"],
    summary: "Get blocker diagnostics for a task",
  });

  registerCurrentRoute({
    method: "get",
    path: "/api/tasks/{id}/diagnostics/subtree",
    tags: ["tasks"],
    summary: "Get bounded subtree blocker diagnostics for a task",
  });

  for (const route of [
    ["get", "/api/routines/{id}/revisions", "List routine revisions"],
    ["post", "/api/routines/{id}/revisions/{revisionId}/restore", "Restore a routine revision"],
  ] as const) {
    registerCurrentRoute({
      method: route[0],
      path: route[1],
      tags: ["routines"],
      summary: route[2],
    });
  }

  for (const route of [
    ["get", "/api/plugins/{pluginId}/companies/{companyId}/local-folders", "List plugin local folders"],
    [
      "get",
      "/api/plugins/{pluginId}/companies/{companyId}/local-folders/{folderKey}/status",
      "Get plugin local folder status",
    ],
    [
      "post",
      "/api/plugins/{pluginId}/companies/{companyId}/local-folders/{folderKey}/validate",
      "Validate a plugin local folder",
    ],
    [
      "put",
      "/api/plugins/{pluginId}/companies/{companyId}/local-folders/{folderKey}",
      "Save a plugin local folder",
    ],
  ] as const) {
    registerCurrentRoute({
      method: route[0],
      path: route[1],
      tags: ["plugins"],
      summary: route[2],
      ...(route[0] === "post" || route[0] === "put" ? { body: pluginLocalFolderPathRequestSchema } : {}),
    });
  }
}
