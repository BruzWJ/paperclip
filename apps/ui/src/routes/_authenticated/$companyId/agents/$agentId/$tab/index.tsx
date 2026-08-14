import { AgentDetailScreen } from "@/components/agents/AgentDetailScreen";
import { isAgentDetailTab } from "@/lib/agent-detail-tabs";
import { loadCompanyAgent } from "@/routes/-company-entity-loader";
import { createFileRoute, notFound } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/$companyId/agents/$agentId/$tab/")({
  loader: async ({ abortController, context, params }) => {
    if (!isAgentDetailTab(params.tab)) {
      throw notFound();
    }
    await loadCompanyAgent({
      queryClient: context.queryClient,
      companyId: params.companyId,
      entityId: params.agentId,
      signal: abortController.signal,
    });
    return { tab: params.tab };
  },
  component: AgentTabRoute,
});

function AgentTabRoute() {
  const { companyId, agentId } = Route.useParams();
  const { tab } = Route.useLoaderData();
  return <AgentDetailScreen companyId={companyId} agentId={agentId} urlTab={tab} />;
}
