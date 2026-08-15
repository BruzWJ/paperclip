import { AgentsScreen } from "@/routes/_authenticated/$companyId/agents/-AgentsScreen";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/$companyId/agents/error/")({
  component: AgentsErrorRoute,
});

function AgentsErrorRoute() {
  return <AgentsScreen tab="error" />;
}
