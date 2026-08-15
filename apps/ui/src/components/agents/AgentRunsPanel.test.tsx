// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import {
  RUN_DETAIL_AGENT_ID,
  RUN_DETAIL_COMPANY_ID,
  RUN_DETAIL_RUN_ID,
  RUN_DETAIL_TASK_ID,
  bounded,
  createCanonicalSessionRecord,
  createJoinedRunDetail,
  createRunEnvelope,
  runDetailAgent,
} from "@/test-utils/agent-run-detail";
import { AgentRunsPanel } from "./AgentRunsPanel";
import { AgentRunDetail } from "./run-detail/AgentRunDetail";
import { AgentRunTranscript } from "./run-detail/AgentRunTranscript";

const sidebarState = vi.hoisted(() => ({ isMobile: false }));
const stickState = vi.hoisted(() => ({ isAtBottom: true }));
const runGet = vi.hoisted(() => vi.fn());
const taskGet = vi.hoisted(() => vi.fn());

vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => sidebarState,
}));

vi.mock("@/hooks/useCompanyRouteId", () => ({
  useCompanyRouteId: () => RUN_DETAIL_COMPANY_ID,
}));

vi.mock("@/api/runs", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/api/runs")>();
  return { ...original, runsApi: { ...original.runsApi, get: runGet } };
});

vi.mock("@/api/tasks", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/api/tasks")>();
  return { ...original, tasksApi: { ...original.tasksApi, get: taskGet } };
});

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    ...props
  }: ComponentProps<"a"> & { to: string; params?: Record<string, string> }) => {
    const href = Object.entries(params ?? {}).reduce(
      (path, [key, value]) => path.replace(`$${key}`, value),
      to,
    );
    return (
      <a href={href} {...props}>
        {children}
      </a>
    );
  },
}));

vi.mock("streamdown", () => ({
  Streamdown: ({ children, isAnimating }: { children: ReactNode; isAnimating?: boolean }) => (
    <div data-testid="streamdown" data-streaming={isAnimating || undefined}>
      {children}
    </div>
  ),
}));

vi.mock("@/components/ai-elements/code-block", () => ({
  CodeBlock: ({ code, language }: { code: string; language: string }) => (
    <pre data-language={language}>{code}</pre>
  ),
}));

