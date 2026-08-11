// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkTimelineResult } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Timeline, timelineSummary } from "./Timeline";

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockWorkTimelineApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

vi.mock("@/api/workTimeline", () => ({
  workTimelineApi: mockWorkTimelineApi,
}));

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/PAP/timeline" }),
}));

vi.mock("@/components/RequestCollapsedSidebar", () => ({
  RequestCollapsedSidebar: () => <div data-testid="request-collapsed-sidebar" />,
}));

const emptyTimeline: WorkTimelineResult = {
  actors: [],
  spans: [],
  events: [],
  edges: [],
  pagination: {
    limit: 100,
    offset: 0,
    totalTasks: 0,
    hasMore: false,
  },
  window: {
    from: "2026-07-01T00:00:00.000Z",
    to: "2026-07-07T23:59:59.999Z",
    capped: false,
  },
};

const populatedTimeline: WorkTimelineResult = {
  actors: [
    { id: "agent:codex", type: "agent", name: "CodexCoder", avatar: "code" },
    { id: "agent:qa", type: "agent", name: "QA", avatar: "shield" },
    { id: "user:board", type: "user", name: "Board Operator", avatar: "/avatar.png" },
  ],
  spans: [
    {
      actorId: "agent:codex",
      runId: "run-1",
      kind: "productive",
      taskId: "task-1",
      taskIdentifier: "PAP-1",
      taskTitle: "Implement timeline stats",
      start: "2026-07-02T10:00:00.000Z",
      end: "2026-07-02T10:30:00.000Z",
      status: "succeeded",
      retryOfRunId: null,
    },
    {
      actorId: "agent:qa",
      runId: "run-2",
      kind: "productive",
      taskId: "task-2",
      taskIdentifier: "PAP-2",
      taskTitle: "Verify timeline stats",
      start: "2026-07-02T11:00:00.000Z",
      end: "2026-07-02T11:15:00.000Z",
      status: "succeeded",
      retryOfRunId: null,
    },
  ],
  events: [],
  edges: [],
  pagination: {
    limit: 100,
    offset: 0,
    totalTasks: 2,
    hasMore: false,
  },
  window: {
    from: "2026-07-02T00:00:00.000Z",
    to: "2026-07-02T23:59:59.999Z",
    capped: false,
  },
};

async function flushReact() {
  for (let index = 0; index < 3; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("Timeline", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockWorkTimelineApi.get.mockResolvedValue(emptyTimeline);
  });

  afterEach(() => {
    if (root) {
      flushSync(() => root?.unmount());
    }
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("requests the collapsed app sidebar by default", async () => {
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <Timeline />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.querySelector('[data-testid="request-collapsed-sidebar"]')).not.toBeNull();
  });

  it("renders range controls plus icon zoom controls without the user lens selector or visible-duration readout", async () => {
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <Timeline />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("Range");
    expect(container.querySelector('[aria-label="Zoom out"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Zoom in"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Reset zoom"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Everyone");
    expect(container.textContent).not.toContain("work kicked off");
    expect(container.textContent).not.toContain("visible");
  });

  it("renders top timeline stats and keeps range controls in the chart footer", async () => {
    mockWorkTimelineApi.get.mockResolvedValue(populatedTimeline);
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <Timeline />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("Runs");
    expect(container.textContent).toContain("Agents");
    expect(container.textContent).toContain("Run time");
    expect(container.textContent).toContain("45m");

    const footer = Array.from(container.querySelectorAll("div")).find((element) =>
      element.textContent?.includes("2 runs") && element.textContent.includes("Range"),
    );
    expect(footer).not.toBeUndefined();
  });

  it("clamps open run summary time to the returned timeline window", async () => {
    mockWorkTimelineApi.get.mockResolvedValue({
      ...populatedTimeline,
      spans: [
        {
          ...populatedTimeline.spans[0],
          start: "2026-07-02T00:00:00.000Z",
          end: null,
        },
      ],
      window: {
        from: "2026-07-02T00:00:00.000Z",
        to: "2026-07-02T02:00:00.000Z",
        capped: false,
      },
    });
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <Timeline />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("Run time");
    expect(container.textContent).toContain("2h 0m");
  });

  it("summarizes only runs that overlap the visible timeline window", () => {
    const summary = timelineSummary(populatedTimeline, {
      fromMs: new Date("2026-07-02T10:15:00.000Z").getTime(),
      toMs: new Date("2026-07-02T11:05:00.000Z").getTime(),
    });

    expect(summary).toEqual({
      runs: 2,
      agents: 2,
      activeMs: 20 * 60 * 1000,
    });
  });

  it("requests the company timeline without a user lens parameter", async () => {
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <Timeline />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(mockWorkTimelineApi.get).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        from: expect.any(String),
        to: expect.any(String),
      }),
    );
    expect(mockWorkTimelineApi.get.mock.calls[0]?.[1]).not.toHaveProperty("userId");
  });
});
