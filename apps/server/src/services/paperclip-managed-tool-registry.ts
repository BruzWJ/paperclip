import {
  PAPERCLIP_RUNTIME_ACTION_KEYS,
  createIssueSchema,
  runtimeAgentConfigureActionSchemaForTargets,
  runtimeAgentCreateConfigurationSchema,
  runtimeAgentHireConfigurationSchema,
  runtimeAgentUpdateConfigurationSchema,
  type IssueExecutionRefMode,
  type JsonSchema,
  type PaperclipActionKey,
} from "@paperclipai/shared";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { z } from "zod";
import {
  resolveContextRetrievalPolicy,
  type ContextDial,
  type ContextRetrievalReachPolicy,
} from "./context-dial-resolver.js";
import { RuntimeToolArgumentsInvalid } from "./runtime-tool-errors.js";

export const PAPERCLIP_CONTEXT_TOOL_NAMES = [
  "list_company_issues",
  "list_sub_issues",
  "read_issue_comments",
  "read_issue_agent_run",
] as const;

type PaperclipContextToolName =
  (typeof PAPERCLIP_CONTEXT_TOOL_NAMES)[number];

export const PAPERCLIP_MANAGED_TOOL_NAMES = [
  ...PAPERCLIP_CONTEXT_TOOL_NAMES,
  ...PAPERCLIP_RUNTIME_ACTION_KEYS,
] as const;

export type PaperclipManagedToolName =
  (typeof PAPERCLIP_MANAGED_TOOL_NAMES)[number];
type BoardManagedToolName = Exclude<
  PaperclipManagedToolName,
  "mention_board"
>;

export function isPaperclipContextToolName(
  value: string,
): value is PaperclipContextToolName {
  return (PAPERCLIP_CONTEXT_TOOL_NAMES as readonly string[]).includes(value);
}

export function isPaperclipManagedToolName(
  value: string,
): value is PaperclipManagedToolName {
  return (PAPERCLIP_MANAGED_TOOL_NAMES as readonly string[]).includes(value);
}

export const PAPERCLIP_MANAGED_TOOL_METADATA = {
  list_company_issues: {
    title: "List company issues",
    description: "List a bounded page of top-level issues in one company.",
    readOnly: true,
  },
  list_sub_issues: {
    title: "List direct sub-issues",
    description: "List a bounded page of direct child issues.",
    readOnly: true,
  },
  read_issue_comments: {
    title: "Read issue comments",
    description: "Read a chronological bounded page of issue comments.",
    readOnly: true,
  },
  read_issue_agent_run: {
    title: "Read issue agent run",
    description: "Read the provider-safe trace for one agent run.",
    readOnly: true,
  },
  issue_create: {
    title: "Create issue",
    description: "Create an issue and dispatch it to an explicit agent owner.",
    readOnly: false,
  },
  issue_assign: {
    title: "Assign issue",
    description: "Assign an issue to an agent owner.",
    readOnly: false,
  },
  issue_update: {
    title: "Update issue",
    description: "Update an issue or add a canonical issue comment.",
    readOnly: false,
  },
  mention_agent: {
    title: "Mention agent",
    description: "Send a canonical issue message to an explicit agent.",
    readOnly: false,
  },
  mention_board: {
    title: "Mention Board",
    description: "Send a canonical issue message to the collective Board.",
    readOnly: false,
  },
  agent_hire: {
    title: "Hire agent",
    description: "Create an agent with a managed Paperclip configuration.",
    readOnly: false,
  },
  agent_configure: {
    title: "Configure agent",
    description: "Update a managed Paperclip agent configuration.",
    readOnly: false,
  },
  list_agents: {
    title: "List agents",
    description: "List agents in one company.",
    readOnly: true,
  },
  agent_read: {
    title: "Read agent",
    description: "Read one agent and its managed configuration.",
    readOnly: true,
  },
} as const satisfies Record<
  PaperclipManagedToolName,
  { title: string; description: string; readOnly: boolean }
>;

const companyId = z.string().uuid();
const issueId = z.string().uuid();
const agentId = z.string().uuid();
const runId = z.string().uuid();
const commentId = z.string().uuid();
const nonBlankMessage = z
  .string()
  .max(200_000)
  .refine((value) => value.trim().length > 0, "Message must not be blank");
