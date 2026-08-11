import { createHash } from "node:crypto";

export type MemoryPartitionKind =
  | "task_agent"
  | "task_shared"
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
  taskId?: string;
  agentId?: string;
}) {
  return {
    company: digest("company", input.companyId),
    task: input.taskId ? digest("task", input.taskId) : null,
    agent: input.agentId
      ? digest("company-agent", `${input.companyId}\0${input.agentId}`)
      : null,
  };
}

function sharedAgentId(company: string): string {
  return digest("company-shared", company);
}

/**
 * Translates Paperclip's company/task × agent/shared matrix onto
 * AgentMemory's required project + agentId coordinates. `project` is only an
 * AgentMemory namespace; it is unrelated to a Paperclip Project entity.
 */
export function memoryPartition(
  kind: MemoryPartitionKind,
  input: { companyId: string; taskId?: string; agentId?: string },
): MemoryPartition {
  const ids = coordinates(input);
  const cwd = `/paperclip/${ids.company}`;
  const companyProject = `paperclip:company:${ids.company}`;
  switch (kind) {
    case "task_agent":
      if (!ids.task || !ids.agent) {
        throw new Error("task_agent memory requires taskId and agentId");
      }
      const taskAgentProject = `${companyProject}:task:${ids.task}`;
      return {
        kind,
        project: taskAgentProject,
        cwd,
        agentId: ids.agent,
      };
    case "task_shared":
      if (!ids.task) throw new Error("task_shared memory requires taskId");
      const taskSharedProject = `${companyProject}:task:${ids.task}`;
      return {
        kind,
        project: taskSharedProject,
        cwd,
        agentId: sharedAgentId(ids.company),
      };
    case "company_agent":
      if (!ids.agent) throw new Error("company_agent memory requires agentId");
      return {
        kind,
        project: companyProject,
        cwd,
        agentId: ids.agent,
      };
    case "company_shared": {
      return {
        kind,
        project: companyProject,
        cwd,
        agentId: sharedAgentId(ids.company),
      };
    }
  }
}

export function memoryObservationSessionId(input: {
  partition: MemoryPartition;
  observationIdentity: string;
}): string {
  return `${memoryPartitionSessionPrefix(input.partition)}${digest(
    "observation",
    input.observationIdentity,
  )}`;
}

export function memoryPartitionSessionPrefix(
  partition: MemoryPartition,
): string {
  return `pc_${digest(
    "session-partition",
    `${partition.project}\0${partition.agentId}`,
  )}_`;
}

export function memoryPartitionOwnsSessionId(
  partition: MemoryPartition,
  sessionId: string,
): boolean {
  const prefix = memoryPartitionSessionPrefix(partition);
  return sessionId.startsWith(prefix)
    && /^[a-f0-9]{64}$/.test(sessionId.slice(prefix.length));
}
