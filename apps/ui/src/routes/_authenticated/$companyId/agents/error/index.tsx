import { createFileRoute } from "@tanstack/react-router";
import { Agents } from "@/routes/_authenticated/$companyId/agents";

export const Route = createFileRoute("/_authenticated/$companyId/agents/error/")(
  { component: AgentsErrorRoute },
);

function AgentsErrorRoute() {
  return <Agents tab="error" />;
}
