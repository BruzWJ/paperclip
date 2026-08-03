import { describe, expect, it } from "vitest";
import { createMockDb } from "./helpers/mock-db.js";
import {
  resolveSystemEscalationOwnerInTransaction,
  terminalizeAgentCreatorEdgesInTransaction,
  terminalizeCreatorEdgeInTransaction,
  terminalizePluginCreatorEdgesInTransaction,
  terminalizeRoutineCreatorEdgesInTransaction,
} from "../services/system-escalation-postgres.js";

type AffectedIssue = Parameters<
  typeof resolveSystemEscalationOwnerInTransaction
>[1];
type SessionAdmission = Parameters<
  typeof terminalizeCreatorEdgeInTransaction
>[1];

const COMPANY_ID = "company-1";
const NOW = new Date("2026-07-25T20:00:00.000Z");
const sessions = {} as SessionAdmission;

function agent(
  id: string,
  status: "idle" | "paused" | "terminated" = "idle",
  reportsTo: string | null = null,
) {
  return {
    id,
    companyId: COMPANY_ID,
    name: id,
    reportsTo,
    status,
    currentAdapterConfigRevisionId: `revision-${id}`,
  };
}

function issue(
  overrides: Partial<AffectedIssue> & Pick<AffectedIssue, "id">,
): AffectedIssue {
  return {
    id: overrides.id,
    companyId: COMPANY_ID,
    parentId: null,
    ownerKind: "agent",
    ownerAgentId: null,
    ownerUserId: null,
    ownerAssignmentSource: null,
    ownershipEpoch: 1,
    creatorKind: "user/board",
    creatorUserId: null,
    creatorAuthorityId: null,
    lifecycleStatus: "open",
    ...overrides,
  } as AffectedIssue;
}

