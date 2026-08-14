import type { AttentionItem } from "@paperclipai/shared";

export function buildAttentionItem(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "a1",
    companyId: "c1",
    sourceKind: "approval",
    subject: {
      kind: "approval",
      id: "s1",
      companyId: "c1",
      title: "t",
      taskNumber: null,
      identifier: null,
      status: null,
      routeTarget: null,
    },
    whyNow: "why",
    decisionVerbs: [],
    inlineResolvable: true,
    entryRule: "",
    exitRule: "",
    dedupKey: "d1",
    dismissalKey: "attention:d1",
    severity: "medium",
    rank: 0,
    activityAt: "2026-07-09T12:00:00Z",
    createdAt: "2026-07-09T12:00:00Z",
    updatedAt: "2026-07-09T12:00:00Z",
    relatedTask: null,
    project: null,
    workspace: null,
    detail: null,
    dismissal: null,
    ...overrides,
  };
}
