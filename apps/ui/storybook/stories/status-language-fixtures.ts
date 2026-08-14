import type { TaskBlockerAttention, TaskRelationTaskSummary } from "@paperclipai/shared";

import { createTask } from "../fixtures/paperclipData";

export type CoveredBlockedCell = {
  label: string;
  status: string;
  blockerAttention: TaskBlockerAttention | null;
  expectedVisual: string;
  expectedCopy: string;
};

export function attention(
  partial: Partial<TaskBlockerAttention> & Pick<TaskBlockerAttention, "state" | "reason">,
): TaskBlockerAttention {
  return {
    state: partial.state,
    reason: partial.reason,
    unresolvedBlockerCount: partial.unresolvedBlockerCount ?? 0,
    coveredBlockerCount: partial.coveredBlockerCount ?? 0,
    stalledBlockerCount: partial.stalledBlockerCount ?? 0,
    attentionBlockerCount: partial.attentionBlockerCount ?? 0,
    sampleBlockerIdentifier: partial.sampleBlockerIdentifier ?? null,
    sampleStalledBlockerIdentifier: partial.sampleStalledBlockerIdentifier ?? null,
  };
}

export const coveredBlockedMatrix: CoveredBlockedCell[] = [
  {
    label: "Normal blocked",
    status: "blocked",
    blockerAttention: null,
    expectedVisual: "solid red ring",
    expectedCopy: "Blocked",
  },
  {
    label: "Covered by 1 active child",
    status: "blocked",
    blockerAttention: attention({
      state: "covered",
      reason: "active_child",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      sampleBlockerIdentifier: "PAP-2175",
    }),
    expectedVisual: "cyan ring",
    expectedCopy: "Blocked · waiting on active sub-task PAP-2175",
  },
  {
    label: "Covered by N active children",
    status: "blocked",
    blockerAttention: attention({
      state: "covered",
      reason: "active_child",
      unresolvedBlockerCount: 3,
      coveredBlockerCount: 3,
    }),
    expectedVisual: "cyan ring",
    expectedCopy: "Blocked · waiting on 3 active sub-tasks",
  },
  {
    label: "Covered by active dependency",
    status: "blocked",
    blockerAttention: attention({
      state: "covered",
      reason: "active_dependency",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      sampleBlockerIdentifier: "PAP-1918",
    }),
    expectedVisual: "cyan ring",
    expectedCopy: "Blocked · covered by active dependency PAP-1918",
  },
  {
    label: "Covered by N active dependencies",
    status: "blocked",
    blockerAttention: attention({
      state: "covered",
      reason: "active_dependency",
      unresolvedBlockerCount: 2,
      coveredBlockerCount: 2,
    }),
    expectedVisual: "cyan ring",
    expectedCopy: "Blocked · covered by 2 active dependencies",
  },
  {
    label: "Stalled review (single leaf)",
    status: "blocked",
    blockerAttention: attention({
      state: "stalled",
      reason: "stalled_review",
      unresolvedBlockerCount: 1,
      stalledBlockerCount: 1,
      sampleBlockerIdentifier: "PAP-2279",
      sampleStalledBlockerIdentifier: "PAP-2279",
    }),
    expectedVisual: "amber ring with dot",
    expectedCopy: "Blocked · review stalled on PAP-2279",
  },
  {
    label: "Stalled review (multiple leaves)",
    status: "blocked",
    blockerAttention: attention({
      state: "stalled",
      reason: "stalled_review",
      unresolvedBlockerCount: 2,
      stalledBlockerCount: 2,
      sampleStalledBlockerIdentifier: "PAP-2279",
    }),
    expectedVisual: "amber ring with dot",
    expectedCopy: "Blocked · 2 reviews stalled with no clear next step",
  },
  {
    label: "Mixed: 1 covered, 1 needs attention",
    status: "blocked",
    blockerAttention: attention({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 2,
      coveredBlockerCount: 1,
      attentionBlockerCount: 1,
    }),
    expectedVisual: "solid red ring",
    expectedCopy: "Blocked · 2 unresolved blockers need attention",
  },
  {
    label: "Needs attention (single blocker)",
    status: "blocked",
    blockerAttention: attention({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 1,
      attentionBlockerCount: 1,
      sampleBlockerIdentifier: "PAP-1042",
    }),
    expectedVisual: "solid red ring",
    expectedCopy: "Blocked · 1 unresolved blocker needs attention",
  },
  {
    label: "Non-blocked with prop ignored",
    status: "in_progress",
    blockerAttention: attention({
      state: "covered",
      reason: "active_child",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      sampleBlockerIdentifier: "PAP-2175",
    }),
    expectedVisual: "yellow ring",
    expectedCopy: "In Progress",
  },
];

