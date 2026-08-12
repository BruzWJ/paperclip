import { Router } from "express";
import { z } from "zod";
import {
  // Agent
  agentAdapterAcpConfigurationSchema,
  agentAdapterConfigurationTestInputSchema,
  agentAdapterConfigurationTestResultSchema,
  agentAdapterRevisionConfigurationSchema,
  agentOperationalConfigurationUpdateSchema,
  runtimeAgentCreateConfigurationSchema,
  runtimeAgentUpdateConfigurationSchema,
  // Task
  createTaskSchema,
  updateTaskTitleSchema,
  updateTaskExecutionPolicySchema,
  decideTaskExecutionStageSchema,
  reassignTaskSchema,
  commitTaskCreatorFormSchema,
  commitTaskOwnerFormSchema,
  selfAssignTaskWithdrawalSchema,
  reopenTaskSchema,
  createTaskLabelSchema,
  createTaskUserCommentSchema,
  boardTaskCommentSchema,
  boardTaskCommentGroupPageSchema,
  boardTaskCommentThreadPageSchema,
  linkTaskApprovalSchema,
  createTaskWorkProductSchema,
  updateTaskWorkProductSchema,
  upsertTaskDocumentSchema,
  restoreTaskDocumentRevisionSchema,
  // Project
  createProjectSchema,
  projectCodebaseSchema,
  updateProjectCodebaseSchema,
  updateProjectSchema,
  // Company
  createCompanySchema,
  updateCompanySchema,
  updateCompanyBrandingSchema,
  companyArtifactsQuerySchema,
  companyArtifactsResponseSchema,
  canonicalUuidSchema,
  // Routine
  createRoutineSchema,
  updateRoutineSchema,
  createRoutineTriggerSchema,
  updateRoutineTriggerSchema,
  rotateRoutineTriggerSecretSchema,
  runRoutineSchema,
  // Folders
  createFolderSchema,
  folderKindSchema,
  moveFolderItemSchema,
  moveFolderSchema,
  updateFolderSchema,
  // Goal
  createGoalSchema,
  updateGoalSchema,
  // Secret
  createSecretSchema,
  updateSecretSchema,
  rotateSecretSchema,
  rotateUserSecretValueSchema,
  createUserSecretDefinitionSchema,
  updateUserSecretDefinitionSchema,
  createUserSecretValueSchema,
  updateUserSecretValueSchema,
  // Approval
  createApprovalSchema,
  resolveApprovalSchema,
  requestApprovalRevisionSchema,
  resubmitApprovalSchema,
  addApprovalCommentSchema,
  // Cost / budget
  createFinanceEventSchema,
  updateCompanyBudgetSchema,
  upsertBudgetPolicySchema,
  resolveBudgetIncidentSchema,
  moneyAmountSchema,
  budgetCurrencySchema,
  ACP_COST_UNAVAILABLE_REASONS,
  ACP_COST_CURSOR_STATES,
  TASK_EXECUTION_RUN_KINDS,
  adapterRuntimeReadinessSchema,
  // Sidebar
  upsertSidebarOrderPreferenceSchema,
  updateInboxAgentPolicySchema,
  // Task tree
  createTaskTreeHoldSchema,
  previewTaskTreeControlSchema,
  releaseTaskTreeHoldSchema,
  createChildTaskSchema,
  // Better Auth user profile input
  authUserIdSchema,
  updateCurrentUserProfileSchema,
  // Company portability
  companyPortabilityPreviewSchema,
  companyPortabilityImportSchema,
  // Access / membership
  acceptInviteSchema,
  approveJoinRequestSchema,
  createCompanyInviteSchema,
  createCliAuthChallengeSchema,
  resolveCliAuthChallengeSchema,
  createBoardApiKeySchema,
  updateCompanyMemberSchema,
  updateCompanyMemberWithPermissionsSchema,
  archiveCompanyMemberSchema,
  updateMemberPermissionsSchema,
  updateUserCompanyAccessSchema,
  // Instance settings
  patchInstanceGeneralSettingsSchema,
  // Resource memberships
  updateResourceMembershipSchema,
  // Document annotations
  createDocumentAnnotationCommentSchema,
  createDocumentAnnotationThreadSchema,
  updateDocumentAnnotationThreadSchema,
  // Secret provider configs and remote import
  createSecretProviderConfigSchema,
  updateSecretProviderConfigSchema,
  secretProviderConfigDiscoveryPreviewSchema,
  remoteSecretImportPreviewSchema,
  remoteSecretImportSchema,
  pluginBridgeRequestSchema,
  pluginCatalogInstallRequestSchema,
  pluginConfigRequestSchema,
  pluginDisableRequestSchema,
  pluginInstallRequestSchema,
  pluginJobRunsQuerySchema,
  pluginListQuerySchema,
  pluginLocalFolderPathRequestSchema,
  pluginLogsQuerySchema,
  pluginUpgradeRequestSchema,
  PLUGIN_BRIDGE_ERROR_CODES,
  TASK_STATUSES,
} from "@paperclipai/shared";

type JsonSchema = Record<string, unknown>;
type OpenApiResponse = Record<string, unknown>;
type OpenApiPathRegistration = {
  method: string;
  path: string;
  request?: {
    params?: z.ZodTypeAny;
    query?: z.ZodTypeAny;
    body?: {
      content: Record<string, { schema: unknown }>;
      required?: boolean;
    };
  };
  responses?: Record<string, OpenApiResponse>;
  [key: string]: unknown;
};

