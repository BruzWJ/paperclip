import { createHash } from "node:crypto";
import {
  AGENT_MENTION_REACH_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
  PAPERCLIP_RUNTIME_ACTION_KEYS,
  runtimeAgentConfigureActionSchemaForTargets,
  runtimeAgentHireConfigurationSchema,
  isMcpToolName,
  type AgentMentionReachGrantKey,
  type IssueExecutionRefMode,
  type JsonSchema,
  type PaperclipActionKey,
} from "@paperclipai/shared";
import { z } from "zod";
import {
  resolveContextRetrievalPolicy,
  type ContextRetrievalReachPolicy,
  type ContextDial,
} from "./context-dial-resolver.js";
import type {
  RetrievalIssueFilters,
} from "./context-retrieval.js";
import { validateJsonSchemaValue } from "./plugin-config-validator.js";

const PAPERCLIP_RETRIEVAL_TOOL_NAMES = [
  "list_company_issues",
  "list_sub_issues",
  "read_issue_comments",
  "read_issue_agent_run",
] as const;

type PaperclipRetrievalToolName =
  (typeof PAPERCLIP_RETRIEVAL_TOOL_NAMES)[number];

const PAPERCLIP_RUNTIME_TOOL_NAMES = [
  ...PAPERCLIP_RETRIEVAL_TOOL_NAMES,
  // Runtime actions include relationship-derived actions which are not
  // persisted agent grants. Keep the entire runtime namespace reserved.
  ...PAPERCLIP_RUNTIME_ACTION_KEYS,
] as const;

export type PaperclipRuntimeToolName =
  (typeof PAPERCLIP_RUNTIME_TOOL_NAMES)[number];

export type RuntimeToolSource = "paperclip" | "plugin";

export interface CompiledRunToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  source: RuntimeToolSource;
  /** Server-only immutable installation identity for a direct plugin tool. */
  pluginInstallationId?: string;
  /** Server-only exact manifest identity compiled with this declaration. */
  pluginManifestIdentity?: string;
  /** Server-only bare manifest tool name dispatched to that installation. */
  pluginToolName?: string;
  /**
   * Server-only validator paired with the serialized JSON Schema. It is never
   * sent to a provider, but makes the exact dynamic descriptor authoritative
   * at tools/call rather than treating discovery as advisory.
   */
  validateArguments?: (value: unknown) => unknown;
}

export interface AgentCatalogEntry {
  id: string;
  name: string;
  capabilities: string | null;
}

/** A configuration target is deliberately id-only. */
export interface RuntimeAgentConfigureTarget {
  id: string;
}

export interface IssueCreateOwnerCatalogEntry extends AgentCatalogEntry {
  kind: "agent";
}

export interface IssueAssignOwnerCatalog {
  issueId: string;
  identifier: string | null;
  owners: readonly (
    | { kind: "self" }
    | IssueCreateOwnerCatalogEntry
  )[];
}

interface CreatorUpdateTargetCatalogEntry {
  issueId: string;
}

/** A tool declared by a ready administrator-installed plugin. */
export interface RuntimePluginTool {
  installationId: string;
  manifestIdentity: string;
  /** Provider-visible, plugin-key namespaced tool name. */
  name: string;
  /** Bare manifest declaration name used only for worker dispatch. */
  toolName: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface RuntimeInterfaceCompileInput {
  mode: IssueExecutionRefMode;
  contextDial: ContextDial;
  actionGrants: Readonly<Partial<Record<PaperclipActionKey, boolean>>>;
  mentionReachGrants?: Readonly<
    Partial<Record<AgentMentionReachGrantKey, boolean>>
  >;
  isCurrentOwner: boolean;
  issueCreateDirectChildren: readonly IssueCreateOwnerCatalogEntry[];
  issueAssignTargets: readonly IssueAssignOwnerCatalog[];
  creatorUpdateTargets: readonly CreatorUpdateTargetCatalogEntry[];
  mentionTargets: readonly AgentCatalogEntry[];
  configureTargets: readonly RuntimeAgentConfigureTarget[];
  /** Ready plugin tools are host-managed and available to every agent. */
  pluginTools: readonly RuntimePluginTool[];
}

interface CompiledRuntimeInterface {
  mode: IssueExecutionRefMode;
  descriptors: readonly CompiledRunToolDescriptor[];
  byName: ReadonlyMap<string, CompiledRunToolDescriptor>;
}

export class RuntimeInterfaceConflict extends Error {
  readonly code = "runtime_interface_conflict";

