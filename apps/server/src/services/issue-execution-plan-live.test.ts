import { describe, expect, it } from "vitest";
import type { LiveEvent } from "@paperclipai/shared";
import {
  IssueExecutionLivePlanViolation,
  publishIssueExecutionLivePlan,
  type CurrentAcpPromptIdentity,
  type RoutedAcpPromptIdentity,
} from "./issue-execution-plan-live.js";
import { subscribeCompanyLiveEvents } from "./live-events.js";

const routedPrompt: RoutedAcpPromptIdentity = {
  companyId: "company-live-plan",
  issueId: "issue-1",
  runId: "run-1",
  refId: "ref-1",
  runOrdinal: 1,
  segmentOrdinal: 0,
  attemptId: "attempt-1",
  capabilityGenerationId: "capability-1",
};

const currentPrompt: CurrentAcpPromptIdentity = {
  ...routedPrompt,
  promptState: "prompt_active",
};

const noLiteralRedactor = { redactText: (value: string) => value };

function plan(entries: readonly Record<string, unknown>[]) {
  return {
    kind: "plan",
    entries,
  } as never;
}

describe("publishIssueExecutionLivePlan", () => {
  it("publishes one company-scoped, redacted, exact full replacement", () => {
    const received: LiveEvent[] = [];
    const otherCompany: LiveEvent[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(
      routedPrompt.companyId,
      (event) => received.push(event),
    );
    const unsubscribeOther = subscribeCompanyLiveEvents(
      "company-other",
      (event) => otherCompany.push(event),
    );

    try {
      const event = publishIssueExecutionLivePlan({
        routedPrompt,
        currentPrompt,
        event: plan([
          {
            content:
              "First sk-abcdefghijklmnopqrst runtime-secret",
            priority: "high",
            status: "in_progress",
          },
          {
            content:
              "First sk-abcdefghijklmnopqrst runtime-secret",
            priority: "high",
            status: "in_progress",
          },
          {
            content: "Later",
            priority: "low",
            status: "pending",
          },
        ]),
        redactor: {
          redactText: (value) =>
            value.replaceAll("runtime-secret", "[runtime-redacted]"),
        },
      });

      expect(received).toEqual([event]);
      expect(otherCompany).toEqual([]);
      expect(event).toMatchObject({
        companyId: routedPrompt.companyId,
        type: "issue.execution.plan.live",
        payload: {
          companyId: routedPrompt.companyId,
          issueId: routedPrompt.issueId,
          runId: routedPrompt.runId,
          refId: routedPrompt.refId,
          runOrdinal: 1,
          segmentOrdinal: 0,
          replacement: [
            {
              content: "First ***REDACTED*** [runtime-redacted]",
              priority: "high",
              status: "in_progress",
            },
            {
              content: "First ***REDACTED*** [runtime-redacted]",
              priority: "high",
              status: "in_progress",
            },
            {
              content: "Later",
              priority: "low",
              status: "pending",
            },
          ],
        },
      });
    } finally {
      unsubscribe();
      unsubscribeOther();
    }
  });

  it("preserves known-empty replacement and top-level monotonic ordering", () => {
    const first = publishIssueExecutionLivePlan({
      routedPrompt,
      currentPrompt,
      event: plan([]),
      redactor: noLiteralRedactor,
    });
    const second = publishIssueExecutionLivePlan({
      routedPrompt,
      currentPrompt,
      event: plan([]),
      redactor: noLiteralRedactor,
    });

    expect(first.payload.replacement).toEqual([]);
    expect(second.id).toBeGreaterThan(first.id);
  });

  it("accepts the canonical zero-based first run-ref ordinal", () => {
    const firstRef = { ...routedPrompt, runOrdinal: 0 };
    expect(
      publishIssueExecutionLivePlan({
        routedPrompt: firstRef,
        currentPrompt: { ...firstRef, promptState: "prompt_active" },
        event: plan([]),
        redactor: noLiteralRedactor,
      }).payload.runOrdinal,
    ).toBe(0);
  });

  it.each([
    ["companyId", "company-stale"],
    ["issueId", "issue-stale"],
    ["runId", "run-stale"],
    ["refId", "ref-stale"],
    ["runOrdinal", 2],
    ["segmentOrdinal", 1],
    ["attemptId", "attempt-stale"],
    ["capabilityGenerationId", "capability-stale"],
  ] as const)("rejects a stale or wrong-scope %s", (field, value) => {
    const received: LiveEvent[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(
      routedPrompt.companyId,
      (event) => received.push(event),
    );
    try {
      expect(() =>
        publishIssueExecutionLivePlan({
          routedPrompt,
          currentPrompt: { ...currentPrompt, [field]: value },
          event: plan([]),
          redactor: noLiteralRedactor,
        }),
      ).toThrow(IssueExecutionLivePlanViolation);
      expect(received).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it.each(["pending_setup", "settled", "terminal"] as const)(
    "rejects %s plan updates without publication",
    (promptState) => {
      const received: LiveEvent[] = [];
      const unsubscribe = subscribeCompanyLiveEvents(
        routedPrompt.companyId,
        (event) => received.push(event),
      );
      try {
        const nonActivePrompt = { ...currentPrompt };
        Object.defineProperty(nonActivePrompt, "promptState", {
          configurable: false,
          enumerable: true,
          value: promptState,
          writable: false,
        });
        expect(() =>
          publishIssueExecutionLivePlan({
            routedPrompt,
            currentPrompt: nonActivePrompt,
            event: plan([]),
            redactor: noLiteralRedactor,
          }),
        ).toThrow("outside an active prompt");
        expect(received).toEqual([]);
      } finally {
        unsubscribe();
      }
    },
  );

  it.each([
    plan([
      { content: "Bad", priority: "urgent", status: "pending" },
    ]),
    plan([
      { content: "Bad", priority: "high", status: "started" },
    ]),
    plan([
      {
        content: "Secret",
        priority: "high",
        status: "pending",
        _meta: { secret: true },
      },
    ]),
    { kind: "plan_update", entries: [] } as never,
    { kind: "plan_removed" } as never,
  ])("rejects malformed or unsupported update %#", (event) => {
    const received: LiveEvent[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(
      routedPrompt.companyId,
      (published) => received.push(published),
    );
    try {
      expect(() =>
        publishIssueExecutionLivePlan({
          routedPrompt,
          currentPrompt,
          event,
          redactor: noLiteralRedactor,
        }),
      ).toThrow(IssueExecutionLivePlanViolation);
      expect(received).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("does not replay a plan to a later subscriber", () => {
    publishIssueExecutionLivePlan({
      routedPrompt,
      currentPrompt,
      event: plan([]),
      redactor: noLiteralRedactor,
    });

    const received: LiveEvent[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(
      routedPrompt.companyId,
      (event) => received.push(event),
    );
    try {
      expect(received).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

});
