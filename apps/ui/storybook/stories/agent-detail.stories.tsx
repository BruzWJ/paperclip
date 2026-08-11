import { useEffect, useState } from "react";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  canonicalizeMoneyAmount,
  type AgentDetail as AgentDetailRecord,
  type AgentRuntimeState,
  type BudgetOverview,
} from "@paperclipai/shared";
import { AgentDetail } from "@/pages/AgentDetail";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import {
  createTaskExecutionRun,
  storybookAgentMap,
  storybookAgents,
  storybookTasks,
} from "../fixtures/paperclipData";

const COMPANY_ID = "company-storybook";
const AGENT_ID = "agent-codex";
const AGENT_ROUTE_REF = "codexcoder"; // the agent fixture's urlKey

// The visual spec freezes Date, so relative fixtures stay deterministic.
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

const agentDetailFixture: AgentDetailRecord = {
  ...storybookAgentMap.get(AGENT_ID)!,
  chainOfCommand: [
    { id: "agent-cto", name: "CTO", title: "CTO" },
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
  adapterType: "codex",
  lastRunId: "run-agent-detail-2",
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
    id: "run-agent-detail-3",
    status: "running",
    targetAgentId: AGENT_ID,
    startedAt: minutesAgo(9).toISOString(),
    finishedAt: null,
    createdAt: minutesAgo(9).toISOString(),
    updatedAt: minutesAgo(1).toISOString(),
  }),
  createTaskExecutionRun({
    id: "run-agent-detail-2",
    status: "succeeded",
    targetAgentId: AGENT_ID,
    currentAttemptId: null,
    currentLeaseId: null,
    startedAt: minutesAgo(43).toISOString(),
    finishedAt: minutesAgo(31).toISOString(),
    terminalClassification: "succeeded",
    terminalFinalizationId: "finalization-run-agent-detail-2",
    createdAt: minutesAgo(43).toISOString(),
    updatedAt: minutesAgo(31).toISOString(),
  }),
  createTaskExecutionRun({
    id: "run-agent-detail-1",
    status: "succeeded",
    targetAgentId: AGENT_ID,
    currentAttemptId: null,
    currentLeaseId: null,
    startedAt: minutesAgo(90).toISOString(),
    finishedAt: minutesAgo(72).toISOString(),
    terminalClassification: "succeeded",
    terminalFinalizationId: "finalization-run-agent-detail-1",
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
    [...queryKeys.agents.detail(AGENT_ROUTE_REF), COMPANY_ID],
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
  queryClient.setQueryData(queryKeys.agents.list(COMPANY_ID), storybookAgents);
  queryClient.setQueryData(queryKeys.budgets.overview(COMPANY_ID), budgetOverviewFixture);
  queryClient.setQueryData(queryKeys.resourceMemberships.mine(COMPANY_ID), {
    projectMemberships: {},
    agentMemberships: {},
    starredProjects: [],
    starredAgents: [],
  });
}

/**
 * Mounts the real AgentDetail route page inside the preview's MemoryRouter
 * (fixed at /PAP/storybook): seed the QueryClient, then navigate to the
 * canonical agent URL so useParams resolves the fixture agent.
 */
function AgentDetailScenario() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  // Seed synchronously before the page's queries mount (staleTime: Infinity
  // in the preview QueryClient keeps these fixtures authoritative).
  useState(() => {
    seedAgentDetailData(queryClient);
    return true;
  });

  useEffect(() => {
    if (selectedCompanyId !== COMPANY_ID) setSelectedCompanyId(COMPANY_ID);
  }, [selectedCompanyId, setSelectedCompanyId]);

  const target = `/PAP/agents/${AGENT_ROUTE_REF}`;
  const onAgentRoute = location.pathname.startsWith(target);
  useEffect(() => {
    // One-way hop onto the agent route; the page owns the URL afterwards
    // (it may append a tab segment), so never navigate back.
    if (!onAgentRoute) navigate(target, { replace: true });
  }, [onAgentRoute, navigate, target]);

  if (selectedCompanyId !== COMPANY_ID || !onAgentRoute) return null;

  return (
    <Routes>
      <Route path="/:companyPrefix/agents/:agentId/:tab?" element={<AgentDetail />} />
      <Route path="*" element={null} />
    </Routes>
  );
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
