import { createFileRoute } from "@tanstack/react-router";
import { AgentDetail } from "@/routes/_authenticated/$companyId/agents/$agentId";
import {
  loadCompanyAgent,
  loadCompanyAgentRun,
} from "@/routes/-company-entity-loader";

export const Route = createFileRoute(
  "/_authenticated/$companyId/agents/$agentId/runs/$runId/",
)({
  loader: async ({ abortController, context, params }) => {
    await loadCompanyAgent({
      queryClient: context.queryClient,
      companyId: params.companyId,
      entityId: params.agentId,
      signal: abortController.signal,
    });
    await loadCompanyAgentRun({
      queryClient: context.queryClient,
      companyId: params.companyId,
      agentId: params.agentId,
      entityId: params.runId,
      signal: abortController.signal,
    });
  },
  component: AgentRunRoute,
});

function AgentRunRoute() {
  const { companyId, agentId, runId } = Route.useParams();
  return (
    <AgentDetail companyId={companyId} agentId={agentId} urlRunId={runId} />
  );
}
