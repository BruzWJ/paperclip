import { createFileRoute } from "@tanstack/react-router";
import { Agents } from "@/routes/_authenticated/$companyId/agents";

export const Route = createFileRoute("/_authenticated/$companyId/agents/idle/")({
  component: AgentsIdleRoute,
});

function AgentsIdleRoute() {
  return <Agents tab="idle" />;
}
