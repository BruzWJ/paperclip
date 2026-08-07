import type {
  PluginBeforePromptInput,
  PluginBeforePromptResult,
  PluginContext,
  PluginContextAccess,
  PluginToolRunContext,
  ToolResult,
} from "@paperclipai/plugin-sdk";
import { AgentMemoryClient } from "./agentmemory-client.js";
import {
  capturePromptComments,
  capturePromptSession,
} from "./capture.js";
import {
  memoryPartition,
  type MemoryPartitionKind,
} from "./memory-partitions.js";

function readString(
  params: unknown,
  key: "query" | "issueId",
): string | null {
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const value = (params as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function memoryGrantCandidates(
  kind: MemoryPartitionKind,
  relation?: "active" | "descendant" | "company" | "outside",
): Array<keyof PluginContextAccess> {
  const companyGrant = kind === "issue_agent" || kind === "company_agent"
    ? "read_company_issue_agent_run"
    : "read_company_issue_comments";
  if (kind === "company_agent" || kind === "company_shared") return [companyGrant];
  if (relation === "active") {
    return [
      kind === "issue_agent" ? "read_issue_agent_run" : "read_issue_comments",
      companyGrant,
    ];
  }
  if (relation === "descendant") {
    return [
      kind === "issue_agent" ? "read_sub_issue_agent_run" : "read_sub_issue_comments",
      companyGrant,
    ];
  }
  return relation === "company" ? [companyGrant] : [];
}

export function canReadIssueMemory(
  kind: "issue_agent" | "issue_shared",
  reach: { visible: boolean; relation: "active" | "descendant" | "company" | "outside" },
  contextAccess: PluginContextAccess,
): boolean {
  return reach.visible
    && memoryGrantCandidates(kind, reach.relation)
      .some((grant) => contextAccess[grant] === true);
}

export async function recall(input: {
  ctx: PluginContext;
  runContext: PluginToolRunContext;
  kind: MemoryPartitionKind;
  params: unknown;
}): Promise<ToolResult> {
  const query = readString(input.params, "query");
  if (!query) return { ok: false, error: "query is required" };
  const resolved = await input.runContext.resolve();
  let issueId: string | undefined;
  if (input.kind === "issue_agent" || input.kind === "issue_shared") {
    issueId = readString(input.params, "issueId") ?? undefined;
    if (!issueId) return { ok: false, error: "issueId is required" };
    const reach = await input.runContext.issueReach(issueId);
    const candidates = memoryGrantCandidates(input.kind, reach.relation);
    if (!canReadIssueMemory(input.kind, reach, resolved.contextAccess)) {
      return {
        ok: false,
        error: reach.visible
          ? `Issue memory requires one of ${candidates.join(", ")} in the current context-access matrix`
          : "Issue memory is outside the current issue-listing reach",
      };
    }
  } else {
    const requiredGrant = input.kind === "company_agent"
      ? "read_company_issue_agent_run"
      : "read_company_issue_comments";
    if (
      resolved.contextAccess.list_company_issues !== true
      || resolved.contextAccess[requiredGrant] !== true
    ) {
      return {
        ok: false,
        error: `Company-wide memory requires list_company_issues and ${requiredGrant} in the current context-access matrix`,
      };
    }
  }

  const partition = memoryPartition(input.kind, {
    companyId: resolved.companyId,
    issueId,
    agentId:
      input.kind === "issue_agent" || input.kind === "company_agent"
        ? resolved.agentId
        : undefined,
  });
  const client = await AgentMemoryClient.connect(input.ctx);
  const result = await client.search(partition, query);
  return {
    ok: true,
    content: result.text,
    data: {
      ...result,
      results: result.results.map((item) => ({ ...item })),
    },
  };
}

/**
 * Blocking before-prompt capture barrier. The exact source Session range and
 * shared comment snapshot are captured before Paperclip transmits the prompt.
 */
export async function beforePrompt(
  ctx: PluginContext,
  input: PluginBeforePromptInput,
): Promise<PluginBeforePromptResult> {
  const client = await AgentMemoryClient.connect(ctx);
  await capturePromptSession({
    ctx,
    client,
    prompt: input,
  });
  await capturePromptComments({
    ctx,
    client,
    companyId: input.companyId,
    issueId: input.issueId,
    snapshotHighWaterSeq: input.snapshotHighWaterSeq,
  });
  return null;
}
