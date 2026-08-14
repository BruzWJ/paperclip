import {
  PAPERCLIP_RUNTIME_ACTION_KEYS,
  addValidationDetail,
  canonicalUuidSchema,
  createTaskSchema,
  runtimeAgentCreateConfigurationSchema,
  runtimeAgentUpdateConfigurationSchema,
} from "@paperclipai/shared";
import { z } from "zod";

export const PAPERCLIP_CONTEXT_TOOL_NAMES = [
  "list_company_tasks",
  "list_sub_tasks",
  "read_task_comments",
  "read_task_agent_run",
] as const;

export type PaperclipContextToolName = (typeof PAPERCLIP_CONTEXT_TOOL_NAMES)[number];

export const PAPERCLIP_MANAGED_TOOL_NAMES = [
  ...PAPERCLIP_CONTEXT_TOOL_NAMES,
  ...PAPERCLIP_RUNTIME_ACTION_KEYS,
] as const;

export type PaperclipManagedToolName = (typeof PAPERCLIP_MANAGED_TOOL_NAMES)[number];

export type BoardManagedToolName = Exclude<PaperclipManagedToolName, "mention_board">;

export function isPaperclipContextToolName(value: string): value is PaperclipContextToolName {
  return (PAPERCLIP_CONTEXT_TOOL_NAMES as readonly string[]).includes(value);
}

export function isPaperclipManagedToolName(value: string): value is PaperclipManagedToolName {
  return (PAPERCLIP_MANAGED_TOOL_NAMES as readonly string[]).includes(value);
}

export const PAPERCLIP_MANAGED_TOOL_METADATA = {
  list_company_tasks: {
    title: "List company tasks",
    description: "List a bounded page of top-level tasks in one company.",
    readOnly: true,
  },
  list_sub_tasks: {
    title: "List direct sub-tasks",
    description: "List a bounded page of direct child tasks.",
    readOnly: true,
  },
  read_task_comments: {
    title: "Read task comments",
    description: "Read a chronological bounded page of task comments.",
    readOnly: true,
  },
  read_task_agent_run: {
    title: "Read task agent run",
    description: "Read the provider-safe trace for one agent run.",
    readOnly: true,
  },
  task_create: {
    title: "Create task",
    description: "Create a task and dispatch it to an explicit agent owner.",
    readOnly: false,
  },
  task_assign: {
    title: "Assign task",
    description: "Assign a task to an agent owner.",
    readOnly: false,
  },
  task_update: {
    title: "Update task",
    description: "Update a task or add a canonical task comment.",
    readOnly: false,
  },
  mention_agent: {
    title: "Mention agent",
    description: "Send a canonical task message to an explicit agent.",
    readOnly: false,
  },
  mention_board: {
    title: "Mention Board",
    description: "Send a canonical task message to the collective Board.",
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

export const taskFiltersSchema = z
  .object({
    status: z.enum(["open", "blocked", "done", "cancelled"]).optional(),
    priority: z.enum(["critical", "high", "medium", "low"]).optional(),
  })
  .strict();

export const exactNonEmptyString = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, "Value must not contain surrounding whitespace");

export const exactTitle = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => value.trim() === value, "Title must not contain surrounding whitespace");

export const nonBlankMessage = z
  .string()
  .max(200_000)
  .refine((value) => value.trim().length > 0, "Message must not be blank");

export const page = {
  cursor: exactNonEmptyString.optional(),
  limit: z.number().int().min(1).max(100).optional(),
};

export const boardTaskUpdateSchema = z
  .object({
    companyId: canonicalUuidSchema,
    taskId: canonicalUuidSchema,
    title: exactTitle.nullable().optional(),
    message: nonBlankMessage.optional(),
    replyToCommentId: canonicalUuidSchema.optional(),
    reopen: z.boolean().optional(),
    status: z.enum(["open", "blocked", "done", "cancelled"]).optional(),
    structuredResult: z.unknown().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.title === undefined && value.message === undefined && value.status === undefined) {
      addValidationDetail(ctx, {
        message: "Provide title, message, or status",
      });
    }
    if (value.reopen && value.message === undefined) {
      addValidationDetail(ctx, {
        message: "Reopening requires a message that explains why",
        path: ["message"],
      });
    }
    if (value.reopen && value.replyToCommentId !== undefined) {
      addValidationDetail(ctx, {
        message: "A reopen cannot be a reply to a run comment",
        path: ["replyToCommentId"],
      });
    }
    if (value.reopen && value.status !== undefined) {
      addValidationDetail(ctx, {
        message: "A reopen cannot include status",
        path: ["status"],
      });
    }
    if (value.reopen && Object.hasOwn(value, "structuredResult")) {
      addValidationDetail(ctx, {
        message: "A reopen cannot include structuredResult",
        path: ["structuredResult"],
      });
    }
    if (value.status !== undefined && value.message === undefined) {
      addValidationDetail(ctx, {
        message: "A lifecycle status update requires a message",
        path: ["message"],
      });
    }
    if (value.status !== undefined && value.replyToCommentId !== undefined) {
      addValidationDetail(ctx, {
        message: "A lifecycle status update cannot reply to a run comment",
        path: ["replyToCommentId"],
      });
    }
    const terminal = value.status === "done" || value.status === "cancelled";
    if (Object.hasOwn(value, "structuredResult") && !terminal) {
      addValidationDetail(ctx, {
        message: "structuredResult is accepted only for done or cancelled",
        path: ["structuredResult"],
      });
    }
    if (terminal && Object.hasOwn(value, "structuredResult") && value.structuredResult === undefined) {
      addValidationDetail(ctx, {
        message: "structuredResult must be omitted rather than undefined",
        path: ["structuredResult"],
      });
    }
  });