const zodTypeName = (schema: z.ZodTypeAny) => schema._def.typeName as string;

function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  const typeName = zodTypeName(schema);
  if (
    typeName === "ZodOptional" ||
    typeName === "ZodDefault" ||
    typeName === "ZodCatch"
  ) {
    return unwrapSchema(schema._def.innerType);
  }
  if (typeName === "ZodEffects") {
    return unwrapSchema(schema._def.schema);
  }
  return schema;
}

function isOptionalSchema(schema: z.ZodTypeAny): boolean {
  const typeName = zodTypeName(schema);
  if (
    typeName === "ZodOptional" ||
    typeName === "ZodDefault" ||
    typeName === "ZodCatch"
  ) {
    return true;
  }
  if (typeName === "ZodEffects") {
    return isOptionalSchema(schema._def.schema);
  }
  if (typeName === "ZodNullable") {
    return isOptionalSchema(schema._def.innerType);
  }
  return false;
}

function applyStringChecks(
  jsonSchema: JsonSchema,
  checks: Array<Record<string, unknown>>,
) {
  for (const check of checks) {
    if (check.kind === "min") jsonSchema.minLength = check.value;
    if (check.kind === "max") jsonSchema.maxLength = check.value;
    if (check.kind === "email") jsonSchema.format = "email";
    if (check.kind === "url") jsonSchema.format = "uri";
    if (check.kind === "uuid") jsonSchema.format = "uuid";
    if (check.kind === "datetime") jsonSchema.format = "date-time";
    if (check.kind === "regex" && check.regex instanceof RegExp) {
      jsonSchema.pattern = check.regex.source;
    }
  }
}

function applyNumberChecks(
  jsonSchema: JsonSchema,
  checks: Array<Record<string, unknown>>,
) {
  for (const check of checks) {
    if (check.kind === "int") jsonSchema.type = "integer";
    if (check.kind === "min") {
      jsonSchema.minimum = check.value;
      if (!check.inclusive) jsonSchema.exclusiveMinimum = true;
    }
    if (check.kind === "max") {
      jsonSchema.maximum = check.value;
      if (!check.inclusive) jsonSchema.exclusiveMaximum = true;
    }
  }
}

function zodToOpenApiSchema(schema: z.ZodTypeAny): JsonSchema {
  const unwrapped = unwrapSchema(schema);
  const typeName = zodTypeName(unwrapped);

  if (typeName === "ZodString") {
    const jsonSchema: JsonSchema = { type: "string" };
    applyStringChecks(jsonSchema, unwrapped._def.checks ?? []);
    return jsonSchema;
  }

  if (typeName === "ZodNumber") {
    const jsonSchema: JsonSchema = { type: "number" };
    applyNumberChecks(jsonSchema, unwrapped._def.checks ?? []);
    return jsonSchema;
  }

  if (typeName === "ZodBoolean") return { type: "boolean" };
  if (typeName === "ZodDate") return { type: "string", format: "date-time" };
  if (typeName === "ZodAny" || typeName === "ZodUnknown") return {};

  if (typeName === "ZodLiteral") {
    const value = unwrapped._def.value;
    return { type: typeof value, enum: [value] };
  }

  if (typeName === "ZodEnum") {
    return { type: "string", enum: unwrapped._def.values };
  }

  if (typeName === "ZodNativeEnum") {
    const values = Object.values(unwrapped._def.values).filter(
      (value) => typeof value === "string" || typeof value === "number",
    );
    return { enum: Array.from(new Set(values)) };
  }

  if (typeName === "ZodArray") {
    return { type: "array", items: zodToOpenApiSchema(unwrapped._def.type) };
  }

  if (typeName === "ZodRecord") {
    return {
      type: "object",
      additionalProperties: zodToOpenApiSchema(unwrapped._def.valueType),
    };
  }

  if (typeName === "ZodNullable") {
    return { ...zodToOpenApiSchema(unwrapped._def.innerType), nullable: true };
  }

  if (typeName === "ZodUnion") {
    return {
      oneOf: unwrapped._def.options.map((option: z.ZodTypeAny) =>
        zodToOpenApiSchema(option),
      ),
    };
  }

  if (typeName === "ZodDiscriminatedUnion") {
    return {
      oneOf: Array.from(unwrapped._def.options.values()).map((option) =>
        zodToOpenApiSchema(option as z.ZodTypeAny),
      ),
    };
  }

  if (typeName === "ZodIntersection") {
    return {
      allOf: [
        zodToOpenApiSchema(unwrapped._def.left),
        zodToOpenApiSchema(unwrapped._def.right),
      ],
    };
  }

  if (typeName === "ZodObject") {
    const shape = unwrapped._def.shape();
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      const propertySchema = value as z.ZodTypeAny;
      properties[key] = zodToOpenApiSchema(propertySchema);
      if (!isOptionalSchema(propertySchema)) required.push(key);
    }
    const jsonSchema: JsonSchema = { type: "object", properties };
    if (required.length > 0) jsonSchema.required = required;
    if (unwrapped._def.unknownKeys === "strict") {
      jsonSchema.additionalProperties = false;
    }
    return jsonSchema;
  }

  return {};
}

function normalizeContent(content: Record<string, { schema: unknown }>) {
  return Object.fromEntries(
    Object.entries(content).map(([contentType, media]) => [
      contentType,
      {
        ...media,
        schema: isZodSchema(media.schema)
          ? zodToOpenApiSchema(media.schema)
          : media.schema,
      },
    ]),
  );
}

