import {
  acceptInviteSchema,
  approveJoinRequestSchema,
  archiveCompanyMemberSchema,
  authUserIdSchema,
  canonicalUuidSchema,
  createCliAuthChallengeSchema,
  createCompanyInviteSchema,
  patchInstanceGeneralSettingsSchema,
  updateCompanyMemberSchema,
  updateCompanyMemberWithPermissionsSchema,
  updateMemberPermissionsSchema,
  upsertSidebarOrderPreferenceSchema,
} from "@paperclipai/shared";
import { z } from "zod";
import { jsonBody, r, registry } from "./openapi-catalog.js";
import { registerCurrentRoute } from "./openapi-security.js";

export function registerOpenApiPaths06(): void {
  // ─── Dashboard ───────────────────────────────────────────────────────────────

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/dashboard",
    tags: ["dashboard"],
    summary: "Get dashboard data",
    request: { params: z.object({ companyId: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  // ─── Sidebar ─────────────────────────────────────────────────────────────────

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/sidebar-badges",
    tags: ["sidebar"],
    summary: "Get sidebar badge counts",
    request: { params: z.object({ companyId: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/attention",
    tags: ["inbox"],
    summary: "List decision-only attention feed items",
    request: { params: z.object({ companyId: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
  });

  registry.registerPath({
    method: "get",
    path: "/api/users/{userId}/sidebar-preferences",
    tags: ["sidebar"],
    summary: "Get current user sidebar preferences",
    request: { params: z.object({ userId: authUserIdSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "put",
    path: "/api/users/{userId}/sidebar-preferences",
    tags: ["sidebar"],
    summary: "Update current user sidebar preferences",
    request: {
      params: z.object({ userId: authUserIdSchema }),
      body: jsonBody(upsertSidebarOrderPreferenceSchema),
    },
    responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/users/{userId}/sidebar-preferences",
    tags: ["sidebar"],
    summary: "Get sidebar preferences for company",
    request: {
      params: z.object({
        companyId: canonicalUuidSchema,
        userId: authUserIdSchema,
      }),
    },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "put",
    path: "/api/companies/{companyId}/users/{userId}/sidebar-preferences",
    tags: ["sidebar"],
    summary: "Update sidebar preferences for company",
    request: {
      params: z.object({
        companyId: canonicalUuidSchema,
        userId: authUserIdSchema,
      }),
      body: jsonBody(upsertSidebarOrderPreferenceSchema),
    },
    responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });

  // ─── Inbox dismissals ────────────────────────────────────────────────────────

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/inbox-dismissals",
    tags: ["inbox"],
    summary: "List inbox dismissals",
    request: { params: z.object({ companyId: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "post",
    path: "/api/companies/{companyId}/inbox-dismissals",
    tags: ["inbox"],
    summary: "Create an inbox dismissal or snooze",
    request: {
      params: z.object({ companyId: canonicalUuidSchema }),
      body: jsonBody(
        z
          .object({
            itemKey: z
              .string()
              .min(1)
              .regex(/^(approval|join|run|attention):.+$/, "Unsupported inbox item key")
              .refine((value) => value.trim() === value),
            kind: z.enum(["dismiss", "snooze"]).optional(),
            snoozedUntil: z
              .string()
              .datetime()
              .refine((value) => new Date(value).toISOString() === value)
              .optional(),
          })
          .strict(),
      ),
    },
    responses: { 201: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/companies/{companyId}/inbox-dismissals/{itemKey}",
    tags: ["inbox"],
    summary: "Restore an inbox dismissal or snooze",
    request: {
      params: z
        .object({
          companyId: canonicalUuidSchema,
          itemKey: z
            .string()
            .min(1)
            .regex(/^(approval|join|run|attention):.+$/)
            .refine((value) => value.trim() === value),
        })
        .strict(),
    },
    responses: { 204: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });

  // ─── Instance settings ────────────────────────────────────────────────────────

  registry.registerPath({
    method: "get",
    path: "/api/instance/settings/general",
    tags: ["instance"],
    summary: "Get general instance settings",
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/instance/settings/general",
    tags: ["instance"],
    summary: "Update general instance settings",
    request: { body: jsonBody(patchInstanceGeneralSettingsSchema) },
    responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });

  // ─── Run interface and narrow control-plane gates ────────────────────────────

  registerCurrentRoute({
    method: "post",
    path: "/api/run-tools",
    tags: ["runs"],
    summary: "Call the run-scoped paperclip.run-tools/v1 interface",
    body: z
      .object({
        jsonrpc: z.literal("2.0"),
        id: z.union([z.string(), z.number(), z.null()]).optional(),
        method: z.enum(["initialize", "tools/list", "tools/call"]),
        params: z.unknown().optional(),
      })
      .strict(),
    responses: {
      200: r.ok(),
      400: r.badRequest,
      401: r.unauthorized,
      403: r.forbidden,
      409: r.conflict,
    },
  });

  registerCurrentRoute({
    method: "get",
    path: "/api/companies/{companyId}/change-consents",
    tags: ["agents"],
    summary: "List target-bound agent configuration change consents",
    query: z
      .object({
        status: z.enum(["pending", "accepted", "rejected", "expired"]).optional(),
      })
      .strict(),
  });

  registerCurrentRoute({
    method: "post",
    path: "/api/companies/{companyId}/change-consents/{consentId}/decision",
    tags: ["agents"],
    summary: "Record the named board user's change-consent decision",
    body: z
      .object({
        decision: z.enum(["accepted", "rejected"]),
        reason: z.string().trim().max(4_000).nullable().optional(),
      })
      .strict(),
  });

  // ─── Access / invites / members ───────────────────────────────────────────────

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/invites",
    tags: ["access"],
    summary: "List company invites",
    request: { params: z.object({ companyId: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "post",
    path: "/api/companies/{companyId}/invites",
    tags: ["access"],
    summary: "Create a company invite",
    request: {
      params: z.object({ companyId: canonicalUuidSchema }),
      body: jsonBody(createCompanyInviteSchema),
    },
    responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
  });

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/join-requests",
    tags: ["access"],
    summary: "List company join requests",
    request: { params: z.object({ companyId: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "post",
    path: "/api/companies/{companyId}/join-requests/{requestId}/approve",
    tags: ["access"],
    summary: "Approve a company join request",
    request: {
      params: z.object({
        companyId: canonicalUuidSchema,
        requestId: canonicalUuidSchema,
      }),
      body: jsonBody(approveJoinRequestSchema),
    },
    responses: {
      200: r.ok(),
      401: r.unauthorized,
      403: r.forbidden,
      404: r.notFound,
      409: r.conflict,
      422: r.unprocessable,
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/companies/{companyId}/join-requests/{requestId}/reject",
    tags: ["access"],
    summary: "Reject a company join request",
    request: {
      params: z.object({
        companyId: canonicalUuidSchema,
        requestId: canonicalUuidSchema,
      }),
    },
    responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
  });

  registry.registerPath({
    method: "post",
    path: "/api/invites/{inviteId}/revoke",
    tags: ["access"],
    summary: "Revoke an invite",
    request: { params: z.object({ inviteId: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
  });

  registry.registerPath({
    method: "get",
    path: "/api/invites/{token}",
    tags: ["access"],
    summary: "Get an invite by token",
    request: { params: z.object({ token: z.string() }) },
    responses: { 200: r.ok(), 404: r.notFound },
  });

  registry.registerPath({
    method: "post",
    path: "/api/invites/{token}/accept",
    tags: ["access"],
    summary: "Accept an invite and create or replay a join request",
    request: {
      params: z.object({ token: z.string() }),
      body: jsonBody(acceptInviteSchema),
    },
    responses: {
      200: r.ok(),
      400: r.badRequest,
      401: r.unauthorized,
      404: r.notFound,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/members",
    tags: ["access"],
    summary: "List company members",
    request: { params: z.object({ companyId: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/companies/{companyId}/members/{memberId}",
    tags: ["access"],
    summary: "Update a company member status or role",
    request: {
      params: z.object({
        companyId: canonicalUuidSchema,
        memberId: canonicalUuidSchema,
      }),
      body: jsonBody(updateCompanyMemberSchema),
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
    path: "/api/companies/{companyId}/members/{memberId}/role-and-grants",
    tags: ["access"],
    summary: "Update a company member role and explicit grants",
    request: {
      params: z.object({
        companyId: canonicalUuidSchema,
        memberId: canonicalUuidSchema,
      }),
      body: jsonBody(updateCompanyMemberWithPermissionsSchema),
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
    path: "/api/companies/{companyId}/members/{memberId}/archive",
    tags: ["access"],
    summary: "Archive a company member",
    request: {
      params: z.object({
        companyId: canonicalUuidSchema,
        memberId: canonicalUuidSchema,
      }),
      body: jsonBody(archiveCompanyMemberSchema),
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
    path: "/api/companies/{companyId}/members/{memberId}/permissions",
    tags: ["access"],
    summary: "Update explicit company member permissions",
    request: {
      params: z.object({
        companyId: canonicalUuidSchema,
        memberId: canonicalUuidSchema,
      }),
      body: jsonBody(updateMemberPermissionsSchema),
    },
    responses: {
      200: r.ok(),
      400: r.badRequest,
      401: r.unauthorized,
      404: r.notFound,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/companies/{companyId}/user-directory",
    tags: ["access"],
    summary: "Get company user directory",
    request: { params: z.object({ companyId: canonicalUuidSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "get",
    path: "/api/cli-auth/users/{userId}",
    tags: ["access"],
    summary: "Get current CLI auth session",
    request: { params: z.object({ userId: authUserIdSchema }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });

  registry.registerPath({
    method: "post",
    path: "/api/cli-auth/challenges",
    tags: ["access"],
    summary: "Create a CLI auth challenge",
    request: { body: jsonBody(createCliAuthChallengeSchema) },
    responses: { 200: r.ok(), 400: r.badRequest },
  });
}