const issueFiltersSchema = z.object({
  status: z.enum(["open", "blocked", "done", "cancelled"]).optional(),
  priority: z.enum(["critical", "high", "medium", "low"]).optional(),
}).strict();
const page = {
  cursor: z.string().trim().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
};

const boardIssueUpdateSchema = z.object({
  companyId,
  issueId,
  title: z.string().trim().min(1).max(240).nullable().optional(),
  message: nonBlankMessage.optional(),
  replyToCommentId: commentId.optional(),
  reopen: z.boolean().optional(),
  status: z.enum(["open", "blocked", "done", "cancelled"]).optional(),
  structuredResult: z.unknown().optional(),
}).strict().superRefine((value, ctx) => {
  if (
    value.title === undefined &&
    value.message === undefined &&
    value.status === undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide title, message, or status",
    });
  }
  if (value.reopen && value.message === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Reopening requires a message that explains why",
      path: ["message"],
    });
  }
  if (value.reopen && value.replyToCommentId !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A reopen cannot be a reply to a run comment",
      path: ["replyToCommentId"],
    });
  }
  if (value.reopen && value.status !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A reopen cannot include status",
      path: ["status"],
    });
  }
  if (value.reopen && Object.hasOwn(value, "structuredResult")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A reopen cannot include structuredResult",
      path: ["structuredResult"],
    });
  }
  if (value.status !== undefined && value.message === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A lifecycle status update requires a message",
      path: ["message"],
    });
  }
  if (value.status !== undefined && value.replyToCommentId !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A lifecycle status update cannot reply to a run comment",
      path: ["replyToCommentId"],
    });
  }
  const terminal = value.status === "done" || value.status === "cancelled";
  if (Object.hasOwn(value, "structuredResult") && !terminal) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "structuredResult is accepted only for done or cancelled",
      path: ["structuredResult"],
    });
  }
  if (
    terminal &&
    Object.hasOwn(value, "structuredResult") &&
    value.structuredResult === undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "structuredResult must be omitted rather than undefined",
      path: ["structuredResult"],
    });
  }
});

/** The one public schema map used by Board MCP and its canonical router. */
export const boardMcpInputSchemas = {
  list_company_issues: z.object({
    companyId,
    filters: issueFiltersSchema.optional(),
    ...page,
  }).strict(),
  list_sub_issues: z.object({ companyId, issueId, ...page }).strict(),
  read_issue_comments: z.object({ companyId, issueId, ...page }).strict(),
  read_issue_agent_run: z.object({
    companyId,
    runId,
    cursor: page.cursor,
  }).strict(),
  issue_create: createIssueSchema
    .omit({ idempotencyKey: true })
    .extend({ companyId })
    .strict(),
  issue_assign: z.object({ companyId, issueId, ownerAgentId: agentId }).strict(),
  issue_update: boardIssueUpdateSchema,
  mention_agent: z.object({
    companyId,
    issueId,
    agentId,
    message: nonBlankMessage,
  }).strict(),
  agent_hire: z.object({
    companyId,
    configuration: runtimeAgentCreateConfigurationSchema,
  }).strict(),
  agent_configure: z.object({
    companyId,
    agentId,
    configuration: runtimeAgentUpdateConfigurationSchema,
  }).strict(),
  list_agents: z.object({
    companyId,
    agentId: agentId.optional(),
    includeTerminated: z.boolean().optional(),
  }).strict(),
  agent_read: z.object({ companyId, agentId }).strict(),
} satisfies Record<BoardManagedToolName, z.ZodTypeAny>;

type ManagedToolPayload<Name extends PaperclipManagedToolName> =
  Name extends "mention_board"
    ? { companyId: string; issueId: string; message: string }
    : Name extends BoardManagedToolName
      ? z.infer<(typeof boardMcpInputSchemas)[Name]>
      : never;

export type PaperclipManagedToolCommandFor<
  Name extends PaperclipManagedToolName,
> = Name extends PaperclipManagedToolName
  ? { name: Name } & ManagedToolPayload<Name> &
    (Name extends "issue_update"
      ? { issueTarget?: "active" | "explicit" }
      : object)
  : never;

