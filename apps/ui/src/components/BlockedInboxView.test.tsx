// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Task, TaskBlockedInboxAttention } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestTask } from "../test-utils/task";

const mockTasksApi = vi.hoisted(() => ({
  list: vi.fn(),
  count: vi.fn(),
}));
const COMPANY_ID = vi.hoisted(() => "11111111-1111-4111-8111-111111111111");

vi.mock("../api/tasks", () => ({
  tasksApi: mockTasksApi,
}));

vi.mock("@/hooks/useCompanyRouteId", () => ({
  useCompanyRouteId: () => COMPANY_ID,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    className,
    disableTaskQuicklook: _disableTaskQuicklook,
    taskPrefetch: _taskPrefetch,
    ...props
  }: React.ComponentProps<"a"> & {
    disableTaskQuicklook?: boolean;
    taskPrefetch?: Task | null;
  }) => (
    <a className={className} {...props}>
      {children}
    </a>
  ),
}));

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> | undefined;
  flushSync(() => {
    result = callback();
  });
  return result;
}

import { BlockedInboxView } from "./BlockedInboxView";
import { defaultTaskFilterState } from "../lib/task-filters";

function attention(
  overrides: Partial<TaskBlockedInboxAttention> = {},
): TaskBlockedInboxAttention {
  return {
    kind: "blocked",
    state: "needs_attention",
    reason: "blocked_chain_stalled",
    severity: "medium",
    stoppedSinceAt: "2026-05-08T10:00:00.000Z",
    owner: { type: "agent", agentId: "agent-1", userId: null, label: null },
    action: { label: "Resolve PAP-77", detail: null },
    sourceTask: null,
    leafTask: null,
    approvalId: null,
    sampleTaskIdentifier: null,
    redaction: { externalDetailsRedacted: false, secretFieldsOmitted: true },
    ...overrides,
  };
}

function makeTask(
  id: string,
  identifier: string,
  title: string,
  attentionPayload: TaskBlockedInboxAttention,
): Task {
  return createTestTask({
    id,
    title,
    boardPresentationStatus: "in_progress",
    ownerAgentId: "agent-1",
    identifier,
    blockedInboxAttention: attentionPayload,
    createdAt: new Date("2026-05-09T00:00:00.000Z"),
    updatedAt: new Date("2026-05-09T00:00:00.000Z"),
  });
}

function renderWithClient(node: React.ReactNode, container: HTMLDivElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>,
    );
  });
  return { root, queryClient };
}

const blockedViewProps = {
  companyId: COMPANY_ID,
  searchQuery: "",
  agentNameById: new Map<string, string>(),
  taskLinkState: null,
  groupBy: "none" as const,
  sortBy: "most_recent" as const,
  taskFilters: defaultTaskFilterState,
  liveTaskIds: new Set<string>(),
  subtreeLiveCounts: new Map<string, number>(),
  workspaceFilterContext: {},
  showStatusColumn: true,
  showIdentifierColumn: true,
  showUpdatedColumn: true,
};

async function waitFor(predicate: () => boolean, attempts = 30): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  throw new Error("waitFor predicate did not become true");
}