  constructor(message: string) {
    super(message);
    this.name = "RuntimeInterfaceConflict";
  }
}

export class RuntimeToolUnavailable extends Error {
  readonly code = "runtime_tool_unavailable";

  constructor(readonly toolName: string) {
    super(`Tool is not available for the current issue execution: ${toolName}`);
    this.name = "RuntimeToolUnavailable";
  }
}

export class RuntimeToolArgumentsInvalid extends Error {
  readonly code = "runtime_tool_arguments_invalid";

  constructor(message: string) {
    super(message);
    this.name = "RuntimeToolArgumentsInvalid";
  }
}

type RuntimeRetrievalInvocation =
  | {
      name: "list_company_issues";
      filters?: RetrievalIssueFilters;
      cursor?: string;
    }
  | {
      name: "list_sub_issues";
      issueId?: string;
      cursor?: string;
    }
  | {
      name: "read_issue_comments";
      issueId?: string;
      cursor?: string;
    }
  | {
      name: "read_issue_agent_run";
      runId: string;
      cursor?: string;
    };

interface RuntimeRetrievalAbi {
  descriptors: readonly CompiledRunToolDescriptor[];
  parse(
    toolName: PaperclipRetrievalToolName,
    value: unknown,
  ): RuntimeRetrievalInvocation;
}

const STRING_ID: JsonSchema = { type: "string", minLength: 1 };
const MESSAGE: JsonSchema = { type: "string", minLength: 1 };

const runtimeMentionArgumentsSchema = z
  .object({
    agentId: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

const runtimeMentionBoardArgumentsSchema = z
  .object({ message: z.string().min(1) })
  .strict();

export type RuntimeMentionArguments = z.infer<
  typeof runtimeMentionArgumentsSchema
>;

/** Sole static shape parser shared by descriptor and typed action ingress. */
export function parseRuntimeMentionArguments(
  value: unknown,
): RuntimeMentionArguments {
  const parsed = runtimeMentionArgumentsSchema.safeParse(value);
  if (!parsed.success) {
    throw new RuntimeToolArgumentsInvalid(
      zodValidationMessage(parsed.error),
    );
  }
  return parsed.data;
}

function objectSchema(
  properties: Record<string, JsonSchema>,
  required: string[] = [],
): JsonSchema {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function zodTypeName(schema: z.ZodTypeAny): string {
  return schema._def.typeName as string;
}

function unwrapZodSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  const typeName = zodTypeName(schema);
  if (
    typeName === "ZodOptional" ||
    typeName === "ZodDefault" ||
    typeName === "ZodCatch"
  ) {
    return unwrapZodSchema(schema._def.innerType);
  }
  if (typeName === "ZodEffects") {
    return unwrapZodSchema(schema._def.schema);
  }
  return schema;
}

function zodIsOptional(schema: z.ZodTypeAny): boolean {
  const typeName = zodTypeName(schema);
  if (
    typeName === "ZodOptional" ||
    typeName === "ZodDefault" ||
    typeName === "ZodCatch"
  ) {
    return true;
  }
  if (typeName === "ZodEffects") return zodIsOptional(schema._def.schema);
  if (typeName === "ZodNullable") {
    return zodIsOptional(schema._def.innerType);
  }
  return false;
}

/**
 * Runtime descriptors need JSON Schema while the canonical action contract is
 * Zod. Keep that translation here so the provider-visible shape and the
 * server-side parser are generated from the same schema instance.
 */
function zodToRuntimeJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const unwrapped = unwrapZodSchema(schema);
  const typeName = zodTypeName(unwrapped);

  if (typeName === "ZodString") {
    const result: JsonSchema = { type: "string" };
    for (const check of (unwrapped._def.checks ?? []) as Array<
      Record<string, unknown>
    >) {
      if (check.kind === "min") result.minLength = check.value as number;
      if (check.kind === "max") result.maxLength = check.value as number;
      if (check.kind === "uuid") result.format = "uuid";
    }
    return result;
  }
  if (typeName === "ZodBoolean") return { type: "boolean" };
  if (typeName === "ZodEnum") {
    return { type: "string", enum: unwrapped._def.values as string[] };
  }
  if (typeName === "ZodArray") {
    const result: JsonSchema = {
      type: "array",
      items: zodToRuntimeJsonSchema(unwrapped._def.type),
    };
    const exactLength = unwrapped._def.exactLength?.value;
    const minLength = unwrapped._def.minLength?.value;
    const maxLength = unwrapped._def.maxLength?.value;
    if (typeof exactLength === "number") {
      result.minItems = exactLength;
      result.maxItems = exactLength;
    } else {
      if (typeof minLength === "number") result.minItems = minLength;
      if (typeof maxLength === "number") result.maxItems = maxLength;
    }
    return result;
  }
  if (typeName === "ZodNullable") {
    return {
      anyOf: [
        zodToRuntimeJsonSchema(unwrapped._def.innerType),
        { type: "null" },
      ],
    };
  }
  if (typeName === "ZodObject") {
    const shape = unwrapped._def.shape() as Record<string, z.ZodTypeAny>;
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [key, property] of Object.entries(shape)) {
      properties[key] = zodToRuntimeJsonSchema(property);
      if (!zodIsOptional(property)) required.push(key);
    }
    return {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: unwrapped._def.unknownKeys === "strict" ? false : true,
    };
  }
  return {};
}

function zodValidationMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `${path}${issue.message}`;
    })
    .join("; ");
}