export type PaperclipManagedToolCommand = {
  [Name in PaperclipManagedToolName]: PaperclipManagedToolCommandFor<Name>;
}[PaperclipManagedToolName];

interface BoardManagedToolDefinition {
  name: BoardManagedToolName;
  title: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  readOnly: boolean;
}

const BOARD_MANAGED_TOOL_NAMES = PAPERCLIP_MANAGED_TOOL_NAMES.filter(
  (name): name is BoardManagedToolName => name !== "mention_board",
);

export const BOARD_MANAGED_TOOLS: readonly BoardManagedToolDefinition[] =
  Object.freeze(BOARD_MANAGED_TOOL_NAMES.map((name) => ({
    name,
    ...PAPERCLIP_MANAGED_TOOL_METADATA[name],
    inputSchema: boardMcpInputSchemas[name],
  })));

export function parseBoardManagedTool<Name extends BoardManagedToolName>(
  name: Name,
  payload: unknown,
): PaperclipManagedToolCommandFor<Name> {
  const parsed = boardMcpInputSchemas[name].parse(payload);
  return { name, ...parsed } as PaperclipManagedToolCommandFor<Name>;
}

export interface AgentCatalogEntry {
  id: string;
  name: string;
  capabilities: string | null;
}

export interface RuntimeAgentConfigureTarget {
  id: string;
}

export interface IssueCreateOwnerCatalogEntry extends AgentCatalogEntry {
  kind: "agent";
}

export interface IssueAssignOwnerCatalog {
  issueId: string;
  identifier: string | null;
  owners: readonly ({ kind: "self" } | IssueCreateOwnerCatalogEntry)[];
}

export interface CreatorUpdateTargetCatalogEntry {
  issueId: string;
}

/** Dynamic facts captured into one exact provider descriptor. */
export interface PaperclipManagedToolRuntimeProjectionInput {
  mode: IssueExecutionRefMode;
  contextDial: ContextDial;
  actionGrants: Readonly<Partial<Record<PaperclipActionKey, boolean>>>;
  isCurrentOwner: boolean;
  issueCreateDirectChildren: readonly IssueCreateOwnerCatalogEntry[];
  issueAssignTargets: readonly IssueAssignOwnerCatalog[];
  creatorUpdateTargets: readonly CreatorUpdateTargetCatalogEntry[];
  mentionTargets: readonly AgentCatalogEntry[];
  configureTargets: readonly RuntimeAgentConfigureTarget[];
}

export interface PaperclipRuntimeCommandScope {
  readonly companyId: string;
  readonly issueId: string;
  readonly targetAgentId: string;
}

type PaperclipManagedToolLedgerMetadata =
  | { kind: "non_mention" }
  | {
      kind: "mention";
      toolName: "mention_agent" | "mention_board";
      targetAgentId: string | null;
    };

export interface RuntimePaperclipManagedToolCall {
  command: PaperclipManagedToolCommand;
  ledger: PaperclipManagedToolLedgerMetadata;
}

export interface ProjectedPaperclipManagedToolDescriptor {
  name: PaperclipManagedToolName;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  source: "paperclip";
  availability: "work" | "both";
  normalizeRuntimeCommand(
    payload: unknown,
    scope: PaperclipRuntimeCommandScope,
  ): RuntimePaperclipManagedToolCall;
}

interface RuntimeProjection<Name extends PaperclipManagedToolName> {
  inputSchema: JsonSchema;
  details?: string;
  normalize(
    payload: unknown,
    scope: PaperclipRuntimeCommandScope,
  ): PaperclipManagedToolCommandFor<Name>;
}

function runtimeJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const { $schema: _dialect, ...result } = toJsonSchemaCompat(schema as never);
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (!value || typeof value !== "object") return value;
    const record = Object.fromEntries(Object.entries(value).map(
      ([key, nested]) => [key, normalize(nested)],
    )) as Record<string, unknown>;
    // Paperclip's compiled ABI uses exclusive object forms. Preserve the
    // established descriptor bytes while deriving those forms from Zod.
    if (
      Array.isArray(record.anyOf) &&
      record.anyOf.every((option) =>
        typeof option === "object" &&
        option !== null &&
        (option as Record<string, unknown>).type === "object"
      )
    ) {
      record.type = "object";
      record.oneOf = record.anyOf;
      delete record.anyOf;
    }
    if (
      record.type === "object" &&
      record.properties &&
      record.required === undefined
    ) {
      record.required = [];
    }
    return record;
  };
  return normalize(result) as JsonSchema;
}