function isZodSchema(value: unknown): value is z.ZodTypeAny {
  return Boolean(
    value &&
    typeof value === "object" &&
    "_def" in value &&
    typeof (value as z.ZodTypeAny).safeParse === "function",
  );
}

function normalizeResponses(responses: Record<string, OpenApiResponse> = {}) {
  return Object.fromEntries(
    Object.entries(responses).map(([status, response]) => {
      const content = response.content as
        Record<string, { schema: unknown }> | undefined;
      return [
        status,
        content
          ? {
              ...response,
              content: normalizeContent(content),
            }
          : response,
      ];
    }),
  );
}

function parametersFromSchema(
  schema: z.ZodTypeAny,
  location: "path" | "query",
) {
  const objectSchema = unwrapSchema(schema);
  if (zodTypeName(objectSchema) !== "ZodObject") return [];
  const shape = objectSchema._def.shape();
  return Object.entries(shape).map(([name, value]) => ({
    name,
    in: location,
    required:
      location === "path" ? true : !isOptionalSchema(value as z.ZodTypeAny),
    schema: zodToOpenApiSchema(value as z.ZodTypeAny),
  }));
}

class OpenAPIRegistry {
  private readonly schemas: Record<string, JsonSchema> = {};
  private readonly paths: Array<OpenApiPathRegistration> = [];

  register(name: string, schema: z.ZodTypeAny) {
    this.schemas[name] = zodToOpenApiSchema(schema);
    return { $ref: `#/components/schemas/${name}` };
  }

  registerPath(pathRegistration: OpenApiPathRegistration) {
    this.paths.push(pathRegistration);
  }

  buildPaths() {
    const paths: Record<string, Record<string, unknown>> = {};
    for (const { method, path, request, responses, ...operation } of this
      .paths) {
      const normalizedOperation: Record<string, unknown> = {
        ...operation,
        responses: normalizeResponses(responses),
      };
      if (request?.params) {
        normalizedOperation.parameters = parametersFromSchema(
          request.params,
          "path",
        );
      }
      if (request?.query) {
        normalizedOperation.parameters = [
          ...((normalizedOperation.parameters as unknown[]) ?? []),
          ...parametersFromSchema(request.query, "query"),
        ];
      }
      if (request?.body) {
        normalizedOperation.requestBody = {
          ...request.body,
          content: normalizeContent(request.body.content),
        };
      }
      paths[path] ??= {};
      paths[path][method] = normalizedOperation;
    }
    return paths;
  }

  buildComponents() {
    return { schemas: this.schemas };
  }
}

const registry = new OpenAPIRegistry();

// ─── Common schemas ──────────────────────────────────────────────────────────

const ErrorSchema = registry.register("Error", z.object({ error: z.string() }));

const PluginBridgeErrorSchema = registry.register(
  "PluginBridgeError",
  z
    .object({
      code: z.enum(PLUGIN_BRIDGE_ERROR_CODES),
      message: z.string(),
      details: z.unknown().optional(),
    })
    .strict(),
);

const pluginBridgeErrorResponse = {
  description: "Plugin worker bridge failure",
  content: { "application/json": { schema: PluginBridgeErrorSchema } },
};

const responses = {
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

const jsonBody = (schema: z.ZodTypeAny) => ({
  content: { "application/json": { schema } },
  required: true as const,
});

const r = responses;

const exactNonBlankQueryParameterSchema = z
  .string()
  .min(1)
  .refine(
    (value) => value.trim() === value,
    "Query parameter must not contain surrounding whitespace",
  );

function exactPositiveIntegerQueryParameterSchema(max: number) {
  return z
    .string()
    .regex(/^[1-9]\d*$/)
    .refine(
      (value) => Number.isSafeInteger(Number(value)) && Number(value) <= max,
      `Query parameter must not exceed ${max}`,
    );
}

const exactIsoDateTimeQueryParameterSchema = z.string().refine((value) => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}, "Query parameter must be an exact ISO timestamp");

const publicAdapterCapabilitiesSchema = z
  .object({
    contractVersion: z.literal("acpx-runtime/v1"),
    runtimeControls: z.array(z.string().min(1)),
  })
  .strict();

const publicAdapterConfigOptionBase = {
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1).optional(),
};

