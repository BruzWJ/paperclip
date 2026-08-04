// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { IssueExecutionRunEnvelopeRecord } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunActivityChart, SuccessRateChart } from "./ActivityCharts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-20T12:00:00.000Z"));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function render(ui: ReactNode) {
  flushSync(() => {
    root.render(ui);
  });
}

function createRun(
  overrides: Partial<IssueExecutionRunEnvelopeRecord> = {},
): IssueExecutionRunEnvelopeRecord {
  return {
    id: "run-1",
    companyId: "company-1",
    issueId: "issue-1",
    sessionId: "session-1",
    executionScopeId: "scope-1",
    kind: "productive",
    status: "succeeded",
    ownershipEpoch: 1,
    targetAgentId: "agent-1",
    adapterConfigRevisionId: "revision-1",
    executionWorkspaceBindingId: "binding-1",
    executionMode: "owner",
    issueExecutionAuthorityId: null,
    consultExecutionId: null,
    parentRunId: null,
    retryOfRunId: null,
    currentAttemptId: null,
    currentLeaseId: null,
    cancellationIntentId: null,
    terminalFinalizationId: "finalization-1",
    startedAt: "2026-04-20T11:58:00.000Z",
    finishedAt: "2026-04-20T11:59:00.000Z",
    terminalClassification: "succeeded",
    terminalReasonCode: null,
    processExitCode: 0,
    processSignal: null,
    createdAt: "2026-04-20T11:58:00.000Z",
    updatedAt: "2026-04-20T11:59:00.000Z",
    ...overrides,
  };
}

describe("ActivityCharts", () => {
  it("renders empty run charts when dashboard aggregate data is temporarily missing", () => {
    render(<RunActivityChart activity={undefined} />);
    expect(container.textContent).toContain("No runs yet");

    render(<SuccessRateChart activity={undefined} />);
    expect(container.textContent).toContain("No runs yet");
  });

  it("still aggregates raw agent runs for detail charts", () => {
    render(
      <RunActivityChart
        runs={[
          createRun({ id: "run-success", status: "succeeded" }),
          createRun({
            id: "run-failed",
            status: "failed",
            terminalClassification: "failed",
            terminalReasonCode: "provider_quota",
          }),
        ]}
      />,
    );

    expect(container.textContent).not.toContain("No runs yet");
    // Tooltip now carries the per-day breakdown (incl. failure error codes).
    const dayCell = container.querySelector("[title^='2026-04-20: 2 runs']");
    expect(dayCell).not.toBeNull();
    expect(dayCell?.getAttribute("title")).toContain("provider_quota: 1");
  });

  it("renders a distinct recovered segment and legend for recovered restart kills", () => {
    render(
      <RunActivityChart
        activity={[
          {
            date: "2026-04-20",
            succeeded: 3,
            failed: 1,
            recovered: 4,
            other: 0,
            total: 8,
            failedByErrorCode: { process_lost: 1 },
          },
        ]}
      />,
    );

    expect(container.textContent).toContain("Recovered");
    const dayCell = container.querySelector("[title*='recovered: 4']");
    expect(dayCell).not.toBeNull();
  });
});
