import { AgentsScreen } from "@/routes/_authenticated/$companyId/agents/-AgentsScreen";
import { createFileRoute } from "@tanstack/react-router";

export { AgentsScreen as Agents } from "@/routes/_authenticated/$companyId/agents/-AgentsScreen";

export const Route = createFileRoute("/_authenticated/$companyId/agents/")({
  component: AgentsIndexRoute,
});

function AgentsIndexRoute() {
  return <AgentsScreen tab="all" />;
}
