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

interface PaperclipManagedAgentMessageDefinitions {
  mention_agent: {
    body: string;
    context: {
      task: PaperclipMessageTask;
      from: PaperclipMessageAgent;
    };
  };
  task_create: {
    body: string;
    context: {
      task: PaperclipMessageTask;
      from: PaperclipMessageActor;
      status: AgentVisibleTaskStatus;
    };
  };
  task_assign: {
    body: string;
    context: {
      task: PaperclipMessageTask;
      from: PaperclipMessageActor;
      status: AgentVisibleTaskStatus;
    };
  };
  task_update: {
    body: string;
    requestedStatus?: AgentVisibleTaskStatus;
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
export type PaperclipAgentMessageToolName = Extract<
  PaperclipManagedToolName,
  keyof PaperclipManagedAgentMessageDefinitions
>;

/**
 * A managed tool contributes one exact body plus locked, resolved context.
 * Only the agent-admission boundary may render it into delivery and comment
 * artifacts.
 */
export type PaperclipManagedAgentMessageContract = {
  [ToolName in PaperclipAgentMessageToolName]: {
    toolName: ToolName;
  } & PaperclipManagedAgentMessageDefinitions[ToolName];
}[PaperclipAgentMessageToolName];

export type PaperclipManagedAgentMessage<ToolName extends PaperclipAgentMessageToolName> = Extract<
  PaperclipManagedAgentMessageContract,
  { toolName: ToolName }
>;

export type PaperclipCommentMentionTarget =
  { kind: "agent"; agent: PaperclipMessageAgent } | { kind: "board" };

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

/**
 * Board-visible mention syntax is presentation only. It never becomes part
 * of the exact text delivered to an agent.
 */
export function renderPaperclipCommentMention(
  target: PaperclipCommentMentionTarget,
  exactBody: string,
): string {
  const mention =
    target.kind === "board" ? "@board" : `@${oneLine(target.agent.name, "Paperclip comment target name")}`;
  return `${mention} ${body(exactBody)}`;
}

export function renderPaperclipManagedAgentMessage(
  input: PaperclipManagedAgentMessageContract,
  recipient: PaperclipMessageAgent,
): { agentText: string; commentBody: string } {
  const exactBody = body(input.body);
  let lines: string[];
  switch (input.toolName) {
    case "mention_agent": {
      lines = [
        "[Paperclip agent message]",
        `To: ${actor(recipient)}`,
        ...taskLines(input.context.task),
        `From: ${actor(input.context.from)}`,
      ];
      break;
    }
    case "task_create":
    case "task_assign": {
      lines = [
        "[Paperclip task assignment]",
        `Action: ${input.toolName === "task_create" ? "Created and assigned" : "Reassigned"}`,
        ...taskLines(input.context.task),
        `From: ${actor(input.context.from)}`,
        `Owner: ${actor(recipient)}`,
        `Status: ${input.context.status}`,
      ];
      break;
    }
    case "task_update": {
      const status =
        input.requestedStatus === undefined
          ? input.context.effectiveStatus
          : input.context.pendingReview
            ? `${input.context.effectiveStatus} (${input.requestedStatus} requested; pending execution-policy review)`
            : `${input.context.previousStatus} -> ${input.context.effectiveStatus}`;
      lines = [
        "[Paperclip task update]",
        ...taskLines(input.context.task),
        `From: ${input.context.sourceRole}, ${actor(input.context.from)}`,
        `Status: ${status}`,
      ];
      break;
    }
  }
  return {
    agentText: envelope(lines, exactBody),
    commentBody: renderPaperclipCommentMention({ kind: "agent", agent: recipient }, exactBody),
  };
}
