// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueExecutionRunEnvelopeRecord } from "@paperclipai/shared";
import { ActiveAgentsPanel } from "./ActiveAgentsPanel";

const mockRunsApi = vi.hoisted(() => ({ listForCompany: vi.fn() }));
const mockIssuesApi = vi.hoisted(() => ({ get: vi.fn() }));
const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));
vi.mock("../api/runs", async () => {
  const actual = await vi.importActual<typeof import("../api/runs")>("../api/runs");
  return { ...actual, runsApi: mockRunsApi };
});
vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("./Identity", () => ({
  Identity: ({ name }: { name: string }) => <span>{name}</span>,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function run(index: number): IssueExecutionRunEnvelopeRecord {
  return {
    id: `run-${index}`,
    companyId: "company-1",
    issueId: `issue-${index}`,
    sessionId: `session-${index}`,
    executionScopeId: `scope-${index}`,
    kind: "productive",
    status: "running",
    ownershipEpoch: 1,
    targetAgentId: `agent-${index}`,
    adapterConfigRevisionId: `revision-${index}`,
    executionWorkspaceBindingId: `binding-${index}`,
    executionMode: "owner",
    issueExecutionAuthorityId: null,
    consultExecutionId: null,
    compactionScopeKind: null,
    parentRunId: null,
    retryOfRunId: null,
    triggeredByRunId: null,
    currentAttemptId: null,
    currentLeaseId: null,
    cancellationIntentId: null,
    terminalFinalizationId: null,
    startedAt: "2026-07-31T12:00:00.000Z",
    finishedAt: null,
    terminalClassification: null,
    terminalReasonCode: null,
    processExitCode: null,
    processSignal: null,
    createdAt: `2026-07-31T12:00:0${index}.000Z`,
    updatedAt: `2026-07-31T12:00:0${index}.000Z`,
  };
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("ActiveAgentsPanel", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockRunsApi.listForCompany.mockResolvedValue({
      items: [1, 2, 3, 4, 5].map(run),
      nextCursor: null,
    });
    mockIssuesApi.get.mockImplementation(async (issueId: string) => ({
      id: issueId,
      identifier: issueId.toUpperCase(),
      title: `Task ${issueId}`,
    }));
    mockAgentsApi.list.mockResolvedValue([]);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders canonical active run envelopes and links overflow to the live page", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ActiveAgentsPanel companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(mockRunsApi.listForCompany).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ limit: 4 }),
    );
    const overflow = [...container.querySelectorAll("a")].find((anchor) =>
      anchor.textContent?.includes("more active run"),
    );
    expect(overflow?.getAttribute("href")).toBe("/dashboard/live");

    await act(async () => root.unmount());
  });
});