function canonicalActionDescriptor(input: {
  name: "agent_hire" | "agent_configure";
  title: string;
  description: string;
  schema: z.ZodTypeAny;
  /** `agentId` plus at least one configuration patch field. */
  minProperties?: number;
}): CompiledRunToolDescriptor {
  const inputSchema = zodToRuntimeJsonSchema(input.schema);
  if (input.minProperties !== undefined) {
    inputSchema.minProperties = input.minProperties;
  }
  return {
    name: input.name,
    title: input.title,
    description: input.description,
    inputSchema,
    source: "paperclip",
    validateArguments(value) {
      const parsed = input.schema.safeParse(value);
      if (!parsed.success) {
        throw new RuntimeToolArgumentsInvalid(
          zodValidationMessage(parsed.error),
        );
      }
      return parsed.data;
    },
  };
}

function cursorSchema(): JsonSchema {
  return {
    type: "string",
    description: "Opaque bounded cursor returned by the preceding page.",
    minLength: 1,
  };
}

function issueFilterSchema(): JsonSchema {
  return objectSchema({
    status: {
      type: "string",
      enum: ["open", "blocked", "done", "cancelled"],
    },
    priority: {
      type: "string",
      enum: ["critical", "high", "medium", "low"],
    },
  });
}

function strictRecord(
  value: unknown,
  label = "Tool arguments",
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeToolArgumentsInvalid(
      `${label} must be an object`,
    );
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label = "tool arguments",
): void {
  const allow = new Set(allowed);
  const unknown = Object.keys(value).filter(
    (key) => !allow.has(key),
  );
  if (unknown.length > 0) {
    throw new RuntimeToolArgumentsInvalid(
      `Unsupported ${label}: ${unknown.join(", ")}`,
    );
  }
}

function parseOptionalString(
  value: unknown,
  name: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new RuntimeToolArgumentsInvalid(
      `${name} must be a non-empty string`,
    );
  }
  return value;
}