function runtimeArguments<T>(schema: z.ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload);
  if (parsed.success) return parsed.data;
  throw new RuntimeToolArgumentsInvalid(
    parsed.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `${path}${issue.message}`;
    }).join("; "),
  );
}

function projection<Name extends PaperclipManagedToolName, Payload>(input: {
  schema: z.ZodType<Payload>;
  details?: string;
  normalize(
    payload: Payload,
    scope: PaperclipRuntimeCommandScope,
  ): PaperclipManagedToolCommandFor<Name>;
}): RuntimeProjection<Name> {
  return {
    inputSchema: runtimeJsonSchema(input.schema),
    ...(input.details ? { details: input.details } : {}),
    normalize(payload, scope) {
      return input.normalize(runtimeArguments(input.schema, payload), scope);
    },
  };
}

const runtimeCursor = z.string().min(1).optional().describe(
  "Opaque bounded cursor returned by the preceding page.",
);

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

function projectRuntimeListCompanyIssues(
  input: PaperclipManagedToolRuntimeProjectionInput,
): RuntimeProjection<"list_company_issues"> | null {
  if (!resolveContextRetrievalPolicy(input.contextDial).listCompanyIssues) {
    return null;
  }
  return projection({
    schema: z.object({
      filters: issueFiltersSchema.optional(),
      cursor: runtimeCursor,
    }).strict(),
    details:
      "Available only with the company-issue listing grant. Lists one bounded page of top-level issues in this run's company; it never returns descendants, another company's issues, or control-plane configuration.",
    normalize: (payload, scope) => ({
      name: "list_company_issues",
      companyId: scope.companyId,
      ...payload,
    }),
  });
}

function projectRuntimeListSubIssues(
  input: PaperclipManagedToolRuntimeProjectionInput,
): RuntimeProjection<"list_sub_issues"> | null {
  const policy = resolveContextRetrievalPolicy(input.contextDial);
  if (!policy.listSubIssues.enabled) return null;
  const explicitTarget = policy.listSubIssues.explicit.company
    ? "With issueId, any issue in this run's company is accepted, including the active issue."
    : "With issueId, only a proper descendant of the active issue is accepted; the active issue itself is rejected.";
  return projection({
    schema: z.object({
      issueId: z.string().min(1).optional(),
      cursor: runtimeCursor,
    }).strict(),
    details: `Lists one bounded page of direct children. Omit issueId to list the active issue's direct children. ${explicitTarget}`,
    normalize: (payload, scope) => ({
      name: "list_sub_issues",
      companyId: scope.companyId,
      issueId: payload.issueId ?? scope.issueId,
      cursor: payload.cursor,
    }),
  });
}

function projectRuntimeReadIssueComments(
  input: PaperclipManagedToolRuntimeProjectionInput,
): RuntimeProjection<"read_issue_comments"> | null {
  const policy = resolveContextRetrievalPolicy(input.contextDial);
  if (!policy.comments.enabled) return null;
  const schema = z.object({
    issueId: policy.comments.issueIdRequired
      ? z.string().min(1)
      : z.string().min(1).optional(),
    cursor: runtimeCursor,
  }).strict();
  return projection({
    schema,
    details: retrievalReachDescription({
      prefix:
        "Reads one chronological bounded page of first-class Session comments.",
      reach: policy.comments,
      issueIdMode: policy.comments.active ? "optional" : "required",
    }),
    normalize: (payload, scope) => ({
      name: "read_issue_comments",
      companyId: scope.companyId,
      issueId: payload.issueId ?? scope.issueId,
      cursor: payload.cursor,
    }),
  });
}

function projectRuntimeReadIssueAgentRun(
  input: PaperclipManagedToolRuntimeProjectionInput,
): RuntimeProjection<"read_issue_agent_run"> | null {
  const policy = resolveContextRetrievalPolicy(input.contextDial);
  if (!policy.runs.enabled) return null;
  return projection({
    schema: z.object({ runId: z.string().min(1), cursor: runtimeCursor }).strict(),
    details: retrievalReachDescription({
      prefix:
        "Reads the delivered source message(s) and bounded provider-safe detailed turns for exactly one run selected by required runId.",
      reach: policy.runs,
      issueIdMode: null,
    }),
    normalize: (payload, scope) => ({
      name: "read_issue_agent_run",
      companyId: scope.companyId,
      ...payload,
    }),
  });
}

