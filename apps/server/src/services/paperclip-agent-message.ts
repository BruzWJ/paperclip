import type { AgentVisibleIssueStatus } from "@paperclipai/shared";

export interface PaperclipMessageAgent {
  id: string;
  name: string;
}

export interface PaperclipMessageActor {
  id?: string | null;
  name: string;
}

export interface PaperclipMessageIssue {
  id: string;
  identifier?: string | null;
}

export type PaperclipPromptOwnerArgument =
  | { kind: "self" }
  | { kind: "agent"; agentId: string };

interface PaperclipManagedToolPromptDefinitions {
  mention_agent: {
    arguments: { agentId: string; message: string };
    context: {
      issue: PaperclipMessageIssue;
      from: PaperclipMessageAgent;
    };
  };
  issue_create: {
    arguments: {
      request: string;
      title?: string | null;
      priority?: "critical" | "high" | "medium" | "low";
      owner: PaperclipPromptOwnerArgument;
    };
    context: {
      issue: PaperclipMessageIssue;
      from: PaperclipMessageActor;
      owner: PaperclipMessageAgent;
      status: AgentVisibleIssueStatus;
    };
  };
  issue_assign: {
    arguments: {
      issueId: string;
      owner: PaperclipPromptOwnerArgument;
    };
    context: {
      issue: PaperclipMessageIssue;
      from: PaperclipMessageActor;
      owner: PaperclipMessageAgent;
      status: AgentVisibleIssueStatus;
      request: string;
    };
  };
  issue_update: {
    arguments: {
      issueId?: string;
      status?: AgentVisibleIssueStatus;
      message: string;
      structuredResult?: unknown;
    };
    context: {
      issue: PaperclipMessageIssue;
      from: PaperclipMessageActor;
      sourceRole: "issue creator" | "issue owner";
      previousStatus: AgentVisibleIssueStatus;
      effectiveStatus: AgentVisibleIssueStatus;
      pendingReview?: boolean;
    };
  };
}

export type PaperclipManagedToolName =
  keyof PaperclipManagedToolPromptDefinitions;

/**
 * A managed tool contributes its immutable arguments and locked, resolved
 * context. The admission boundary owns rendering this contract into the one
 * canonical comment/ref/ACPX source message.
 */
export type PaperclipManagedToolPromptContract = {
  [ToolName in PaperclipManagedToolName]: {
    toolName: ToolName;
  } & PaperclipManagedToolPromptDefinitions[ToolName];
}[PaperclipManagedToolName];

export type PaperclipManagedToolPrompt<
  ToolName extends PaperclipManagedToolName,
> = Extract<PaperclipManagedToolPromptContract, { toolName: ToolName }>;

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

function issueLines(issue: PaperclipMessageIssue): string[] {
  const id = oneLine(issue.id, "Paperclip message issue id");
  const identifier = issue.identifier?.trim()
    ? oneLine(issue.identifier, "Paperclip message issue identifier")
    : null;
  return [`Issue: ${identifier ? `${identifier} (${id})` : id}`];
}

function envelope(lines: readonly string[], exactBody: string): string {
  return `${lines.join("\n")}\n\n${body(exactBody)}`;
}

export function paperclipEnvelopeHasBody(
  rendered: string,
  heading: "[Paperclip agent message]" | "[Paperclip issue assignment]",
  exactBody: string,
): boolean {
  const separator = rendered.indexOf("\n\n");
  return (
    rendered.startsWith(`${heading}\n`) &&
    separator >= 0 &&
    rendered.slice(separator + 2) === exactBody
  );
}

function renderMentionAgentPrompt(
  input: PaperclipManagedToolPrompt<"mention_agent">,
): string {
  return envelope(
    [
      "[Paperclip agent message]",
      ...issueLines(input.context.issue),
      `From: ${actor(input.context.from)}`,
    ],
    input.arguments.message,
  );
}

function renderIssueCreatePrompt(
  input: PaperclipManagedToolPrompt<"issue_create">,
): string {
  return envelope(
    [
      "[Paperclip issue assignment]",
      "Action: Created and assigned",
      ...issueLines(input.context.issue),
      `From: ${actor(input.context.from)}`,
      `Owner: ${actor(input.context.owner)}`,
      `Status: ${input.context.status}`,
    ],
    input.arguments.request,
  );
}

function renderIssueAssignPrompt(
  input: PaperclipManagedToolPrompt<"issue_assign">,
): string {
  return envelope(
    [
      "[Paperclip issue assignment]",
      "Action: Reassigned",
      ...issueLines(input.context.issue),
      `From: ${actor(input.context.from)}`,
      `Owner: ${actor(input.context.owner)}`,
      `Status: ${input.context.status}`,
    ],
    input.context.request,
  );
}

function renderIssueUpdatePrompt(
  input: PaperclipManagedToolPrompt<"issue_update">,
): string {
  const requestedStatus = input.arguments.status;
  const status = requestedStatus === undefined
    ? input.context.effectiveStatus
    : input.context.pendingReview
      ? `${input.context.effectiveStatus} (${requestedStatus} requested; pending execution-policy review)`
      : `${input.context.previousStatus} -> ${input.context.effectiveStatus}`;
  return envelope(
    [
      "[Paperclip issue update]",
      ...issueLines(input.context.issue),
      `From: ${input.context.sourceRole}, ${actor(input.context.from)}`,
      `Status: ${status}`,
    ],
    input.arguments.message,
  );
}

export function renderPaperclipManagedToolPrompt(
  input: PaperclipManagedToolPromptContract,
): string {
  switch (input.toolName) {
    case "mention_agent":
      return renderMentionAgentPrompt(input);
    case "issue_create":
      return renderIssueCreatePrompt(input);
    case "issue_assign":
      return renderIssueAssignPrompt(input);
    case "issue_update":
      return renderIssueUpdatePrompt(input);
  }
}
