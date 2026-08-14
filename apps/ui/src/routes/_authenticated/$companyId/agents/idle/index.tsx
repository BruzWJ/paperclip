import { AgentsScreen } from "@/components/agents/AgentsScreen";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/$companyId/agents/idle/")({
  component: AgentsIdleRoute,
});

function AgentsIdleRoute() {
  return <AgentsScreen tab="idle" />;
}