describe("BlockedInboxView", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockTasksApi.list.mockReset();
  });

  afterEach(() => {
    container.remove();
  });

  it("shows the empty state when no blocked tasks are returned", async () => {
    mockTasksApi.list.mockResolvedValue([]);
    const { root } = renderWithClient(
      <BlockedInboxView {...blockedViewProps} />,
      container,
    );
    await waitFor(
      () =>
        container.querySelector('[data-testid="blocked-inbox-empty"]') !== null,
    );
    expect(
      container.querySelector('[data-testid="blocked-inbox-empty"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("No work is stopped.");
    expect(container.textContent).toContain(
      "Tasks that need a decision, recovery, or external action will appear here.",
    );
    act(() => root.unmount());
  });

  it("defaults to no grouping and orders rows by most recent stopped item first", async () => {
    const tasks: Task[] = [
      makeTask(
        "task-low",
        "PAP-1",
        "External wait row",
        attention({ reason: "external_owner_action", severity: "low" }),
      ),
      makeTask(
        "task-stalled-high",
        "PAP-2",
        "Stalled chain row",
        attention({
          reason: "blocked_chain_stalled",
          severity: "high",
          stoppedSinceAt: "2026-05-09T01:00:00.000Z",
          action: { label: "Resolve PAP-9", detail: null },
        }),
      ),
      makeTask(
        "task-stalled-critical",
        "PAP-3",
        "Critical stalled row",
        attention({
          reason: "blocked_chain_stalled",
          severity: "critical",
          stoppedSinceAt: "2026-05-09T05:00:00.000Z",
          action: { label: "Resolve PAP-10", detail: null },
        }),
      ),
      makeTask(
        "task-decision",
        "PAP-4",
        "Pending board decision",
        attention({
          reason: "pending_board_decision",
          severity: "medium",
          owner: { type: "board", agentId: null, userId: null, label: "Board" },
          action: { label: "Accept or reject", detail: null },
        }),
      ),
    ];
    mockTasksApi.list.mockResolvedValue(tasks);

    const { root } = renderWithClient(
      <BlockedInboxView
        {...blockedViewProps}
        agentNameById={new Map([["agent-1", "ClaudeCoder"]])}
      />,
      container,
    );
    await waitFor(
      () => container.querySelectorAll("a[data-inbox-task-link]").length === 4,
    );

    expect(
      container.querySelectorAll('[data-testid^="blocked-inbox-group-"]'),
    ).toHaveLength(0);

    const titles = Array.from(
      container.querySelectorAll<HTMLAnchorElement>("a[data-inbox-task-link]"),
    ).map((link) => link.parentElement?.textContent ?? "");
    expect(titles[0]).toContain("Critical stalled row");
    expect(titles[1]).toContain("Stalled chain row");

    expect(mockTasksApi.list).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({
        attention: "blocked",
        includeBlockedInboxAttention: true,
        includeBlockedBy: true,
      }),
    );

    act(() => root.unmount());
  });

  it("places blocker reason chips with the title before owner and timestamp metadata", async () => {
    mockTasksApi.list.mockResolvedValue([
      makeTask(
        "task-decision",
        "PAP-4",
        "Pending board decision",
        attention({
          reason: "pending_board_decision",
          severity: "medium",
          owner: { type: "board", agentId: null, userId: null, label: "Board" },
          action: { label: "Accept or reject", detail: null },
        }),
      ),
    ]);

    const { root } = renderWithClient(
      <BlockedInboxView {...blockedViewProps} />,
      container,
    );
    await waitFor(
      () => container.querySelector("a[data-inbox-task-link]") !== null,
    );

    const rowText =
      container.querySelector("a[data-inbox-task-link]")?.parentElement
        ?.textContent ?? "";
    expect(rowText.indexOf("Pending board decision")).toBeGreaterThanOrEqual(0);
    expect(rowText.indexOf("Needs decision")).toBeGreaterThan(
      rowText.indexOf("Pending board decision"),
    );
    expect(rowText.indexOf("Board")).toBeGreaterThan(
      rowText.indexOf("Needs decision"),
    );
    expect(rowText).not.toContain("Accept or reject");
    expect(
      container.querySelector('[data-testid="blocked-row-reason-column"]')
        ?.textContent,
    ).toContain("Needs decision");

    act(() => root.unmount());
  });

  it("filters rows by search query against title, identifier, owner and action", async () => {
    const tasks: Task[] = [
      makeTask(
        "task-1",
        "PAP-77",
        "Resume parked work",
        attention({
          reason: "blocked_chain_stalled",
          owner: {
            type: "agent",
            agentId: null,
            userId: null,
            label: "Charlie",
          },
          action: { label: "Resume parked blocker", detail: null },
        }),
      ),
      makeTask(
        "task-2",
        "PAP-99",
        "Other unrelated thing",
        attention({
          reason: "external_owner_action",
          owner: {
            type: "external",
            agentId: null,
            userId: null,
            label: "Vendor",
          },
          action: { label: "Awaiting Vendor", detail: null },
        }),
      ),
    ];
    mockTasksApi.list.mockResolvedValue(tasks);

    const { root } = renderWithClient(
      <BlockedInboxView {...blockedViewProps} searchQuery="charlie" />,
      container,
    );
    await waitFor(
      () => container.querySelectorAll("a[data-inbox-task-link]").length > 0,
    );

    const links = container.querySelectorAll<HTMLAnchorElement>(
      "a[data-inbox-task-link]",
    );
    const titles = Array.from(links).map(
      (link) => link.parentElement?.textContent ?? "",
    );
    expect(titles.some((t) => t.includes("Resume parked work"))).toBe(true);
    expect(titles.some((t) => t.includes("Other unrelated thing"))).toBe(false);

    act(() => root.unmount());
  });

  it("uses loaded live descendants when blocked inbox rows do not have a server summary", async () => {
    mockTasksApi.list.mockResolvedValue([
      {
        ...makeTask(
          "blocked-parent",
          "PAP-77",
          "Blocked parent with active child",
          attention({ reason: "blocked_chain_stalled" }),
        ),
        boardPresentationStatus: "blocked",
        blockerAttention: null,
        liveDescendantCount: undefined,
      } as unknown as Task,
    ]);

    const { root } = renderWithClient(
      <BlockedInboxView
        {...blockedViewProps}
        subtreeLiveCounts={new Map([["blocked-parent", 1]])}
      />,
      container,
    );
    await waitFor(
      () => container.querySelector("a[data-inbox-task-link]") !== null,
    );

    expect(
      container.querySelector(
        '[aria-label="Blocked · waiting on 1 active sub-task"]',
      ),
    ).not.toBeNull();

    act(() => root.unmount());
  });

  it("renders the visible error banner with retry when the query fails", async () => {
    mockTasksApi.list.mockRejectedValue(new Error("network down"));

    const { root } = renderWithClient(
      <BlockedInboxView {...blockedViewProps} />,
      container,
    );
    await waitFor(
      () =>
        container.querySelector('[data-testid="blocked-inbox-error"]') !== null,
    );

    const banner = container.querySelector(
      '[data-testid="blocked-inbox-error"]',
    );
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute("role")).toBe("alert");
    expect(banner?.textContent).toContain("Couldn't load the Blocked tab");

    act(() => root.unmount());
  });
});