function parseIssueFilters(
  value: unknown,
): RetrievalIssueFilters | undefined {
  if (value === undefined) return undefined;
  const filters = strictRecord(value, "filters");
  assertExactKeys(filters, ["status", "priority"], "filter fields");
  const status = parseOptionalString(filters.status, "filters.status");
  const priority = parseOptionalString(
    filters.priority,
    "filters.priority",
  );
  if (
    status !== undefined &&
    !["open", "blocked", "done", "cancelled"].includes(status)
  ) {
    throw new RuntimeToolArgumentsInvalid(
      "filters.status is not an allowed issue status",
    );
  }
  if (
    priority !== undefined &&
    !["critical", "high", "medium", "low"].includes(priority)
  ) {
    throw new RuntimeToolArgumentsInvalid(
      "filters.priority is not an allowed issue priority",
    );
  }
  return {
    ...(status
      ? { status: status as RetrievalIssueFilters["status"] }
      : {}),
    ...(priority
      ? {
          priority:
            priority as RetrievalIssueFilters["priority"],
        }
      : {}),
  };
}

function retrievalReachDescription(input: {
  prefix: string;
  reach: ContextRetrievalReachPolicy;
  issueIdMode: "optional" | "required" | null;
}): string {
  const tiers: string[] = [];
  if (input.reach.active) {
    tiers.push(
      input.issueIdMode === "optional"
        ? "the active issue (omit issueId or pass it explicitly)"
        : input.issueIdMode === "required"
          ? "the active issue through an explicit issueId"
          : "a run on the active issue",
    );
  }
  if (input.reach.descendant) {
    tiers.push(
      input.issueIdMode
        ? "a proper descendant of the active issue through an explicit issueId"
        : "a run on a proper descendant of the active issue",
    );
  }
  if (input.reach.company) {
    tiers.push(
      input.issueIdMode
        ? "any issue in this run's company through an explicit issueId"
        : "a run on any issue in this run's company",
    );
  }
  return `${input.prefix} Authorized target tiers: ${tiers.join("; ")}.`;
}

