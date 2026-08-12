// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkTimelineResult } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Timeline, timelineSummary } from ".";

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockWorkTimelineApi = vi.hoisted(() => ({
  get: vi.fn(),
}));
const COMPANY_ID = vi.hoisted(() => "11111111-1111-4111-8111-111111111111");
const TASK_ONE_ID = "22222222-2222-4222-8222-222222222222";
const TASK_TWO_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ONE_ID = "44444444-4444-4444-8444-444444444444";
const RUN_TWO_ID = "55555555-5555-4555-8555-555555555555";

vi.mock("@/hooks/useCompanyRouteId", () => ({
  useCompanyRouteId: () => COMPANY_ID,
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

vi.mock("@/api/workTimeline", () => ({
  workTimelineApi: mockWorkTimelineApi,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useLocation: () => ({ pathname: `/${COMPANY_ID}/timeline` }),
  Link: ({
    children,
    to,
    params,
    ...props
  }: {
    children: ReactNode;
    to: string;
    params?: Record<string, string>;
  }) => {
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

vi.mock("@/components/RequestCollapsedSidebar", () => ({
  RequestCollapsedSidebar: () => (
    <div data-testid="request-collapsed-sidebar" />
  ),
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
    {
      id: "user:board",
      type: "user",
      name: "Board Operator",
      avatar: "/avatar.png",
    },
  ],
  spans: [
    {
      actorId: "agent:codex",
      runId: RUN_ONE_ID,
      kind: "productive",
      taskId: TASK_ONE_ID,
      taskNumber: 1,
      taskIdentifier: "PAP-1",
      taskTitle: "Implement timeline stats",
      start: "2026-07-02T10:00:00.000Z",
      end: "2026-07-02T10:30:00.000Z",
      status: "succeeded",
      retryOfRunId: null,
    },
    {
      actorId: "agent:qa",
      runId: RUN_TWO_ID,
      kind: "productive",
      taskId: TASK_TWO_ID,
      taskNumber: 2,
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

    expect(
      container.querySelector('[data-testid="request-collapsed-sidebar"]'),
    ).not.toBeNull();
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

    const footer = Array.from(container.querySelectorAll("div")).find(
      (element) =>
        element.textContent?.includes("2 runs") &&
        element.textContent.includes("Range"),
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
      COMPANY_ID,
      expect.objectContaining({
        from: expect.any(String),
        to: expect.any(String),
      }),
    );
    expect(mockWorkTimelineApi.get.mock.calls[0]?.[1]).not.toHaveProperty(
      "userId",
    );
  });
});
