import { Router } from "express";
import { z } from "zod";
import {
  // Agent
  agentCompanySkillPinsResponseSchema,
  agentCompanySkillPinsUpdateSchema,
  publicAgentAdapterAcpConfigurationSchema,
  agentAdapterConfigurationTestInputSchema,
  agentAdapterConfigurationTestResultSchema,
  agentAdapterRevisionConfigurationSchema,
  agentOperationalConfigurationUpdateSchema,
  runtimeAgentCreateConfigurationSchema,
  runtimeAgentUpdateConfigurationSchema,
  // Issue
  createIssueSchema,
  updateIssueTitleSchema,
  updateIssueExecutionPolicySchema,
  decideIssueExecutionStageSchema,
  reassignIssueSchema,
  commitIssueCreatorFormSchema,
  commitIssueOwnerFormSchema,
  selfAssignIssueWithdrawalSchema,
  reopenIssueSchema,
  createIssueLabelSchema,
  createIssueUserCommentSchema,
  boardIssueCommentSchema,
  boardIssueCommentGroupPageSchema,
  boardIssueCommentThreadPageSchema,
  linkIssueApprovalSchema,
  createIssueWorkProductSchema,
  updateIssueWorkProductSchema,
  upsertIssueDocumentSchema,
  restoreIssueDocumentRevisionSchema,
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
  // Routine
  createRoutineSchema,
  updateRoutineSchema,
  createRoutineTriggerSchema,
  updateRoutineTriggerSchema,
  rotateRoutineTriggerSecretSchema,
  runRoutineSchema,
  // Folders
  createFolderSchema,
  ensureMySkillFolderSchema,
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
  issueExecutionWatchdogDecisionInputSchema,
  moneyAmountSchema,
  budgetCurrencySchema,
  ACP_COST_UNAVAILABLE_REASONS,
  ACP_COST_CURSOR_STATES,
  ISSUE_EXECUTION_RUN_KINDS,
  adapterRuntimeReadinessSchema,
  // Sidebar
  upsertSidebarOrderPreferenceSchema,
  // Company skills
  companySkillCreateSchema,
  companySkillFileDeleteSchema,
  companySkillFileUpdateSchema,
  companySkillImportSchema,
  companySkillTestInputCreateSchema,
  companySkillTestInputUpdateSchema,
  companySkillTestRunCreateSchema,
  companySkillTestRunListQuerySchema,
  companySkillTestRunTemplateCreateSchema,
  companySkillTestRunTemplateUpdateSchema,
  evaluateSkillPolicySchema,
  replaceSkillPolicySchema,
  updateInboxAgentPolicySchema,
  // Issue tree
  createIssueTreeHoldSchema,
  previewIssueTreeControlSchema,
  releaseIssueTreeHoldSchema,
  createChildIssueSchema,
  // Better Auth user profile input
  updateCurrentUserProfileSchema,
  // Company portability (legacy routes)
  companyPortabilityExportSchema,
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
  pluginConfigRequestSchema,
  pluginDisableRequestSchema,
  pluginInstallRequestSchema,
  pluginJobRunsQuerySchema,
  pluginListQuerySchema,
  pluginLocalFolderPathRequestSchema,
  pluginLogsQuerySchema,
  pluginUpgradeRequestSchema,
  PLUGIN_BRIDGE_ERROR_CODES,
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
  if (typeName === "ZodOptional" || typeName === "ZodDefault" || typeName === "ZodCatch") {
    return unwrapSchema(schema._def.innerType);
  }
  if (typeName === "ZodEffects") {
    return unwrapSchema(schema._def.schema);
  }
  return schema;
}

