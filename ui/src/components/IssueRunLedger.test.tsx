// @vitest-environment jsdom

import type { IssueExecutionRunEnvelopeRecord } from "@paperclipai/shared";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultIssueRunLedgerRunId,
  IssueRunLedgerContent,
  projectIssueRunLedgerGroups,
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
    executionWorkspaceBindingId: "binding-1",
    executionMode: "owner",
    issueExecutionAuthorityId: null,
    consultExecutionId: null,
    compactionScopeKind: null,
    parentRunId: null,
    retryOfRunId: null,
    triggeredByRunId: null,
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

  it("records watchdog decisions against the selected canonical run", () => {
    const onWatchdogDecision = vi.fn();
    act(() => {
      root.render(
        <IssueRunLedgerContent
          runs={[run()]}
          selectedRunId="run-12345678"
          issueStatus="in_progress"
          childIssues={[]}
          agentMap={new Map([["agent-1", { name: "Builder" }]])}
          onWatchdogDecision={onWatchdogDecision}
        />,
      );
    });

    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Continue monitoring",
    );
    act(() => button?.click());
    expect(onWatchdogDecision).toHaveBeenCalledWith({
      runId: "run-12345678",
      decision: "continue",
    });
  });

  it("groups compactions only by triggeredByRunId and keeps orphans explicit", () => {
    const parentA = run({
      id: "parent-a-12345678",
      startedAt: "2026-07-31T10:00:00.000Z",
      createdAt: "2026-07-31T10:00:00.000Z",
    });
    const parentB = run({
      id: "parent-b-12345678",
      kind: "consult",
      executionMode: "consult",
      startedAt: "2026-07-31T11:00:00.000Z",
      createdAt: "2026-07-31T11:00:00.000Z",
    });
    const olderCompaction = run({
      id: "compact-old-12345678",
      kind: "compaction",
      triggeredByRunId: parentA.id,
      parentRunId: parentB.id,
      retryOfRunId: parentB.id,
      targetAgentId: null,
      executionMode: null,
      compactionScopeKind: "turns-recovery",
      startedAt: "2026-07-31T12:00:00.000Z",
      createdAt: "2026-07-31T12:00:00.000Z",
    });
    const newerCompaction = run({
      id: "compact-new-12345678",
      kind: "compaction",
      triggeredByRunId: parentA.id,
      parentRunId: parentB.id,
      retryOfRunId: parentB.id,
      targetAgentId: null,
      executionMode: null,
      compactionScopeKind: "comments-recovery",
      startedAt: "2026-07-31T13:00:00.000Z",
      createdAt: "2026-07-31T13:00:00.000Z",
    });
    const orphan = run({
      id: "compact-orphan-12345678",
      kind: "compaction",
      triggeredByRunId: "missing-trigger-12345678",
      parentRunId: parentB.id,
      retryOfRunId: parentB.id,
      targetAgentId: null,
      executionMode: null,
      compactionScopeKind: "turns-recovery",
      startedAt: "2026-07-31T12:30:00.000Z",
      createdAt: "2026-07-31T12:30:00.000Z",
    });

    const groups = projectIssueRunLedgerGroups([
      orphan,
      parentB,
      olderCompaction,
      parentA,
      newerCompaction,
    ]);
    const parentAGroup = groups.find((group) => group.id === parentA.id);
    expect(parentAGroup?.compactions.map((item) => item.id)).toEqual([
      newerCompaction.id,
      olderCompaction.id,
    ]);
    expect(groups[0]?.id).toBe(parentA.id);
    expect(groups.find((group) => group.id === orphan.id)).toMatchObject({
      orphanedCompaction: true,
      compactions: [],
    });
    expect(groups.find((group) => group.id === parentB.id)?.compactions).toEqual([]);
    expect(
      groups.flatMap((group) => [
        group.parent.id,
        ...group.compactions.map((item) => item.id),
      ]),
    ).toHaveLength(5);
    expect(defaultIssueRunLedgerRunId([
      orphan,
      parentB,
      olderCompaction,
      parentA,
      newerCompaction,
    ])).toBe(parentA.id);
  });

  it("renders nested compactions as selectable detail rows and labels an orphan", () => {
    const onSelectRun = vi.fn();
    const parent = run({
      id: "parent-run-12345678",
      startedAt: "2026-07-31T10:00:00.000Z",
      createdAt: "2026-07-31T10:00:00.000Z",
    });
    const child = run({
      id: "compact-child-12345678",
      kind: "compaction",
      triggeredByRunId: parent.id,
      targetAgentId: null,
      executionMode: null,
      compactionScopeKind: "turns-recovery",
      startedAt: "2026-07-31T12:00:00.000Z",
      createdAt: "2026-07-31T12:00:00.000Z",
    });
    const orphan = run({
      id: "compact-orphan-12345678",
      kind: "compaction",
      triggeredByRunId: "missing-run-12345678",
      targetAgentId: null,
      executionMode: null,
      compactionScopeKind: "comments-recovery",
      startedAt: "2026-07-31T13:00:00.000Z",
      createdAt: "2026-07-31T13:00:00.000Z",
    });
    act(() => {
      root.render(
        <IssueRunLedgerContent
          runs={[orphan, child, parent]}
          selectedRunId={parent.id}
          onSelectRun={onSelectRun}
          issueStatus="in_progress"
          childIssues={[]}
          agentMap={new Map([["agent-1", { name: "Builder" }]])}
        />,
      );
    });

    expect(container.textContent).toContain("Running now by Builder");
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      `/agents/agent-1/runs/${parent.id}`,
    );
    expect(container.textContent).toContain("triggering run unavailable");
    const childButton = container.querySelector(
      `[data-run-id="${child.id}"] button`,
    );
    act(() => (childButton as HTMLButtonElement | null)?.click());
    expect(onSelectRun).toHaveBeenCalledWith(child.id);
    expect(container.querySelectorAll(`[data-run-id="${child.id}"]`)).toHaveLength(1);
  });

  it("applies the feed limit to top-level groups without dropping attached compactions", () => {
    const parents = Array.from({ length: 20 }, (_, index) =>
      run({
        id: `parent-${String(index).padStart(2, "0")}-12345678`,
        startedAt: `2026-07-30T${String(index).padStart(2, "0")}:00:00.000Z`,
        createdAt: `2026-07-30T${String(index).padStart(2, "0")}:00:00.000Z`,
      }));
    const compaction = run({
      id: "compact-attached-12345678",
      kind: "compaction",
      triggeredByRunId: parents[0]!.id,
      targetAgentId: null,
      executionMode: null,
      compactionScopeKind: "turns-recovery",
      startedAt: "2026-07-31T23:00:00.000Z",
      createdAt: "2026-07-31T23:00:00.000Z",
    });
    act(() => {
      root.render(
        <IssueRunLedgerContent
          runs={[...parents, compaction]}
          issueStatus="in_progress"
          childIssues={[]}
          agentMap={new Map([["agent-1", { name: "Builder" }]])}
        />,
      );
    });

    expect(container.querySelectorAll("[data-run-id]")).toHaveLength(21);
  });
});
