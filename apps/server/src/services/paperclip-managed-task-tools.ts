import { z } from "zod";
import { resolveContextRetrievalPolicy } from "./context-dial-resolver.js";
import { RuntimeToolArgumentsInvalid } from "./runtime-tool-errors.js";
import { taskFiltersSchema } from "./paperclip-managed-tool-definitions.js";
import * as toolRuntime from "./paperclip-managed-tool-runtime.js";

export function projectRuntimeListCompanyTasks(
  input: toolRuntime.PaperclipManagedToolRuntimeProjectionInput,
): toolRuntime.RuntimeProjection<"list_company_tasks"> | null {
  if (!resolveContextRetrievalPolicy(input.contextDial).listCompanyTasks) {
    return null;
  }
  return toolRuntime.projection({
    schema: z
      .object({
        filters: taskFiltersSchema.optional(),
        cursor: toolRuntime.runtimeCursor,
      })
      .strict(),
    details:
      "Available only with the company-task listing grant. Lists one bounded page of top-level tasks in this run's company; it never returns descendants, another company's tasks, or control-plane configuration.",
    normalize: (payload, scope) => ({
      name: "list_company_tasks",
      companyId: scope.companyId,
      ...payload,
    }),
  });
}

export function projectRuntimeListSubTasks(
  input: toolRuntime.PaperclipManagedToolRuntimeProjectionInput,
): toolRuntime.RuntimeProjection<"list_sub_tasks"> | null {
  const policy = resolveContextRetrievalPolicy(input.contextDial);
  if (!policy.listSubTasks.enabled) return null;
  const explicitTarget = policy.listSubTasks.explicit.company
    ? "With taskId, any task in this run's company is accepted, including the active task."
    : "With taskId, only a proper descendant of the active task is accepted; the active task itself is rejected.";
  return toolRuntime.projection({
    schema: z
      .object({
        taskId: z.string().min(1).optional(),
        cursor: toolRuntime.runtimeCursor,
      })
      .strict(),
    details: `Lists one bounded page of direct children. Omit taskId to list the active task's direct children. ${explicitTarget}`,
    normalize: (payload, scope) => ({
      name: "list_sub_tasks",
      companyId: scope.companyId,
      taskId: payload.taskId ?? scope.taskId,
      cursor: payload.cursor,
    }),
  });
}

export function projectRuntimeReadTaskComments(
  input: toolRuntime.PaperclipManagedToolRuntimeProjectionInput,
): toolRuntime.RuntimeProjection<"read_task_comments"> | null {
  const policy = resolveContextRetrievalPolicy(input.contextDial);
  if (!policy.comments.enabled) return null;
  const schema = z
    .object({
      taskId: policy.comments.taskIdRequired ? z.string().min(1) : z.string().min(1).optional(),
      cursor: toolRuntime.runtimeCursor,
    })
    .strict();
  return toolRuntime.projection({
    schema,
    details: toolRuntime.retrievalReachDescription({
      prefix: "Reads one chronological bounded page of first-class Session comments.",
      reach: policy.comments,
      taskIdMode: policy.comments.active ? "optional" : "required",
    }),
    normalize: (payload, scope) => ({
      name: "read_task_comments",
      companyId: scope.companyId,
      taskId: payload.taskId ?? scope.taskId,
      cursor: payload.cursor,
    }),
  });
}

export function projectRuntimeReadTaskAgentRun(
  input: toolRuntime.PaperclipManagedToolRuntimeProjectionInput,
): toolRuntime.RuntimeProjection<"read_task_agent_run"> | null {
  const policy = resolveContextRetrievalPolicy(input.contextDial);
  if (!policy.runs.enabled) return null;
  return toolRuntime.projection({
    schema: z.object({ runId: z.string().min(1), cursor: toolRuntime.runtimeCursor }).strict(),
    details: toolRuntime.retrievalReachDescription({
      prefix:
        "Reads the delivered source message(s) and bounded provider-safe detailed turns for exactly one run selected by required runId.",
      reach: policy.runs,
      taskIdMode: null,
    }),
    normalize: (payload, scope) => ({
      name: "read_task_agent_run",
      companyId: scope.companyId,
      ...payload,
    }),
  });
}

export function agentIdChoice(entries: readonly toolRuntime.AgentCatalogEntry[]) {
  const ids = entries.map((entry) => entry.id) as [string, ...string[]];
  return z
    .enum(ids)
    .describe(
      entries
        .map((entry) => `${entry.id}: ${entry.name}${entry.capabilities ? ` — ${entry.capabilities}` : ""}`)
        .join("\n"),
    );
}

export const selfOwnerSchema = z.object({ kind: z.literal("self") }).strict();

export function ownerSchema(entries: readonly toolRuntime.TaskCreateOwnerCatalogEntry[]) {
  if (entries.length === 0) return selfOwnerSchema;
  return z.union([
    selfOwnerSchema,
    z
      .object({
        kind: z.literal("agent"),
        agentId: agentIdChoice(entries),
      })
      .strict(),
  ]);
}