export function buildRuntimeRetrievalAbi(
  dial: ContextDial,
): RuntimeRetrievalAbi {
  const policy = resolveContextRetrievalPolicy(dial);
  const descriptors: CompiledRunToolDescriptor[] = [];

  if (policy.listCompanyIssues) {
    descriptors.push({
      name: "list_company_issues",
      title: "List company issues",
      description:
        "Available only with the company-issue listing grant. Lists one bounded page of top-level issues in this run's company; it never returns descendants, another company's issues, or control-plane configuration.",
      inputSchema: objectSchema({
        filters: issueFilterSchema(),
        cursor: cursorSchema(),
      }),
      source: "paperclip",
    });
  }

  if (policy.listSubIssues.enabled) {
    const explicitTarget = policy.listSubIssues.explicit.company
      ? "With issueId, any issue in this run's company is accepted, including the active issue."
      : "With issueId, only a proper descendant of the active issue is accepted; the active issue itself is rejected.";
    descriptors.push({
      name: "list_sub_issues",
      title: "List direct sub-issues",
      description: `Lists one bounded page of direct children. Omit issueId to list the active issue's direct children. ${explicitTarget}`,
      inputSchema: objectSchema({
        issueId: STRING_ID,
        cursor: cursorSchema(),
      }),
      source: "paperclip",
    });
  }

  if (policy.comments.enabled) {
    descriptors.push({
      name: "read_issue_comments",
      title: "Read issue comments",
      description: retrievalReachDescription({
        prefix:
          "Reads one chronological bounded page of first-class Session comments.",
        reach: policy.comments,
        issueIdMode: policy.comments.active ? "optional" : "required",
      }),
      inputSchema: objectSchema(
        {
          issueId: STRING_ID,
          cursor: cursorSchema(),
        },
        policy.comments.issueIdRequired ? ["issueId"] : [],
      ),
      source: "paperclip",
    });
  }

  if (policy.runs.enabled) {
    descriptors.push({
      name: "read_issue_agent_run",
      title: "Read issue agent run",
      description: retrievalReachDescription({
        prefix:
          "Reads one bounded provider-safe canonical trace page for exactly one run selected by required runId.",
        reach: policy.runs,
        issueIdMode: null,
      }),
      inputSchema: objectSchema(
        { runId: STRING_ID, cursor: cursorSchema() },
        ["runId"],
      ),
      source: "paperclip",
    });
  }

  const available = new Set(
    descriptors.map((descriptor) => descriptor.name),
  );
  return {
    descriptors,
    parse(toolName, value) {
      if (!available.has(toolName)) {
        throw new RuntimeToolUnavailable(toolName);
      }
      const input = strictRecord(value);
      switch (toolName) {
        case "list_company_issues":
          assertExactKeys(input, ["filters", "cursor"]);
          return {
            name: toolName,
            filters: parseIssueFilters(input.filters),
            cursor: parseOptionalString(input.cursor, "cursor"),
          };
        case "list_sub_issues":
          assertExactKeys(input, ["issueId", "cursor"]);
          return {
            name: toolName,
            issueId: parseOptionalString(
              input.issueId,
              "issueId",
            ),
            cursor: parseOptionalString(input.cursor, "cursor"),
          };
        case "read_issue_comments": {
          assertExactKeys(input, ["issueId", "cursor"]);
          const issueId = parseOptionalString(
            input.issueId,
            "issueId",
          );
          if (policy.comments.issueIdRequired && !issueId) {
            throw new RuntimeToolArgumentsInvalid(
              "issueId is required without the active-issue comment grant",
            );
          }
          return {
            name: toolName,
            issueId,
            cursor: parseOptionalString(input.cursor, "cursor"),
          };
        }
        case "read_issue_agent_run": {
          assertExactKeys(input, ["runId", "cursor"]);
          const runId = parseOptionalString(input.runId, "runId");
          if (!runId) {
            throw new RuntimeToolArgumentsInvalid(
              "runId is required",
            );
          }
          return {
            name: toolName,
            runId,
            cursor: parseOptionalString(input.cursor, "cursor"),
          };
        }
      }
    },
  };
}

function descriptiveAgentChoiceSchema(
  entries: readonly AgentCatalogEntry[],
): JsonSchema {
  return {
    type: "string",
    enum: entries.map((entry) => entry.id),
    description: entries
      .map(
        (entry) =>
          `${entry.id}: ${entry.name}${entry.capabilities ? ` — ${entry.capabilities}` : ""}`,
      )
      .join("\n"),
  };
}

function issueCreateDescriptor(
  children: readonly IssueCreateOwnerCatalogEntry[],
): CompiledRunToolDescriptor {
  const ownerVariants: JsonSchema[] = [
    objectSchema({ kind: { const: "self" } }, ["kind"]),
  ];
  if (children.length > 0) {
    ownerVariants.push(
      objectSchema(
        {
          kind: { const: "agent" },
          agentId: descriptiveAgentChoiceSchema(children),
        },
        ["kind", "agentId"],
      ),
    );
  }

  return {
    name: "issue_create",
    title: "Create direct child issue",
    description:
      "Create one direct child of the active issue and canonically mention its explicit invokable owner with the immutable request.",
    inputSchema: objectSchema(
      {
        request: MESSAGE,
        title: { type: "string", minLength: 1 },
        priority: {
          type: "string",
          enum: ["critical", "high", "medium", "low"],
        },
        owner: { oneOf: ownerVariants },
        contextAccessMask: objectSchema(
          Object.fromEntries(
            [
              "carry_context",
              "read_issue_comments",
              "read_issue_agent_run",
              "list_sub_issues",
              "read_sub_issue_comments",
              "read_sub_issue_agent_run",
              "list_company_issues",
              "read_company_issue_comments",
              "read_company_issue_agent_run",
            ].map((key) => [key, { type: "boolean" }]),
          ),
        ),
      },
      ["request", "owner"],
    ),
    source: "paperclip",
  };
}

