import { describe, expect, it } from "vitest";
import {
  decodeIssueExecutionPlanLiveEvent,
  decodeIssueExecutionPlanLivePayload,
} from "./live.js";

const payload = {
  companyId: "company-1",
  issueId: "issue-1",
  runId: "run-1",
  refId: "ref-1",
  runOrdinal: 1,
  segmentOrdinal: 0,
  replacement: [
    { content: "First", priority: "high", status: "in_progress" },
    { content: "First", priority: "high", status: "in_progress" },
    { content: "Later", priority: "low", status: "pending" },
  ],
} as const;

describe("issue.execution.plan.live codec", () => {
  it("accepts the exact payload while preserving order and duplicates", () => {
    expect(decodeIssueExecutionPlanLivePayload(payload)).toEqual(payload);
    expect(
      decodeIssueExecutionPlanLivePayload({
        ...payload,
        replacement: [],
      }),
    ).toEqual({ ...payload, replacement: [] });
  });

  it.each([
    { ...payload, runOrdinal: 0 },
    { ...payload, segmentOrdinal: -1 },
    { ...payload, companyId: " company-1" },
    { ...payload, extra: true },
    {
      ...payload,
      replacement: [
        { content: "Bad", priority: "urgent", status: "pending" },
      ],
    },
    {
      ...payload,
      replacement: [
        { content: "Bad", priority: "high", status: "started" },
      ],
    },
    {
      ...payload,
      replacement: [
        {
          content: "Bad",
          priority: "high",
          status: "pending",
          _meta: { secret: true },
        },
      ],
    },
  ])("rejects malformed or noncanonical payload %#", (candidate) => {
    expect(decodeIssueExecutionPlanLivePayload(candidate)).toBeNull();
  });

  it("requires matching top-level and payload company identities", () => {
    expect(
      decodeIssueExecutionPlanLiveEvent({
        id: 7,
        companyId: "company-1",
        type: "issue.execution.plan.live",
        createdAt: "2026-07-31T00:00:00.000Z",
        payload,
      }),
    ).not.toBeNull();

    expect(
      decodeIssueExecutionPlanLiveEvent({
        id: 8,
        companyId: "company-2",
        type: "issue.execution.plan.live",
        createdAt: "2026-07-31T00:00:00.000Z",
        payload,
      }),
    ).toBeNull();

    expect(
      decodeIssueExecutionPlanLiveEvent({
        id: 9,
        companyId: "company-1",
        type: "issue.execution.plan.live",
        createdAt: "2026-07-31T00:00:00.000Z",
        payload,
        currentPlan: payload.replacement,
      }),
    ).toBeNull();
  });
});