export function projectRuntimeTaskCreate(
  input: toolRuntime.PaperclipManagedToolRuntimeProjectionInput,
): toolRuntime.RuntimeProjection<"task_create"> | null {
  if (input.mode !== "owner" || input.actionGrants.task_create !== true) {
    return null;
  }
  return toolRuntime.projection({
    schema: z
      .object({
        request: z.string().min(1),
        title: z.string().min(1).optional(),
        priority: z.enum(["critical", "high", "medium", "low"]).optional(),
        owner: ownerSchema(input.taskCreateDirectChildren),
      })
      .strict(),
    details:
      "Create one direct child of the active task and canonically mention its explicit invokable owner with the immutable request.",
    normalize(payload, scope) {
      return {
        name: "task_create",
        companyId: scope.companyId,
        parentId: scope.taskId,
        request: payload.request,
        ownerAgentId: payload.owner.kind === "self" ? scope.targetAgentId : payload.owner.agentId,
        ...(payload.title === undefined ? {} : { title: payload.title }),
        ...(payload.priority === undefined ? {} : { priority: payload.priority }),
      };
    },
  });
}

export function unionSchema(schemas: readonly z.ZodTypeAny[]): z.ZodTypeAny {
  if (schemas.length === 1) return schemas[0]!;
  return z.union(schemas as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
}

export function projectRuntimeTaskAssign(
  input: toolRuntime.PaperclipManagedToolRuntimeProjectionInput,
): toolRuntime.RuntimeProjection<"task_assign"> | null {
  if (
    input.mode !== "owner" ||
    input.actionGrants.task_create !== true ||
    input.taskAssignTargets.length === 0
  ) {
    return null;
  }
  const targets = new Map(input.taskAssignTargets.map((target) => [target.taskId, target]));
  const schema = unionSchema(
    input.taskAssignTargets.map((target) => {
      const owners = target.owners.map((owner) =>
        owner.kind === "self"
          ? selfOwnerSchema
          : z
              .object({
                kind: z.literal("agent"),
                agentId: z.literal(owner.id),
              })
              .strict(),
      );
      return z
        .object({
          taskId: z.literal(target.taskId).describe(target.identifier),
          owner: unionSchema(owners),
        })
        .strict();
    }),
  );
  return toolRuntime.projection({
    schema,
    details:
      "Reassign one nonterminal direct child created by this exact task execution and canonically mention its new owner with the task request.",
    normalize(
      payload: {
        taskId: string;
        owner: { kind: "self" } | { kind: "agent"; agentId: string };
      },
      scope,
    ) {
      if (!targets.has(payload.taskId)) {
        throw new RuntimeToolArgumentsInvalid("taskId is not in the current assignment catalog");
      }
      return {
        name: "task_assign",
        companyId: scope.companyId,
        taskId: payload.taskId,
        ownerAgentId: payload.owner.kind === "self" ? scope.targetAgentId : payload.owner.agentId,
      };
    },
  });
}

export function projectRuntimeTaskUpdate(
  input: toolRuntime.PaperclipManagedToolRuntimeProjectionInput,
): toolRuntime.RuntimeProjection<"task_update"> | null {
  if (input.mode !== "owner") return null;
  const creatorTaskIds = input.creatorUpdateTargets.map((target) => target.taskId);
  const forms: z.ZodTypeAny[] = [];
  const addNonterminalForms = (target: () => Record<string, z.ZodTypeAny>) => {
    forms.push(
      z.object({ ...target(), message: z.string().min(1) }).strict(),
      z
        .object({
          ...target(),
          status: z.enum(["open", "blocked"]),
          message: z.string().min(1),
        })
        .strict(),
    );
  };
  if (input.isCurrentOwner) {
    addNonterminalForms(() => ({}));
    forms.push(
      z
        .object({
          status: z.enum(["done", "cancelled"]),
          message: z.string().min(1),
          structuredResult: z.unknown().optional(),
        })
        .strict(),
    );
  }
  if (creatorTaskIds.length > 0) {
    addNonterminalForms(() => ({
      taskId: z.enum(creatorTaskIds as [string, ...string[]]),
    }));
  }
  if (forms.length === 0) return null;
  return toolRuntime.projection({
    schema: unionSchema(forms),
    details:
      "Publish one canonical task comment, optionally update lifecycle, and automatically mention the creator/owner counterpart in that counterpart's task context. Omit taskId to update the active task as its current owner, including terminal done or cancelled disposition; provide an eligible direct-child taskId to update it as its exact creator with a message, open, or blocked status.",
    normalize(
      payload: {
        taskId?: string;
        status?: "open" | "blocked" | "done" | "cancelled";
        message: string;
        structuredResult?: unknown;
      },
      scope,
    ) {
      const explicit = Object.hasOwn(payload, "taskId");
      return {
        name: "task_update",
        companyId: scope.companyId,
        taskId: payload.taskId ?? scope.taskId,
        taskTarget: explicit ? "explicit" : "active",
        message: payload.message,
        ...(payload.status === undefined ? {} : { status: payload.status }),
        ...(Object.hasOwn(payload, "structuredResult") ? { structuredResult: payload.structuredResult } : {}),
      };
    },
  });
}

export function projectRuntimeMentionAgent(
  input: toolRuntime.PaperclipManagedToolRuntimeProjectionInput,
): toolRuntime.RuntimeProjection<"mention_agent"> | null {
  if (input.mentionTargets.length === 0) return null;
  return toolRuntime.projection({
    schema: z
      .object({
        agentId: agentIdChoice(input.mentionTargets),
        message: z.string().min(1),
      })
      .strict(),
    details:
      "Post one canonical task comment mentioning an authorized agent on this same task. The asynchronous call is non-terminal and gives the recipient no owner or creator lifecycle authority.",
    normalize: (payload, scope) => ({
      name: "mention_agent",
      companyId: scope.companyId,
      taskId: scope.taskId,
      ...payload,
    }),
  });
}
