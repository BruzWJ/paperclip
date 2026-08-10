// @vitest-environment jsdom

import type { IssueExecutionRunEnvelopeRecord } from "@paperclipai/shared";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultIssueRunLedgerRunId,
  IssueRunLedgerContent,
} from "./IssueRunLedger";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function run(
  overrides: Partial<IssueExecutionRunEnvelopeRecord> = {},
): IssueExecutionRunEnvelopeRecord {
  return {
    id: "run-12345678",
    companyId: "company-1",
    issueId: "issue-1",
    sessionId: "session-1",
    executionScopeId: "scope-1",
    kind: "productive",
    status: "running",
    ownershipEpoch: 1,
    targetAgentId: "agent-1",
    adapterConfigRevisionId: "revision-1",
    executionMode: "owner",
    issueExecutionAuthorityId: null,
    consultExecutionId: null,
    parentRunId: null,
    retryOfRunId: null,
    currentAttemptId: "attempt-1",
    currentLeaseId: "lease-1",
    cancellationIntentId: null,
    terminalFinalizationId: null,
    startedAt: "2026-07-31T12:00:00.000Z",
    finishedAt: null,
    terminalClassification: null,
    terminalReasonCode: null,
    processExitCode: null,
    processSignal: null,
    createdAt: "2026-07-31T12:00:00.000Z",
    updatedAt: "2026-07-31T12:00:00.000Z",
    ...overrides,
  };
}

describe("IssueRunLedgerContent", () => {
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
        <IssueRunLedgerContent
          runs={[run({ terminalReasonCode: "waiting_for_dependency" })]}
          selectedRunId="run-12345678"
          issueStatus="in_progress"
          childIssues={[]}
          agentMap={new Map([["agent-1", { name: "Builder" }]])}
        />,
      );
    });

    expect(container.textContent).toContain("Running now by Builder");
    expect(container.textContent).toContain("waiting_for_dependency");
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "/agents/agent-1/runs/run-12345678",
    );
  });

  it("selects the newest ordinary run by run timestamp", () => {
    const older = run({
      id: "older-run-12345678",
      startedAt: "2026-07-31T10:00:00.000Z",
      createdAt: "2026-07-31T10:00:00.000Z",
    });
    const newer = run({
      id: "newer-run-12345678",
      kind: "consult",
      executionMode: "consult",
      startedAt: "2026-07-31T11:00:00.000Z",
      createdAt: "2026-07-31T11:00:00.000Z",
    });

    expect(defaultIssueRunLedgerRunId([older, newer])).toBe(newer.id);
  });

  it("renders ordinary runs as individually selectable detail rows", () => {
    const onSelectRun = vi.fn();
    const productive = run({
      id: "productive-run-12345678",
      startedAt: "2026-07-31T10:00:00.000Z",
      createdAt: "2026-07-31T10:00:00.000Z",
    });
    const consult = run({
      id: "consult-run-12345678",
      kind: "consult",
      executionMode: "consult",
      startedAt: "2026-07-31T12:00:00.000Z",
      createdAt: "2026-07-31T12:00:00.000Z",
    });
    act(() => {
      root.render(
        <IssueRunLedgerContent
          runs={[consult, productive]}
          selectedRunId={productive.id}
          onSelectRun={onSelectRun}
          issueStatus="in_progress"
          childIssues={[]}
          agentMap={new Map([["agent-1", { name: "Builder" }]])}
        />,
      );
    });

    expect(container.textContent).toContain("Running now by Builder");
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      `/agents/agent-1/runs/${consult.id}`,
    );
    const consultButton = container.querySelector(
      `[data-run-id="${consult.id}"] button`,
    );
    act(() => (consultButton as HTMLButtonElement | null)?.click());
    expect(onSelectRun).toHaveBeenCalledWith(consult.id);
    expect(container.querySelectorAll("[data-run-id]")).toHaveLength(2);
  });

  it("applies the feed limit to ordinary run records", () => {
    const runs = Array.from({ length: 21 }, (_, index) =>
      run({
        id: `run-${String(index).padStart(2, "0")}-12345678`,
        startedAt: `2026-07-30T${String(index).padStart(2, "0")}:00:00.000Z`,
        createdAt: `2026-07-30T${String(index).padStart(2, "0")}:00:00.000Z`,
      }));
    act(() => {
      root.render(
        <IssueRunLedgerContent
          runs={runs}
          issueStatus="in_progress"
          childIssues={[]}
          agentMap={new Map([["agent-1", { name: "Builder" }]])}
        />,
      );
    });

    expect(container.querySelectorAll("[data-run-id]")).toHaveLength(20);
  });
});