const publicAdapterConfigOptionSchema = z.discriminatedUnion("type", [
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

const publicReadyAdapterInfoSchema = z
  .object({
    type: z.string(),
    label: z.string(),
    modelsCount: z.number().int().nonnegative(),
    loaded: z.literal(true),
    capabilities: publicAdapterCapabilitiesSchema,
    configOptions: z.array(publicAdapterConfigOptionSchema),
  })
  .strict();

const publicUnavailableAdapterInfoSchema = z
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

const publicAdapterInfoSchema = z.discriminatedUnion("loaded", [
  publicReadyAdapterInfoSchema,
  publicUnavailableAdapterInfoSchema,
]);

const publicAgentAdapterRevisionSchema = z
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

const publicAgentAdapterRevisionCreateResponseSchema = z
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

const taskExecutionRunKindSchema = z.enum(["productive", "consult"]);

const taskExecutionRunEnvelopeRecordSchema = z
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

const workTimelineQuerySchema = z
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

const workTimelineResponseSchema = z
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
          kind: z.enum([
            "created",
            "commented",
            "approved",
            "delegated",
            "assigned",
          ]),
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

const canonicalUuidPathParameterNames = new Set([
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

function paramsSchemaFromPath(
  routePath: string,
): z.ZodObject<z.ZodRawShape> | undefined {
  const names = [...routePath.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(
    (match) => match[1],
  );
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

function registerCurrentRoute(input: {
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

type OpenApiAuthLevel =
  "public" | "authenticated" | "board" | "instance_admin" | "run_interface";

const BOARD_SESSION_AUTH_SCHEME = "BoardSessionAuth";
const BOARD_API_KEY_AUTH_SCHEME = "BoardApiKeyAuth";
const RUN_INTERFACE_AUTH_SCHEME = "RunInterfaceBearerAuth";

function securityRequirement(name: string): Record<string, string[]> {
  return { [name]: [] };
}

const BOARD_SECURITY: Array<Record<string, string[]>> = [
  securityRequirement(BOARD_SESSION_AUTH_SCHEME),
  securityRequirement(BOARD_API_KEY_AUTH_SCHEME),
];

const AUTHENTICATED_SECURITY: Array<Record<string, string[]>> = [
  ...BOARD_SECURITY,
];

const RUN_INTERFACE_SECURITY: Array<Record<string, string[]>> = [
  securityRequirement(RUN_INTERFACE_AUTH_SCHEME),
];

const RUN_INTERFACE_OPERATIONS = new Set(["POST /api/run-tools"]);

const PUBLIC_OPERATIONS = new Set([
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

const BOARD_ONLY_PREFIXES = [
  "/api/auth/",
  "/api/admin/",
  "/api/plugins",
  "/api/instance/",
];

const BOARD_ONLY_OPERATIONS = new Set([
  "GET /api/companies",
  "POST /api/companies",
  "GET /api/companies/stats",
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

const INSTANCE_ADMIN_OPERATIONS = new Set([
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

const CREATED_OPERATIONS = new Set([
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

const ACCEPTED_OPERATIONS = new Set([
  "POST /api/companies/imports",
  "POST /api/health/dev-server/restart",
  "POST /api/invites/{token}/accept",
]);

const FORBIDDEN_RESPONSE = {
  description: "Forbidden",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/Error" },
    },
  },
};

function operationKey(method: string, path: string) {
  return `${method.toUpperCase()} ${path}`;
}

function isBoardOnlyOperation(method: string, path: string) {
  const key = operationKey(method, path);
  if (BOARD_ONLY_OPERATIONS.has(key)) return true;
  return BOARD_ONLY_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function resolveOperationAuthLevel(
  method: string,
  path: string,
): OpenApiAuthLevel {
  const key = operationKey(method, path);
  if (PUBLIC_OPERATIONS.has(key)) return "public";
  if (RUN_INTERFACE_OPERATIONS.has(key)) return "run_interface";
  if (INSTANCE_ADMIN_OPERATIONS.has(key)) return "instance_admin";
  if (isBoardOnlyOperation(method, path)) return "board";
  return "authenticated";
}

function applyOperationStatusOverride(
  operation: Record<string, unknown>,
  fromStatus: string,
  toStatus: string,
) {
  const responses = operation.responses as Record<string, unknown> | undefined;
  if (!responses || !responses[fromStatus] || responses[toStatus]) return;
  responses[toStatus] = responses[fromStatus];
  delete responses[fromStatus];
}

function applyDocumentFixups(document: any): any {
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
      description:
        "Board API key presented in the Authorization bearer header.",
    },
    [RUN_INTERFACE_AUTH_SCHEME]: {
      type: "http",
      scheme: "bearer",
      bearerFormat: "Run Interface Bearer",
      description:
        "Single-run bearer accepted only by the compiled paperclip.run-tools/v1 endpoint.",
    },
  };
  document.security = AUTHENTICATED_SECURITY;

  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(
      pathItem as Record<string, any>,
    )) {
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
        const responses = (operation.responses ??= {}) as Record<
          string,
          unknown
        >;
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
  summary:
    "List control-plane-eligible agents with current revisions for task ownership",
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
  summary:
    "Test an unsaved adapter configuration through a disposable ACPX session",
  description:
    "Validates the exact active ACPX adapter and its generic session selections, then opens and removes a no-prompt local test session. This does not claim execution-workspace readiness and persists no agent, revision, or run.",
  request: {
    params: z.object({ companyId: canonicalUuidSchema, type: z.string() }),
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
          .refine(
            (value) => value.trim() === value,
            "originId must not contain surrounding whitespace",
          )
          .optional(),
        originKind: z
          .string()
          .min(1)
          .refine(
            (value) => value.trim() === value,
            "originKind must not contain surrounding whitespace",
          )
          .optional(),
        ownerAgentId: canonicalUuidSchema.optional(),
        ownerUserId: z
          .string()
          .min(1)
          .refine(
            (value) => value.trim() === value,
            "ownerUserId must be an exact non-blank user ID",
          )
          .optional(),
        parentId: canonicalUuidSchema.optional(),
        participantAgentId: canonicalUuidSchema.optional(),
        projectId: canonicalUuidSchema.optional(),
        q: z
          .string()
          .min(1)
          .refine(
            (value) => value.trim() === value,
            "q must not contain surrounding whitespace",
          )
          .optional(),
        sortDir: z.enum(["asc", "desc"]).optional(),
        sortField: z.literal("updated").optional(),
        status: z
          .union([z.enum(TASK_STATUSES), z.array(z.enum(TASK_STATUSES)).min(1)])
          .optional(),
        touchedByUserId: z
          .string()
          .min(1)
          .refine(
            (value) => value.trim() === value,
            "touchedByUserId must be an exact non-blank user ID",
          )
          .optional(),
        unreadForUserId: z
          .string()
          .min(1)
          .refine(
            (value) => value.trim() === value,
            "unreadForUserId must be an exact non-blank user ID",
          )
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
  summary:
    "Let the immutable named-user creator self-assign for cancellation only",
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
  summary:
    "Commit a documented human escalation or withdrawal owner form update",
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
  request: { params: z.object({ id: canonicalUuidSchema, key: z.string() }) },
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
  request: { params: z.object({ id: canonicalUuidSchema, key: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/tasks/{id}/documents/{key}/revisions",
  tags: ["tasks"],
  summary: "List task document revisions",
  request: { params: z.object({ id: canonicalUuidSchema, key: z.string() }) },
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
  summary:
    "Add a typed user comment with an optional explicit current-owner mention",
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

// ─── Costs ───────────────────────────────────────────────────────────────────

const costRangeQuerySchema = z
  .object({
    from: exactIsoDateTimeQueryParameterSchema.optional(),
    to: exactIsoDateTimeQueryParameterSchema.optional(),
  })
  .strict();

const costListQuerySchema = costRangeQuerySchema
  .extend({
    limit: exactPositiveIntegerQueryParameterSchema(500).optional(),
  })
  .strict();

const costSummaryResponseSchema = z
  .object({
    companyId: canonicalUuidSchema,
    budgetCurrency: budgetCurrencySchema,
    knownSpendAmount: moneyAmountSchema,
    budgetMonthlyAmount: moneyAmountSchema,
    remainingAmount: moneyAmountSchema,
    utilizationPercent: z.number().nonnegative(),
    pricedPromptCount: z.number().int().nonnegative(),
    unpricedPromptCount: z.number().int().nonnegative(),
  })
  .strict();

const costByAgentResponseSchema = z.array(
  z
    .object({
      agentId: canonicalUuidSchema,
      agentName: z.string().nullable(),
      agentStatus: z.string().nullable(),
      budgetCurrency: budgetCurrencySchema,
      knownCostAmount: moneyAmountSchema,
      pricedPromptCount: z.number().int().nonnegative(),
      unpricedPromptCount: z.number().int().nonnegative(),
    })
    .strict(),
);

const costByProjectResponseSchema = z.array(
  z
    .object({
      projectId: canonicalUuidSchema.nullable(),
      projectName: z.string().nullable(),
      budgetCurrency: budgetCurrencySchema,
      knownCostAmount: moneyAmountSchema,
      pricedPromptCount: z.number().int().nonnegative(),
      unpricedPromptCount: z.number().int().nonnegative(),
    })
    .strict(),
);

const taskCostSummaryResponseSchema = z
  .object({
    taskId: canonicalUuidSchema,
    taskCount: z.number().int().nonnegative(),
    includeDescendants: z.boolean(),
    budgetCurrency: budgetCurrencySchema,
    knownCostAmount: moneyAmountSchema,
    pricedPromptCount: z.number().int().nonnegative(),
    unpricedPromptCount: z.number().int().nonnegative(),
    runCount: z.number().int().nonnegative(),
    runtimeMs: z.number().nonnegative(),
  })
  .strict();

const canonicalCostEventResponseSchema = z
  .object({
    id: canonicalUuidSchema,
    accountingId: canonicalUuidSchema,
    companyId: canonicalUuidSchema,
    taskId: canonicalUuidSchema,
    agentId: canonicalUuidSchema,
    runId: canonicalUuidSchema,
    runKind: z.enum(TASK_EXECUTION_RUN_KINDS),
    promptKind: z.enum(["base", "steering"]),
    refId: canonicalUuidSchema.nullable(),
    runOrdinal: z.number().int().nonnegative().nullable(),
    segmentOrdinal: z.number().int().nonnegative().nullable(),
    budgetCurrency: budgetCurrencySchema,
    kind: z.enum(["known", "unavailable"]),
    unavailableReason: z.enum(ACP_COST_UNAVAILABLE_REASONS).nullable(),
    observedCumulativeAmount: moneyAmountSchema.nullable(),
    observedCurrency: z.string().nullable(),
    knownDeltaAmount: moneyAmountSchema.nullable(),
    cursorBeforeState: z.enum(ACP_COST_CURSOR_STATES),
    cursorBeforeAmount: moneyAmountSchema.nullable(),
    cursorBeforeCurrency: budgetCurrencySchema.nullable(),
    cursorAfterState: z.enum(["known", "unavailable"]),
    cursorAfterAmount: moneyAmountSchema.nullable(),
    cursorAfterCurrency: budgetCurrencySchema.nullable(),
    occurredAt: z.string().datetime(),
    createdAt: z.string().datetime(),
  })
  .strict();

const financeSummaryRowResponseSchema = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    debitAmount: moneyAmountSchema,
    creditAmount: moneyAmountSchema,
    netDirection: z.enum(["debit", "credit"]),
    netAmount: moneyAmountSchema,
    estimatedDebitAmount: moneyAmountSchema,
    eventCount: z.number().int().nonnegative(),
  })
  .strict();

const financeEventResponseSchema = z
  .object({
    amount: moneyAmountSchema,
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .passthrough();

const budgetPolicySummaryResponseSchema = z
  .object({
    budgetCurrency: budgetCurrencySchema,
    limitAmount: moneyAmountSchema,
    observedAmount: moneyAmountSchema,
    remainingAmount: moneyAmountSchema,
  })
  .passthrough();

const budgetIncidentResponseSchema = z
  .object({
    budgetCurrency: budgetCurrencySchema,
    limitAmount: moneyAmountSchema,
    observedAmount: moneyAmountSchema,
  })
  .passthrough();

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/costs/summary",
  tags: ["costs"],
  summary: "Get canonical AI cost summary",
  request: {
    params: z.object({ companyId: canonicalUuidSchema }),
    query: costRangeQuerySchema,
  },
  responses: { 200: r.ok(costSummaryResponseSchema), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/costs/by-agent",
  tags: ["costs"],
  summary: "Get canonical AI costs by agent",
  request: {
    params: z.object({ companyId: canonicalUuidSchema }),
    query: costRangeQuerySchema,
  },
  responses: { 200: r.ok(costByAgentResponseSchema), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/costs/by-project",
  tags: ["costs"],
  summary: "Get canonical AI costs by project",
  request: {
    params: z.object({ companyId: canonicalUuidSchema }),
    query: costRangeQuerySchema,
  },
  responses: { 200: r.ok(costByProjectResponseSchema), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/cost-events",
  tags: ["costs"],
  summary: "List canonical settled-prompt cost facts",
  request: {
    params: z.object({ companyId: canonicalUuidSchema }),
    query: costListQuerySchema,
  },
  responses: {
    200: r.ok(z.array(canonicalCostEventResponseSchema)),
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
    query: costRangeQuerySchema,
  },
  responses: {
    200: r.ok(
      z
        .object({
          companyId: canonicalUuidSchema,
          currencies: z.array(financeSummaryRowResponseSchema),
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
    query: costRangeQuerySchema,
  },
  responses: {
    200: r.ok(
      z.array(
        financeSummaryRowResponseSchema
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
    query: costRangeQuerySchema,
  },
  responses: {
    200: r.ok(
      z.array(
        financeSummaryRowResponseSchema
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
    query: costListQuerySchema,
  },
  responses: {
    200: r.ok(z.array(financeEventResponseSchema)),
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
    201: r.ok(financeEventResponseSchema),
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
    200: r.ok(budgetPolicySummaryResponseSchema),
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
    200: r.ok(budgetIncidentResponseSchema),
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
          policies: z.array(budgetPolicySummaryResponseSchema),
          activeIncidents: z.array(budgetIncidentResponseSchema),
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
    200: r.ok(budgetPolicySummaryResponseSchema),
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
            .regex(
              /^(approval|join|run|attention):.+$/,
              "Unsupported inbox item key",
            )
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
    200: r.ok(
      z.object({ run: taskExecutionRunEnvelopeRecordSchema }).passthrough(),
    ),
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
    params: z.object({ id: canonicalUuidSchema, holdId: canonicalUuidSchema }),
  },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/tasks/{id}/tree-holds/{holdId}/release",
  tags: ["tasks"],
  summary: "Release a task tree hold",
  request: {
    params: z.object({ id: canonicalUuidSchema, holdId: canonicalUuidSchema }),
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
    params: z.object({ companyId: canonicalUuidSchema, userId: z.string() }),
  },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
});

registry.registerPath({
  method: "put",
  path: "/api/companies/{companyId}/users/{userId}/inbox-agent-policy",
  tags: ["companies"],
  summary: "Update a company user's inbox agent policy",
  request: {
    params: z.object({ companyId: canonicalUuidSchema, userId: z.string() }),
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
  summary:
    "List selectable ACPX agents and non-selectable local probe diagnostics",
  responses: {
    200: r.ok(z.array(publicAdapterInfoSchema)),
    401: r.unauthorized,
  },
});

// ─── Plugins ──────────────────────────────────────────────────────────────────

const pluginInstallationParams = z.object({ pluginId: canonicalUuidSchema });

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

registry.registerPath({
  method: "delete",
  path: "/api/plugins/{pluginId}",
  tags: ["plugins"],
  summary: "Delete a plugin",
  request: {
    params: pluginInstallationParams,
  },
  responses: {
    204: r.noContent,
    400: r.badRequest,
    401: r.unauthorized,
    403: r.forbidden,
    404: r.notFound,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/plugins/{pluginId}/enable",
  tags: ["plugins"],
  summary: "Enable a plugin",
  request: { params: pluginInstallationParams },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/plugins/{pluginId}/disable",
  tags: ["plugins"],
  summary: "Disable a plugin",
  request: {
    params: pluginInstallationParams,
    body: jsonBody(pluginDisableRequestSchema),
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
  method: "get",
  path: "/api/plugins/{pluginId}/logs",
  tags: ["plugins"],
  summary: "Get plugin logs",
  request: {
    params: pluginInstallationParams,
    query: pluginLogsQuerySchema,
  },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
});

registry.registerPath({
  method: "post",
  path: "/api/plugins/{pluginId}/upgrade",
  tags: ["plugins"],
  summary: "Upgrade a plugin",
  request: {
    params: pluginInstallationParams,
    body: jsonBody(pluginUpgradeRequestSchema),
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
  method: "get",
  path: "/api/plugins/{pluginId}/config",
  tags: ["plugins"],
  summary: "Get instance-scoped plugin config",
  request: {
    params: pluginInstallationParams,
  },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
});

registry.registerPath({
  method: "post",
  path: "/api/plugins/{pluginId}/config",
  tags: ["plugins"],
  summary: "Set instance-scoped plugin config",
  request: {
    params: pluginInstallationParams,
    body: jsonBody(pluginConfigRequestSchema),
  },
  responses: {
    200: r.ok(),
    400: r.badRequest,
    401: r.unauthorized,
    403: r.forbidden,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/plugins/{pluginId}/config/test",
  tags: ["plugins"],
  summary: "Test instance-scoped plugin config",
  request: {
    params: pluginInstallationParams,
    body: jsonBody(pluginConfigRequestSchema),
  },
  responses: {
    200: r.ok(),
    400: r.badRequest,
    401: r.unauthorized,
    403: r.forbidden,
    502: pluginBridgeErrorResponse,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/plugins/{pluginId}/jobs",
  tags: ["plugins"],
  summary: "List plugin jobs",
  request: {
    params: pluginInstallationParams,
  },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
});

registry.registerPath({
  method: "get",
  path: "/api/plugins/{pluginId}/jobs/{jobId}/runs",
  tags: ["plugins"],
  summary: "List runs for a plugin job",
  request: {
    params: pluginInstallationParams.extend({ jobId: canonicalUuidSchema }),
    query: pluginJobRunsQuerySchema,
  },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
});

registry.registerPath({
  method: "post",
  path: "/api/plugins/{pluginId}/jobs/{jobId}/trigger",
  tags: ["plugins"],
  summary: "Trigger a plugin job",
  request: {
    params: pluginInstallationParams.extend({ jobId: canonicalUuidSchema }),
  },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/plugins/{pluginId}/webhooks/{endpointKey}",
  tags: ["plugins"],
  summary: "Deliver an external webhook payload to a plugin",
  request: {
    params: pluginInstallationParams.extend({ endpointKey: z.string() }),
  },
  responses: {
    200: r.ok(),
    400: r.badRequest,
    404: r.notFound,
    502: pluginBridgeErrorResponse,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/plugins/{pluginId}/dashboard",
  tags: ["plugins"],
  summary: "Get plugin dashboard data",
  request: { params: pluginInstallationParams },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
});

registry.registerPath({
  method: "post",
  path: "/api/plugins/{pluginId}/data/{key}",
  tags: ["plugins"],
  summary: "Get plugin data by key",
  request: {
    params: pluginInstallationParams.extend({ key: z.string() }),
    body: jsonBody(pluginBridgeRequestSchema),
  },
  responses: {
    200: r.ok(),
    401: r.unauthorized,
    502: pluginBridgeErrorResponse,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/plugins/{pluginId}/actions/{key}",
  tags: ["plugins"],
  summary: "Invoke a plugin action",
  request: {
    params: pluginInstallationParams.extend({ key: z.string() }),
    body: jsonBody(pluginBridgeRequestSchema),
  },
  responses: {
    200: r.ok(),
    401: r.unauthorized,
    502: pluginBridgeErrorResponse,
  },
});

// ─── Task comment reads ──────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/tasks/{id}/comments/{commentId}",
  tags: ["tasks"],
  summary: "Get a single task comment",
  request: {
    params: z.object({
      id: canonicalUuidSchema,
      commentId: canonicalUuidSchema,
    }),
  },
  responses: {
    200: r.ok(boardTaskCommentSchema),
    401: r.unauthorized,
    404: r.notFound,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/tasks/{id}/comments/{rootCommentId}/thread",
  tags: ["tasks"],
  summary: "Page one root comment group",
  request: {
    params: z.object({
      id: canonicalUuidSchema,
      rootCommentId: canonicalUuidSchema,
    }),
    query: z
      .object({
        cursor: exactNonBlankQueryParameterSchema.optional(),
        limit: exactPositiveIntegerQueryParameterSchema(500).optional(),
      })
      .strict(),
  },
  responses: {
    200: r.ok(boardTaskCommentThreadPageSchema),
    401: r.unauthorized,
    404: r.notFound,
  },
});

// ─── Org chart images ─────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/org.svg",
  tags: ["companies"],
  summary: "Get org chart as SVG",
  request: { params: z.object({ companyId: canonicalUuidSchema }) },
  responses: { 200: { description: "SVG image" }, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/org.png",
  tags: ["companies"],
  summary: "Get org chart as PNG",
  request: { params: z.object({ companyId: canonicalUuidSchema }) },
  responses: { 200: { description: "PNG image" }, 401: r.unauthorized },
});

// ─── Company portability ─────────────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/api/companies/imports/preview",
  tags: ["companies"],
  summary: "Preview a new-company import",
  request: { body: jsonBody(companyPortabilityPreviewSchema) },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/imports",
  tags: ["companies"],
  summary: "Apply a new-company import",
  request: { body: jsonBody(companyPortabilityImportSchema) },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

// ─── CLI auth ─────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/cli-auth/challenges/{id}",
  tags: ["access"],
  summary: "Get a CLI auth challenge",
  request: { params: z.object({ id: canonicalUuidSchema }) },
  responses: { 200: r.ok(), 404: r.notFound },
});

// ─── Invite assets ────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/invites/{token}/logo",
  tags: ["access"],
  summary: "Get company logo for an invite",
  request: { params: z.object({ token: z.string() }) },
  responses: { 200: { description: "Image file" }, 404: r.notFound },
});

// ─── Admin ────────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/admin/users/{userId}/company-access",
  tags: ["admin"],
  summary: "Get company access for a user (admin)",
  request: { params: z.object({ userId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
});

registry.registerPath({
  method: "put",
  path: "/api/admin/users/{userId}/company-access",
  tags: ["admin"],
  summary: "Set company access for a user (admin)",
  request: {
    params: z.object({ userId: z.string() }),
    body: jsonBody(updateUserCompanyAccessSchema),
  },
  responses: {
    200: r.ok(),
    400: r.badRequest,
    401: r.unauthorized,
    403: r.forbidden,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/admin/users/{userId}/promote-instance-admin",
  tags: ["admin"],
  summary: "Promote a user to instance admin",
  request: { params: z.object({ userId: z.string() }) },
  responses: {
    200: r.ok(),
    401: r.unauthorized,
    403: r.forbidden,
    404: r.notFound,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/admin/users/{userId}/demote-instance-admin",
  tags: ["admin"],
  summary: "Demote a user from instance admin",
  request: { params: z.object({ userId: z.string() }) },
  responses: {
    200: r.ok(),
    401: r.unauthorized,
    403: r.forbidden,
    404: r.notFound,
  },
});

// ─── Plugin UI static ─────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/_plugins/{pluginId}/ui/{filePath}",
  tags: ["plugins"],
  summary: "Serve plugin UI static file",
  request: {
    params: pluginInstallationParams.extend({ filePath: z.string() }),
  },
  responses: { 200: { description: "Static file content" }, 404: r.notFound },
});

// ─── Current route coverage ─────────────────────────────────────────────────

registerCurrentRoute({
  method: "post",
  path: "/api/health/dev-server/restart",
  tags: ["health"],
  summary: "Request a managed dev-server restart",
  responses: {
    202: r.ok(),
    403: r.forbidden,
    404: r.notFound,
    409: { description: "Restart is not required" },
  },
});

registerCurrentRoute({
  method: "post",
  path: "/api/bootstrap/claim",
  tags: ["access"],
  summary: "Claim first instance admin from a browser session",
  responses: {
    200: r.ok(),
    401: r.unauthorized,
    404: r.notFound,
    409: { description: "Instance admin already claimed" },
  },
});

registerCurrentRoute({
  method: "get",
  path: "/api/board-api-keys",
  tags: ["access"],
  summary: "List board API keys",
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registerCurrentRoute({
  method: "post",
  path: "/api/board-api-keys",
  tags: ["access"],
  summary: "Create a named board API key",
  body: createBoardApiKeySchema,
  responses: { 201: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registerCurrentRoute({
  method: "delete",
  path: "/api/board-api-keys/{keyId}",
  tags: ["access"],
  summary: "Revoke a board API key",
});

for (const route of [
  ["get", "/api/companies/{companyId}/search", "Search company data"],
  [
    "get",
    "/api/companies/{companyId}/search/extract",
    "Extract company search matches",
  ],
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
  [
    "get",
    "/api/companies/{companyId}/secret-providers/health",
    "Check configured secret providers",
  ],
  [
    "get",
    "/api/companies/{companyId}/secret-provider-configs",
    "List secret provider configurations",
  ],
  [
    "get",
    "/api/secret-provider-configs/{id}",
    "Get a secret provider configuration",
  ],
  [
    "delete",
    "/api/secret-provider-configs/{id}",
    "Delete a secret provider configuration",
  ],
  [
    "post",
    "/api/secret-provider-configs/{id}/default",
    "Set the default secret provider configuration",
  ],
  [
    "post",
    "/api/secret-provider-configs/{id}/health",
    "Check a secret provider configuration",
  ],
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
  [
    "get",
    "/api/tasks/{id}/documents/{key}/annotations",
    "List document annotation threads",
  ],
  [
    "get",
    "/api/tasks/{id}/documents/{key}/annotations/{threadId}",
    "Get a document annotation thread",
  ],
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
  [
    "get",
    "/api/routines/{id}/description/annotations",
    "List routine description annotation threads",
  ],
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
  [
    "post",
    "/api/routines/{id}/revisions/{revisionId}/restore",
    "Restore a routine revision",
  ],
] as const) {
  registerCurrentRoute({
    method: route[0],
    path: route[1],
    tags: ["routines"],
    summary: route[2],
  });
}

for (const route of [
  [
    "get",
    "/api/plugins/{pluginId}/companies/{companyId}/local-folders",
    "List plugin local folders",
  ],
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
    ...(route[0] === "post" || route[0] === "put"
      ? { body: pluginLocalFolderPathRequestSchema }
      : {}),
  });
}

// ─── Spec builder ─────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildOpenApiDocument(): any {
  return applyDocumentFixups({
    openapi: "3.0.0",
    info: {
      title: "Paperclip API",
      version: "1.0.0",
      description: "REST API for the Paperclip AI agent management platform",
    },
    servers: [{ url: "/" }],
    components: registry.buildComponents(),
    paths: registry.buildPaths(),
  });
}

export function openApiRoutes() {
  const router = Router({ caseSensitive: true, strict: true });
  router.get("/openapi.json", (_req, res) => {
    res.json(buildOpenApiDocument());
  });
  return router;
}
