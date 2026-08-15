import { AgentRunsPanel } from "@/components/agents/AgentRunsPanel";
import { queryKeys } from "@/lib/queryKeys";
import {
  RUN_DETAIL_AGENT_ID,
  RUN_DETAIL_COMPANY_ID,
  RUN_DETAIL_RUN_ID,
  RUN_DETAIL_TASK_ID,
  bounded,
  createJoinedRunDetail,
  createRunEnvelope,
  runDetailAgent,
} from "@/test-utils/agent-run-detail";
import type { TaskExecutionRunJoinedDetail } from "@/api/runs";
import type { TaskExecutionRunEnvelopeRecord } from "@paperclipai/shared";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

const taskFixture = {
  id: RUN_DETAIL_TASK_ID,
  companyId: RUN_DETAIL_COMPANY_ID,
  taskNumber: 412,
  identifier: "PAP-412",
  title: "Redesign the agent run detail",
  request: "Present the canonical provider transcript and execution records.",
};

const richDetail = createJoinedRunDetail();
const recentRun = createRunEnvelope({
  id: "55555555-5555-4555-8555-555555555556",
  status: "running",
  currentAttemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
  currentLeaseId: "lease-live-run",
  terminalFinalizationId: null,
  finishedAt: null,
  terminalClassification: null,
  createdAt: "2026-08-14T18:00:00.000Z",
  updatedAt: "2026-08-14T18:09:00.000Z",
});
const olderRun = createRunEnvelope({
  id: "55555555-5555-4555-8555-555555555557",
  status: "failed",
  terminalFinalizationId: "77777777-7777-4777-8777-777777777778",
  terminalClassification: "failed",
  terminalReasonCode: "provider_process_exited",
  createdAt: "2026-08-14T15:00:00.000Z",
  updatedAt: "2026-08-14T15:03:00.000Z",
});

interface AgentRunDetailScenarioProps {
  runs: TaskExecutionRunEnvelopeRecord[];
  selectedRunId: string | null;
  detail?: TaskExecutionRunJoinedDetail;
}

function AgentRunDetailScenario({ runs, selectedRunId, detail }: AgentRunDetailScenarioProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  useState(() => {
    const routinesQueryKey = queryKeys.routines.list(RUN_DETAIL_COMPANY_ID);
    queryClient.setQueryDefaults(routinesQueryKey, { staleTime: Number.POSITIVE_INFINITY });
    queryClient.setQueryData(routinesQueryKey, []);
    if (detail) queryClient.setQueryData(queryKeys.runDetail(detail.run.id), detail);
    queryClient.setQueryData(queryKeys.tasks.detail(RUN_DETAIL_TASK_ID), taskFixture);
    return true;
  });

  const target = `/${RUN_DETAIL_COMPANY_ID}/agents/${RUN_DETAIL_AGENT_ID}/runs`;
  const isTargetRoute = location.pathname === target;
  useEffect(() => {
    if (isTargetRoute) return;
    void navigate({
      to: "/$companyId/agents/$agentId/$tab",
      params: {
        companyId: RUN_DETAIL_COMPANY_ID,
        agentId: RUN_DETAIL_AGENT_ID,
        tab: "runs",
      },
      replace: true,
    });
  }, [isTargetRoute, navigate]);

  if (!isTargetRoute) return null;
  return (
    <div className="mx-auto w-full max-w-7xl p-6">
      <AgentRunsPanel
        runs={runs}
        agentRouteId={RUN_DETAIL_AGENT_ID}
        selectedRunId={selectedRunId}
        agent={runDetailAgent}
      />
    </div>
  );
}

const meta = {
  title: "Pages/Agent Run Detail",
  component: AgentRunsPanel,
  args: {
    runs: [richDetail.run],
    agentRouteId: RUN_DETAIL_AGENT_ID,
    selectedRunId: RUN_DETAIL_RUN_ID,
    agent: runDetailAgent,
  },
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "AI Elements execution history and run detail with canonical Conversation messages, reasoning and tools, lifecycle Queue, Context usage, Artifact output paths, and protocol diagnostics.",
      },
    },
  },
} satisfies Meta<typeof AgentRunsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RichCompletedDesktop: Story = {
  parameters: { viewport: { defaultViewport: "desktop" } },
  render: () => (
    <AgentRunDetailScenario
      runs={[recentRun, richDetail.run, olderRun]}
      selectedRunId={RUN_DETAIL_RUN_ID}
      detail={richDetail}
    />
  ),
};

export const DeepLinkedOutsideRecentHistory: Story = {
  parameters: { viewport: { defaultViewport: "desktop" } },
  render: () => (
    <AgentRunDetailScenario
      runs={[recentRun, olderRun]}
      selectedRunId={RUN_DETAIL_RUN_ID}
      detail={richDetail}
    />
  ),
};

export const BoundedExecutionRecords: Story = {
  parameters: { viewport: { defaultViewport: "desktop" } },
  render: () => {
    const detail = createJoinedRunDetail({
      sessionMessages: bounded(richDetail.sessionMessages.items, true),
      attempts: bounded(richDetail.attempts.items, true),
      sessionEvents: bounded(richDetail.sessionEvents.items, true),
      outputComments: bounded(richDetail.outputComments.items, true),
    });
    return (
      <AgentRunDetailScenario runs={[recentRun, detail.run]} selectedRunId={detail.run.id} detail={detail} />
    );
  },
};

export const MobileRunHistory: Story = {
  parameters: { viewport: { defaultViewport: "mobile" } },
  render: () => (
    <AgentRunDetailScenario
      runs={[recentRun, richDetail.run, olderRun]}
      selectedRunId={null}
      detail={richDetail}
    />
  ),
};

export const MobileSelectedRun: Story = {
  parameters: { viewport: { defaultViewport: "mobile" } },
  render: () => (
    <AgentRunDetailScenario
      runs={[recentRun, richDetail.run, olderRun]}
      selectedRunId={RUN_DETAIL_RUN_ID}
      detail={richDetail}
    />
  ),
};
