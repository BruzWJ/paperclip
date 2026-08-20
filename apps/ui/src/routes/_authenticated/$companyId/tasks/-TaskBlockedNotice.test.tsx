// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TaskBlockedNotice } from "./-TaskBlockedNotice";

vi.mock("@/hooks/useCompanyRouteId", () => ({
  useCompanyRouteId: () => "11111111-1111-4111-8111-111111111111",
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: ComponentProps<"a"> & { to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act<T>(callback: () => T): T {
  let result: T | undefined;
  flushSync(() => {
    result = callback();
  });
  const maybePromise = result as unknown as PromiseLike<unknown>;
  if (result && typeof maybePromise.then === "function") {
    throw new TypeError("This test act shim only supports synchronous callbacks.");
  }
  return result as T;
}

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;
let dateNowSpy: ReturnType<typeof vi.spyOn> | null = null;

const SYSTEM_NOW = new Date("2026-04-18T20:00:00.000Z").getTime();

beforeEach(() => {
  dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(SYSTEM_NOW);
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  root = null;
  container?.remove();
  container = null;
  dateNowSpy?.mockRestore();
  dateNowSpy = null;
});

function withProviders(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

function render(element: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(withProviders(element)));
  return container;
}

describe("TaskBlockedNotice", () => {
  it("does not render when the task is cancelled even if blockers remain", () => {
    const node = render(
      <TaskBlockedNotice
        taskStatus="cancelled"
        blockers={[
          {
            id: "blocker-1",
            taskNumber: 123,
            identifier: "PAP-123",
            title: "Blocker",
            boardPresentationStatus: "in_progress",
            priority: "medium",
            ownerAgentId: null,
            ownerUserId: null,
          },
        ]}
      />,
    );

    expect(node.textContent).toBe("");
  });

  it("keeps the amber notice when a covered chain has no confirmed live blocker", () => {
    const node = render(
      <TaskBlockedNotice
        taskStatus="blocked"
        liveTaskIds={new Set(["unrelated-live"])}
        blockerAttention={{
          state: "covered",
          reason: "active_dependency",
          unresolvedBlockerCount: 1,
          coveredBlockerCount: 1,
          stalledBlockerCount: 0,
          attentionBlockerCount: 0,
          sampleBlockerIdentifier: "TASK-1",
          sampleStalledBlockerIdentifier: null,
        }}
        blockers={[
          {
            id: "blocker-1",
            taskNumber: 1,
            identifier: "TASK-1",
            title: "Dependency work",
            boardPresentationStatus: "in_progress",
            priority: "medium",
            ownerAgentId: "agent-1",
            ownerUserId: null,
          },
        ]}
        allBlockers={[
          {
            id: "blocker-1",
            taskNumber: 1,
            identifier: "TASK-1",
            title: "Dependency work",
            boardPresentationStatus: "in_progress",
            priority: "medium",
            ownerAgentId: "agent-1",
            ownerUserId: null,
          },
        ]}
      />,
    );

    expect(node.querySelector('[data-testid="task-blocked-notice-live"]')).toBeNull();
    expect(node.textContent).toContain("Use Update status to change it when ready");
    expect(node.textContent).toContain("select Notify owner on a comment");
    expect(node.querySelector('[data-blocker-attention-state="covered"]')).not.toBeNull();
  });

  it("sorts same-status live-work steps with numeric identifier ordering", () => {
    const node = render(
      <TaskBlockedNotice
        taskStatus="blocked"
        liveTaskIds={new Set(["blocker-11"])}
        blockerAttention={{
          state: "covered",
          reason: "active_dependency",
          unresolvedBlockerCount: 1,
          coveredBlockerCount: 3,
          stalledBlockerCount: 0,
          attentionBlockerCount: 0,
          sampleBlockerIdentifier: "TASK-11",
          sampleStalledBlockerIdentifier: null,
        }}
        blockers={[
          {
            id: "blocker-11",
            taskNumber: 11,
            identifier: "TASK-11",
            title: "Running work",
            boardPresentationStatus: "in_progress",
            priority: "medium",
            ownerAgentId: "agent-1",
            ownerUserId: null,
          },
        ]}
        allBlockers={[
          {
            id: "blocker-10",
            taskNumber: 10,
            identifier: "TASK-10",
            title: "Tenth done step",
            boardPresentationStatus: "done",
            priority: "medium",
            ownerAgentId: "agent-1",
            ownerUserId: null,
          },
          {
            id: "blocker-9",
            taskNumber: 9,
            identifier: "TASK-9",
            title: "Ninth done step",
            boardPresentationStatus: "done",
            priority: "medium",
            ownerAgentId: "agent-1",
            ownerUserId: null,
          },
          {
            id: "blocker-11",
            taskNumber: 11,
            identifier: "TASK-11",
            title: "Running work",
            boardPresentationStatus: "in_progress",
            priority: "medium",
            ownerAgentId: "agent-1",
            ownerUserId: null,
          },
        ]}
      />,
    );

    const stepLinks = Array.from(node.querySelectorAll('[data-testid="task-blocked-notice-steps"] a')).map(
      (link) => link.textContent ?? "",
    );

    expect(stepLinks[0]).toContain("TASK-9");
    expect(stepLinks[1]).toContain("TASK-10");
    expect(stepLinks[2]).toContain("TASK-11");

    const runningStep = node.querySelectorAll('[data-testid="task-blocked-notice-steps"] a')[2];
    if (!runningStep) throw new Error("Expected a running live-work step.");
    expect(runningStep.textContent).toContain("In Progress");
    expect(node.querySelector('[data-testid="task-blocked-notice-now-running"]')).toBeNull();
  });

  it("explains explicit status and notification actions without linked blockers", () => {
    const node = render(<TaskBlockedNotice taskStatus="blocked" blockers={[]} />);

    expect(node.textContent).toContain("This task is marked blocked");
    expect(node.textContent).toContain("Use Update status to change it when ready");
    expect(node.textContent).toContain("select Notify owner on a comment");
  });

  it("shows external now-running blockers beneath the label on a separate line", () => {
    const node = render(
      <TaskBlockedNotice
        taskStatus="blocked"
        liveTaskIds={new Set(["terminal-live"])}
        blockerAttention={{
          state: "covered",
          reason: "active_dependency",
          unresolvedBlockerCount: 1,
          coveredBlockerCount: 1,
          stalledBlockerCount: 0,
          attentionBlockerCount: 0,
          sampleBlockerIdentifier: "TASK-99",
          sampleStalledBlockerIdentifier: null,
        }}
        blockers={[
          {
            id: "blocker-1",
            taskNumber: 1,
            identifier: "TASK-1",
            title: "Queued dependency",
            boardPresentationStatus: "todo",
            priority: "medium",
            ownerAgentId: "agent-1",
            ownerUserId: null,
            terminalBlockers: [
              {
                id: "terminal-live",
                taskNumber: 99,
                identifier: "TASK-99",
                title: "External running task",
                boardPresentationStatus: "in_progress",
                priority: "medium",
                ownerAgentId: "agent-1",
                ownerUserId: null,
              },
            ],
          },
        ]}
        allBlockers={[
          {
            id: "blocker-1",
            taskNumber: 1,
            identifier: "TASK-1",
            title: "Queued dependency",
            boardPresentationStatus: "todo",
            priority: "medium",
            ownerAgentId: "agent-1",
            ownerUserId: null,
          },
        ]}
      />,
    );

    const nowRunning = node.querySelector('[data-testid="task-blocked-notice-now-running"]');
    expect(nowRunning).not.toBeNull();
    expect(nowRunning!.children[0]?.textContent?.trim()).toBe("Now running");
    expect(nowRunning!.children[1]?.querySelector("a")?.textContent).toContain("TASK-99");
    const stepText = node.querySelector('[data-testid="task-blocked-notice-steps"]')?.textContent;
    expect(stepText).not.toContain("TASK-99");
  });
});