export const coveredBlockedTask = createTask({
  id: "dddddddd-dddd-4ddd-8ddd-ddddddddd011",
  identifier: "PAP-2178",
  taskNumber: 2178,
  title: "Covered blocked visual state: final acceptance",
  boardPresentationStatus: "blocked",
  priority: "medium",
  blockerAttention: coveredBlockedMatrix[1]!.blockerAttention ?? undefined,
  lastActivityAt: new Date("2026-04-24T13:40:00.000Z"),
  updatedAt: new Date("2026-04-24T13:40:00.000Z"),
});

export function summaryBlocker(
  partial: Partial<TaskRelationTaskSummary> &
    Pick<TaskRelationTaskSummary, "id" | "identifier" | "title" | "boardPresentationStatus">,
): TaskRelationTaskSummary {
  return {
    id: partial.id,
    taskNumber: partial.taskNumber ?? Number(partial.identifier.split("-").at(-1)),
    identifier: partial.identifier,
    title: partial.title,
    boardPresentationStatus: partial.boardPresentationStatus,
    priority: partial.priority ?? "medium",
    ownerAgentId: partial.ownerAgentId ?? null,
    ownerUserId: partial.ownerUserId ?? null,
    terminalBlockers: partial.terminalBlockers,
  };
}

export type BlockedNoticeStateLabel =
  "Default covered" | "Stalled (single leaf)" | "Stalled (multiple leaves)";

export type BlockedNoticeFixture = {
  label: BlockedNoticeStateLabel;
  caption: string;
  blockers: TaskRelationTaskSummary[];
  blockerAttention: TaskBlockerAttention;
};

export const stalledLeafSingle = summaryBlocker({
  id: "dddddddd-dddd-4ddd-8ddd-ddddddddd01c",
  identifier: "PAP-2279",
  title: "Stage gate review for export pipeline",
  boardPresentationStatus: "in_review",
});

export const stalledLeafMultiPrimary = summaryBlocker({
  id: "dddddddd-dddd-4ddd-8ddd-ddddddddd01a",
  identifier: "PAP-2284",
  title: "Approve schema migration",
  boardPresentationStatus: "in_review",
});

export const stalledLeafMultiSecondary = summaryBlocker({
  id: "dddddddd-dddd-4ddd-8ddd-ddddddddd01b",
  identifier: "PAP-2291",
  title: "Sign off on rollout copy",
  boardPresentationStatus: "in_review",
});

export const blockedNoticeFixtures: BlockedNoticeFixture[] = [
  {
    label: "Default covered",
    caption: "Active sub-task covers the chain — informational only.",
    blockers: [
      summaryBlocker({
        id: "dddddddd-dddd-4ddd-8ddd-ddddddddd00f",
        identifier: "PAP-2175",
        title: "Wire export pipeline preview",
        boardPresentationStatus: "in_progress",
      }),
    ],
    blockerAttention: attention({
      state: "covered",
      reason: "active_child",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      sampleBlockerIdentifier: "PAP-2175",
    }),
  },
  {
    label: "Stalled (single leaf)",
    caption: "Chain stalled on one leaf review — copy names the leaf and shows the chip strip.",
    blockers: [
      summaryBlocker({
        id: "dddddddd-dddd-4ddd-8ddd-ddddddddd01f",
        identifier: "PAP-2278",
        title: "Ship rollout dashboard",
        boardPresentationStatus: "blocked",
        terminalBlockers: [stalledLeafSingle],
      }),
    ],
    blockerAttention: attention({
      state: "stalled",
      reason: "stalled_review",
      unresolvedBlockerCount: 1,
      stalledBlockerCount: 1,
      sampleBlockerIdentifier: "PAP-2279",
      sampleStalledBlockerIdentifier: "PAP-2279",
    }),
  },
  {
    label: "Stalled (multiple leaves)",
    caption:
      'Multiple stalled reviews — body uses plural agreement ("reviews"/"them") to match the chip strip.',
    blockers: [
      summaryBlocker({
        id: "dddddddd-dddd-4ddd-8ddd-ddddddddd01d",
        identifier: "PAP-2283",
        title: "Coordinate billing change rollout",
        boardPresentationStatus: "blocked",
        terminalBlockers: [stalledLeafMultiPrimary],
      }),
      summaryBlocker({
        id: "dddddddd-dddd-4ddd-8ddd-ddddddddd01e",
        identifier: "PAP-2290",
        title: "Coordinate marketing transfer",
        boardPresentationStatus: "blocked",
        terminalBlockers: [stalledLeafMultiSecondary],
      }),
    ],
    blockerAttention: attention({
      state: "stalled",
      reason: "stalled_review",
      unresolvedBlockerCount: 2,
      stalledBlockerCount: 2,
      sampleStalledBlockerIdentifier: "PAP-2284",
    }),
  },
];
