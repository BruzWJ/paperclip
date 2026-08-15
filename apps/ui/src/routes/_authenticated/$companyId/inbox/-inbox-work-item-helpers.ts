import { approvalLabel } from "@/features/approvals/ApprovalPayload";
import type { InboxWorkItem } from "@/lib/inbox";
import { matchesInboxTaskSearch } from "@/lib/inbox";
import { formatOwnerUserLabel } from "@/lib/task-owners";
import type { CreatorOption } from "@/lib/presentation-contracts";
import type { Agent, Task } from "@paperclipai/shared";
import { deriveOriginatingActor } from "@paperclipai/shared";
import { readTaskIdFromRun, runFailureMessage } from "./-inbox-row-model";

interface BuildInboxCreatorOptionsOptions {
  agents: Agent[] | undefined;
  currentUserId: string | null;
  mineTasks: Task[];
  touchedTasks: Task[];
}

export function buildInboxCreatorOptions({
  agents,
  currentUserId,
  mineTasks,
  touchedTasks,
}: BuildInboxCreatorOptionsOptions): CreatorOption[] {
  const options = new Map<string, CreatorOption>();
  const sourceTasks = [...mineTasks, ...touchedTasks];

  if (currentUserId) {
    options.set(`user:${currentUserId}`, {
      id: `user:${currentUserId}`,
      label: "Me",
      kind: "user",
      searchText: `me user ${currentUserId}`,
    });
  }

  for (const task of sourceTasks) {
    const creator = deriveOriginatingActor(task);
    if (creator?.kind !== "user") continue;

    const id = `user:${creator.id}`;
    if (options.has(id)) continue;
    options.set(id, {
      id,
      label: formatOwnerUserLabel(creator.id, currentUserId) ?? creator.id.slice(0, 5),
      kind: "user",
      searchText: `${creator.id} board user`,
    });
  }

  const knownAgentIds = new Set<string>();
  for (const agent of agents ?? []) {
    knownAgentIds.add(agent.id);
    const id = `agent:${agent.id}`;
    if (options.has(id)) continue;
    options.set(id, {
      id,
      label: agent.name,
      kind: "agent",
      searchText: `${agent.name} ${agent.id} agent`,
    });
  }

  for (const task of sourceTasks) {
    const creator = deriveOriginatingActor(task);
    if (creator?.kind !== "agent" || knownAgentIds.has(creator.id)) continue;

    const id = `agent:${creator.id}`;
    if (options.has(id)) continue;
    options.set(id, {
      id,
      label: creator.id.slice(0, 8),
      kind: "agent",
      searchText: `${creator.id} agent`,
    });
  }

  return [...options.values()].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "user" ? -1 : 1;
    return left.label.localeCompare(right.label);
  });
}

interface FilterInboxWorkItemsOptions {
  agentById: Map<string, string>;
  normalizedSearchQuery: string;
  taskById: Map<string, Task>;
  workItems: InboxWorkItem[];
}

export function filterInboxWorkItems({
  agentById,
  normalizedSearchQuery,
  taskById,
  workItems,
}: FilterInboxWorkItemsOptions): InboxWorkItem[] {
  const query = normalizedSearchQuery.toLowerCase();
  if (!query) return workItems;

  return workItems.filter((item) => {
    if (item.kind === "task") return matchesInboxTaskSearch(item.task, query);
    if (item.kind === "approval") {
      const label = approvalLabel(
        item.approval.type,
        item.approval.payload as Record<string, unknown> | null,
      );
      return label.toLowerCase().includes(query) || item.approval.type.toLowerCase().includes(query);
    }
    if (item.kind === "failed_run") {
      const name = agentById.get(item.run.targetAgentId);
      if (name?.toLowerCase().includes(query)) return true;
      if (runFailureMessage(item.run).toLowerCase().includes(query)) return true;
      const taskId = readTaskIdFromRun(item.run);
      const task = taskId ? taskById.get(taskId) : null;
      return Boolean(
        task?.title?.toLowerCase().includes(query) || task?.identifier?.toLowerCase().includes(query),
      );
    }
    return Boolean(
      item.joinRequest.requestEmailSnapshot?.toLowerCase().includes(query) ||
      item.joinRequest.requestingUserId?.toLowerCase().includes(query),
    );
  });
}