function agentIdChoice(entries: readonly AgentCatalogEntry[]) {
  const ids = entries.map((entry) => entry.id) as [string, ...string[]];
  return z.enum(ids).describe(entries.map(
    (entry) =>
      `${entry.id}: ${entry.name}${entry.capabilities ? ` — ${entry.capabilities}` : ""}`,
  ).join("\n"));
}

const selfOwnerSchema = z.object({ kind: z.literal("self") }).strict();

function ownerSchema(entries: readonly IssueCreateOwnerCatalogEntry[]) {
  if (entries.length === 0) return selfOwnerSchema;
  return z.union([
    selfOwnerSchema,
    z.object({
      kind: z.literal("agent"),
      agentId: agentIdChoice(entries),
    }).strict(),
  ]);
}

function projectRuntimeIssueCreate(
  input: PaperclipManagedToolRuntimeProjectionInput,
): RuntimeProjection<"issue_create"> | null {
  if (input.mode !== "owner" || input.actionGrants.issue_create !== true) {
    return null;
  }
  return projection({
    schema: z.object({
      request: z.string().min(1),
      title: z.string().min(1).optional(),
      priority: z.enum(["critical", "high", "medium", "low"]).optional(),
      owner: ownerSchema(input.issueCreateDirectChildren),
    }).strict(),
    details:
      "Create one direct child of the active issue and canonically mention its explicit invokable owner with the immutable request.",
    normalize(payload, scope) {
      return {
        name: "issue_create",
        companyId: scope.companyId,
        parentId: scope.issueId,
        request: payload.request,
        ownerAgentId: payload.owner.kind === "self"
          ? scope.targetAgentId
          : payload.owner.agentId,
        ...(payload.title === undefined ? {} : { title: payload.title }),
        ...(payload.priority === undefined ? {} : { priority: payload.priority }),
      };
    },
  });
}

