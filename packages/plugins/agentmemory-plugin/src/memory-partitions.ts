import { createHash } from "node:crypto";

export type MemoryPartitionKind =
  | "issue_agent"
  | "issue_shared"
  | "company_agent"
  | "company_shared";

export interface MemoryPartition {
  kind: MemoryPartitionKind;
  project: string;
  cwd: string;
  agentId: string;
}

function digest(kind: string, value: string): string {
  return createHash("sha256")
    .update(`paperclip-agentmemory/v1\0${kind}\0${value}`)
    .digest("hex");
}

function coordinates(input: {
  companyId: string;
  issueId?: string;
  agentId?: string;
}) {
  return {
    company: digest("company", input.companyId),
    issue: input.issueId ? digest("issue", input.issueId) : null,
    agent: input.agentId ? digest("agent", input.agentId) : null,
  };
}

function partitionAgentId(project: string): string {
  return digest("partition-agent", project);
}

/**
 * Builds opaque AgentMemory coordinates. Raw Paperclip tenant, issue, and
 * agent IDs never leave Paperclip through project or agent labels.
 */
export function memoryPartition(
  kind: MemoryPartitionKind,
  input: { companyId: string; issueId?: string; agentId?: string },
): MemoryPartition {
  const ids = coordinates(input);
  const cwd = `/paperclip/${ids.company}`;
  switch (kind) {
    case "issue_agent":
      if (!ids.issue || !ids.agent) {
        throw new Error("issue_agent memory requires issueId and agentId");
      }
      const issueAgentProject =
        `paperclip:${ids.company}:issue:${ids.issue}:agent:${ids.agent}`;
      return {
        kind,
        project: issueAgentProject,
        cwd,
        agentId: partitionAgentId(issueAgentProject),
      };
    case "issue_shared":
      if (!ids.issue) throw new Error("issue_shared memory requires issueId");
      const issueSharedProject =
        `paperclip:${ids.company}:issue:${ids.issue}:shared`;
      return {
        kind,
        project: issueSharedProject,
        cwd,
        agentId: partitionAgentId(issueSharedProject),
      };
    case "company_agent":
      if (!ids.agent) throw new Error("company_agent memory requires agentId");
      const companyAgentProject =
        `paperclip:${ids.company}:company:agent:${ids.agent}`;
      return {
        kind,
        project: companyAgentProject,
        cwd,
        agentId: partitionAgentId(companyAgentProject),
      };
    case "company_shared": {
      const companySharedProject = `paperclip:${ids.company}:company:shared`;
      return {
        kind,
        project: companySharedProject,
        cwd,
        agentId: partitionAgentId(companySharedProject),
      };
    }
  }
}

export function memorySessionId(input: {
  partition: MemoryPartition;
  sourceKind: "run" | "comments";
  sourceId: string;
}): string {
  return `pc_${digest(
    "session",
    `${input.partition.project}\0${input.sourceKind}\0${input.sourceId}`,
  )}`;
}