function issueAssignDescriptor(
  targets: readonly IssueAssignOwnerCatalog[],
): CompiledRunToolDescriptor {
  const targetSchemas = targets.map((target) => {
    const ownerVariants = target.owners.map((owner): JsonSchema => {
      if (owner.kind === "self") {
        return objectSchema({ kind: { const: "self" } }, ["kind"]);
      }
      return objectSchema(
        {
          kind: { const: "agent" },
          agentId: { type: "string", const: owner.id },
        },
        ["kind", "agentId"],
      );
    });
    return objectSchema(
      {
        issueId: {
          type: "string",
          const: target.issueId,
          description: target.identifier ?? target.issueId,
        },
        owner: { oneOf: ownerVariants },
      },
      ["issueId", "owner"],
    );
  });

  return {
    name: "issue_assign",
    title: "Assign creator-owned issue",
    description:
      "Reassign one nonterminal direct child created by this exact issue execution and canonically mention its new owner with the issue request.",
    inputSchema: { oneOf: targetSchemas },
    source: "paperclip",
  };
}

function issueUpdateDescriptor(
  includeOwnerForm: boolean,
  creatorTargets: readonly CreatorUpdateTargetCatalogEntry[],
): CompiledRunToolDescriptor | null {
  const forms: JsonSchema[] = [];
  const addNonterminalUpdateVariants = (
    targetProperties: Record<string, JsonSchema>,
    targetRequired: string[],
  ) => {
    forms.push(
      objectSchema(
        {
          ...targetProperties,
          message: MESSAGE,
        },
        [...targetRequired, "message"],
      ),
      objectSchema(
        {
          ...targetProperties,
          status: { type: "string", enum: ["open", "blocked"] },
          message: MESSAGE,
        },
        [...targetRequired, "status", "message"],
      ),
    );
  };

  const addOwnerUpdateVariants = () => {
    addNonterminalUpdateVariants({}, []);
    forms.push(
      objectSchema(
        {
          status: { type: "string", enum: ["done", "cancelled"] },
          message: MESSAGE,
          structuredResult: {},
        },
        ["status", "message"],
      ),
    );
  };

  if (includeOwnerForm) {
    // Omitted issueId always means the active issue, and therefore requires
    // current-owner authority at call time. Terminal disposition is
    // deliberately owner-only: it hard-stops the receiving execution epoch.
    addOwnerUpdateVariants();
  }
  if (creatorTargets.length > 0) {
    // Supplying issueId is only allowed for a nonterminal direct child made
    // by this exact execution authority. It selects creator authority, not a
    // second caller-facing action, and only permits nonterminal lifecycle
    // state because creator updates automatically wake the current owner.
    addNonterminalUpdateVariants(
      {
        issueId: {
          type: "string",
          enum: creatorTargets.map((target) => target.issueId),
        },
      },
      ["issueId"],
    );
  }
  if (forms.length === 0) return null;

  return {
    name: "issue_update",
    title: "Update issue",
    description:
      "Publish one canonical issue comment, optionally update lifecycle, and automatically mention the creator/owner counterpart in that counterpart's issue context. Omit issueId to update the active issue as its current owner, including terminal done or cancelled disposition; provide an eligible direct-child issueId to update it as its exact creator with a message, open, or blocked status.",
    inputSchema: { oneOf: forms },
    source: "paperclip",
  };
}

function mentionDescriptor(
  targets: readonly AgentCatalogEntry[],
): CompiledRunToolDescriptor {
  const targetIds = new Set(targets.map((target) => target.id));
  return {
    name: "mention_agent",
    title: "Mention agent",
    description:
      "Post one canonical issue comment mentioning an authorized agent on this same issue. The asynchronous call is non-terminal and gives the recipient no owner or creator lifecycle authority.",
    inputSchema: objectSchema(
      {
        agentId: descriptiveAgentChoiceSchema(targets),
        message: MESSAGE,
      },
      ["agentId", "message"],
    ),
    source: "paperclip",
    validateArguments(value) {
      const parsed = parseRuntimeMentionArguments(value);
      if (!targetIds.has(parsed.agentId)) {
        throw new RuntimeToolArgumentsInvalid(
          "agentId is not in the current mention target catalog",
        );
      }
      return parsed;
    },
  };
}

