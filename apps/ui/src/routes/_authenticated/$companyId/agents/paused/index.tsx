import { createFileRoute } from "@tanstack/react-router";
import { Agents } from "@/routes/_authenticated/$companyId/agents";

export const Route = createFileRoute(
  "/_authenticated/$companyId/agents/paused/",
)({ component: AgentsPausedRoute });

function AgentsPausedRoute() {
  return <Agents tab="paused" />;
}
