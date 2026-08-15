import type { Agent } from "@paperclipai/shared";
import { type AgentSidebarSortMode, type AgentSortModeUpdatedDetail } from "@/lib/agent-order";
import type { LabeledValue } from "@/lib/presentation-contracts";

export const AGENT_SORT_CHOICES: LabeledValue[] = [
  { value: "top", label: "Top" },
  { value: "alphabetical", label: "Alphabetical" },
  { value: "recent", label: "Recent" },
];

export function isAgentSortModeUpdatedDetail(value: unknown): value is AgentSortModeUpdatedDetail {
  if (typeof value !== "object" || value === null) return false;
  const storageKey = Reflect.get(value, "storageKey");
  const sortMode = Reflect.get(value, "sortMode");
  return (
    typeof storageKey === "string" &&
    (sortMode === "top" || sortMode === "alphabetical" || sortMode === "recent")
  );
}

export function agentTimestamp(agent: Agent, field: "updatedAt" | "createdAt"): number {
  const raw = agent[field];
  if (!raw) return 0;
  const time = new Date(raw).getTime();
  return Number.isFinite(time) ? time : 0;
}

export function sortAgents(agents: Agent[], sortMode: AgentSidebarSortMode): Agent[] {
  if (sortMode === "top") return agents;
  const sorted = [...agents];
  if (sortMode === "alphabetical") {
    sorted.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
    return sorted;
  }
  sorted.sort((left, right) => {
    const updatedDiff = agentTimestamp(right, "updatedAt") - agentTimestamp(left, "updatedAt");
    if (updatedDiff !== 0) return updatedDiff;

    const createdDiff = agentTimestamp(right, "createdAt") - agentTimestamp(left, "createdAt");
    return createdDiff !== 0
      ? createdDiff
      : left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
  return sorted;
}
