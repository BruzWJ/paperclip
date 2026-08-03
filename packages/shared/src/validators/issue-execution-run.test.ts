import { describe, expect, it } from "vitest";
import {
  acpCostCursorStateSchema,
  issueExecutionLaneKindSchema,
  issueExecutionNativeCorrelationPurposeSchema,
  issueExecutionNativeCorrelationStateSchema,
  issueExecutionPromptCapabilityStateSchema,
  issueExecutionPromptSettlementSchema,
  issueExecutionRunLivenessFactSchema,
  issueExecutionWatchdogDecisionInputSchema,
} from "./issue-execution-run.js";

const outcomeReferenceId = "00000000-0000-4000-8000-000000000001";
const accountingId = "00000000-0000-4000-8000-000000000002";
const costEventId = "00000000-0000-4000-8000-000000000003";

describe("ACP correlation and prompt capability enums", () => {
  it("accepts only the closed canonical values", () => {
    expect(issueExecutionNativeCorrelationPurposeSchema.parse("carry")).toBe(
      "carry",
    );
    expect(
      issueExecutionNativeCorrelationPurposeSchema.parse(
        "active_run_steering",
      ),
    ).toBe("active_run_steering");
    expect(issueExecutionNativeCorrelationStateSchema.parse("eligible")).toBe(
      "eligible",
    );
    expect(issueExecutionNativeCorrelationStateSchema.parse("current")).toBe(
      "current",
    );
    expect(issueExecutionNativeCorrelationStateSchema.parse("superseded")).toBe(
      "superseded",
    );
    expect(issueExecutionLaneKindSchema.parse("owner")).toBe("owner");
    expect(issueExecutionLaneKindSchema.parse("consult")).toBe("consult");
    expect(acpCostCursorStateSchema.parse("unanchored")).toBe("unanchored");
    expect(acpCostCursorStateSchema.parse("known")).toBe("known");
    expect(acpCostCursorStateSchema.parse("unavailable")).toBe("unavailable");
    expect(issueExecutionPromptCapabilityStateSchema.parse("pending_setup")).toBe(
      "pending_setup",
    );
    expect(issueExecutionPromptCapabilityStateSchema.parse("active")).toBe(
      "active",
    );
    expect(issueExecutionPromptCapabilityStateSchema.parse("revoked")).toBe(
      "revoked",
    );

    for (const value of [
      "session",
      "invalidated",
      "expired",
      "mention_session",
      "reusable",
    ]) {
      expect(issueExecutionNativeCorrelationPurposeSchema.safeParse(value).success).toBe(
        false,
      );
      expect(issueExecutionPromptCapabilityStateSchema.safeParse(value).success).toBe(
        false,
      );
    }
  });
});

describe("issue execution prompt settlement codec", () => {
  it("accepts each closed branch without normalizing absent accounting", () => {
    expect(
      issueExecutionPromptSettlementSchema.parse({
        promptTransmissionPhase: "not_transmitted",
        protocolSettlementState: null,
        outcome: null,
        outcomeReferenceId: null,
        accountingId: null,
        costEventId: null,
        settlementVersion: 0,
      }),
    ).toMatchObject({ protocolSettlementState: null });

    expect(
      issueExecutionPromptSettlementSchema.parse({
        promptTransmissionPhase: "not_transmitted",
        protocolSettlementState: "not_sent",
        outcome: "released_unsent",
        outcomeReferenceId,
        accountingId: null,
        costEventId: null,
        settlementVersion: 1,
      }),
    ).toMatchObject({ protocolSettlementState: "not_sent" });

    expect(
      issueExecutionPromptSettlementSchema.parse({
        promptTransmissionPhase: "transmitted",
        protocolSettlementState: "settled",
        outcome: "refused",
        outcomeReferenceId,
        accountingId,
        costEventId,
        settlementVersion: 1,
      }),
    ).toMatchObject({ protocolSettlementState: "settled" });

    expect(
      issueExecutionPromptSettlementSchema.parse({
        promptTransmissionPhase: "transmitted",
        protocolSettlementState: "incomplete",
        outcome: "ambiguous",
        outcomeReferenceId,
        accountingId: null,
        costEventId: null,
        settlementVersion: 1,
      }),
    ).toMatchObject({ protocolSettlementState: "incomplete" });
  });

  it("rejects crossed phases, one-sided accounting, aliases, and extra keys", () => {
    const settled = {
      promptTransmissionPhase: "transmitted",
      protocolSettlementState: "settled",
      outcome: "succeeded",
      outcomeReferenceId,
      accountingId,
      costEventId,
      settlementVersion: 1,
    } as const;

    expect(
      issueExecutionPromptSettlementSchema.safeParse({
        ...settled,
        promptTransmissionPhase: "not_transmitted",
      }).success,
    ).toBe(false);
    expect(
      issueExecutionPromptSettlementSchema.safeParse({
        ...settled,
        costEventId: null,
      }).success,
    ).toBe(false);
    expect(
      issueExecutionPromptSettlementSchema.safeParse({
        ...settled,
        protocolSettlementState: "complete",
      }).success,
    ).toBe(false);
    expect(
      issueExecutionPromptSettlementSchema.safeParse({
        ...settled,
        usage: {},
      }).success,
    ).toBe(false);
  });
});

describe("issue execution run liveness fact codec", () => {
  it("accepts only the five bounded fact fields", () => {
    const fact = {
      livenessState: "advanced",
      livenessReason: "A canonical same-run action was committed.",
      continuationAttempt: 0,
      lastUsefulActionAt: "2026-07-31T12:00:00.000Z",
      nextAction: null,
    } as const;

    expect(issueExecutionRunLivenessFactSchema.parse(fact)).toEqual(fact);
    expect(
      issueExecutionRunLivenessFactSchema.safeParse({
        ...fact,
        metadata: {},
      }).success,
    ).toBe(false);
    expect(
      issueExecutionRunLivenessFactSchema.safeParse({
        ...fact,
        livenessReason: " ",
      }).success,
    ).toBe(false);
  });
});

describe("issue execution watchdog decision codec", () => {
  it("accepts only the closed decision/deadline branches", () => {
    expect(
      issueExecutionWatchdogDecisionInputSchema.parse({
        decision: "snooze",
        snoozedUntil: "2026-08-01T12:00:00.000Z",
        reason: "Operator is waiting for external evidence.",
      }),
    ).toMatchObject({ decision: "snooze" });
    expect(
      issueExecutionWatchdogDecisionInputSchema.parse({
        decision: "continue",
        snoozedUntil: null,
      }),
    ).toEqual({ decision: "continue", snoozedUntil: null });
    expect(
      issueExecutionWatchdogDecisionInputSchema.safeParse({
        decision: "snooze",
        snoozedUntil: null,
      }).success,
    ).toBe(false);
    expect(
      issueExecutionWatchdogDecisionInputSchema.safeParse({
        decision: "dismissed_false_positive",
        snoozedUntil: "2026-08-01T12:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      issueExecutionWatchdogDecisionInputSchema.safeParse({
        decision: "dismissed",
      }).success,
    ).toBe(false);
    expect(
      issueExecutionWatchdogDecisionInputSchema.safeParse({
        decision: "continue",
        output: "copied evaluation",
      }).success,
    ).toBe(false);
  });
});
