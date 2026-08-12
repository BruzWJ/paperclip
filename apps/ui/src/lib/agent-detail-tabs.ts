const AGENT_DETAIL_TABS = [
  "configuration",
  "runs",
  "budget",
] as const;

type AgentDetailTab = (typeof AGENT_DETAIL_TABS)[number];
export type AgentDetailView = "dashboard" | AgentDetailTab;

export function isAgentDetailTab(value: string): value is AgentDetailTab {
  return AGENT_DETAIL_TABS.some((tab) => tab === value);
}
