import { Command } from "commander";
import { randomUUID } from "node:crypto";
import type { Agent, BoardTaskComment, Task } from "@paperclipai/shared";
import { createTaskSchema, createTaskUserCommentSchema } from "@paperclipai/shared";
import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface PromptOptions extends BaseClientOptions {
  agent?: string;
  task?: string;
  title?: string;
  companyId?: string;
}

interface PromptResult {
  ok: true;
  mode: "task" | "comment";
  actor: "agent" | "board";
  apiBase: string;
  companyId: string;
  agent: {
    id: string;
    name: string;
    urlKey?: string | null;
  };
  task?: Task | null;
  comment?: BoardTaskComment | null;
}

export function registerPromptCommands(program: Command): void {
  const board = program.command("board").description("Board operator operations");
  addCommonClientOptions(
    board
      .command("prompt")
      .description("Create/update Paperclip work for an agent using board auth")
      .requiredOption("--agent <agent>", "Target agent ID, shortname, or name")
      .option("-C, --company-id <id>", "Company ID")
      .option("--task <taskId>", "Append as a comment to an existing task")
      .option("--title <title>", "Task title when creating a new task")
      .argument("<prompt...>", "Prompt text")
      .action(async (promptParts: string[], opts: PromptOptions) => {
        try {
          const result = await runBoardPrompt(opts.agent ?? "", promptParts.join(" "), opts);
          printOutput(result, { json: opts.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

export async function runBoardPrompt(
  agentRef: string,
  prompt: string,
  opts: PromptOptions,
): Promise<PromptResult> {
  const ctx = resolveCommandContext(opts, { requireCompany: true });
  const body = normalizePrompt(prompt);
  const query = new URLSearchParams({ companyId: ctx.companyId ?? "" });
  const agent = await ctx.api.get<Agent>(`${apiPath`/api/agents/${agentRef}`}?${query.toString()}`);
  if (!agent) throw new Error(`Agent not found: ${agentRef}`);

  return createOrCommentForAgent({
    api: ctx.api,
    actor: "board",
    agent,
    companyId: ctx.companyId ?? agent.companyId,
    prompt: body,
    taskId: opts.task,
    title: opts.title,
  });
}

async function createOrCommentForAgent(input: {
  api: {
    apiBase: string;
    get<T>(path: string): Promise<T | null>;
    post<T>(path: string, body?: unknown): Promise<T | null>;
  };
  actor: "agent" | "board";
  agent: Agent;
  companyId: string;
  prompt: string;
  taskId?: string;
  title?: string;
}): Promise<PromptResult> {
  if (input.taskId?.trim()) {
    const taskId = input.taskId.trim();
    const task = await input.api.get<Task>(apiPath`/api/tasks/${taskId}`);
    if (
      !task ||
      task.ownerAgentId !== input.agent.id ||
      typeof task.ownershipEpoch !== "number"
    ) {
      throw new Error(
        "Existing-task prompts require the selected agent to be the exact current owner",
      );
    }
    const payload = createTaskUserCommentSchema.parse({
      message: input.prompt,
      idempotencyKey: randomUUID(),
      mention: {
        targetAgentId: input.agent.id,
        ownershipEpoch: task.ownershipEpoch,
      },
    });
    const result = await input.api.post<{ comment: BoardTaskComment }>(
      apiPath`/api/tasks/${taskId}/comments`,
      payload,
    );
    return {
      ok: true,
      mode: "comment",
      actor: input.actor,
      apiBase: input.api.apiBase,
      companyId: input.companyId,
      agent: agentSummary(input.agent),
      comment: result?.comment ?? null,
    };
  }

  const payload = createTaskSchema.parse({
    request: input.prompt,
    ownerAgentId: input.agent.id,
    idempotencyKey: randomUUID(),
    title: input.title?.trim() || defaultPromptTitle(input.prompt),
    priority: "medium",
  });
  const task = await input.api.post<Task>(apiPath`/api/companies/${input.companyId}/tasks`, payload);
  return {
    ok: true,
    mode: "task",
    actor: input.actor,
    apiBase: input.api.apiBase,
    companyId: input.companyId,
    agent: agentSummary(input.agent),
    task,
  };
}

function normalizePrompt(prompt: string): string {
  if (!prompt.trim()) throw new Error("Prompt text is required");
  return prompt;
}

function defaultPromptTitle(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "Prompt task";
  return firstLine.length > 100 ? `${firstLine.slice(0, 97)}...` : firstLine;
}

function agentSummary(agent: Agent): PromptResult["agent"] {
  return {
    id: agent.id,
    name: agent.name,
    urlKey: typeof agent.urlKey === "string" ? agent.urlKey : null,
  };
}
