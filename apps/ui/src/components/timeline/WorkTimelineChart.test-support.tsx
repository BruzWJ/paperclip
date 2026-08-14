// @vitest-environment jsdom

import type { WorkTimelineResult } from "@paperclipai/shared";
import type { ComponentProps, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, vi } from "vitest";
import { WorkTimelineChart } from "./WorkTimelineChart";

vi.mock("@/hooks/useCompanyRouteId", () => ({
  useCompanyRouteId: () => "11111111-1111-4111-8111-111111111111",
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    children,
    ...props
  }: {
    to: string;
    params?: Record<string, string>;
    children: ReactNode;
  } & Omit<ComponentProps<"a">, "href">) => {
    const href = to
      .replace("$companyId", params?.companyId ?? "")
      .replace("$taskNumber", params?.taskNumber ?? "");
    return (
      <a href={href} {...props}>
        {children}
      </a>
    );
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

export let container: HTMLDivElement;
export let root: Root;

export function replaceRoot(nextRoot: Root) {
  root = nextRoot;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

export function renderChart(
  data: WorkTimelineResult,
  props: Partial<ComponentProps<typeof WorkTimelineChart>> = {},
) {
  flushSync(() => {
    root.render(
      <WorkTimelineChart
        data={data}
        zoom="hour"
        nowMs={new Date("2026-07-02T12:00:00.000Z").getTime()}
        {...props}
      />,
    );
  });
}

export async function flushTimelineEffects(count = 5) {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export function timelineSample(): WorkTimelineResult {
  return {
    actors: [
      { id: "agent:codex", type: "agent", name: "CodexCoder", avatar: "code" },
      { id: "agent:qa", type: "agent", name: "QA", avatar: "shield" },
    ],
    spans: [
      {
        actorId: "agent:codex",
        runId: "run-1",
        kind: "productive",
        taskId: "task-1",
        taskNumber: 12443,
        taskIdentifier: "PAP-12443",
        taskTitle: "Work Timeline sticky gutter",
        start: "2026-07-02T09:00:00.000Z",
        end: "2026-07-02T10:00:00.000Z",
        status: "succeeded",
        retryOfRunId: null,
      },
      {
        actorId: "agent:qa",
        runId: "run-2",
        kind: "productive",
        taskId: "task-2",
        taskNumber: 12426,
        taskIdentifier: "PAP-12426",
        taskTitle: "QA validation",
        start: "2026-07-02T11:00:00.000Z",
        end: "2026-07-02T11:30:00.000Z",
        status: "succeeded",
        retryOfRunId: null,
      },
    ],
    events: [],
    edges: [],
    pagination: { limit: 200, offset: 0, totalTasks: 2, hasMore: false },
    window: {
      from: "2026-07-02T00:00:00.000Z",
      to: "2026-07-03T00:00:00.000Z",
      capped: false,
    },
  };
}
