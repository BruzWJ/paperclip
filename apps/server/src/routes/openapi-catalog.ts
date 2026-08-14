import {
  PLUGIN_BRIDGE_ERROR_CODES,
  agentAdapterAcpConfigurationSchema,
  authUserIdSchema,
  canonicalUuidSchema,
} from "@paperclipai/shared";
import { z } from "zod";
import { OpenAPIRegistry } from "./openapi-schema.js";

export const registry = new OpenAPIRegistry();

// ─── Common schemas ──────────────────────────────────────────────────────────

export const ErrorSchema = registry.register("Error", z.object({ error: z.string() }));

export const PluginBridgeErrorSchema = registry.register(
  "PluginBridgeError",
  z
    .object({
      code: z.enum(PLUGIN_BRIDGE_ERROR_CODES),
      message: z.string(),
      details: z.unknown().optional(),
    })
    .strict(),
);

export const pluginBridgeErrorResponse = {
  description: "Plugin worker bridge failure",
  content: { "application/json": { schema: PluginBridgeErrorSchema } },
};

export const responses = {
  ok: (schema: z.ZodTypeAny = z.record(z.unknown())) => ({
    description: "Success",
    content: { "application/json": { schema } },
  }),
  noContent: { description: "No content" },
  badRequest: {
    description: "Bad request",
    content: { "application/json": { schema: ErrorSchema } },
  },
  unauthorized: {
    description: "Unauthorized",
    content: { "application/json": { schema: ErrorSchema } },
  },
  forbidden: {
    description: "Forbidden",
    content: { "application/json": { schema: ErrorSchema } },
  },
  notFound: {
    description: "Not found",
    content: { "application/json": { schema: ErrorSchema } },
  },
  conflict: {
    description: "Conflict",
    content: { "application/json": { schema: ErrorSchema } },
  },
  unprocessable: {
    description: "Unprocessable entity",
    content: { "application/json": { schema: ErrorSchema } },
  },
  serverError: {
    description: "Internal server error",
    content: { "application/json": { schema: ErrorSchema } },
  },
  tooManyRequests: {
    description: "Too many requests",
    content: { "application/json": { schema: ErrorSchema } },
  },
};

export const jsonBody = (schema: z.ZodTypeAny) => ({
  content: { "application/json": { schema } },
  required: true as const,
});

export const r = responses;

export const exactNonBlankQueryParameterSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, "Query parameter must not contain surrounding whitespace");

export function exactPositiveIntegerQueryParameterSchema(max: number) {
  return z
    .string()
    .regex(/^[1-9]\d*$/)
    .refine(
      (value) => Number.isSafeInteger(Number(value)) && Number(value) <= max,
      `Query parameter must not exceed ${max}`,
    );
}

export const exactIsoDateTimeQueryParameterSchema = z.string().refine((value) => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}, "Query parameter must be an exact ISO timestamp");

export const publicAdapterCapabilitiesSchema = z
  .object({
    contractVersion: z.literal("acpx-runtime/v1"),
    runtimeControls: z.array(z.string().min(1)),
  })
  .strict();

export const publicAdapterConfigOptionBase = {
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1).optional(),
};

export const publicAdapterConfigOptionSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...publicAdapterConfigOptionBase,
      type: z.literal("text"),
      currentValue: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      ...publicAdapterConfigOptionBase,
      type: z.literal("select"),
      currentValue: z.string().min(1).optional(),
      values: z
        .array(
          z
            .object({
              value: z.string().min(1),
              label: z.string().min(1),
            })
            .strict(),
        )
        .min(1),
    })
    .strict(),
  z
    .object({
      ...publicAdapterConfigOptionBase,
      type: z.literal("toggle"),
      currentValue: z.boolean(),
    })
    .strict(),
]);

export const publicReadyAdapterInfoSchema = z
  .object({
    type: z.string(),
    label: z.string(),
    modelsCount: z.number().int().nonnegative(),
    loaded: z.literal(true),
    capabilities: publicAdapterCapabilitiesSchema,
    configOptions: z.array(publicAdapterConfigOptionSchema),
  })
  .strict();

