import { AgentsScreen } from "@/components/agents/AgentsScreen";
import { createFileRoute } from "@tanstack/react-router";

export { AgentsScreen as Agents } from "@/components/agents/AgentsScreen";

export const Route = createFileRoute("/_authenticated/$companyId/agents/")({
  component: AgentsIndexRoute,
});

function AgentsIndexRoute() {
  return <AgentsScreen tab="all" />;
}
