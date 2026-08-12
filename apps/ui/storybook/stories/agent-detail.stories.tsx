import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  canonicalizeMoneyAmount,
  type AgentDetail as AgentDetailRecord,
  type AgentRuntimeState,
  type BudgetOverview,
} from "@paperclipai/shared";
import { AgentDetail } from "@/routes/_authenticated/$companyId/agents/$agentId";
import { queryKeys } from "@/lib/queryKeys";
import {
  createTaskExecutionRun,
  storybookAgentMap,
  storybookAgents,
  storybookTasks,
} from "../fixtures/paperclipData";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "storybook-user";

// The visual spec freezes Date, so relative fixtures stay deterministic.
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

const agentDetailFixture: AgentDetailRecord = {
  ...storybookAgentMap.get("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1")!,
  id: AGENT_ID,
  companyId: COMPANY_ID,
  chainOfCommand: [
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3", name: "CTO", title: "CTO" },
    { id: AGENT_ID, name: "CodexCoder", title: "Senior Product Engineer" },
  ],
  access: {
    membership: null,
    grants: [],
  },
  pluginManagement: null,
};

const runtimeStateFixture: AgentRuntimeState = {
  agentId: AGENT_ID,
  companyId: COMPANY_ID,
  lastRunId: "90000000-0000-4000-8000-000000000005",
  lastRunStatus: "succeeded",
  lastContextUsedTokens: 128_431,
  lastContextWindowTokens: 200_000,
  peakContextUsedTokens: 180_000,
  aggregateKnownCostAmount: canonicalizeMoneyAmount("129.4"),
  unpricedPromptCount: 2,
  lastError: null,
  createdAt: minutesAgo(12_000),
  updatedAt: minutesAgo(3),
};

const runsFixture = [
  createTaskExecutionRun({
    id: "90000000-0000-4000-8000-000000000006",
    status: "running",
    targetAgentId: AGENT_ID,
    startedAt: minutesAgo(9).toISOString(),
    finishedAt: null,
    createdAt: minutesAgo(9).toISOString(),
    updatedAt: minutesAgo(1).toISOString(),
  }),
  createTaskExecutionRun({
    id: "90000000-0000-4000-8000-000000000005",
    status: "succeeded",
    targetAgentId: AGENT_ID,
    currentAttemptId: null,
    currentLeaseId: null,
    startedAt: minutesAgo(43).toISOString(),
    finishedAt: minutesAgo(31).toISOString(),
    terminalClassification: "succeeded",
    terminalFinalizationId: "93000000-0000-4000-8000-000000000005",
    createdAt: minutesAgo(43).toISOString(),
    updatedAt: minutesAgo(31).toISOString(),
  }),
  createTaskExecutionRun({
    id: "90000000-0000-4000-8000-000000000004",
    status: "succeeded",
    targetAgentId: AGENT_ID,
    currentAttemptId: null,
    currentLeaseId: null,
    startedAt: minutesAgo(90).toISOString(),
    finishedAt: minutesAgo(72).toISOString(),
    terminalClassification: "succeeded",
    terminalFinalizationId: "93000000-0000-4000-8000-000000000004",
    createdAt: minutesAgo(95).toISOString(),
    updatedAt: minutesAgo(72).toISOString(),
  }),
];

const budgetOverviewFixture: BudgetOverview = {
  companyId: COMPANY_ID,
  budgetCurrency: "USD",
  policies: [],
  activeIncidents: [],
  pausedAgentCount: 0,
  pausedProjectCount: 0,
  pendingApprovalCount: 0,
};

function seedAgentDetailData(queryClient: QueryClient) {
  queryClient.setQueryData(
    [...queryKeys.agents.detail(AGENT_ID), COMPANY_ID],
    agentDetailFixture,
  );
  queryClient.setQueryData(queryKeys.agents.runtimeState(AGENT_ID), runtimeStateFixture);
  queryClient.setQueryData(queryKeys.runs(COMPANY_ID, { agentId: AGENT_ID }), {
    items: runsFixture,
    nextCursor: null,
  });
  queryClient.setQueryData(
    [...queryKeys.tasks.list(COMPANY_ID), "participant-agent", AGENT_ID],
    storybookTasks.slice(0, 4),
  );
  queryClient.setQueryData(queryKeys.agents.list(COMPANY_ID), [
    agentDetailFixture,
    ...storybookAgents.filter((agent) => agent.id !== "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"),
  ]);
  queryClient.setQueryData(queryKeys.budgets.overview(COMPANY_ID), budgetOverviewFixture);
  queryClient.setQueryData(queryKeys.resourceMemberships.forUser(COMPANY_ID, USER_ID), {
    projectMemberships: {},
    agentMemberships: {},
    starredProjects: [],
    starredAgents: [],
  });
  queryClient.setQueryData(queryKeys.auth.session, {
    session: { id: "storybook-session", userId: USER_ID },
    user: { id: USER_ID, name: "Storybook User", email: "storybook@example.com", image: null },
  });
}

/**
 * Mounts the real AgentDetail route page inside the preview's memory router
 * (fixed at a company-scoped Storybook route): seed the QueryClient, then navigate to the
 * canonical agent URL so useParams resolves the fixture agent.
 */
function AgentDetailScenario() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  // Seed synchronously before the page's queries mount (staleTime: Infinity
  // in the preview QueryClient keeps these fixtures authoritative).
  useState(() => {
    seedAgentDetailData(queryClient);
    return true;
  });

  const target = `/${COMPANY_ID}/agents/${AGENT_ID}`;
  const onAgentRoute = location.pathname.startsWith(target);
  useEffect(() => {
    // One-way hop onto the agent route; the page owns the URL afterwards
    // (it may append a tab segment), so never navigate back.
    if (!onAgentRoute) {
      void navigate({
        to: "/$companyId/agents/$agentId",
        params: { companyId: COMPANY_ID, agentId: AGENT_ID },
        replace: true,
      });
    }
  }, [onAgentRoute, navigate, target]);

  if (!onAgentRoute) return null;

  return <AgentDetail companyId={COMPANY_ID} agentId={AGENT_ID} />;
}

const meta: Meta = {
  title: "Pages/Agent Detail",
  parameters: { layout: "fullscreen", a11y: { test: "off" } },
};
export default meta;
type Story = StoryObj;

export const Dashboard: Story = {
  render: () => <AgentDetailScenario />,
};