/**
 * A collective Board request deliberately has no target catalog. The Board is
 * one company-scoped recipient, and this signal never creates an execution
 * ref, an approval, or a review stage.
 */
function mentionBoardDescriptor(): CompiledRunToolDescriptor {
  return {
    name: "mention_board",
    title: "Mention Board",
    description:
      "Post one canonical issue comment mentioning the collective Board for information or direction. The asynchronous call is non-terminal and does not change issue lifecycle, approvals, or review.",
    inputSchema: objectSchema(
      {
        message: MESSAGE,
      },
      ["message"],
    ),
    validateArguments(value) {
      const parsed = runtimeMentionBoardArgumentsSchema.safeParse(value);
      if (!parsed.success) {
        throw new RuntimeToolArgumentsInvalid(
          zodValidationMessage(parsed.error),
        );
      }
      return parsed.data;
    },
    source: "paperclip",
  };
}

function hireDescriptor(): CompiledRunToolDescriptor {
  return canonicalActionDescriptor({
    name: "agent_hire",
    title: "Hire direct-report agent",
    description:
      "Create one ordinary direct-report agent. Provider, adapter, budget, lifecycle, and operational fields are not accepted.",
    schema: runtimeAgentHireConfigurationSchema,
  });
}

function configureDescriptor(
  targets: readonly RuntimeAgentConfigureTarget[],
): CompiledRunToolDescriptor {
  return canonicalActionDescriptor({
    name: "agent_configure",
    title: "Configure runtime agent",
    description:
      "Update authorized runtime-agent identity, context cells, and grants only.",
    schema: runtimeAgentConfigureActionSchemaForTargets(
      targets.map((target) => target.id),
    ),
    minProperties: 2,
  });
}

function actionDescriptors(
  input: RuntimeInterfaceCompileInput,
): CompiledRunToolDescriptor[] {
  const descriptors: CompiledRunToolDescriptor[] = [];
  const ownerMode = input.mode === "owner";

  if (ownerMode && input.actionGrants.issue_create === true) {
    descriptors.push(issueCreateDescriptor(input.issueCreateDirectChildren));
  }
  if (
    ownerMode &&
    // Creating direct children and reassigning the caller's own direct
    // children are one authority. There is intentionally no independent
    // issue_assign grant.
    input.actionGrants.issue_create === true &&
    input.issueAssignTargets.length > 0
  ) {
    descriptors.push(issueAssignDescriptor(input.issueAssignTargets));
  }
  if (ownerMode) {
    // Lifecycle authority follows the active owner, while an exact creator
    // execution may update its direct child nonterminally. Neither form is an
    // independently configurable agent action grant.
    const descriptor = issueUpdateDescriptor(
      input.isCurrentOwner,
      input.creatorUpdateTargets,
    );
    if (descriptor) descriptors.push(descriptor);
  }
  if (
    input.actionGrants.mention_agent === true &&
    input.mentionTargets.length > 0
  ) {
    descriptors.push(mentionDescriptor(input.mentionTargets));
  }
  if (input.actionGrants.mention_board === true) {
    descriptors.push(mentionBoardDescriptor());
  }
  if (input.actionGrants.agent_hire === true) {
    descriptors.push(hireDescriptor());
  }
  if (
    input.actionGrants.agent_configure === true &&
    input.configureTargets.length > 0
  ) {
    descriptors.push(configureDescriptor(input.configureTargets));
  }

  return descriptors;
}

