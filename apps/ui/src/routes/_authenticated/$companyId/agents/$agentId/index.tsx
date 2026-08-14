import { AgentDetailScreen } from "@/components/agents/AgentDetailScreen";
import { loadCompanyAgent } from "@/routes/-company-entity-loader";
import { createFileRoute } from "@tanstack/react-router";

export { AgentDetailScreen as AgentDetail } from "@/components/agents/AgentDetailScreen";

export const Route = createFileRoute("/_authenticated/$companyId/agents/$agentId/")({
  loader: ({ abortController, context, params }) =>
    loadCompanyAgent({
      queryClient: context.queryClient,
      companyId: params.companyId,
      entityId: params.agentId,
      signal: abortController.signal,
    }),
  component: AgentDashboardRoute,
});

function AgentDashboardRoute() {
  const { companyId, agentId } = Route.useParams();
  return <AgentDetailScreen companyId={companyId} agentId={agentId} />;
}
