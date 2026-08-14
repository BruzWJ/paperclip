import type { AgentVisibleTaskStatus } from "@paperclipai/shared";
import type { PaperclipManagedToolName } from "./paperclip-managed-tool-registry.js";

export interface PaperclipMessageAgent {
  id: string;
  name: string;
}

export interface PaperclipMessageActor {
  id?: string | null;
  name: string;
}

export interface PaperclipMessageTask {
  id: string;
  identifier: string;
}

export type PaperclipPromptOwnerArgument = { kind: "self" } | { kind: "agent"; agentId: string };

interface PaperclipManagedToolPromptDefinitions {
  mention_agent: {
    arguments: { agentId: string; message: string };
    context: {
      task: PaperclipMessageTask;
      from: PaperclipMessageAgent;
      to: PaperclipMessageAgent;
    };
  };
  task_create: {
    arguments: {
      request: string;
      title?: string | null;
      priority?: "critical" | "high" | "medium" | "low";
      owner: PaperclipPromptOwnerArgument;
    };
    context: {
      task: PaperclipMessageTask;
      from: PaperclipMessageActor;
      owner: PaperclipMessageAgent;
      status: AgentVisibleTaskStatus;
    };
  };
  task_assign: {
    arguments: {
      taskId: string;
      owner: PaperclipPromptOwnerArgument;
    };
    context: {
      task: PaperclipMessageTask;
      from: PaperclipMessageActor;
      owner: PaperclipMessageAgent;
      status: AgentVisibleTaskStatus;
      request: string;
    };
  };
  task_update: {
    arguments: {
      taskId?: string;
      status?: AgentVisibleTaskStatus;
      message: string;
      structuredResult?: unknown;
    };
    context: {
      task: PaperclipMessageTask;
      from: PaperclipMessageActor;
      sourceRole: "task creator" | "task owner";
      previousStatus: AgentVisibleTaskStatus;
      effectiveStatus: AgentVisibleTaskStatus;
      pendingReview?: boolean;
    };
  };
}

/**
 * Only delivery-producing tools have a rendered agent-message contract. This
 * is intentionally a subset of the canonical managed-tool vocabulary, not a
 * second competing tool-name registry.
 */
export type PaperclipDeliveryPromptToolName = Extract<
  PaperclipManagedToolName,
  keyof PaperclipManagedToolPromptDefinitions
>;

/**
 * A managed tool contributes its immutable arguments and locked, resolved
 * context. The admission boundary owns rendering this contract into the one
 * canonical comment/ref/ACPX source message.
 */
export type PaperclipManagedToolPromptContract = {
  [ToolName in PaperclipDeliveryPromptToolName]: {
    toolName: ToolName;
  } & PaperclipManagedToolPromptDefinitions[ToolName];
}[PaperclipDeliveryPromptToolName];

export type PaperclipManagedToolPrompt<ToolName extends PaperclipDeliveryPromptToolName> = Extract<
  PaperclipManagedToolPromptContract,
  { toolName: ToolName }
>;

function oneLine(value: string, label: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) throw new Error(`${label} must be non-empty`);
  return normalized;
}

function body(value: string): string {
  if (!value.trim()) {
    throw new Error("Paperclip agent message body must be non-empty");
  }
  return value;
}

function actor(value: PaperclipMessageActor): string {
  const name = oneLine(value.name, "Paperclip message actor name");
  return value.id === null || value.id === undefined
    ? name
    : `${name} (${oneLine(value.id, "Paperclip message actor id")})`;
}

function taskLines(task: PaperclipMessageTask): string[] {
  const id = oneLine(task.id, "Paperclip message task id");
  const identifier = oneLine(task.identifier, "Paperclip message task identifier");
  return [`Task: ${identifier} (${id})`];
}

function envelope(lines: readonly string[], exactBody: string): string {
  return `${lines.join("\n")}\n\n${body(exactBody)}`;
}

export function paperclipEnvelopeHasBody(
  rendered: string,
  heading: "[Paperclip agent message]" | "[Paperclip task assignment]",
  exactBody: string,
): boolean {
  const separator = rendered.indexOf("\n\n");
  return rendered.startsWith(`${heading}\n`) && separator >= 0 && rendered.slice(separator + 2) === exactBody;
}

function renderMentionAgentPrompt(input: PaperclipManagedToolPrompt<"mention_agent">): string {
  return envelope(
    [
      "[Paperclip agent message]",
      `To: ${actor(input.context.to)}`,
      ...taskLines(input.context.task),
      `From: ${actor(input.context.from)}`,
    ],
    `@${input.context.to.name} ${input.arguments.message}`,
  );
}

function renderTaskCreatePrompt(input: PaperclipManagedToolPrompt<"task_create">): string {
  return envelope(
    [
      "[Paperclip task assignment]",
      "Action: Created and assigned",
      ...taskLines(input.context.task),
      `From: ${actor(input.context.from)}`,
      `Owner: ${actor(input.context.owner)}`,
      `Status: ${input.context.status}`,
    ],
    input.arguments.request,
  );
}

function renderTaskAssignPrompt(input: PaperclipManagedToolPrompt<"task_assign">): string {
  return envelope(
    [
      "[Paperclip task assignment]",
      "Action: Reassigned",
      ...taskLines(input.context.task),
      `From: ${actor(input.context.from)}`,
      `Owner: ${actor(input.context.owner)}`,
      `Status: ${input.context.status}`,
    ],
    input.context.request,
  );
}

function renderTaskUpdatePrompt(input: PaperclipManagedToolPrompt<"task_update">): string {
  const requestedStatus = input.arguments.status;
  const status =
    requestedStatus === undefined
      ? input.context.effectiveStatus
      : input.context.pendingReview
        ? `${input.context.effectiveStatus} (${requestedStatus} requested; pending execution-policy review)`
        : `${input.context.previousStatus} -> ${input.context.effectiveStatus}`;
  return envelope(
    [
      "[Paperclip task update]",
      ...taskLines(input.context.task),
      `From: ${input.context.sourceRole}, ${actor(input.context.from)}`,
      `Status: ${status}`,
    ],
    input.arguments.message,
  );
}

export function renderPaperclipManagedToolPrompt(input: PaperclipManagedToolPromptContract): string {
  switch (input.toolName) {
    case "mention_agent":
      return renderMentionAgentPrompt(input);
    case "task_create":
      return renderTaskCreatePrompt(input);
    case "task_assign":
      return renderTaskAssignPrompt(input);
    case "task_update":
      return renderTaskUpdatePrompt(input);
  }
}