export const publicUnavailableAdapterInfoSchema = z
  .object({
    type: z.string().min(1),
    label: z.string().min(1),
    modelsCount: z.literal(0),
    loaded: z.literal(false),
    diagnostic: z
      .object({
        code: z.enum(["acpx_probe_failed", "acpx_catalog_invalid"]),
        message: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export const publicAdapterInfoSchema = z.discriminatedUnion("loaded", [
  publicReadyAdapterInfoSchema,
  publicUnavailableAdapterInfoSchema,
]);

export const publicAgentAdapterRevisionSchema = z
  .object({
    id: canonicalUuidSchema,
    companyId: canonicalUuidSchema,
    agentId: canonicalUuidSchema,
    revisionNumber: z.number().int().positive(),
    acpConfiguration: agentAdapterAcpConfigurationSchema,
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    parentRevisionId: canonicalUuidSchema.nullable(),
    createdByAgentId: canonicalUuidSchema.nullable(),
    createdByUserId: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();

export const publicAgentAdapterRevisionCreateResponseSchema = z
  .object({
    revision: publicAgentAdapterRevisionSchema,
    current: z
      .object({
        agentId: canonicalUuidSchema,
        currentAdapterConfigRevisionId: canonicalUuidSchema,
        updatedAt: z.string().datetime(),
      })
      .strict(),
    appended: z.boolean(),
  })
  .strict();

export const taskExecutionRunKindSchema = z.enum(["productive", "consult"]);

export const taskExecutionRunEnvelopeRecordSchema = z
  .object({
    id: canonicalUuidSchema,
    companyId: canonicalUuidSchema,
    taskId: canonicalUuidSchema,
    sessionId: canonicalUuidSchema,
    executionScopeId: canonicalUuidSchema,
    kind: taskExecutionRunKindSchema,
    status: z.enum([
      "queued",
      "scheduled_retry",
      "running",
      "succeeded",
      "interrupted",
      "failed",
      "cancelled",
      "timed_out",
    ]),
    ownershipEpoch: z.number().int().positive(),
    targetAgentId: canonicalUuidSchema,
    adapterConfigRevisionId: canonicalUuidSchema,
    executionMode: z.enum(["owner", "consult"]),
    taskExecutionAuthorityId: canonicalUuidSchema.nullable(),
    consultExecutionId: canonicalUuidSchema.nullable(),
    parentRunId: canonicalUuidSchema.nullable(),
    retryOfRunId: canonicalUuidSchema.nullable(),
    currentAttemptId: canonicalUuidSchema.nullable(),
    currentLeaseId: canonicalUuidSchema.nullable(),
    cancellationIntentId: canonicalUuidSchema.nullable(),
    terminalFinalizationId: canonicalUuidSchema.nullable(),
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable(),
    terminalClassification: z
      .enum(["succeeded", "interrupted", "failed", "cancelled", "timed_out"])
      .nullable(),
    terminalReasonCode: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const workTimelineQuerySchema = z
  .object({
    from: z.string().optional(),
    to: z.string().optional(),
    userId: z.string().optional(),
    goalId: canonicalUuidSchema.optional(),
    projectId: canonicalUuidSchema.optional(),
    taskId: canonicalUuidSchema.optional(),
    limit: z.string().optional(),
    offset: z.string().optional(),
  })
  .strict();

export const workTimelineResponseSchema = z
  .object({
    actors: z.array(
      z
        .object({
          id: z.string(),
          type: z.enum(["agent", "user", "system", "plugin"]),
          name: z.string(),
          avatar: z.string().nullable().optional(),
        })
        .strict(),
    ),
    spans: z.array(
      z
        .object({
          actorId: z.string(),
          runId: canonicalUuidSchema,
          kind: taskExecutionRunKindSchema,
          taskId: canonicalUuidSchema,
          taskIdentifier: z.string().nullable(),
          taskTitle: z.string().nullable(),
          start: z.string(),
          end: z.string().nullable(),
          status: z.enum([
            "queued",
            "scheduled_retry",
            "running",
            "succeeded",
            "interrupted",
            "failed",
            "cancelled",
            "timed_out",
          ]),
          retryOfRunId: z.string().nullable(),
        })
        .strict(),
    ),
    events: z.array(
      z
        .object({
          actorId: z.string(),
          kind: z.enum(["created", "commented", "approved", "delegated", "assigned"]),
          taskId: canonicalUuidSchema,
          at: z.string(),
        })
        .strict(),
    ),
    edges: z.array(
      z
        .object({
          fromActorId: z.string(),
          toActorId: z.string(),
          taskId: canonicalUuidSchema,
          at: z.string(),
          kind: z.enum(["delegation", "assignment", "mention"]),
        })
        .strict(),
    ),
    pagination: z
      .object({
        limit: z.number().int().positive(),
        offset: z.number().int().nonnegative(),
        totalTasks: z.number().int().nonnegative(),
        hasMore: z.boolean(),
      })
      .strict(),
    window: z
      .object({
        from: z.string(),
        to: z.string(),
        capped: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const canonicalUuidPathParameterNames = new Set([
  "approvalId",
  "assetId",
  "attachmentId",
  "commentId",
  "companyId",
  "consentId",
  "definitionId",
  "folderId",
  "holdId",
  "id",
  "incidentId",
  "inviteId",
  "jobId",
  "keyId",
  "labelId",
  "memberId",
  "pluginId",
  "requestId",
  "revisionId",
  "rootCommentId",
  "runId",
  "secretId",
  "taskId",
  "threadId",
]);

export function paramsSchemaFromPath(routePath: string): z.ZodObject<z.ZodRawShape> | undefined {
  const names = [...routePath.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]);
  if (names.length === 0) return undefined;
  const shape: z.ZodRawShape = {};
  for (const name of names) {
    if (name === "userId") {
      shape[name] = authUserIdSchema;
    } else if (canonicalUuidPathParameterNames.has(name)) {
      shape[name] = canonicalUuidSchema;
    } else if (name === "taskNumber") {
      shape[name] = z
        .string()
        .regex(/^[1-9]\d*$/)
        .refine((value) => Number.isSafeInteger(Number(value)));
    } else {
      shape[name] = z
        .string()
        .min(1)
        .refine((value) => value.trim() === value);
    }
  }
  return z.object(shape).strict();
}