export const boardTaskCreateSchema = createTaskSchema
  .omit({ idempotencyKey: true, title: true })
  .extend({
    companyId: canonicalUuidSchema,
    title: exactTitle.nullable().optional(),
  })
  .strict();

export const exactRuntimeAgentCreateConfigurationSchema = z.intersection(
  z.object({ name: exactNonEmptyString }).passthrough(),
  runtimeAgentCreateConfigurationSchema,
);

export const exactRuntimeAgentUpdateConfigurationSchema = z.intersection(
  z.object({ name: exactNonEmptyString.optional() }).passthrough(),
  runtimeAgentUpdateConfigurationSchema,
);

/** The one public, exact schema map used by authenticated Board MCP. */
export const boardMcpInputSchemas = {
  list_company_tasks: z
    .object({
      companyId: canonicalUuidSchema,
      filters: taskFiltersSchema.optional(),
      ...page,
    })
    .strict(),
  list_sub_tasks: z
    .object({
      companyId: canonicalUuidSchema,
      taskId: canonicalUuidSchema,
      ...page,
    })
    .strict(),
  read_task_comments: z
    .object({
      companyId: canonicalUuidSchema,
      taskId: canonicalUuidSchema,
      ...page,
    })
    .strict(),
  read_task_agent_run: z
    .object({
      companyId: canonicalUuidSchema,
      runId: canonicalUuidSchema,
      cursor: page.cursor,
    })
    .strict(),
  task_create: boardTaskCreateSchema,
  task_assign: z
    .object({
      companyId: canonicalUuidSchema,
      taskId: canonicalUuidSchema,
      ownerAgentId: canonicalUuidSchema,
    })
    .strict(),
  task_update: boardTaskUpdateSchema,
  mention_agent: z
    .object({
      companyId: canonicalUuidSchema,
      taskId: canonicalUuidSchema,
      agentId: canonicalUuidSchema,
      message: nonBlankMessage,
    })
    .strict(),
  agent_hire: z
    .object({
      companyId: canonicalUuidSchema,
      configuration: exactRuntimeAgentCreateConfigurationSchema,
    })
    .strict(),
  agent_configure: z
    .object({
      companyId: canonicalUuidSchema,
      agentId: canonicalUuidSchema,
      configuration: exactRuntimeAgentUpdateConfigurationSchema,
    })
    .strict(),
  list_agents: z
    .object({
      companyId: canonicalUuidSchema,
      agentId: canonicalUuidSchema.optional(),
      includeTerminated: z.boolean().optional(),
    })
    .strict(),
  agent_read: z
    .object({
      companyId: canonicalUuidSchema,
      agentId: canonicalUuidSchema,
    })
    .strict(),
} satisfies Record<BoardManagedToolName, z.ZodTypeAny>;

export type ManagedToolPayload<Name extends PaperclipManagedToolName> = Name extends "mention_board"
  ? { companyId: string; taskId: string; message: string }
  : Name extends BoardManagedToolName
    ? z.infer<(typeof boardMcpInputSchemas)[Name]>
    : never;

export type PaperclipManagedToolCommandFor<Name extends PaperclipManagedToolName> =
  Name extends PaperclipManagedToolName
    ? { name: Name } & ManagedToolPayload<Name> &
        (Name extends "task_update" ? { taskTarget?: "active" | "explicit" } : object)
    : never;

export type PaperclipManagedToolCommand = {
  [Name in PaperclipManagedToolName]: PaperclipManagedToolCommandFor<Name>;
}[PaperclipManagedToolName];

export interface BoardManagedToolDefinition {
  name: BoardManagedToolName;
  title: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  readOnly: boolean;
}

export const BOARD_MANAGED_TOOL_NAMES = PAPERCLIP_MANAGED_TOOL_NAMES.filter(
  (name): name is BoardManagedToolName => name !== "mention_board",
);

export const BOARD_MANAGED_TOOLS: readonly BoardManagedToolDefinition[] = Object.freeze(
  BOARD_MANAGED_TOOL_NAMES.map((name) => ({
    name,
    ...PAPERCLIP_MANAGED_TOOL_METADATA[name],
    inputSchema: boardMcpInputSchemas[name],
  })),
);

export function parseBoardManagedTool<Name extends BoardManagedToolName>(
  name: Name,
  payload: unknown,
): PaperclipManagedToolCommandFor<Name> {
  const parsed = boardMcpInputSchemas[name].parse(payload);
  return { name, ...parsed } as PaperclipManagedToolCommandFor<Name>;
}
