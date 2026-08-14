// Shared by the file routes and Agents page without pulling the page's
// dependency graph into route validation.
export const AGENT_FILTER_TABS = ["all", "idle", "paused", "error"] as const;

export type AgentFilterTab = (typeof AGENT_FILTER_TABS)[number];

export interface AgentLiveRunSummary {
  runId: string;
  liveCount: number;
}