vi.mock("use-stick-to-bottom", () => {
  const StickToBottom = ({ children, ...props }: ComponentProps<"div">) => <div {...props}>{children}</div>;
  StickToBottom.Content = ({ children, ...props }: ComponentProps<"div">) => <div {...props}>{children}</div>;
  return {
    StickToBottom,
    useStickToBottomContext: () => ({
      isAtBottom: stickState.isAtBottom,
      scrollToBottom: vi.fn(),
    }),
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const taskFixture = {
  id: RUN_DETAIL_TASK_ID,
  companyId: RUN_DETAIL_COMPANY_ID,
  taskNumber: 412,
  identifier: "PAP-412",
  title: "Redesign the agent run detail",
  request: "Present the canonical provider transcript.",
};

function createClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
}

function seedDetail(client: QueryClient, detail = createJoinedRunDetail()) {
  client.setQueryData(queryKeys.runDetail(detail.run.id), detail);
  client.setQueryData(queryKeys.tasks.detail(detail.run.taskId), taskFixture);
  return detail;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("AgentRunsPanel AI Elements run detail", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    sidebarState.isMobile = false;
    stickState.isAtBottom = true;
    runGet.mockReset();
    taskGet.mockReset();
    taskGet.mockResolvedValue(taskFixture);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    window.scrollTo = vi.fn();
    if (!globalThis.ResizeObserver) {
      globalThis.ResizeObserver = class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  async function renderWithClient(node: ReactNode, client = createClient()) {
    await act(async () => {
      root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
    });
    await flush();
    return client;
  }

  it("renders a loader-cached deep-linked run that is absent from the recent run list", async () => {
    const detail = createJoinedRunDetail();
    const client = createClient();
    seedDetail(client, detail);
    const newerRun = createRunEnvelope({
      id: "55555555-5555-4555-8555-555555555556",
      createdAt: "2026-08-14T18:00:00.000Z",
      updatedAt: "2026-08-14T18:00:00.000Z",
    });

    await renderWithClient(
      <AgentRunsPanel
        runs={[newerRun]}
        agentRouteId={RUN_DETAIL_AGENT_ID}
        selectedRunId={RUN_DETAIL_RUN_ID}
        agent={runDetailAgent}
      />,
      client,
    );

    expect(container.querySelector('input[aria-label="Run identifier"]')?.getAttribute("value")).toBe(
      RUN_DETAIL_RUN_ID,
    );
    expect(container.querySelector('[role="log"][aria-label="Run session transcript"]')).not.toBeNull();
    expect(container.textContent).toContain("PAP-412 execution");
    expect(
      container.querySelector(
        `a[href="/${RUN_DETAIL_COMPANY_ID}/agents/${RUN_DETAIL_AGENT_ID}/runs/${RUN_DETAIL_RUN_ID}"][aria-current="page"]`,
      ),
    ).not.toBeNull();
    expect(runGet).not.toHaveBeenCalled();
  });

  it("loads later messages and marks only the final incomplete part of the last complete page live", async () => {
    const earlier = createCanonicalSessionRecord({
      seq: 1,
      wire: {
        id: "msg_run_earlier_incomplete",
        type: "assistant",
        agent: "earlier-agent",
        content: [
          {
            type: "reasoning",
            id: "reasoning-run-earlier",
            text: "Earlier incomplete thought",
            time: { created: Date.parse("2026-08-14T17:00:01.000Z") },
          },
        ],
        time: { created: Date.parse("2026-08-14T17:00:01.000Z") },
      },
    });
    const latest = createCanonicalSessionRecord({
      seq: 2,
      wire: {
        id: "msg_run_latest_incomplete",
        type: "assistant",
        agent: "current-agent",
        content: [
          {
            type: "reasoning",
            id: "reasoning-run-current-earlier",
            text: "Current record non-final thought",
            time: { created: Date.parse("2026-08-14T17:00:02.000Z") },
          },
          {
            type: "reasoning",
            id: "reasoning-run-current-final",
            text: "Current record final thought",
            time: { created: Date.parse("2026-08-14T17:00:03.000Z") },
          },
        ],
        time: { created: Date.parse("2026-08-14T17:00:02.000Z") },
      },
    });
    const running = createRunEnvelope({
      status: "running",
      finishedAt: null,
      terminalClassification: null,
      terminalFinalizationId: null,
    });
    const loadMore = vi.fn();
    stickState.isAtBottom = false;

    await act(async () => {
      root.render(
        <AgentRunTranscript
          run={running}
          records={[latest, earlier]}
          truncated
          hasMore
          isLoadingMore={false}
          loadMoreError={new Error("Cursor page unavailable")}
          onLoadMore={loadMore}
        />,
      );
    });
    await flush();

    expect(container.textContent).not.toContain("Live");
    expect(container.querySelector('[data-streaming="true"]')).toBeNull();
    expect(container.textContent).toContain(
      "Later stored messages are omitted from this bounded transcript.",
    );
    expect(container.textContent).toContain("Cursor page unavailable");
    expect(
      container.querySelector('button[aria-label="Jump to latest loaded session message"]'),
    ).not.toBeNull();
    const retry = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Retry loading later messages",
    );
    expect(retry).toBeTruthy();
    await act(async () => retry?.click());
    expect(loadMore).toHaveBeenCalledOnce();

    await act(async () => {
      root.render(
        <AgentRunTranscript
          run={running}
          records={[latest, earlier]}
          truncated={false}
          hasMore={false}
          isLoadingMore={false}
          loadMoreError={null}
        />,
      );
    });
    await flush();

    expect(container.textContent).toContain("Live");
    const streamingParts = container.querySelectorAll('[data-streaming="true"]');
    expect(streamingParts).toHaveLength(1);
    expect(streamingParts[0]?.textContent).toContain("Current record final thought");
    expect(streamingParts[0]?.textContent).not.toContain("Current record non-final thought");
    expect(streamingParts[0]?.textContent).not.toContain("Earlier incomplete thought");
  });

  it("renders Queue attempts and retries plus Artifact and FileTree workspace outputs", async () => {
    const client = createClient();
    const detail = seedDetail(client);
    await renderWithClient(
      <AgentRunDetail
        runId={detail.run.id}
        initialRun={detail.run}
        agent={runDetailAgent}
        companyId={RUN_DETAIL_COMPANY_ID}
      />,
      client,
    );

    expect(container.textContent).toContain("2 attempts");
    expect(container.textContent).toContain("1 retry");
    expect(container.textContent).toContain("generation 1");
    expect(container.textContent).toContain("transient provider error");
    expect(container.textContent).toContain("lease 2 released");
    expect(container.textContent).toContain("cancellation completed");
    expect(container.textContent).toContain("Loaded output references");
    const tree = container.querySelector('[role="group"][aria-label="Reported workspace output paths"]');
    expect(tree).not.toBeNull();
    expect(tree?.textContent).toContain("run-detail-summary.md");
    expect(tree?.textContent).toContain("run-detail.tsx");
    expect(tree?.textContent).not.toContain("verification.json");
    expect(container.textContent).toContain("verification.json");
  });

  it("discloses bounded transcript and lifecycle collections as partial", async () => {
    const baseline = createJoinedRunDetail();
    const detail = createJoinedRunDetail({
      sessionMessages: bounded(baseline.sessionMessages.items, true),
      attempts: bounded(baseline.attempts.items, true),
    });
    const client = createClient();
    seedDetail(client, detail);

    await renderWithClient(
      <AgentRunDetail
        runId={detail.run.id}
        initialRun={detail.run}
        agent={runDetailAgent}
        companyId={RUN_DETAIL_COMPANY_ID}
      />,
      client,
    );

    expect(container.textContent).toContain("Bounded view");
    expect(container.textContent).toContain("Later stored messages are omitted from this bounded transcript");
    expect(container.textContent).toContain("Some execution collections are bounded");
    expect(container.textContent).toContain("records shown here may be partial");
  });

  it("shows the AI loading state while joined detail is pending", async () => {
    runGet.mockReturnValue(new Promise(() => {}));
    const run = createRunEnvelope();
    await renderWithClient(
      <AgentRunDetail
        runId={run.id}
        initialRun={run}
        agent={runDetailAgent}
        companyId={RUN_DETAIL_COMPANY_ID}
      />,
    );

    const status = container.querySelector('[role="status"][aria-label="Loading run detail"]');
    expect(status).not.toBeNull();
    expect(status?.textContent).toContain("Loading execution transcript and protocol records");
    expect(status?.textContent).toContain(RUN_DETAIL_RUN_ID);
    expect(runGet).toHaveBeenCalledWith(RUN_DETAIL_RUN_ID);
  });

  it("keeps an accessible retryable error when joined detail fails", async () => {
    runGet.mockRejectedValue(new Error("Joined run detail is temporarily unavailable"));
    const run = createRunEnvelope();
    await renderWithClient(
      <AgentRunDetail
        runId={run.id}
        initialRun={run}
        agent={runDetailAgent}
        companyId={RUN_DETAIL_COMPANY_ID}
      />,
    );
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Could not load this run");
    });

    expect(container.textContent).toContain("Joined run detail is temporarily unavailable");
    expect(
      Array.from(container.querySelectorAll("button")).some((button) => button.textContent === "Retry"),
    ).toBe(true);
  });

  it("switches between the mobile run list and the selected detail route", async () => {
    sidebarState.isMobile = true;
    const detail = createJoinedRunDetail();
    const olderRun = createRunEnvelope({
      id: "55555555-5555-4555-8555-555555555557",
      createdAt: "2026-08-14T16:00:00.000Z",
      updatedAt: "2026-08-14T16:00:00.000Z",
    });
    const client = createClient();
    seedDetail(client, detail);

    await renderWithClient(
      <AgentRunsPanel
        runs={[detail.run, olderRun]}
        agentRouteId={RUN_DETAIL_AGENT_ID}
        selectedRunId={null}
        agent={runDetailAgent}
      />,
      client,
    );

    expect(container.querySelector('nav[aria-label="Agent run history"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Back to runs");
    const runLink = container.querySelector(
      `a[href="/${RUN_DETAIL_COMPANY_ID}/agents/${RUN_DETAIL_AGENT_ID}/runs/${RUN_DETAIL_RUN_ID}"]`,
    );
    expect(runLink).not.toBeNull();

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <AgentRunsPanel
            runs={[detail.run, olderRun]}
            agentRouteId={RUN_DETAIL_AGENT_ID}
            selectedRunId={RUN_DETAIL_RUN_ID}
            agent={runDetailAgent}
          />
        </QueryClientProvider>,
      );
    });
    await flush();

    expect(container.textContent).not.toContain("Back to runs");
    expect(container.querySelector('nav[aria-label="Agent run history"]')).toBeNull();
    expect(container.querySelector('[role="log"][aria-label="Run session transcript"]')).not.toBeNull();
  });
});
