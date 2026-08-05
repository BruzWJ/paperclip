// Shared between the route table (App.tsx) and the Agents page. This lives in
// lib/ so registering the `agents/:tab` routes does not pull the whole Agents
// page (and its dependency graph) into the eager entry chunk — App.tsx only
// needs the tab names, the page itself is loaded lazily.
export const AGENT_FILTER_TABS = ["all", "active", "paused", "error"] as const;

export type AgentFilterTab = (typeof AGENT_FILTER_TABS)[number];