function unionSchema(schemas: readonly z.ZodTypeAny[]): z.ZodTypeAny {
  if (schemas.length === 1) return schemas[0]!;
  return z.union(schemas as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
}

function projectRuntimeIssueAssign(
  input: PaperclipManagedToolRuntimeProjectionInput,
): RuntimeProjection<"issue_assign"> | null {
  if (
    input.mode !== "owner" ||
    input.actionGrants.issue_create !== true ||
    input.issueAssignTargets.length === 0
  ) {
    return null;
  }
  const targets = new Map(input.issueAssignTargets.map((target) => [
    target.issueId,
    target,
  ]));
  const schema = unionSchema(input.issueAssignTargets.map((target) => {
    const owners = target.owners.map((owner) =>
      owner.kind === "self"
        ? selfOwnerSchema
        : z.object({
            kind: z.literal("agent"),
            agentId: z.literal(owner.id),
          }).strict());
    return z.object({
      issueId: z.literal(target.issueId).describe(target.identifier ?? target.issueId),
      owner: unionSchema(owners),
    }).strict();
  }));
  return projection({
    schema,
    details:
      "Reassign one nonterminal direct child created by this exact issue execution and canonically mention its new owner with the issue request.",
    normalize(payload: { issueId: string; owner: { kind: "self" } | { kind: "agent"; agentId: string } }, scope) {
      if (!targets.has(payload.issueId)) {
        throw new RuntimeToolArgumentsInvalid(
          "issueId is not in the current assignment catalog",
        );
      }
      return {
        name: "issue_assign",
        companyId: scope.companyId,
        issueId: payload.issueId,
        ownerAgentId: payload.owner.kind === "self"
          ? scope.targetAgentId
          : payload.owner.agentId,
      };
    },
  });
}

function projectRuntimeIssueUpdate(
  input: PaperclipManagedToolRuntimeProjectionInput,
): RuntimeProjection<"issue_update"> | null {
  if (input.mode !== "owner") return null;
  const creatorIssueIds = input.creatorUpdateTargets.map((target) => target.issueId);
  const forms: z.ZodTypeAny[] = [];
  const addNonterminalForms = (
    target: () => Record<string, z.ZodTypeAny>,
  ) => {
    forms.push(
      z.object({ ...target(), message: z.string().min(1) }).strict(),
      z.object({
        ...target(),
        status: z.enum(["open", "blocked"]),
        message: z.string().min(1),
      }).strict(),
    );
  };
  if (input.isCurrentOwner) {
    addNonterminalForms(() => ({}));
    forms.push(z.object({
      status: z.enum(["done", "cancelled"]),
      message: z.string().min(1),
      structuredResult: z.unknown().optional(),
    }).strict());
  }
  if (creatorIssueIds.length > 0) {
    addNonterminalForms(() => ({
      issueId: z.enum(creatorIssueIds as [string, ...string[]]),
    }));
  }
  if (forms.length === 0) return null;
  return projection({
    schema: unionSchema(forms),
    details:
      "Publish one canonical issue comment, optionally update lifecycle, and automatically mention the creator/owner counterpart in that counterpart's issue context. Omit issueId to update the active issue as its current owner, including terminal done or cancelled disposition; provide an eligible direct-child issueId to update it as its exact creator with a message, open, or blocked status.",
    normalize(payload: {
      issueId?: string;
      status?: "open" | "blocked" | "done" | "cancelled";
      message: string;
      structuredResult?: unknown;
    }, scope) {
      const explicit = Object.hasOwn(payload, "issueId");
      return {
        name: "issue_update",
        companyId: scope.companyId,
        issueId: payload.issueId ?? scope.issueId,
        issueTarget: explicit ? "explicit" : "active",
        message: payload.message,
        ...(payload.status === undefined ? {} : { status: payload.status }),
        ...(Object.hasOwn(payload, "structuredResult")
          ? { structuredResult: payload.structuredResult }
          : {}),
      };
    },
  });
}

function projectRuntimeMentionAgent(
  input: PaperclipManagedToolRuntimeProjectionInput,
): RuntimeProjection<"mention_agent"> | null {
  if (input.mentionTargets.length === 0) return null;
  return projection({
    schema: z.object({
      agentId: agentIdChoice(input.mentionTargets),
      message: z.string().min(1),
    }).strict(),
    details:
      "Post one canonical issue comment mentioning an authorized agent on this same issue. The asynchronous call is non-terminal and gives the recipient no owner or creator lifecycle authority.",
    normalize: (payload, scope) => ({
      name: "mention_agent",
      companyId: scope.companyId,
      issueId: scope.issueId,
      ...payload,
    }),
  });
}

function projectRuntimeMentionBoard(
  input: PaperclipManagedToolRuntimeProjectionInput,
): RuntimeProjection<"mention_board"> | null {
  if (input.actionGrants.mention_board !== true) return null;
  return projection({
    schema: z.object({ message: z.string().min(1) }).strict(),
    details:
      "Post one canonical issue comment mentioning the collective Board for information or direction. The asynchronous call is non-terminal and does not change issue lifecycle, approvals, or review.",
    normalize: (payload, scope) => ({
      name: "mention_board",
      companyId: scope.companyId,
      issueId: scope.issueId,
      ...payload,
    }),
  });
}

function projectRuntimeListAgents(
  input: PaperclipManagedToolRuntimeProjectionInput,
): RuntimeProjection<"list_agents"> | null {
  if (
    input.actionGrants.list_all_agents !== true &&
    input.actionGrants.list_parent_agents !== true
  ) {
    return null;
  }
  return projection({
    schema: z.object({ agentId: z.string().min(1).optional() }).strict(),
    details:
      "List agents in this run's company with their name, title, id, capabilities, reporting parent, and status. Terminated agents are excluded. Omit agentId to list all agents. Provide an agentId to list only that agent and its entire reporting subtree (children, grandchildren, etc.).",
    normalize: (payload, scope) => ({
      name: "list_agents",
      companyId: scope.companyId,
      ...payload,
    }),
  });
}

function projectRuntimeAgentRead(
  input: PaperclipManagedToolRuntimeProjectionInput,
): RuntimeProjection<"agent_read"> | null {
  if (input.actionGrants.agent_configure !== true) return null;
  return projection({
    schema: z.object({ agentId: z.string().min(1) }).strict(),
    details:
      "Read one agent's runtime identity, grants, and status by agentId. Requires the agent_configure action grant but performs no mutation. The target agent must be in the same company and not terminated.",
    normalize: (payload, scope) => ({
      name: "agent_read",
      companyId: scope.companyId,
      ...payload,
    }),
  });
}

function projectRuntimeAgentHire(
  input: PaperclipManagedToolRuntimeProjectionInput,
): RuntimeProjection<"agent_hire"> | null {
  if (input.actionGrants.agent_hire !== true) return null;
  return projection({
    schema: runtimeAgentHireConfigurationSchema,
    details:
      "Create one ordinary direct-report agent. Provider, adapter, budget, lifecycle, and operational fields are not accepted.",
    normalize: (configuration, scope) => ({
      name: "agent_hire",
      companyId: scope.companyId,
      configuration: { ...configuration, reportsTo: scope.targetAgentId },
    }),
  });
}

function projectRuntimeAgentConfigure(
  input: PaperclipManagedToolRuntimeProjectionInput,
): RuntimeProjection<"agent_configure"> | null {
  if (
    input.actionGrants.agent_configure !== true ||
    input.configureTargets.length === 0
  ) {
    return null;
  }
  const schema = runtimeAgentConfigureActionSchemaForTargets(
    input.configureTargets.map((target) => target.id),
  );
  const result = projection({
    schema,
    details:
      "Update authorized runtime-agent identity, context cells, and grants only.",
    normalize(parsed, scope) {
      const { agentId, ...configuration } = parsed;
      return {
        name: "agent_configure",
        companyId: scope.companyId,
        agentId,
        configuration,
      };
    },
  });
  result.inputSchema.minProperties = 2;
  return result;
}

function projectRuntimeTool(
  name: PaperclipManagedToolName,
  input: PaperclipManagedToolRuntimeProjectionInput,
): RuntimeProjection<PaperclipManagedToolName> | null {
  switch (name) {
    case "list_company_issues": return projectRuntimeListCompanyIssues(input);
    case "list_sub_issues": return projectRuntimeListSubIssues(input);
    case "read_issue_comments": return projectRuntimeReadIssueComments(input);
    case "read_issue_agent_run": return projectRuntimeReadIssueAgentRun(input);
    case "issue_create": return projectRuntimeIssueCreate(input);
    case "issue_assign": return projectRuntimeIssueAssign(input);
    case "issue_update": return projectRuntimeIssueUpdate(input);
    case "mention_agent": return projectRuntimeMentionAgent(input);
    case "mention_board": return projectRuntimeMentionBoard(input);
    case "agent_hire": return projectRuntimeAgentHire(input);
    case "agent_configure": return projectRuntimeAgentConfigure(input);
    case "list_agents": return projectRuntimeListAgents(input);
    case "agent_read": return projectRuntimeAgentRead(input);
  }
}

export function projectPaperclipManagedTools(
  input: PaperclipManagedToolRuntimeProjectionInput,
): readonly ProjectedPaperclipManagedToolDescriptor[] {
  return PAPERCLIP_MANAGED_TOOL_NAMES.flatMap((name) => {
    const projected = projectRuntimeTool(name, input);
    if (!projected) return [];
    const metadata = PAPERCLIP_MANAGED_TOOL_METADATA[name];
    return [{
      name,
      title: metadata.title,
      description: projected.details
        ? `${metadata.description} ${projected.details}`
        : metadata.description,
      inputSchema: projected.inputSchema,
      source: "paperclip" as const,
      availability:
        metadata.readOnly && !isPaperclipContextToolName(name)
          ? "both" as const
          : "work" as const,
      normalizeRuntimeCommand(payload, scope) {
        const command = projected.normalize(payload, scope);
        return {
          command,
          ledger: command.name === "mention_agent"
            ? {
                kind: "mention" as const,
                toolName: "mention_agent" as const,
                targetAgentId: command.agentId,
              }
            : command.name === "mention_board"
              ? {
                  kind: "mention" as const,
                  toolName: "mention_board" as const,
                  targetAgentId: null,
                }
              : { kind: "non_mention" as const },
        };
      },
    }];
  });
}