function edge(
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "edge-1",
    companyId: COMPANY_ID,
    issueId: "issue-child",
    sessionId: "ses_child",
    ownershipEpoch: 1,
    generation: 1,
    creatorKind: "plugin",
    endpointKind: "plugin",
    endpointId: "plugin-1",
    endpointSnapshot: {},
    state: "receivable",
    terminalReason: null,
    terminalSourceKind: null,
    terminalSourceId: null,
    terminalAudit: null,
    endpointTombstone: null,
    terminalizedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("PostgreSQL system escalation contracts without a database", () => {
  it("selects the live immutable agent creator before every ancestor", async () => {
    const affected = issue({
      id: "issue-child",
      parentId: "issue-parent",
      creatorKind: "agent-execution",
      creatorAuthorityId: "authority-creator",
    });
    const harness = createMockDb({
      select: [
        [agent("creator-agent"), agent("ancestor-agent")],
        [
          affected,
          issue({
            id: "issue-parent",
            ownerAgentId: "ancestor-agent",
          }),
        ],
        [{ agentId: "creator-agent" }],
      ],
    });

    await expect(
      resolveSystemEscalationOwnerInTransaction(
        harness.db as never,
        affected,
      ),
    ).resolves.toEqual({ kind: "agent", agentId: "creator-agent" });
    expect(harness.remaining("select")).toBe(0);
  });

  it("falls through a dead immutable creator to the first live ancestor owner", async () => {
    const affected = issue({
      id: "issue-child",
      parentId: "issue-parent",
      creatorKind: "agent-execution",
      creatorAuthorityId: "authority-creator",
    });
    const harness = createMockDb({
      select: [
        [agent("creator-agent", "terminated"), agent("ancestor-agent")],
        [
          affected,
          issue({
            id: "issue-parent",
            ownerAgentId: "ancestor-agent",
          }),
        ],
        [{ agentId: "creator-agent" }],
      ],
    });

    await expect(
      resolveSystemEscalationOwnerInTransaction(
        harness.db as never,
        affected,
      ),
    ).resolves.toEqual({ kind: "agent", agentId: "ancestor-agent" });
  });

  it("uses the named root creator after the agent ladder is exhausted", async () => {
    const affected = issue({
      id: "issue-child",
      parentId: "issue-root",
      creatorKind: "routine",
    });
    const root = issue({
      id: "issue-root",
      ownerAgentId: "dead-root-owner",
      creatorKind: "user/board",
      creatorUserId: "root-user",
    });
    const harness = createMockDb({
      select: [
        [agent("dead-root-owner", "terminated")],
        [affected, root],
      ],
    });

    await expect(
      resolveSystemEscalationOwnerInTransaction(
        harness.db as never,
        affected,
      ),
    ).resolves.toEqual({ kind: "user", userId: "root-user" });
  });

  it("falls back to the board and never promotes an unrelated live company agent", async () => {
    const affected = issue({
      id: "issue-child",
      creatorKind: "plugin",
    });
    const harness = createMockDb({
      select: [[agent("unrelated-agent")], [affected]],
    });

    await expect(
      resolveSystemEscalationOwnerInTransaction(
        harness.db as never,
        affected,
      ),
    ).resolves.toEqual({ kind: "board" });
  });

  it("fails closed to the board for a cyclic issue ancestry", async () => {
    const affected = issue({
      id: "issue-child",
      parentId: "issue-parent",
      creatorKind: "routine",
    });
    const parent = issue({
      id: "issue-parent",
      parentId: "issue-child",
      ownerKind: "user",
      creatorUserId: "must-not-win",
    });
    const harness = createMockDb({ select: [[], [affected, parent]] });

    await expect(
      resolveSystemEscalationOwnerInTransaction(
        harness.db as never,
        affected,
      ),
    ).resolves.toEqual({ kind: "board" });
  });

  it("keeps a terminal issue's creator edge receivable and opens no escalation", async () => {
    const affected = issue({
      id: "issue-child",
      lifecycleStatus: "done",
    });
    const current = edge();
    const harness = createMockDb({
      select: [[affected], [current], []],
    });

    await expect(
      terminalizeCreatorEdgeInTransaction(
        harness.db as never,
        sessions,
        {
          companyId: COMPANY_ID,
          issueId: affected.id,
          ownershipEpoch: 1,
          creatorEdgeId: current.id,
          reason: "plugin_disabled",
          sourceKind: "plugin_lifecycle",
          sourceId: "plugin-operation-1",
          systemSource: "recovery",
          triggeringRunId: null,
        },
        () => NOW,
      ),
    ).resolves.toEqual({ edge: current, escalation: null });
    expect(
      harness.calls.filter((call) => call.operation === "update"),
    ).toHaveLength(0);
    expect(harness.remaining("select")).toBe(0);
  });

  it("deduplicates agent structural-loss settlement by issue and preserves agent_terminated", async () => {
    const affected = issue({
      id: "issue-child",
      lifecycleStatus: "cancelled",
    });
    const wrapperEdge = edge({
      creatorKind: "agent-execution",
      endpointKind: "agent-execution",
      endpointId: "authority-agent",
    });
    const terminalEdge = edge({
      ...wrapperEdge,
      state: "terminal",
      terminalReason: "agent_terminated",
    });
    const harness = createMockDb({
      select: [
        [{ id: "authority-agent" }],
        [{ edge: wrapperEdge }, { edge: wrapperEdge }],
        [affected],
        [terminalEdge],
        [],
      ],
    });

    await expect(
      terminalizeAgentCreatorEdgesInTransaction(
        harness.db as never,
        sessions,
        {
          companyId: COMPANY_ID,
          agentId: "agent-1",
          sourceId: "agent-tombstone-1",
          now: NOW,
        },
      ),
    ).resolves.toEqual([]);
    expect(harness.remaining("select")).toBe(0);
  });

  it.each([
    {
      label: "plugin lifecycle",
      reason: "plugin_disabled" as const,
      invoke: (db: never) =>
        terminalizePluginCreatorEdgesInTransaction(db, sessions, {
          pluginInstallationId: "plugin-1",
          reason: "plugin_disabled",
          sourceId: "plugin-operation-1",
          now: NOW,
        }),
    },
    {
      label: "routine lifecycle",
      reason: "routine_deleted" as const,
      invoke: (db: never) =>
        terminalizeRoutineCreatorEdgesInTransaction(db, sessions, {
          companyId: COMPANY_ID,
          routineId: "routine-1",
          sourceId: "routine-operation-1",
          now: NOW,
        }),
    },
  ])("maps $label loss to its canonical terminal reason", async ({ reason, invoke }) => {
    const affected = issue({
      id: "issue-child",
      lifecycleStatus: "done",
    });
    const wrapperEdge = edge({
      creatorKind: reason === "routine_deleted" ? "routine" : "plugin",
      endpointKind: reason === "routine_deleted" ? "routine" : "plugin",
      endpointId: reason === "routine_deleted" ? "routine-1" : "plugin-1",
    });
    const terminalEdge = edge({
      ...wrapperEdge,
      state: "terminal",
      terminalReason: reason,
    });
    const harness = createMockDb({
      select: [[{ edge: wrapperEdge }], [affected], [terminalEdge], []],
    });

    await expect(invoke(harness.db as never)).resolves.toEqual([]);
    expect(harness.remaining("select")).toBe(0);
  });
});
