import type { AttentionFeed, AttentionSourceKind } from "@paperclipai/shared";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ATTENTION_GROUP_BY_KEY,
  ATTENTION_GROUP_BY_OPTIONS,
  attentionBadgeCount,
  isInlineResolvable,
  loadAttentionGroupBy,
  saveAttentionGroupBy,
  sourceMeta,
} from "./attention";
import { buildAttentionItem as buildItem } from "./attention-test-support";

describe("attention group preference persistence", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to None and lists it as the first group option", () => {
    expect(loadAttentionGroupBy()).toBe("none");
    expect(ATTENTION_GROUP_BY_OPTIONS[0]).toEqual(["none", "None"]);
  });

  it("round-trips explicit grouped choices and treats stale values as None", () => {
    saveAttentionGroupBy("date");
    expect(loadAttentionGroupBy()).toBe("date");
    localStorage.setItem(ATTENTION_GROUP_BY_KEY, "unexpected");
    expect(loadAttentionGroupBy()).toBe("none");
  });
});

describe("isInlineResolvable", () => {
  it("is true for approvals and join requests when server flags inlineResolvable", () => {
    for (const kind of ["approval", "join_request"] as AttentionSourceKind[]) {
      expect(isInlineResolvable(buildItem({ sourceKind: kind, inlineResolvable: true }))).toBe(true);
    }
  });

  it("is false when the server marks a row non-inline", () => {
    expect(isInlineResolvable(buildItem({ sourceKind: "approval", inlineResolvable: false }))).toBe(false);
  });

  it("is never inline for reviews even when flagged", () => {
    expect(isInlineResolvable(buildItem({ sourceKind: "review", inlineResolvable: true }))).toBe(false);
  });

  it("deep-links Board requests, reviews, and budget rows", () => {
    for (const kind of ["mention_board", "budget_alert", "review"] as AttentionSourceKind[]) {
      expect(isInlineResolvable(buildItem({ sourceKind: kind, inlineResolvable: true }))).toBe(false);
    }
  });
});

describe("attentionBadgeCount", () => {
  it("counts every Board Attention row", () => {
    const feed: AttentionFeed = {
      companyId: "c1",
      generatedAt: "2026-07-09T12:00:00Z",
      totalCount: 3,
      countsBySourceKind: {} as AttentionFeed["countsBySourceKind"],
      items: [buildItem({ id: "1" }), buildItem({ id: "2" }), buildItem({ id: "3" })],
    };
    expect(attentionBadgeCount(feed)).toBe(3);
  });

  it("is zero for an empty or missing feed", () => {
    expect(attentionBadgeCount(null)).toBe(0);
    expect(attentionBadgeCount(undefined)).toBe(0);
  });
});

describe("sourceMeta", () => {
  it("labels every catalog source kind", () => {
    const kinds: AttentionSourceKind[] = [
      "approval",
      "join_request",
      "review",
      "budget_alert",
      "mention_board",
    ];
    for (const kind of kinds) {
      expect(sourceMeta(kind).label.length).toBeGreaterThan(0);
      expect(sourceMeta(kind).icon).toBeTruthy();
    }
  });
});