function isOptionalSchema(schema: z.ZodTypeAny): boolean {
  const typeName = zodTypeName(schema);
  if (typeName === "ZodOptional" || typeName === "ZodDefault" || typeName === "ZodCatch") {
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

function applyStringChecks(jsonSchema: JsonSchema, checks: Array<Record<string, unknown>>) {
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

function applyNumberChecks(jsonSchema: JsonSchema, checks: Array<Record<string, unknown>>) {
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
    return { oneOf: unwrapped._def.options.map((option: z.ZodTypeAny) => zodToOpenApiSchema(option)) };
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
      const content = response.content as Record<string, { schema: unknown }> | undefined;
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

function parametersFromSchema(schema: z.ZodTypeAny, location: "path" | "query") {
  const objectSchema = unwrapSchema(schema);
  if (zodTypeName(objectSchema) !== "ZodObject") return [];
  const shape = objectSchema._def.shape();
  return Object.entries(shape).map(([name, value]) => ({
    name,
    in: location,
    required: location === "path" ? true : !isOptionalSchema(value as z.ZodTypeAny),
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
    for (const { method, path, request, responses, ...operation } of this.paths) {
      const normalizedOperation: Record<string, unknown> = {
        ...operation,
        responses: normalizeResponses(responses),
      };
      if (request?.params) {
        normalizedOperation.parameters = parametersFromSchema(request.params, "path");
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

const ErrorSchema = registry.register(
  "Error",
  z.object({ error: z.string() }),
);

const PluginBridgeErrorSchema = registry.register(
  "PluginBridgeError",
  z.object({
    code: z.enum(PLUGIN_BRIDGE_ERROR_CODES),
    message: z.string(),
    details: z.unknown().optional(),
  }).strict(),
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

const publicAdapterCapabilitiesSchema = z.object({
  supportsModelProfiles: z.boolean(),
  contractVersion: z.literal("acpx-runtime/v1"),
  runtimeControls: z.array(z.string().min(1)),
}).strict();

const acpAdapterModelSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  value: z.string().min(1),
  limits: z.object({
    contextTokenLimit: z.number().int().positive(),
    inputTokenLimit: z.number().int().positive().optional(),
    outputTokenLimit: z.number().int().positive(),
  }).strict().nullable(),
}).strict();

// Configuration field details are dynamically supplied by ACPX. The server
// validates the exact declarative contract before serializing it, while this
// public schema deliberately leaves field-specific metadata open for future
// ACPX controls.
const publicAdapterConfigSchema = z.object({
  fields: z.array(z.unknown()),
}).passthrough();

const publicReadyAdapterInfoSchema = z.object({
  type: z.string(),
  label: z.string(),
  source: z.literal("acpx"),
  modelsCount: z.number().int().nonnegative(),
  loaded: z.literal(true),
  capabilities: publicAdapterCapabilitiesSchema,
  registryName: z.string().min(1),
  configSchema: publicAdapterConfigSchema,
}).strict();

const publicUnavailableAdapterInfoSchema = z.object({
  type: z.string().min(1),
  label: z.string().min(1),
  source: z.literal("acpx"),
  modelsCount: z.literal(0),
  loaded: z.literal(false),
  diagnostic: z.object({
    code: z.enum(["acpx_probe_failed", "acpx_catalog_invalid"]),
    message: z.string().min(1),
  }).strict(),
  registryName: z.string().min(1),
}).strict();

const publicAdapterInfoSchema = z.discriminatedUnion("loaded", [
  publicReadyAdapterInfoSchema,
  publicUnavailableAdapterInfoSchema,
]);

const adapterImplementationIdentitySchema = z.object({
  adapterType: z.string().min(1),
  definitionVersion: z.literal("acpx-runtime/v1"),
  protocolVersion: z.literal(1),
  origin: z.enum(["builtin", "external"]),
  packageName: z.string().min(1),
  packageVersion: z.string().min(1),
  buildIdentity: z.string().min(1),
  artifactDigest: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

const publicAgentAdapterRevisionSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  agentId: z.string().uuid(),
  revisionNumber: z.number().int().positive(),
  adapterType: z.string().min(1),
  implementationIdentity: adapterImplementationIdentitySchema,
  adapterConfigSchemaVersion: z.literal(
    "paperclip.acp-adapter-config/v1",
  ),
  normalizedConfig: z.record(z.unknown()),
  runtimeConfig: z.record(z.unknown()),
  acpConfiguration: publicAgentAdapterAcpConfigurationSchema,
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  parentRevisionId: z.string().uuid().nullable(),
  createdByAgentId: z.string().uuid().nullable(),
  createdByUserId: z.string().nullable(),
  createdAt: z.string().datetime(),
}).strict();

const publicAgentAdapterRevisionCreateResponseSchema = z.object({
  revision: publicAgentAdapterRevisionSchema,
  current: z.object({
    agentId: z.string().uuid(),
    adapterType: z.string(),
    adapterConfig: z.record(z.unknown()),
    runtimeConfig: z.record(z.unknown()),
    currentAdapterConfigRevisionId: z.string().uuid(),
    updatedAt: z.string().datetime(),
  }).strict(),
  appended: z.boolean(),
}).strict();

const issueExecutionRunKindSchema = z.enum([
  "productive",
  "consult",
]);

const issueExecutionWatchdogDecisionRecordSchema = z
  .object({
    id: z.string().uuid(),
    companyId: z.string().uuid(),
    runId: z.string().uuid(),
    evaluationIssueId: z.string().uuid().nullable(),
    decision: z.enum([
      "snooze",
      "continue",
      "dismissed_false_positive",
    ]),
    snoozedUntil: z.string().datetime().nullable(),
    reason: z.string().min(1).max(4000).nullable(),
    createdByAgentId: z.string().uuid().nullable(),
    createdByUserId: z.string().nullable(),
    createdByRunId: z.string().uuid().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();

const issueExecutionRunEnvelopeRecordSchema = z
  .object({
    id: z.string().uuid(),
    companyId: z.string().uuid(),
    issueId: z.string().uuid(),
    sessionId: z.string().uuid(),
    executionScopeId: z.string().uuid(),
    kind: issueExecutionRunKindSchema,
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
    targetAgentId: z.string().uuid(),
    adapterConfigRevisionId: z.string().uuid(),
    executionMode: z.enum(["owner", "consult"]),
    issueExecutionAuthorityId: z.string().uuid().nullable(),
    consultExecutionId: z.string().uuid().nullable(),
    parentRunId: z.string().uuid().nullable(),
    retryOfRunId: z.string().uuid().nullable(),
    currentAttemptId: z.string().uuid().nullable(),
    currentLeaseId: z.string().uuid().nullable(),
    cancellationIntentId: z.string().uuid().nullable(),
    terminalFinalizationId: z.string().uuid().nullable(),
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable(),
    terminalClassification: z
      .enum(["succeeded", "interrupted", "failed", "cancelled", "timed_out"])
      .nullable(),
    terminalReasonCode: z.string().nullable(),
    processExitCode: z.number().int().nullable(),
    processSignal: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

const workTimelineQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  userId: z.string().optional(),
  goalId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  issueId: z.string().uuid().optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
}).strict();

const workTimelineResponseSchema = z.object({
  actors: z.array(z.object({
    id: z.string(),
    type: z.enum(["agent", "user", "system", "plugin"]),
    name: z.string(),
    avatar: z.string().nullable().optional(),
  }).strict()),
  spans: z.array(z.object({
    actorId: z.string(),
    runId: z.string(),
    kind: issueExecutionRunKindSchema,
    issueId: z.string(),
    issueIdentifier: z.string().nullable(),
    issueTitle: z.string().nullable(),
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
  }).strict()),
  events: z.array(z.object({
    actorId: z.string(),
    kind: z.enum(["created", "commented", "approved", "delegated", "assigned"]),
    issueId: z.string(),
    at: z.string(),
  }).strict()),
  edges: z.array(z.object({
    fromActorId: z.string(),
    toActorId: z.string(),
    issueId: z.string(),
    at: z.string(),
    kind: z.enum(["delegation", "assignment", "mention"]),
  }).strict()),
  pagination: z.object({
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
    totalIssues: z.number().int().nonnegative(),
    hasMore: z.boolean(),
  }).strict(),
  window: z.object({
    from: z.string(),
    to: z.string(),
    capped: z.boolean(),
  }).strict(),
}).strict();

function paramsSchemaFromPath(routePath: string): z.ZodObject<z.ZodRawShape> | undefined {
  const names = [...routePath.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]);
  if (names.length === 0) return undefined;
  const shape: z.ZodRawShape = {};
  for (const name of names) {
    shape[name] = z.string();
  }
  return z.object(shape);
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
  const request = params || input.query || input.body
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
    responses: input.responses ?? { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
  });
}

type OpenApiAuthLevel =
  | "public"
  | "authenticated"
  | "board"
  | "instance_admin"
  | "run_interface";

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

const RUN_INTERFACE_OPERATIONS = new Set([
  "POST /api/run-tools",
]);

const PUBLIC_OPERATIONS = new Set([
  "GET /api/health",
  "GET /api/openapi.json",
  "POST /api/cli-auth/challenges",
  "GET /api/cli-auth/challenges/{id}",
  "POST /api/cli-auth/challenges/{id}/cancel",
  "GET /api/invites/{token}",
  "GET /api/invites/{token}/logo",
  "GET /api/invites/{token}/onboarding",
  "GET /api/invites/{token}/onboarding.txt",
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
  "GET /api/companies/issues",
  "GET /api/cli-auth/me",
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
  "GET /api/agents/{id}/company-skill-pins",
  "PUT /api/agents/{id}/company-skill-pins",
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
  "GET /api/companies/{companyId}/resource-memberships/me",
  "PUT /api/companies/{companyId}/resource-memberships/me/agents/{agentId}",
  "PUT /api/companies/{companyId}/resource-memberships/me/projects/{projectId}",
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
  "GET /api/companies/{companyId}/me/user-secrets",
  "POST /api/companies/{companyId}/me/user-secrets",
  "PATCH /api/companies/{companyId}/me/user-secrets/{secretId}",
  "POST /api/companies/{companyId}/me/user-secrets/{secretId}/rotate",
  "DELETE /api/companies/{companyId}/me/user-secrets/{secretId}",
  "POST /api/companies/{companyId}/secrets/remote-import",
  "POST /api/companies/{companyId}/secrets/remote-import/preview",
  "GET /api/secrets/{id}/usage",
  "GET /api/secrets/{id}/access-events",
  "POST /api/health/dev-server/restart",
]);

const INSTANCE_ADMIN_OPERATIONS = new Set([
  "POST /api/companies",
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
  "POST /api/issues/{id}/documents/{key}/annotations",
  "POST /api/issues/{id}/documents/{key}/annotations/{threadId}/comments",
  "POST /api/routines/{id}/description/annotations",
  "POST /api/routines/{id}/description/annotations/{threadId}/comments",
  "POST /api/issues/{id}/work-products",
  "POST /api/issues/{id}/low-trust/promotions",
  "POST /api/issues/{id}/approvals",
  "POST /api/companies/{companyId}/issues",
  "POST /api/issues/{id}/children",
  "POST /api/issues/{id}/comments",
  "POST /api/companies/{companyId}/issues/{issueId}/attachments",
  "POST /api/companies/{companyId}/projects",
  "POST /api/companies/{companyId}/routines",
  "POST /api/companies/{companyId}/folders",
  "POST /api/companies/{companyId}/folders/ensure-my",
  "POST /api/routines/{id}/triggers",
  "POST /api/companies/{companyId}/secrets",
  "POST /api/companies/{companyId}/user-secret-definitions",
  "POST /api/companies/{companyId}/me/user-secrets",
  "POST /api/companies/{companyId}/skills",
  "POST /api/companies/{companyId}/skills/import",
  "POST /api/admin/users/{userId}/promote-instance-admin",
  "POST /api/plugins/install",
  "POST /api/companies/{companyId}/goals",
]);

const ACCEPTED_OPERATIONS = new Set([
  "POST /api/companies/import",
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

function resolveOperationAuthLevel(method: string, path: string): OpenApiAuthLevel {
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
      description: "Board API key presented in the Authorization bearer header.",
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

// ─── Health ──────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/health",
  tags: ["health"],
  summary: "Health check",
  responses: {
    200: r.ok(z.object({
      status: z.enum(["ok", "unhealthy"]),
      version: z.string().optional(),
      bootstrapStatus: z.enum(["ready", "bootstrap_pending"]).optional(),
      bootstrapInviteActive: z.boolean().optional(),
    })),
    503: { description: "Service unavailable", content: { "application/json": { schema: ErrorSchema } } },
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
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/artifacts",
  tags: ["companies"],
  summary: "List company artifacts",
  request: {
    params: z.object({ companyId: z.string() }),
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
    params: z.object({ companyId: z.string() }),
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
    params: z.object({ companyId: z.string() }),
    body: jsonBody(updateCompanySchema.partial()),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "patch",
  path: "/api/companies/{companyId}/branding",
  tags: ["companies"],
  summary: "Update company branding",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(updateCompanyBrandingSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/archive",
  tags: ["companies"],
  summary: "Archive a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "delete",
  path: "/api/companies/{companyId}",
  tags: ["companies"],
  summary: "Delete a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});


registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/exports",
  tags: ["companies"],
  summary: "Export company data",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/exports/preview",
  tags: ["companies"],
  summary: "Preview company export",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/imports/preview",
  tags: ["companies"],
  summary: "Preview company import",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/imports/apply",
  tags: ["companies"],
  summary: "Apply company import",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

// ─── Teams Catalog ──────────────────────────────────────────────────────────

for (const route of [
  ["get", "/api/teams/catalog", "List catalog teams"],
  ["get", "/api/teams/catalog/{catalogId}/files", "Get catalog team file"],
  ["get", "/api/teams/catalog/{catalogId}", "Get catalog team"],
  ["post", "/api/companies/{companyId}/teams/catalog/{catalogId}/preview", "Preview catalog team install"],
  ["post", "/api/companies/{companyId}/teams/catalog/{catalogId}/install", "Install catalog team"],
] as const) {
  registerCurrentRoute({
    method: route[0],
    path: route[1],
    tags: ["teams"],
    summary: route[2],
  });
}

// ─── Agents ──────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/agents",
  tags: ["agents"],
  summary: "List agents in a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/issue-owner-catalog",
  tags: ["agents"],
  summary: "List agents eligible to own or be mentioned in an issue",
  request: { params: z.object({ companyId: z.string() }) },
  responses: {
    200: r.ok(z.array(z.object({
      id: z.string(),
      name: z.string(),
      title: z.string().nullable(),
      icon: z.string().nullable(),
    }).strict())),
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
    params: z.object({ companyId: z.string() }),
    body: jsonBody(runtimeAgentCreateConfigurationSchema),
  },
  responses: {
    200: r.ok(z.object({
      comment: boardIssueCommentSchema,
      retried: z.boolean(),
    }).strict()),
    201: r.ok(z.object({
      comment: boardIssueCommentSchema,
      retried: z.boolean(),
    }).strict()),
    400: r.badRequest,
    401: r.unauthorized,
    403: r.forbidden,
    409: r.conflict,
    422: r.unprocessable,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/agent-configurations",
  tags: ["agents"],
  summary: "List agent configurations for a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/org",
  tags: ["agents"],
  summary: "Get org chart data",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/agents/{id}",
  tags: ["agents"],
  summary: "Get an agent",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/agents/{id}/runtime-state",
  tags: ["agents"],
  summary: "Get canonical operational runtime state for an agent",
  request: { params: z.object({ id: z.string().uuid() }) },
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
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "patch",
  path: "/api/agents/{id}/runtime-configuration",
  tags: ["agents"],
  summary: "Update explicit agent context, action, and mention grants",
  request: {
    params: z.object({ id: z.string() }),
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
  path: "/api/agents/{id}/company-skill-pins",
  tags: ["agents"],
  summary: "Read the exact company skill pins from the current agent configuration",
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({ companyId: z.string().optional() }),
  },
  responses: {
    200: r.ok(agentCompanySkillPinsResponseSchema),
    401: r.unauthorized,
    403: r.forbidden,
    404: r.notFound,
    422: r.unprocessable,
  },
});

registry.registerPath({
  method: "put",
  path: "/api/agents/{id}/company-skill-pins",
  tags: ["agents"],
  summary: "Replace the exact company skill pins and append the derived adapter snapshot",
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({ companyId: z.string().optional() }),
    body: jsonBody(agentCompanySkillPinsUpdateSchema),
  },
  responses: {
    200: r.ok(agentCompanySkillPinsResponseSchema),
    400: r.badRequest,
    401: r.unauthorized,
    403: r.forbidden,
    404: r.notFound,
    422: r.unprocessable,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/agents/{id}/adapter-config-revisions",
  tags: ["agents"],
  summary: "List immutable adapter configuration revisions, newest first",
  request: { params: z.object({ id: z.string() }) },
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
  request: { params: z.object({ id: z.string() }) },
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
    params: z.object({ id: z.string() }),
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
    params: z.object({ id: z.string() }),
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
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: r.ok(),
    401: r.unauthorized,
    403: r.forbidden,
    404: r.notFound,
    409: r.conflict,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/agents/{id}/configuration",
  tags: ["agents"],
  summary: "Get agent configuration",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/agents/{id}/config-revisions",
  tags: ["agents"],
  summary: "List agent config revisions",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/agents/{id}/config-revisions/{revisionId}",
  tags: ["agents"],
  summary: "Get an agent config revision",
  request: { params: z.object({ id: z.string(), revisionId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/agents/{id}/pause",
  tags: ["agents"],
  summary: "Pause an agent",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/agents/{id}/resume",
  tags: ["agents"],
  summary: "Resume an agent",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/agents/{id}/clear-error",
  tags: ["agents"],
  summary: "Clear an agent error",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden, 404: r.notFound, 409: r.conflict },
});

registry.registerPath({
  method: "post",
  path: "/api/agents/{id}/terminate",
  tags: ["agents"],
  summary: "Terminate an agent",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

// ─── Adapters ────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/adapters/{type}/models",
  tags: ["adapters"],
  summary: "List models for an adapter type",
  request: { params: z.object({ companyId: z.string(), type: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/adapters/{type}/test-configuration",
  tags: ["adapters"],
  summary: "Test an unsaved adapter configuration through a disposable ACPX session",
  description:
    "Validates the exact active ACPX adapter and its generic session selections, then opens and removes a no-prompt local test session. This does not claim execution-workspace readiness and persists no agent, revision, or run.",
  request: {
    params: z.object({ companyId: z.string(), type: z.string() }),
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

// ─── Issues ──────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/issues",
  tags: ["issues"],
  summary: "List issues in a company",
  description: "Use `view=compact` for the compact board issue-list row contract. The default response is the canonical full issue-list contract.",
  request: {
    params: z.object({ companyId: z.string() }),
    query: z.object({ view: z.enum(["compact"]).optional() }).passthrough(),
  },
  responses: { 200: r.ok(), 304: { description: "Not Modified" }, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/issues",
  tags: ["issues"],
  summary: "Create an issue",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createIssueSchema),
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
  path: "/api/issues/{id}",
  tags: ["issues"],
  summary: "Get an issue",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "patch",
  path: "/api/issues/{id}",
  tags: ["issues"],
  summary: "Update board-editable issue title metadata",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(updateIssueTitleSchema),
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
  path: "/api/issues/{id}/execution-policy",
  tags: ["issues"],
  summary: "Configure the board-owned execution policy for an issue",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(updateIssueExecutionPolicySchema),
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
  path: "/api/issues/{id}/execution-policy/decisions",
  tags: ["issues"],
  summary: "Append a decision for the active board execution-policy stage",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(decideIssueExecutionStageSchema),
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
  path: "/api/issues/{id}/reassign",
  tags: ["issues"],
  summary: "Reassign an issue through the separately audited board entrance",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(reassignIssueSchema),
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
  path: "/api/issues/{id}/creator-reassign",
  tags: ["issues"],
  summary: "Reassign an issue as its immutable named-user creator",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(reassignIssueSchema),
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
  path: "/api/issues/{id}/withdrawal-self-assignment",
  tags: ["issues"],
  summary:
    "Let the immutable named-user creator self-assign for cancellation only",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(selfAssignIssueWithdrawalSchema),
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
  path: "/api/issue-creator-form-updates",
  tags: ["issues"],
  summary: "Commit an exact authenticated named-creator form update",
  request: {
    body: jsonBody(commitIssueCreatorFormSchema),
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
  path: "/api/issue-owner-form-updates",
  tags: ["issues"],
  summary:
    "Commit a documented human escalation or withdrawal owner form update",
  request: {
    body: jsonBody(commitIssueOwnerFormSchema),
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
  path: "/api/issues/{id}/reopen",
  tags: ["issues"],
  summary: "Reopen a terminal issue through the audited board command",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(reopenIssueSchema),
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
  path: "/api/issues/{id}/work-products",
  tags: ["issues"],
  summary: "List issue work products",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/work-products",
  tags: ["issues"],
  summary: "Create an issue work product",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(createIssueWorkProductSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "patch",
  path: "/api/work-products/{id}",
  tags: ["issues"],
  summary: "Update a work product",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(updateIssueWorkProductSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/work-products/{id}",
  tags: ["issues"],
  summary: "Delete a work product",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/documents",
  tags: ["issues"],
  summary: "List issue documents",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/documents/{key}",
  tags: ["issues"],
  summary: "Get an issue document",
  request: { params: z.object({ id: z.string(), key: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "put",
  path: "/api/issues/{id}/documents/{key}",
  tags: ["issues"],
  summary: "Upsert an issue document",
  request: {
    params: z.object({ id: z.string(), key: z.string() }),
    body: jsonBody(upsertIssueDocumentSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/issues/{id}/documents/{key}",
  tags: ["issues"],
  summary: "Delete an issue document",
  request: { params: z.object({ id: z.string(), key: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/documents/{key}/revisions",
  tags: ["issues"],
  summary: "List issue document revisions",
  request: { params: z.object({ id: z.string(), key: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/documents/{key}/revisions/{revisionId}/restore",
  tags: ["issues"],
  summary: "Restore a document revision",
  request: {
    params: z.object({ id: z.string(), key: z.string(), revisionId: z.string() }),
    body: jsonBody(restoreIssueDocumentRevisionSchema),
  },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/comments",
  tags: ["issues"],
  summary: "Page root-grouped issue comments",
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({
      cursor: z.string().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
      entryLimit: z.coerce.number().int().min(1).max(500).optional(),
    }).strict(),
  },
  responses: { 200: r.ok(boardIssueCommentGroupPageSchema), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/comments",
  tags: ["issues"],
  summary: "Add a typed user comment with an optional explicit current-owner mention",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(createIssueUserCommentSchema),
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
  path: "/api/issues/{id}/approvals",
  tags: ["issues"],
  summary: "List issue approvals",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/approvals",
  tags: ["issues"],
  summary: "Link an approval to an issue",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(linkIssueApprovalSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/issues/{id}/approvals/{approvalId}",
  tags: ["issues"],
  summary: "Unlink an approval from an issue",
  request: { params: z.object({ id: z.string(), approvalId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/read",
  tags: ["issues"],
  summary: "Mark an issue as read",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/issues/{id}/read",
  tags: ["issues"],
  summary: "Mark an issue as unread",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/inbox-archive",
  tags: ["issues"],
  summary: "Archive issue from inbox",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(z.object({ userId: z.string().min(1).optional() })),
  },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
});

registry.registerPath({
  method: "delete",
  path: "/api/issues/{id}/inbox-archive",
  tags: ["issues"],
  summary: "Un-archive issue from inbox",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(z.object({ userId: z.string().min(1).optional() })),
  },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/attachments",
  tags: ["issues"],
  summary: "List issue attachments",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/labels",
  tags: ["issues"],
  summary: "List labels in a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/labels",
  tags: ["issues"],
  summary: "Create a label",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createIssueLabelSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/labels/{labelId}",
  tags: ["issues"],
  summary: "Delete a label",
  request: { params: z.object({ labelId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

// ─── Projects ────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/projects",
  tags: ["projects"],
  summary: "List projects in a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/projects",
  tags: ["projects"],
  summary: "Create a project",
  request: {
    params: z.object({ companyId: z.string() }),
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
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/projects/{id}/codebase",
  tags: ["projects"],
  summary: "Get the board-managed project codebase",
  request: { params: z.object({ id: z.string() }) },
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
    params: z.object({ id: z.string() }),
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
    params: z.object({ id: z.string() }),
    body: jsonBody(updateProjectSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/projects/{id}",
  tags: ["projects"],
  summary: "Delete a project",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});





// ─── Routines ────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/routines",
  tags: ["routines"],
  summary: "List routines in a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/routines",
  tags: ["routines"],
  summary: "Create a routine",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createRoutineSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/routines/{id}",
  tags: ["routines"],
  summary: "Get a routine",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "patch",
  path: "/api/routines/{id}",
  tags: ["routines"],
  summary: "Update a routine",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(updateRoutineSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/routines/{id}/runs",
  tags: ["routines"],
  summary: "List runs for a routine",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/routines/{id}/run",
  tags: ["routines"],
  summary: "Manually run a routine",
  request: {
    params: z.object({ id: z.string() }),
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
    params: z.object({ id: z.string() }),
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
    params: z.object({ id: z.string() }),
    body: jsonBody(updateRoutineTriggerSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/routine-triggers/{id}",
  tags: ["routines"],
  summary: "Delete a routine trigger",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/routine-triggers/{id}/rotate-secret",
  tags: ["routines"],
  summary: "Rotate a routine trigger secret",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(rotateRoutineTriggerSecretSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
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
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/goals",
  tags: ["goals"],
  summary: "Create a goal",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createGoalSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/goals/{id}",
  tags: ["goals"],
  summary: "Get a goal",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "patch",
  path: "/api/goals/{id}",
  tags: ["goals"],
  summary: "Update a goal",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(updateGoalSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/goals/{id}",
  tags: ["goals"],
  summary: "Delete a goal",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

// ─── Secrets ─────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/secret-providers",
  tags: ["secrets"],
  summary: "List secret providers",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/secrets",
  tags: ["secrets"],
  summary: "List secrets in a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/secrets",
  tags: ["secrets"],
  summary: "Create a secret",
  request: {
    params: z.object({ companyId: z.string() }),
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
    params: z.object({ id: z.string() }),
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
    params: z.object({ id: z.string() }),
    body: jsonBody(rotateSecretSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/secrets/{id}",
  tags: ["secrets"],
  summary: "Delete a secret",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/user-secret-definitions",
  tags: ["secrets"],
  summary: "List user secret definitions",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/user-secret-definitions",
  tags: ["secrets"],
  summary: "Create a user secret definition",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createUserSecretDefinitionSchema),
  },
  responses: { 201: r.ok(), 400: r.badRequest, 401: r.unauthorized, 403: r.forbidden },
});

registry.registerPath({
  method: "patch",
  path: "/api/companies/{companyId}/user-secret-definitions/{definitionId}",
  tags: ["secrets"],
  summary: "Update a user secret definition",
  request: {
    params: z.object({ companyId: z.string(), definitionId: z.string() }),
    body: jsonBody(updateUserSecretDefinitionSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

registry.registerPath({
  method: "delete",
  path: "/api/companies/{companyId}/user-secret-definitions/{definitionId}",
  tags: ["secrets"],
  summary: "Delete a user secret definition",
  request: { params: z.object({ companyId: z.string(), definitionId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/user-secret-definitions/{definitionId}/coverage",
  tags: ["secrets"],
  summary: "Get user secret definition coverage",
  request: { params: z.object({ companyId: z.string(), definitionId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/me/user-secrets",
  tags: ["secrets"],
  summary: "List my user secret values",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/me/user-secrets",
  tags: ["secrets"],
  summary: "Create my user secret value",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createUserSecretValueSchema),
  },
  responses: { 201: r.ok(), 400: r.badRequest, 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

registry.registerPath({
  method: "patch",
  path: "/api/companies/{companyId}/me/user-secrets/{secretId}",
  tags: ["secrets"],
  summary: "Update my user secret value",
  request: {
    params: z.object({ companyId: z.string(), secretId: z.string() }),
    body: jsonBody(updateUserSecretValueSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/me/user-secrets/{secretId}/rotate",
  tags: ["secrets"],
  summary: "Rotate my user secret value",
  request: {
    params: z.object({ companyId: z.string(), secretId: z.string() }),
    body: jsonBody(rotateUserSecretValueSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

registry.registerPath({
  method: "delete",
  path: "/api/companies/{companyId}/me/user-secrets/{secretId}",
  tags: ["secrets"],
  summary: "Delete my user secret value",
  request: { params: z.object({ companyId: z.string(), secretId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

// ─── Approvals ───────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/approvals",
  tags: ["approvals"],
  summary: "List approvals in a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/approvals",
  tags: ["approvals"],
  summary: "Create an approval",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createApprovalSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/approvals/{id}",
  tags: ["approvals"],
  summary: "Get an approval",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/approvals/{id}/issues",
  tags: ["approvals"],
  summary: "List issues linked to an approval",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/approvals/{id}/approve",
  tags: ["approvals"],
  summary: "Approve an approval",
  request: {
    params: z.object({ id: z.string() }),
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
    params: z.object({ id: z.string() }),
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
    params: z.object({ id: z.string() }),
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
    params: z.object({ id: z.string() }),
    body: jsonBody(resubmitApprovalSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/approvals/{id}/comments",
  tags: ["approvals"],
  summary: "List approval comments",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/approvals/{id}/comments",
  tags: ["approvals"],
  summary: "Add a comment to an approval",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(addApprovalCommentSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

// ─── Costs ───────────────────────────────────────────────────────────────────

const costRangeQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
}).strict();

const costListQuerySchema = costRangeQuerySchema.extend({
  limit: z.coerce.number().int().positive().max(500).optional(),
}).strict();

const costSummaryResponseSchema = z.object({
  companyId: z.string().uuid(),
  budgetCurrency: budgetCurrencySchema,
  knownSpendAmount: moneyAmountSchema,
  budgetMonthlyAmount: moneyAmountSchema,
  remainingAmount: moneyAmountSchema,
  utilizationPercent: z.number().nonnegative(),
  pricedPromptCount: z.number().int().nonnegative(),
  unpricedPromptCount: z.number().int().nonnegative(),
}).strict();

const costByAgentResponseSchema = z.array(z.object({
  agentId: z.string().uuid(),
  agentName: z.string().nullable(),
  agentStatus: z.string().nullable(),
  budgetCurrency: budgetCurrencySchema,
  knownCostAmount: moneyAmountSchema,
  pricedPromptCount: z.number().int().nonnegative(),
  unpricedPromptCount: z.number().int().nonnegative(),
}).strict());

const costByProjectResponseSchema = z.array(z.object({
  projectId: z.string().uuid().nullable(),
  projectName: z.string().nullable(),
  budgetCurrency: budgetCurrencySchema,
  knownCostAmount: moneyAmountSchema,
  pricedPromptCount: z.number().int().nonnegative(),
  unpricedPromptCount: z.number().int().nonnegative(),
}).strict());

const issueCostSummaryResponseSchema = z.object({
  issueId: z.string().uuid(),
  issueCount: z.number().int().nonnegative(),
  includeDescendants: z.boolean(),
  budgetCurrency: budgetCurrencySchema,
  knownCostAmount: moneyAmountSchema,
  pricedPromptCount: z.number().int().nonnegative(),
  unpricedPromptCount: z.number().int().nonnegative(),
  runCount: z.number().int().nonnegative(),
  runtimeMs: z.number().nonnegative(),
}).strict();

const canonicalCostEventResponseSchema = z.object({
  id: z.string().uuid(),
  accountingId: z.string().uuid(),
  companyId: z.string().uuid(),
  issueId: z.string().uuid(),
  agentId: z.string().uuid(),
  runId: z.string().uuid(),
  runKind: z.enum(ISSUE_EXECUTION_RUN_KINDS),
  promptKind: z.enum(["base", "steering"]),
  refId: z.string().uuid().nullable(),
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
}).strict();

const financeSummaryRowResponseSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  debitAmount: moneyAmountSchema,
  creditAmount: moneyAmountSchema,
  netDirection: z.enum(["debit", "credit"]),
  netAmount: moneyAmountSchema,
  estimatedDebitAmount: moneyAmountSchema,
  eventCount: z.number().int().nonnegative(),
}).strict();

const financeEventResponseSchema = z.object({
  amount: moneyAmountSchema,
  currency: z.string().regex(/^[A-Z]{3}$/),
}).passthrough();

const budgetPolicySummaryResponseSchema = z.object({
  budgetCurrency: budgetCurrencySchema,
  limitAmount: moneyAmountSchema,
  observedAmount: moneyAmountSchema,
  remainingAmount: moneyAmountSchema,
}).passthrough();

const budgetIncidentResponseSchema = z.object({
  budgetCurrency: budgetCurrencySchema,
  limitAmount: moneyAmountSchema,
  observedAmount: moneyAmountSchema,
}).passthrough();

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/costs/summary",
  tags: ["costs"],
  summary: "Get canonical AI cost summary",
  request: {
    params: z.object({ companyId: z.string() }),
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
    params: z.object({ companyId: z.string() }),
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
    params: z.object({ companyId: z.string() }),
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
    params: z.object({ companyId: z.string() }),
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
    params: z.object({ companyId: z.string() }),
    query: costRangeQuerySchema,
  },
  responses: {
    200: r.ok(z.object({
      companyId: z.string().uuid(),
      currencies: z.array(financeSummaryRowResponseSchema),
    }).strict()),
    401: r.unauthorized,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/costs/finance-by-biller",
  tags: ["costs"],
  summary: "Get finance totals by biller and currency",
  request: {
    params: z.object({ companyId: z.string() }),
    query: costRangeQuerySchema,
  },
  responses: {
    200: r.ok(z.array(financeSummaryRowResponseSchema.extend({
      biller: z.string(),
      kindCount: z.number().int().nonnegative(),
    }).strict())),
    401: r.unauthorized,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/costs/finance-by-kind",
  tags: ["costs"],
  summary: "Get finance totals by kind and currency",
  request: {
    params: z.object({ companyId: z.string() }),
    query: costRangeQuerySchema,
  },
  responses: {
    200: r.ok(z.array(financeSummaryRowResponseSchema.extend({
      eventKind: z.string(),
      billerCount: z.number().int().nonnegative(),
    }).strict())),
    401: r.unauthorized,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/costs/finance-events",
  tags: ["costs"],
  summary: "List finance events",
  request: {
    params: z.object({ companyId: z.string() }),
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
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createFinanceEventSchema),
  },
  responses: { 201: r.ok(financeEventResponseSchema), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/budgets/policies",
  tags: ["costs"],
  summary: "Create or update a budget policy",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(upsertBudgetPolicySchema),
  },
  responses: { 200: r.ok(budgetPolicySummaryResponseSchema), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/budget-incidents/{incidentId}/resolve",
  tags: ["costs"],
  summary: "Resolve a budget incident",
  request: {
    params: z.object({ companyId: z.string(), incidentId: z.string() }),
    body: jsonBody(resolveBudgetIncidentSchema),
  },
  responses: { 200: r.ok(budgetIncidentResponseSchema), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/budgets/overview",
  tags: ["costs"],
  summary: "Get budget overview",
  request: { params: z.object({ companyId: z.string() }) },
  responses: {
    200: r.ok(z.object({
      companyId: z.string().uuid(),
      budgetCurrency: budgetCurrencySchema,
      policies: z.array(budgetPolicySummaryResponseSchema),
      activeIncidents: z.array(budgetIncidentResponseSchema),
      pausedAgentCount: z.number().int().nonnegative(),
      pausedProjectCount: z.number().int().nonnegative(),
      pendingApprovalCount: z.number().int().nonnegative(),
    }).strict()),
    401: r.unauthorized,
  },
});

registry.registerPath({
  method: "patch",
  path: "/api/companies/{companyId}/budgets",
  tags: ["costs"],
  summary: "Update company budget",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(updateCompanyBudgetSchema),
  },
  responses: { 200: r.ok(budgetPolicySummaryResponseSchema), 400: r.badRequest, 401: r.unauthorized },
});

// ─── Activity ────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/activity",
  tags: ["activity"],
  summary: "List company activity",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/activity",
  tags: ["activity"],
  summary: "Create an activity entry",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(z.object({
      actorType: z.enum(["agent", "user", "system", "plugin"]).optional(),
      actorId: z.string().min(1),
      action: z.string().min(1),
      entityType: z.string().min(1),
      entityId: z.string().min(1),
      agentId: z.string().uuid().optional().nullable(),
      details: z.record(z.unknown()).optional().nullable(),
    })),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/activity",
  tags: ["activity"],
  summary: "List activity for an issue",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/runs",
  tags: ["runs"],
  summary: "List canonical issue execution run envelopes for an issue",
  request: {
    params: z.object({ id: z.string() }),
    query: z
      .object({
        status: z.string().min(1).optional(),
        cursor: z.string().max(1000).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      })
      .strict(),
  },
  responses: {
    200: r.ok(
      z
        .object({
          items: z.array(issueExecutionRunEnvelopeRecordSchema),
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
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

// ─── Sidebar ─────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/sidebar-badges",
  tags: ["sidebar"],
  summary: "Get sidebar badge counts",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/attention",
  tags: ["inbox"],
  summary: "List decision-only attention feed items",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
});

// ─── Decision training ──────────────────────────────────────────────────────

const decisionTrainingSourceKindSchema = z.enum(["interaction", "approval", "execution_decision"]);

registerCurrentRoute({
  method: "post",
  path: "/api/companies/{companyId}/decision-training",
  tags: ["decision-training"],
  summary: "Capture a decision training example",
  body: z.object({
    sourceKind: decisionTrainingSourceKindSchema,
    sourceId: z.string().uuid(),
    issueId: z.string().uuid(),
    notes: z.string().max(100_000).default(""),
  }).strict(),
  responses: { 201: r.ok(), 400: r.badRequest, 401: r.unauthorized, 403: r.forbidden, 404: r.notFound, 409: r.conflict },
});

registerCurrentRoute({
  method: "post",
  path: "/api/companies/{companyId}/decision-training/preview",
  tags: ["decision-training"],
  summary: "Preview a decision training snapshot",
  body: z.object({
    sourceKind: decisionTrainingSourceKindSchema,
    sourceId: z.string().uuid(),
    issueId: z.string().uuid(),
  }).strict(),
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 403: r.forbidden, 404: r.notFound, 409: r.conflict },
});

registerCurrentRoute({
  method: "get",
  path: "/api/companies/{companyId}/decision-training",
  tags: ["decision-training"],
  summary: "List decision training examples",
  query: z.object({
    project: z.string().uuid().optional(),
    kind: decisionTrainingSourceKindSchema.optional(),
    author: z.string().optional(),
    q: z.string().max(500).optional(),
  }),
});

registerCurrentRoute({
  method: "get",
  path: "/api/companies/{companyId}/decision-training/export.jsonl",
  tags: ["decision-training"],
  summary: "Export decision training examples as JSONL",
});

registerCurrentRoute({
  method: "get",
  path: "/api/decision-training/{id}",
  tags: ["decision-training"],
  summary: "Get a decision training example",
});

registerCurrentRoute({
  method: "patch",
  path: "/api/decision-training/{id}",
  tags: ["decision-training"],
  summary: "Update decision training notes",
  body: z.object({ notes: z.string().max(100_000) }).strict(),
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

registerCurrentRoute({
  method: "delete",
  path: "/api/decision-training/{id}",
  tags: ["decision-training"],
  summary: "Delete a decision training example",
  responses: { 204: r.ok(), 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/sidebar-preferences/me",
  tags: ["sidebar"],
  summary: "Get current user sidebar preferences",
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "put",
  path: "/api/sidebar-preferences/me",
  tags: ["sidebar"],
  summary: "Update current user sidebar preferences",
  request: { body: jsonBody(upsertSidebarOrderPreferenceSchema) },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/sidebar-preferences/me",
  tags: ["sidebar"],
  summary: "Get sidebar preferences for company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "put",
  path: "/api/companies/{companyId}/sidebar-preferences/me",
  tags: ["sidebar"],
  summary: "Update sidebar preferences for company",
  request: {
    params: z.object({ companyId: z.string() }),
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
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/inbox-dismissals",
  tags: ["inbox"],
  summary: "Create an inbox dismissal or snooze",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(z.object({
      itemKey: z.string().trim().min(1).regex(/^(approval|join|run|attention):.+$/, "Unsupported inbox item key"),
      kind: z.enum(["dismiss", "snooze"]).optional(),
      snoozedUntil: z.string().datetime().optional(),
    })),
  },
  responses: { 201: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/companies/{companyId}/inbox-dismissals/{itemKey}",
  tags: ["inbox"],
  summary: "Restore an inbox dismissal or snooze",
  request: { params: z.object({ companyId: z.string(), itemKey: z.string() }) },
  responses: { 204: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

// ─── Instance settings ────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/instance/settings",
  tags: ["instance"],
  summary: "Get instance settings",
  responses: { 200: r.ok(), 401: r.unauthorized },
});

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
  body: z.object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number(), z.null()]).optional(),
    method: z.enum(["initialize", "tools/list", "tools/call"]),
    params: z.unknown().optional(),
  }).strict(),
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
  query: z.object({
    status: z.enum(["pending", "accepted", "rejected", "expired"]).optional(),
  }).strict(),
});

registerCurrentRoute({
  method: "post",
  path: "/api/companies/{companyId}/change-consents/{consentId}/decision",
  tags: ["agents"],
  summary: "Record the named board user's change-consent decision",
  body: z.object({
    decision: z.enum(["accepted", "rejected"]),
    reason: z.string().trim().max(4_000).nullable().optional(),
  }).strict(),
});

// ─── Access / invites / members ───────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/invites",
  tags: ["access"],
  summary: "List company invites",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/invites",
  tags: ["access"],
  summary: "Create a company invite",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createCompanyInviteSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/join-requests",
  tags: ["access"],
  summary: "List company join requests",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/join-requests/{requestId}/approve",
  tags: ["access"],
  summary: "Approve a company join request",
  request: {
    params: z.object({ companyId: z.string(), requestId: z.string() }),
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
  request: { params: z.object({ companyId: z.string(), requestId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/invites/{inviteId}/revoke",
  tags: ["access"],
  summary: "Revoke an invite",
  request: { params: z.object({ inviteId: z.string() }) },
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
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/members",
  tags: ["access"],
  summary: "List company members",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "patch",
  path: "/api/companies/{companyId}/members/{memberId}",
  tags: ["access"],
  summary: "Update a company member status or role",
  request: {
    params: z.object({ companyId: z.string(), memberId: z.string() }),
    body: jsonBody(updateCompanyMemberSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "patch",
  path: "/api/companies/{companyId}/members/{memberId}/role-and-grants",
  tags: ["access"],
  summary: "Update a company member role and explicit grants",
  request: {
    params: z.object({ companyId: z.string(), memberId: z.string() }),
    body: jsonBody(updateCompanyMemberWithPermissionsSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/members/{memberId}/archive",
  tags: ["access"],
  summary: "Archive a company member",
  request: {
    params: z.object({ companyId: z.string(), memberId: z.string() }),
    body: jsonBody(archiveCompanyMemberSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "patch",
  path: "/api/companies/{companyId}/members/{memberId}/permissions",
  tags: ["access"],
  summary: "Update explicit company member permissions",
  request: {
    params: z.object({ companyId: z.string(), memberId: z.string() }),
    body: jsonBody(updateMemberPermissionsSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/user-directory",
  tags: ["access"],
  summary: "Get company user directory",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/cli-auth/me",
  tags: ["access"],
  summary: "Get current CLI auth session",
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
    params: z.object({ id: z.string() }),
    body: jsonBody(resolveCliAuthChallengeSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/cli-auth/challenges/{id}/cancel",
  tags: ["access"],
  summary: "Cancel a CLI auth challenge",
  request: {
    params: z.object({ id: z.string() }),
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
  path: "/api/companies/{companyId}/users/{userSlug}/profile",
  tags: ["auth"],
  summary: "Get a user profile within a company",
  request: { params: z.object({ companyId: z.string(), userSlug: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

// ─── Issue execution runs ────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/runs",
  tags: ["runs"],
  summary: "List canonical issue execution run envelopes",
  request: {
    params: z.object({ companyId: z.string().uuid() }),
    query: z
      .object({
        agentId: z.string().uuid().optional(),
        status: z.string().min(1).optional(),
        cursor: z.string().max(1000).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      })
      .strict(),
  },
  responses: {
    200: r.ok(
      z
        .object({
          items: z.array(issueExecutionRunEnvelopeRecordSchema),
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
  summary: "Get the bounded joined detail for an issue execution run",
  request: {
    params: z.object({ runId: z.string().uuid() }),
    query: z
      .object({
        limit: z.coerce.number().int().min(1).max(500).optional(),
      })
      .strict(),
  },
  responses: {
    200: r.ok(
      z
        .object({ run: issueExecutionRunEnvelopeRecordSchema })
        .passthrough(),
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
    params: z.object({ runId: z.string().uuid() }),
  },
  responses: {
    200: r.ok(adapterRuntimeReadinessSchema),
    401: r.unauthorized,
    403: r.forbidden,
    404: r.notFound,
    422: r.unprocessable,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/runs/{runId}/watchdog-decisions",
  tags: ["runs"],
  summary: "Record an audited watchdog decision for an issue execution run",
  request: {
    params: z.object({ runId: z.string().uuid() }),
    body: jsonBody(issueExecutionWatchdogDecisionInputSchema),
  },
  responses: {
    201: {
      description: "Created",
      content: {
        "application/json": {
          schema: issueExecutionWatchdogDecisionRecordSchema,
        },
      },
    },
    400: r.badRequest,
    401: r.unauthorized,
    403: r.forbidden,
    404: r.notFound,
  },
});


// ─── Issue tree ──────────────────────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/children",
  tags: ["issues"],
  summary: "Create child issues",
  request: { params: z.object({ id: z.string() }), body: jsonBody(createChildIssueSchema) },
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
  path: "/api/issues/{id}/tree-control/state",
  tags: ["issues"],
  summary: "Get issue tree control state",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/tree-control/preview",
  tags: ["issues"],
  summary: "Preview issue tree control changes",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(previewIssueTreeControlSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/tree-holds",
  tags: ["issues"],
  summary: "List issue tree holds",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/tree-holds",
  tags: ["issues"],
  summary: "Create an issue tree hold",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(createIssueTreeHoldSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/tree-holds/{holdId}",
  tags: ["issues"],
  summary: "Get an issue tree hold",
  request: { params: z.object({ id: z.string(), holdId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/tree-holds/{holdId}/release",
  tags: ["issues"],
  summary: "Release an issue tree hold",
  request: {
    params: z.object({ id: z.string(), holdId: z.string() }),
    body: jsonBody(releaseIssueTreeHoldSchema),
  },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

// ─── Attachments ──────────────────────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/issues/{issueId}/attachments",
  tags: ["assets"],
  summary: "Upload an attachment to an issue",
  request: { params: z.object({ companyId: z.string(), issueId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/attachments/{attachmentId}/content",
  tags: ["assets"],
  summary: "Download attachment content",
  request: { params: z.object({ attachmentId: z.string() }) },
  responses: { 200: { description: "File content" }, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "delete",
  path: "/api/attachments/{attachmentId}",
  tags: ["assets"],
  summary: "Delete an attachment",
  request: { params: z.object({ attachmentId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

// ─── Assets ──────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/assets/images",
  tags: ["assets"],
  summary: "Upload an image asset",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/logo",
  tags: ["assets"],
  summary: "Upload company logo",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/assets/{assetId}/content",
  tags: ["assets"],
  summary: "Download asset content",
  request: { params: z.object({ assetId: z.string() }) },
  responses: { 200: { description: "File content" }, 401: r.unauthorized, 404: r.notFound },
});

// ─── Company skills ───────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/skills",
  tags: ["skills"],
  summary: "List skills for a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/skills/{skillId}",
  tags: ["skills"],
  summary: "Get a company skill",
  request: { params: z.object({ companyId: z.string(), skillId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/skills/{skillId}/update-status",
  tags: ["skills"],
  summary: "Get skill update status",
  request: { params: z.object({ companyId: z.string(), skillId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/skills/{skillId}/files",
  tags: ["skills"],
  summary: "List skill files",
  request: { params: z.object({ companyId: z.string(), skillId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/skills",
  tags: ["skills"],
  summary: "Create a company skill",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(companySkillCreateSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "patch",
  path: "/api/companies/{companyId}/skills/{skillId}/files",
  tags: ["skills"],
  summary: "Update a skill file",
  request: {
    params: z.object({ companyId: z.string(), skillId: z.string() }),
    body: jsonBody(companySkillFileUpdateSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/companies/{companyId}/skills/{skillId}/files",
  tags: ["skills"],
  summary: "Delete a skill file or folder",
  request: {
    params: z.object({ companyId: z.string(), skillId: z.string() }),
    body: jsonBody(companySkillFileDeleteSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/skills/{skillId}/test-inputs",
  tags: ["skills"],
  summary: "List skill test inputs",
  request: { params: z.object({ companyId: z.string(), skillId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/skills/{skillId}/test-inputs",
  tags: ["skills"],
  summary: "Create a skill test input",
  request: {
    params: z.object({ companyId: z.string(), skillId: z.string() }),
    body: jsonBody(companySkillTestInputCreateSchema),
  },
  responses: { 201: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "patch",
  path: "/api/companies/{companyId}/skills/{skillId}/test-inputs/{inputId}",
  tags: ["skills"],
  summary: "Update a skill test input",
  request: {
    params: z.object({ companyId: z.string(), skillId: z.string(), inputId: z.string() }),
    body: jsonBody(companySkillTestInputUpdateSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "delete",
  path: "/api/companies/{companyId}/skills/{skillId}/test-inputs/{inputId}",
  tags: ["skills"],
  summary: "Delete a skill test input",
  request: { params: z.object({ companyId: z.string(), skillId: z.string(), inputId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/skill-test-run-templates",
  tags: ["skills"],
  summary: "List skill test-run templates",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/skill-test-run-templates",
  tags: ["skills"],
  summary: "Create a skill test-run template",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(companySkillTestRunTemplateCreateSchema),
  },
  responses: { 201: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "patch",
  path: "/api/companies/{companyId}/skill-test-run-templates/{templateId}",
  tags: ["skills"],
  summary: "Update a skill test-run template",
  request: {
    params: z.object({ companyId: z.string(), templateId: z.string() }),
    body: jsonBody(companySkillTestRunTemplateUpdateSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "delete",
  path: "/api/companies/{companyId}/skill-test-run-templates/{templateId}",
  tags: ["skills"],
  summary: "Delete a skill test-run template",
  request: { params: z.object({ companyId: z.string(), templateId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/skills/{skillId}/test-runs",
  tags: ["skills"],
  summary: "List skill test runs",
  request: {
    params: z.object({ companyId: z.string(), skillId: z.string() }),
    query: companySkillTestRunListQuerySchema,
  },
  responses: { 200: r.ok(), 401: r.unauthorized, 422: r.unprocessable },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/skills/{skillId}/test-runs/{runId}",
  tags: ["skills"],
  summary: "Get a skill test run",
  request: { params: z.object({ companyId: z.string(), skillId: z.string(), runId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/skills/{skillId}/test-runs",
  tags: ["skills"],
  summary: "Create a skill test run",
  request: {
    params: z.object({ companyId: z.string(), skillId: z.string() }),
    body: jsonBody(companySkillTestRunCreateSchema),
  },
  responses: { 201: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/skills/{skillId}/test-runs/{runId}/cancel",
  tags: ["skills"],
  summary: "Cancel a skill test run",
  request: { params: z.object({ companyId: z.string(), skillId: z.string(), runId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "delete",
  path: "/api/companies/{companyId}/skills/{skillId}/test-runs/{runId}",
  tags: ["skills"],
  summary: "Delete a skill test run",
  request: { params: z.object({ companyId: z.string(), skillId: z.string(), runId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/skills/import",
  tags: ["skills"],
  summary: "Import a skill",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(companySkillImportSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/skills/{skillId}/install-update",
  tags: ["skills"],
  summary: "Install a skill update",
  request: { params: z.object({ companyId: z.string(), skillId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/companies/{companyId}/skills/{skillId}",
  tags: ["skills"],
  summary: "Delete a company skill",
  request: { params: z.object({ companyId: z.string(), skillId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/skill-policy",
  tags: ["skills"],
  summary: "Get the effective company skill policy",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
});

registry.registerPath({
  method: "put",
  path: "/api/companies/{companyId}/skill-policy",
  tags: ["skills"],
  summary: "Replace the company skill policy",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(replaceSkillPolicySchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 403: r.forbidden, 409: r.conflict },
});

registry.registerPath({
  method: "delete",
  path: "/api/companies/{companyId}/skill-policy",
  tags: ["skills"],
  summary: "Reset the company skill policy to the open default",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/skill-policy/evaluate",
  tags: ["skills"],
  summary: "Evaluate a company skill policy decision",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(evaluateSkillPolicySchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 403: r.forbidden },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/users/me/inbox-agent-policy",
  tags: ["companies"],
  summary: "Get the current user's inbox agent policy",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
});

registry.registerPath({
  method: "put",
  path: "/api/companies/{companyId}/users/me/inbox-agent-policy",
  tags: ["companies"],
  summary: "Update the current user's inbox agent policy",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(updateInboxAgentPolicySchema),
  },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden, 422: r.unprocessable },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/users/{userId}/inbox-agent-policy",
  tags: ["companies"],
  summary: "Get a company user's inbox agent policy",
  request: { params: z.object({ companyId: z.string(), userId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
});

registry.registerPath({
  method: "put",
  path: "/api/companies/{companyId}/users/{userId}/inbox-agent-policy",
  tags: ["companies"],
  summary: "Update a company user's inbox agent policy",
  request: {
    params: z.object({ companyId: z.string(), userId: z.string() }),
    body: jsonBody(updateInboxAgentPolicySchema),
  },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden, 422: r.unprocessable },
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
  method: "post",
  path: "/api/adapters/install",
  tags: ["adapters"],
  summary: "Retired: ACPX supplies the agent catalog",
  responses: { 410: { description: "Install or authenticate an ACPX-compatible CLI instead." }, 401: r.unauthorized },
});

registry.registerPath({
  method: "patch",
  path: "/api/adapters/{type}",
  tags: ["adapters"],
  summary: "Retired: ACPX exclusively decides local agent availability",
  request: { params: z.object({ type: z.string() }) },
  responses: {
    410: { description: "ACPX supplies availability; Paperclip cannot hide or enable agents." },
    401: r.unauthorized,
    403: r.forbidden,
  },
});

registry.registerPath({
  method: "patch",
  path: "/api/adapters/{type}/override",
  tags: ["adapters"],
  summary: "Retired: ACPX has no Paperclip override layer",
  request: { params: z.object({ type: z.string() }) },
  responses: { 410: { description: "ACPX supplies the current catalog." }, 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/adapters/{type}",
  tags: ["adapters"],
  summary: "Retired: ACPX supplies the agent catalog",
  request: { params: z.object({ type: z.string() }) },
  responses: { 410: { description: "ACPX supplies the current catalog." }, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/adapters/{type}/reload",
  tags: ["adapters"],
  summary: "Retired: ACPX supplies the agent catalog",
  request: { params: z.object({ type: z.string() }) },
  responses: { 410: { description: "ACPX supplies the current catalog." }, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/adapters/{type}/reinstall",
  tags: ["adapters"],
  summary: "Retired: ACPX supplies the agent catalog",
  request: { params: z.object({ type: z.string() }) },
  responses: { 410: { description: "ACPX supplies the current catalog." }, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/adapters/{type}/config-schema",
  tags: ["adapters"],
  summary: "Get ACPX-supplied session settings schema",
  request: { params: z.object({ type: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

// ─── Plugins ──────────────────────────────────────────────────────────────────

const pluginInstallationParams = z.object({ pluginId: z.string().uuid() });

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
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 403: r.forbidden },
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
    params: pluginInstallationParams.extend({ jobId: z.string() }),
    query: pluginJobRunsQuerySchema,
  },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
});

registry.registerPath({
  method: "post",
  path: "/api/plugins/{pluginId}/jobs/{jobId}/trigger",
  tags: ["plugins"],
  summary: "Trigger a plugin job",
  request: { params: pluginInstallationParams.extend({ jobId: z.string() }) },
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
  responses: { 200: r.ok(), 401: r.unauthorized, 502: pluginBridgeErrorResponse },
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
  responses: { 200: r.ok(), 401: r.unauthorized, 502: pluginBridgeErrorResponse },
});

// ─── LLM text endpoints ───────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/llms/agent-configuration.txt",
  tags: ["llms"],
  summary: "Get agent configuration as plain text (for LLM context)",
  responses: { 200: { description: "Plain text agent configuration" }, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/llms/agent-configuration/{adapterType}.txt",
  tags: ["llms"],
  summary: "Get agent configuration for a specific adapter type",
  request: { params: z.object({ adapterType: z.string() }) },
  responses: { 200: { description: "Plain text agent configuration" }, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/llms/agent-icons.txt",
  tags: ["llms"],
  summary: "Get agent icon names as plain text",
  responses: { 200: { description: "Plain text icon list" }, 401: r.unauthorized },
});

// ─── Issues (legacy / misc) ───────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/issues",
  tags: ["issues"],
  summary: "Legacy — returns error directing to /api/companies/{companyId}/issues",
  responses: { 400: r.badRequest },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/comments/{commentId}",
  tags: ["issues"],
  summary: "Get a single issue comment",
  request: { params: z.object({ id: z.string(), commentId: z.string() }) },
  responses: { 200: r.ok(boardIssueCommentSchema), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/comments/{rootCommentId}/thread",
  tags: ["issues"],
  summary: "Page one root comment group",
  request: {
    params: z.object({ id: z.string(), rootCommentId: z.string().uuid() }),
    query: z.object({
      cursor: z.string().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
    }).strict(),
  },
  responses: {
    200: r.ok(boardIssueCommentThreadPageSchema),
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
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: { description: "SVG image" }, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/org.png",
  tags: ["companies"],
  summary: "Get org chart as PNG",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: { description: "PNG image" }, 401: r.unauthorized },
});

// ─── Company portability (legacy routes) ─────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/issues",
  tags: ["companies"],
  summary: "Legacy — returns error directing to correct issues path",
  responses: { 400: r.badRequest },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/export",
  tags: ["companies"],
  summary: "Export a company (legacy singular form)",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(companyPortabilityExportSchema),
  },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/import/preview",
  tags: ["companies"],
  summary: "Preview a company import (legacy route)",
  request: { body: jsonBody(companyPortabilityPreviewSchema) },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/import",
  tags: ["companies"],
  summary: "Apply a company import (legacy route)",
  request: { body: jsonBody(companyPortabilityImportSchema) },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

// ─── CLI auth ─────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/cli-auth/challenges/{id}",
  tags: ["access"],
  summary: "Get a CLI auth challenge",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 404: r.notFound },
});

// ─── Invite onboarding ────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/invites/{token}/logo",
  tags: ["access"],
  summary: "Get company logo for an invite",
  request: { params: z.object({ token: z.string() }) },
  responses: { 200: { description: "Image file" }, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/invites/{token}/onboarding",
  tags: ["access"],
  summary: "Get onboarding data for an invite",
  request: { params: z.object({ token: z.string() }) },
  responses: { 200: r.ok(), 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/invites/{token}/onboarding.txt",
  tags: ["access"],
  summary: "Get onboarding instructions as plain text",
  request: { params: z.object({ token: z.string() }) },
  responses: { 200: { description: "Plain text onboarding instructions" }, 404: r.notFound },
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
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 403: r.forbidden },
});

registry.registerPath({
  method: "post",
  path: "/api/admin/users/{userId}/promote-instance-admin",
  tags: ["admin"],
  summary: "Promote a user to instance admin",
  request: { params: z.object({ userId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/admin/users/{userId}/demote-instance-admin",
  tags: ["admin"],
  summary: "Demote a user from instance admin",
  request: { params: z.object({ userId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

// ─── Plugin UI static ─────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/_plugins/{pluginId}/ui/{filePath}",
  tags: ["plugins"],
  summary: "Serve plugin UI static file",
  request: { params: pluginInstallationParams.extend({ filePath: z.string() }) },
  responses: { 200: { description: "Static file content" }, 404: r.notFound },
});

// ─── Current route coverage ─────────────────────────────────────────────────

registerCurrentRoute({
  method: "get",
  path: "/api/adapters/{type}",
  tags: ["adapters"],
  summary: "Get ACPX-discovered agent details",
  responses: {
    200: r.ok(publicReadyAdapterInfoSchema),
    401: r.unauthorized,
    404: r.notFound,
  },
});

registerCurrentRoute({
  method: "get",
  path: "/api/companies/{companyId}/adapters/{type}/model-profiles",
  tags: ["adapters"],
  summary: "List adapter model profiles for a company",
});

registerCurrentRoute({
  method: "post",
  path: "/api/health/dev-server/restart",
  tags: ["health"],
  summary: "Request a managed dev-server restart",
  responses: { 202: r.ok(), 403: r.forbidden, 404: r.notFound, 409: { description: "Restart is not required" } },
});

registerCurrentRoute({
  method: "post",
  path: "/api/bootstrap/claim",
  tags: ["access"],
  summary: "Claim first instance admin from a browser session",
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound, 409: { description: "Instance admin already claimed" } },
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
  ["get", "/api/companies/{companyId}/search/extract", "Extract company search matches"],
  ["get", "/api/companies/{companyId}/issues/count", "Count issues in a company"],
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
  method: "post",
  path: "/api/companies/{companyId}/folders/ensure-my",
  tags: ["folders"],
  summary: "Ensure the current user's personal skill folder exists",
  body: ensureMySkillFolderSchema,
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
  path: "/api/issues/{id}/cost-summary",
  tags: ["costs"],
  summary: "Get issue cost summary",
  query: z.object({
    excludeRoot: z.enum(["true", "false", "1", "0"]).optional(),
  }).strict(),
  responses: {
    200: r.ok(issueCostSummaryResponseSchema),
    400: r.badRequest,
    401: r.unauthorized,
    404: r.notFound,
  },
});

for (const route of [
  ["get", "/api/companies/{companyId}/resource-memberships/me", "List current user's resource memberships"],
  ["put", "/api/companies/{companyId}/resource-memberships/me/agents/{agentId}", "Join or leave an agent resource"],
  ["put", "/api/companies/{companyId}/resource-memberships/me/projects/{projectId}", "Join or leave a project resource"],
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
  responses: { 201: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
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
  ["get", "/api/skills/catalog", "List catalog skills"],
  ["get", "/api/skills/catalog/{catalogId}", "Get a catalog skill"],
  ["get", "/api/skills/catalog/{catalogId}/files", "List catalog skill files"],
  ["post", "/api/companies/{companyId}/skills/install-catalog", "Install a catalog skill"],
  ["get", "/api/companies/{companyId}/skills/categories", "List company skill categories"],
  ["post", "/api/companies/{companyId}/skills/{skillId}/audit", "Audit a company skill"],
  ["patch", "/api/companies/{companyId}/skills/{skillId}", "Update a company skill"],
  ["get", "/api/companies/{companyId}/skills/{skillId}/versions", "List skill versions"],
  ["post", "/api/companies/{companyId}/skills/{skillId}/versions", "Create a skill version"],
  ["get", "/api/companies/{companyId}/skills/{skillId}/versions/{versionId}", "Get a skill version"],
  ["post", "/api/companies/{companyId}/skills/{skillId}/star", "Star a company skill"],
  ["delete", "/api/companies/{companyId}/skills/{skillId}/star", "Unstar a company skill"],
  ["get", "/api/companies/{companyId}/skills/{skillId}/fork-precheck", "Preview company skill fork impact"],
  ["post", "/api/companies/{companyId}/skills/{skillId}/fork", "Fork a company skill"],
  ["get", "/api/companies/{companyId}/skills/{skillId}/comments", "List skill comments"],
  ["post", "/api/companies/{companyId}/skills/{skillId}/comments", "Create a skill comment"],
  ["patch", "/api/companies/{companyId}/skills/{skillId}/comments/{commentId}", "Update a skill comment"],
  ["delete", "/api/companies/{companyId}/skills/{skillId}/comments/{commentId}", "Delete a skill comment"],
  ["post", "/api/companies/{companyId}/skills/{skillId}/reset", "Reset a company skill"],
] as const) {
  registerCurrentRoute({
    method: route[0],
    path: route[1],
    tags: ["skills"],
    summary: route[2],
    ...(route[0] === "post" ? { body: z.record(z.unknown()).optional() } : {}),
  });
}

for (const route of [
  ["get", "/api/issues/{id}/documents/{key}/annotations", "List document annotation threads"],
  ["get", "/api/issues/{id}/documents/{key}/annotations/{threadId}", "Get a document annotation thread"],
  ["post", "/api/issues/{id}/documents/{key}/lock", "Lock an issue document"],
  ["post", "/api/issues/{id}/documents/{key}/unlock", "Unlock an issue document"],
] as const) {
  registerCurrentRoute({
    method: route[0],
    path: route[1],
    tags: ["issues"],
    summary: route[2],
  });
}

registerCurrentRoute({
  method: "post",
  path: "/api/issues/{id}/documents/{key}/annotations",
  tags: ["issues"],
  summary: "Create a document annotation thread",
  body: createDocumentAnnotationThreadSchema,
  responses: { 201: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registerCurrentRoute({
  method: "post",
  path: "/api/issues/{id}/documents/{key}/annotations/{threadId}/comments",
  tags: ["issues"],
  summary: "Add a document annotation comment",
  body: createDocumentAnnotationCommentSchema,
  responses: { 201: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registerCurrentRoute({
  method: "post",
  path: "/api/issues/{id}/low-trust/promotions",
  tags: ["issues"],
  summary: "Promote quarantined low-trust output",
  body: z.object({
    sourceArtifactKind: z.enum(["comment", "document", "work_product", "issue"]),
    sourceArtifactId: z.string().uuid(),
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(8_000),
  }),
  responses: { 201: r.ok(), 400: r.badRequest, 401: r.unauthorized, 403: r.forbidden, 404: r.notFound, 422: r.unprocessable },
});

registerCurrentRoute({
  method: "patch",
  path: "/api/issues/{id}/documents/{key}/annotations/{threadId}",
  tags: ["issues"],
  summary: "Update a document annotation thread",
  body: updateDocumentAnnotationThreadSchema,
});

for (const route of [
  ["get", "/api/routines/{id}/description/annotations", "List routine description annotation threads"],
  ["get", "/api/routines/{id}/description/annotations/{threadId}", "Get a routine description annotation thread"],
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
  responses: { 201: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registerCurrentRoute({
  method: "post",
  path: "/api/routines/{id}/description/annotations/{threadId}/comments",
  tags: ["routines"],
  summary: "Add a routine description annotation comment",
  body: createDocumentAnnotationCommentSchema,
  responses: { 201: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
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
  path: "/api/issues/{id}/diagnostics/blockers",
  tags: ["issues"],
  summary: "Get blocker diagnostics for an issue",
});

registerCurrentRoute({
  method: "get",
  path: "/api/issues/{id}/diagnostics/subtree",
  tags: ["issues"],
  summary: "Get bounded subtree blocker diagnostics for an issue",
});

for (const route of [
  ["get", "/api/routines/{id}/revisions", "List routine revisions"],
  ["post", "/api/routines/{id}/revisions/{revisionId}/restore", "Restore a routine revision"],
  ["get", "/api/routines/{id}/description/annotations", "List routine description annotation threads"],
  ["get", "/api/routines/{id}/description/annotations/{threadId}", "Get a routine description annotation thread"],
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
  responses: { 201: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registerCurrentRoute({
  method: "post",
  path: "/api/routines/{id}/description/annotations/{threadId}/comments",
  tags: ["routines"],
  summary: "Add a routine description annotation comment",
  body: createDocumentAnnotationCommentSchema,
  responses: { 201: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registerCurrentRoute({
  method: "patch",
  path: "/api/routines/{id}/description/annotations/{threadId}",
  tags: ["routines"],
  summary: "Update a routine description annotation thread",
  body: updateDocumentAnnotationThreadSchema,
});

for (const route of [
  ["get", "/api/plugins/{pluginId}/companies/{companyId}/local-folders", "List plugin local folders"],
  ["get", "/api/plugins/{pluginId}/companies/{companyId}/local-folders/{folderKey}/status", "Get plugin local folder status"],
  ["post", "/api/plugins/{pluginId}/companies/{companyId}/local-folders/{folderKey}/validate", "Validate a plugin local folder"],
  ["put", "/api/plugins/{pluginId}/companies/{companyId}/local-folders/{folderKey}", "Save a plugin local folder"],
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

export const buildOpenApiSpec = buildOpenApiDocument;

export function openApiRoutes() {
  const router = Router();
  router.get("/openapi.json", (_req, res) => {
    res.json(buildOpenApiDocument());
  });
  return router;
}
