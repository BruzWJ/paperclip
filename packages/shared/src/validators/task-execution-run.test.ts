import { describe, expect, it } from "vitest";
import {
  acpCostCursorStateSchema,
  taskExecutionLaneKindSchema,
  taskExecutionNativeCorrelationPurposeSchema,
  taskExecutionNativeCorrelationStateSchema,
  taskExecutionPromptCapabilityStateSchema,
  taskExecutionPromptSettlementSchema,
  taskExecutionRunKindSchema,
  taskExecutionRunLivenessFactSchema,
} from "./task-execution-run.js";
import {
  TASK_EXECUTION_RUN_KINDS,
  TASK_EXECUTION_SESSION_OPERATIONS,
} from "../types/task-execution-run.js";

const outcomeReferenceId = "00000000-0000-4000-8000-000000000001";
const accountingId = "00000000-0000-4000-8000-000000000002";
const costEventId = "00000000-0000-4000-8000-000000000003";

describe("task execution run and session-operation enums", () => {
  it("contains only ordinary productive/consult runs and native new/resume operations", () => {
    expect(TASK_EXECUTION_RUN_KINDS).toEqual(["productive", "consult"]);
    expect(taskExecutionRunKindSchema.parse("productive")).toBe("productive");
    expect(taskExecutionRunKindSchema.parse("consult")).toBe("consult");
    expect(taskExecutionRunKindSchema.safeParse("compaction").success).toBe(false);
    expect(TASK_EXECUTION_SESSION_OPERATIONS).toEqual([
      "new",
      "resume",
      "steer_resume",
    ]);
    expect(TASK_EXECUTION_SESSION_OPERATIONS).not.toContain("recovery_new");
  });
});

describe("ACP correlation and prompt capability enums", () => {
  it("accepts only the closed canonical values", () => {
    expect(taskExecutionNativeCorrelationPurposeSchema.parse("carry")).toBe(
      "carry",
    );
    expect(
      taskExecutionNativeCorrelationPurposeSchema.parse(
        "active_run_steering",
      ),
    ).toBe("active_run_steering");
    expect(taskExecutionNativeCorrelationStateSchema.parse("eligible")).toBe(
      "eligible",
    );
    expect(taskExecutionNativeCorrelationStateSchema.parse("current")).toBe(
      "current",
    );
    expect(taskExecutionNativeCorrelationStateSchema.parse("superseded")).toBe(
      "superseded",
    );
    expect(taskExecutionLaneKindSchema.parse("owner")).toBe("owner");
    expect(taskExecutionLaneKindSchema.parse("consult")).toBe("consult");
    expect(acpCostCursorStateSchema.parse("unanchored")).toBe("unanchored");
    expect(acpCostCursorStateSchema.parse("known")).toBe("known");
    expect(acpCostCursorStateSchema.parse("unavailable")).toBe("unavailable");
    expect(taskExecutionPromptCapabilityStateSchema.parse("pending_setup")).toBe(
      "pending_setup",
    );
    expect(taskExecutionPromptCapabilityStateSchema.parse("active")).toBe(
      "active",
    );
    expect(taskExecutionPromptCapabilityStateSchema.parse("revoked")).toBe(
      "revoked",
    );

    for (const value of [
      "session",
      "invalidated",
      "expired",
      "mention_session",
      "reusable",
    ]) {
      expect(taskExecutionNativeCorrelationPurposeSchema.safeParse(value).success).toBe(
        false,
      );
      expect(taskExecutionPromptCapabilityStateSchema.safeParse(value).success).toBe(
        false,
      );
    }
  });
});

describe("task execution prompt settlement codec", () => {
  it("accepts each closed branch without normalizing absent accounting", () => {
    expect(
      taskExecutionPromptSettlementSchema.parse({
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
      taskExecutionPromptSettlementSchema.parse({
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
      taskExecutionPromptSettlementSchema.parse({
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
      taskExecutionPromptSettlementSchema.parse({
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
      taskExecutionPromptSettlementSchema.safeParse({
        ...settled,
        promptTransmissionPhase: "not_transmitted",
      }).success,
    ).toBe(false);
    expect(
      taskExecutionPromptSettlementSchema.safeParse({
        ...settled,
        costEventId: null,
      }).success,
    ).toBe(false);
    expect(
      taskExecutionPromptSettlementSchema.safeParse({
        ...settled,
        protocolSettlementState: "complete",
      }).success,
    ).toBe(false);
    expect(
      taskExecutionPromptSettlementSchema.safeParse({
        ...settled,
        usage: {},
      }).success,
    ).toBe(false);
  });
});

describe("task execution run liveness fact codec", () => {
  it("accepts only the five bounded fact fields", () => {
    const fact = {
      livenessState: "advanced",
      livenessReason: "A canonical same-run action was committed.",
      continuationAttempt: 0,
      lastUsefulActionAt: "2026-07-31T12:00:00.000Z",
      nextAction: null,
    } as const;

    expect(taskExecutionRunLivenessFactSchema.parse(fact)).toEqual(fact);
    expect(
      taskExecutionRunLivenessFactSchema.safeParse({
        ...fact,
        metadata: {},
      }).success,
    ).toBe(false);
    expect(
      taskExecutionRunLivenessFactSchema.safeParse({
        ...fact,
        livenessReason: " ",
      }).success,
    ).toBe(false);
  });
});
