// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkTimelineResult } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { filterTimelineData, Route, timelineSummary } from ".";
import { getRouteComponent } from "@/test/route-component";

const Timeline = getRouteComponent(Route);

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockSetRouteRequestsCollapsed = vi.hoisted(() => vi.fn());
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

vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({
    setRouteRequestsCollapsed: mockSetRouteRequestsCollapsed,
  }),
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

  async function renderTimeline() {
    root = createRoot(container);
    flushSync(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <Timeline />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("requests the collapsed app sidebar by default", async () => {
    await renderTimeline();

    expect(mockSetRouteRequestsCollapsed).toHaveBeenCalledWith(true);
  });

  it("keeps range and filter controls available when the selected window is empty", async () => {
    await renderTimeline();

    expect(container.textContent).toContain("Window");
    expect(container.querySelector('[aria-label="Search timeline runs"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Filter timeline by run status"]')).not.toBeNull();
    expect(container.textContent).toContain("No work recorded in this window");
  });

  it("does not treat task history outside the returned window as visible activity", async () => {
    mockWorkTimelineApi.get.mockResolvedValue({
      ...emptyTimeline,
      actors: [{ id: "user:board", type: "user", name: "Board Operator", avatar: null }],
      events: [
        {
          actorId: "user:board",
          kind: "created",
          taskId: TASK_ONE_ID,
          at: "2026-06-01T00:00:00.000Z",
        },
      ],
    });
    await renderTimeline();

    expect(container.textContent).toContain("No work recorded in this window");
    expect(container.querySelector(".gantt")).toBeNull();
  });

  it("renders operator summary, integrated viewport controls, and the Kibo chart", async () => {
    mockWorkTimelineApi.get.mockResolvedValue(populatedTimeline);
    await renderTimeline();

    expect(container.textContent).toContain("Runs");
    expect(container.textContent).toContain("Agents");
    expect(container.textContent).toContain("Run time");
    expect(container.textContent).toContain("Activity");
    expect(container.textContent).toContain("45m");
    expect(container.querySelector(".gantt")).not.toBeNull();
    expect(container.querySelector('[data-roadmap-ui="gantt-sidebar"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Timeline scale"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Timeline navigation"]')).not.toBeNull();
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
    await renderTimeline();

    expect(container.textContent).toContain("Run time");
    expect(container.textContent).toContain("2h");
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
      activity: 0,
      relationships: 0,
      attention: 0,
    });
  });

  it("filters runs, actors, activity, and relationships as one coherent chart projection", () => {
    const data: WorkTimelineResult = {
      ...populatedTimeline,
      spans: [populatedTimeline.spans[0], { ...populatedTimeline.spans[1], status: "failed" }],
      events: [
        {
          actorId: "user:board",
          kind: "commented",
          taskId: TASK_ONE_ID,
          at: "2026-07-02T10:05:00.000Z",
        },
        {
          actorId: "user:board",
          kind: "approved",
          taskId: TASK_TWO_ID,
          at: "2026-07-02T11:05:00.000Z",
        },
      ],
      edges: [
        {
          fromActorId: "user:board",
          toActorId: "agent:qa",
          taskId: TASK_TWO_ID,
          at: "2026-07-02T11:00:00.000Z",
          kind: "assignment",
        },
      ],
    };

    const filtered = filterTimelineData(data, "QA", "attention");
    expect(filtered.spans.map((span) => span.runId)).toEqual([RUN_TWO_ID]);
    expect(filtered.events).toHaveLength(1);
    expect(filtered.edges).toHaveLength(1);
    expect(filtered.actors.map((actor) => actor.id)).toEqual(
      expect.arrayContaining(["agent:qa", "user:board"]),
    );
  });

  it("finds event-only work by actor name", () => {
    const eventOnlyTaskId = "66666666-6666-4666-8666-666666666666";
    const filtered = filterTimelineData(
      {
        ...emptyTimeline,
        actors: [{ id: "user:operator", type: "user", name: "Timeline Operator", avatar: null }],
        events: [
          {
            actorId: "user:operator",
            kind: "commented",
            taskId: eventOnlyTaskId,
            at: "2026-07-03T10:00:00.000Z",
          },
        ],
      },
      "Timeline Operator",
      "all",
    );

    expect(filtered.spans).toHaveLength(0);
    expect(filtered.events.map((event) => event.taskId)).toEqual([eventOnlyTaskId]);
    expect(filtered.actors.map((actor) => actor.id)).toEqual(["user:operator"]);
  });

  it("opens exact run details from a selectable Gantt bar", async () => {
    mockWorkTimelineApi.get.mockResolvedValue(populatedTimeline);
    await renderTimeline();

    const runButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label*="PAP-1 · Implement timeline stats, Succeeded"]',
    );
    expect(runButton).not.toBeNull();
    flushSync(() => runButton?.click());

    expect(container.textContent).toContain("Open task");
    expect(container.textContent).toContain(RUN_ONE_ID);
    expect(container.querySelector('[aria-label="Close run details"]')).not.toBeNull();
  });

  it("lets operators page through partial task results", async () => {
    mockWorkTimelineApi.get.mockResolvedValue({
      ...populatedTimeline,
      pagination: {
        limit: 200,
        offset: 0,
        totalTasks: 201,
        hasMore: true,
      },
    });
    await renderTimeline();

    const pageControls = container.querySelector('[aria-label="Timeline task pages"]');
    const nextPage = Array.from(pageControls?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
      (button) => button.textContent === "Next",
    );
    flushSync(() => nextPage?.click());
    await flushReact();

    expect(mockWorkTimelineApi.get).toHaveBeenLastCalledWith(
      COMPANY_ID,
      expect.objectContaining({ offset: 200 }),
    );
  });

  it("requests the company timeline without a user lens parameter", async () => {
    await renderTimeline();

    expect(mockWorkTimelineApi.get).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({
        from: expect.any(String),
        to: expect.any(String),
      }),
    );
    expect(mockWorkTimelineApi.get.mock.calls[0]?.[1]).not.toHaveProperty("userId");
  });
});