function pluginDescriptors(
  tools: readonly RuntimePluginTool[],
): CompiledRunToolDescriptor[] {
  return tools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    source: "plugin",
    pluginInstallationId: tool.installationId,
    pluginManifestIdentity: tool.manifestIdentity,
    pluginToolName: tool.toolName,
    validateArguments(argumentsValue) {
      const validation = validateJsonSchemaValue(
        argumentsValue,
        tool.inputSchema,
      );
      if (!validation.valid) {
        throw new RuntimeToolArgumentsInvalid(
          `Invalid arguments for ${tool.name}: ${validation.errors
            ?.map((error) => `${error.field} ${error.message}`)
            .join("; ") ?? "schema validation failed"}`,
        );
      }
      return argumentsValue;
    },
  }));
}

function validateCompileInput(input: RuntimeInterfaceCompileInput): void {
  for (const key of PAPERCLIP_ACTION_KEYS) {
    if (input.actionGrants[key] !== undefined && typeof input.actionGrants[key] !== "boolean") {
      throw new RuntimeInterfaceConflict(`Invalid action grant value for ${key}`);
    }
  }
  for (const key of AGENT_MENTION_REACH_GRANT_KEYS) {
    if (
      input.mentionReachGrants?.[key] !== undefined &&
      typeof input.mentionReachGrants[key] !== "boolean"
    ) {
      throw new RuntimeInterfaceConflict(
        `Invalid mention reach grant value for ${key}`,
      );
    }
  }
}

export function compileRuntimeInterface(
  input: RuntimeInterfaceCompileInput,
): CompiledRuntimeInterface {
  validateCompileInput(input);
  const descriptors = [
    ...buildRuntimeRetrievalAbi(input.contextDial).descriptors,
    ...actionDescriptors(input),
    ...pluginDescriptors(input.pluginTools),
  ];
  const byName = new Map<string, CompiledRunToolDescriptor>();
  for (const descriptor of descriptors) {
    if (!isMcpToolName(descriptor.name)) {
      throw new RuntimeInterfaceConflict(
        `Compiled tool name is not provider-safe: ${descriptor.name}`,
      );
    }
    if (
      descriptor.source !== "paperclip" &&
      (PAPERCLIP_RUNTIME_TOOL_NAMES as readonly string[]).includes(
        descriptor.name,
      )
    ) {
      throw new RuntimeInterfaceConflict(
        `External tool collides with Paperclip tool: ${descriptor.name}`,
      );
    }
    if (byName.has(descriptor.name)) {
      throw new RuntimeInterfaceConflict(
        `Duplicate compiled tool name: ${descriptor.name}`,
      );
    }
    byName.set(descriptor.name, descriptor);
  }
  return {
    mode: input.mode,
    descriptors: Object.freeze(descriptors),
    byName,
  };
}

function canonicalDescriptorJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RuntimeInterfaceConflict(
        "Runtime descriptor contains a non-finite number",
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalDescriptorJson).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new RuntimeInterfaceConflict(
      "Runtime descriptor contains a non-JSON value",
    );
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalDescriptorJson(record[key])}`,
    )
    .join(",")}}`;
}

/**
 * Stable server-authority digest shared by pre-activation prompt resolution
 * and the active capability gateway. Validator functions are deliberately
 * excluded; their schema and immutable selections are the canonical
 * provider-visible and call-time contract.
 */
function compiledRuntimeInterfaceDigest(
  compiled: CompiledRuntimeInterface,
): string {
  const contract = {
    mode: compiled.mode,
    descriptors: compiled.descriptors.map((descriptor) => ({
      name: descriptor.name,
      title: descriptor.title,
      description: descriptor.description,
      inputSchema: descriptor.inputSchema,
      source: descriptor.source,
      pluginInstallationId: descriptor.pluginInstallationId,
      pluginManifestIdentity: descriptor.pluginManifestIdentity,
      pluginToolName: descriptor.pluginToolName,
    })),
  };
  return createHash("sha256")
    .update("paperclip.runtime-interface/v1\n", "utf8")
    .update(canonicalDescriptorJson(contract), "utf8")
    .digest("hex");
}

export function runtimeInterfaceDigest(
  input: RuntimeInterfaceCompileInput,
): string {
  return compiledRuntimeInterfaceDigest(compileRuntimeInterface(input));
}
