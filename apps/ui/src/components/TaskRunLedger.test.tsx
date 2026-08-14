// @vitest-environment jsdom

import type { TaskExecutionRunEnvelopeRecord } from "@paperclipai/shared";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultTaskRunLedgerRunId, TaskRunLedgerContent } from "./TaskRunLedger";

const COMPANY_ID = vi.hoisted(() => "11111111-1111-4111-8111-111111111111");
const AGENT_ID = "22222222-2222-4222-8222-222222222222";

function uuidFor(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

const RUN_ID = uuidFor(1);

vi.mock("@/hooks/useCompanyRouteId", () => ({
  useCompanyRouteId: () => COMPANY_ID,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, children }: { to: string; params?: Record<string, string>; children: ReactNode }) => {
    const href = to
      .replace("$companyId", params?.companyId ?? "")
      .replace("$agentId", params?.agentId ?? "")
      .replace("$runId", params?.runId ?? "");
    return <a href={href}>{children}</a>;
  },
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function run(overrides: Partial<TaskExecutionRunEnvelopeRecord> = {}): TaskExecutionRunEnvelopeRecord {
  return {
    id: RUN_ID,
    companyId: COMPANY_ID,
    taskId: uuidFor(2),
    sessionId: uuidFor(3),
    executionScopeId: uuidFor(4),
    kind: "productive",
    status: "running",
    ownershipEpoch: 1,
    targetAgentId: AGENT_ID,
    adapterConfigRevisionId: uuidFor(5),
    executionMode: "owner",
    taskExecutionAuthorityId: null,
    consultExecutionId: null,
    parentRunId: null,
    retryOfRunId: null,
    currentAttemptId: uuidFor(6),
    currentLeaseId: uuidFor(7),
    cancellationIntentId: null,
    terminalFinalizationId: null,
    startedAt: "2026-07-31T12:00:00.000Z",
    finishedAt: null,
    terminalClassification: null,
    terminalReasonCode: null,
    createdAt: "2026-07-31T12:00:00.000Z",
    updatedAt: "2026-07-31T12:00:00.000Z",
    ...overrides,
  };
}

describe("TaskRunLedgerContent", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders canonical envelope fields and a joined-detail link", () => {
    act(() => {
      root.render(
        <TaskRunLedgerContent
          runs={[run({ terminalReasonCode: "waiting_for_dependency" })]}
          selectedRunId={RUN_ID}
          taskStatus="in_progress"
          childTasks={[]}
          agentMap={new Map([[AGENT_ID, { id: AGENT_ID, name: "Builder" }]])}
        />,
      );
    });

    expect(container.textContent).toContain("Running now by Builder");
    expect(container.textContent).toContain("waiting_for_dependency");
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      `/${COMPANY_ID}/agents/${AGENT_ID}/runs/${RUN_ID}`,
    );
  });

  it("selects the newest ordinary run by run timestamp", () => {
    const older = run({
      id: uuidFor(8),
      startedAt: "2026-07-31T10:00:00.000Z",
      createdAt: "2026-07-31T10:00:00.000Z",
    });
    const newer = run({
      id: uuidFor(9),
      kind: "consult",
      executionMode: "consult",
      startedAt: "2026-07-31T11:00:00.000Z",
      createdAt: "2026-07-31T11:00:00.000Z",
    });

    expect(defaultTaskRunLedgerRunId([older, newer])).toBe(newer.id);
  });

  it("renders ordinary runs as individually selectable detail rows", () => {
    const onSelectRun = vi.fn();
    const productive = run({
      id: uuidFor(10),
      startedAt: "2026-07-31T10:00:00.000Z",
      createdAt: "2026-07-31T10:00:00.000Z",
    });
    const consult = run({
      id: uuidFor(11),
      kind: "consult",
      executionMode: "consult",
      startedAt: "2026-07-31T12:00:00.000Z",
      createdAt: "2026-07-31T12:00:00.000Z",
    });
    act(() => {
      root.render(
        <TaskRunLedgerContent
          runs={[consult, productive]}
          selectedRunId={productive.id}
          onSelectRun={onSelectRun}
          taskStatus="in_progress"
          childTasks={[]}
          agentMap={new Map([[AGENT_ID, { id: AGENT_ID, name: "Builder" }]])}
        />,
      );
    });

    expect(container.textContent).toContain("Running now by Builder");
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      `/${COMPANY_ID}/agents/${AGENT_ID}/runs/${consult.id}`,
    );
    const consultButton = container.querySelector(`[data-run-id="${consult.id}"] button`);
    act(() => (consultButton as HTMLButtonElement | null)?.click());
    expect(onSelectRun).toHaveBeenCalledWith(consult.id);
    expect(container.querySelectorAll("[data-run-id]")).toHaveLength(2);
  });

  it("applies the feed limit to ordinary run records", () => {
    const runs = Array.from({ length: 21 }, (_, index) =>
      run({
        id: uuidFor(100 + index),
        startedAt: `2026-07-30T${String(index).padStart(2, "0")}:00:00.000Z`,
        createdAt: `2026-07-30T${String(index).padStart(2, "0")}:00:00.000Z`,
      }),
    );
    act(() => {
      root.render(
        <TaskRunLedgerContent
          runs={runs}
          taskStatus="in_progress"
          childTasks={[]}
          agentMap={new Map([[AGENT_ID, { id: AGENT_ID, name: "Builder" }]])}
        />,
      );
    });

    expect(container.querySelectorAll("[data-run-id]")).toHaveLength(20);
  });
});
