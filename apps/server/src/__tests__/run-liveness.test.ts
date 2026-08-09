import { describe, expect, it } from "vitest";
import {
  classifyRunLiveness,
  type RunLivenessClassificationInput,
} from "../services/run-liveness.ts";

const baseInput = {
  runStatus: "succeeded",
  issueLifecycleStatus: "open",
  assistantTextParts: [],
  failureFacts: {
    terminalReasonCode: "protocol_settled",
    assistantErrors: [],
  },
  continuationAttempt: 0,
  evidence: null,
} satisfies RunLivenessClassificationInput;

describe("run liveness classifier", () => {
  it("classifies text-only future work as plan_only", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      assistantTextParts: [
        "I will inspect the repo next and then implement the fix.",
      ],
    });

    expect(classification.livenessState).toBe("plan_only");
    expect(classification.actionability).toBe("runnable");
    expect(classification.nextAction).toContain("inspect the repo");
  });

  it("classifies empty successful output as empty_response", () => {
    const classification = classifyRunLiveness(baseInput);

    expect(classification.livenessState).toBe("empty_response");
    expect(classification.actionability).toBe("unknown");
  });

  it("treats documents, products, and actions as progress", () => {
    const latestEvidenceAt = new Date("2026-04-18T12:00:00Z");
    const classification = classifyRunLiveness({
      ...baseInput,
      assistantTextParts: ["Updated implementation."],
      evidence: {
        documentRevisionsCreated: 1,
        workProductsCreated: 1,
        toolOrActionEventsCreated: 1,
        latestEvidenceAt,
      },
    });

    expect(classification.livenessState).toBe("advanced");
    expect(classification.lastUsefulActionAt).toBe(latestEvidenceAt);
  });

  it("does not treat workspace operations alone as concrete progress", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      assistantTextParts: ["I will inspect the repo next."],
      evidence: {
        latestEvidenceAt: new Date("2026-04-18T12:00:00Z"),
      },
    });

    expect(classification.livenessState).toBe("plan_only");
    expect(classification.lastUsefulActionAt).toBeNull();
  });

  it("does not infer a planning exemption without typed action evidence", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      assistantTextParts: [
        "Plan:\n- Inspect files\n- Implement after approval",
      ],
    });

    expect(classification.livenessState).toBe("plan_only");
  });

  it("exempts runs that update the plan document from plan-only classification", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      assistantTextParts: [
        "Next steps:\n- inspect files\n- implement the service",
      ],
      evidence: {
        documentRevisionsCreated: 1,
        planDocumentRevisionsCreated: 1,
        latestEvidenceAt: new Date("2026-04-18T12:00:00Z"),
      },
    });

    expect(classification.livenessState).toBe("advanced");
  });

  it("classifies done issues as completed", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      issueLifecycleStatus: "done",
      assistantTextParts: ["Finished the implementation."],
    });

    expect(classification.livenessState).toBe("completed");
  });

  it("classifies declared blockers as blocked", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      assistantTextParts: [
        "I cannot proceed because I need access credentials.",
      ],
    });

    expect(classification.livenessState).toBe("blocked");
    expect(classification.actionability).toBe("blocked_external");
  });

  it("preserves the typed blocked lifecycle fact", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      issueLifecycleStatus: "blocked",
      assistantTextParts: ["Recorded the current state."],
    });

    expect(classification.livenessState).toBe("blocked");
    expect(classification.livenessReason).toBe("Issue status is blocked");
  });

  it("treats issue-chain validation output as runnable follow-up", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      assistantTextParts: [
        [
          "PAP-1949 remains blocked until PAP-2000 is resolved.",
          "Validation is ready for the next pass.",
          "",
          "- Blocked chain context: PAP-1949 -> PAP-1999 -> PAP-2000",
          "- Next action: run npm test and report the row counts.",
        ].join("\n"),
      ],
    });

    expect(classification.livenessState).toBe("plan_only");
    expect(classification.actionability).toBe("runnable");
    expect(classification.nextAction).toBe(
      "run npm test and report the row counts.",
    );
  });

  it("uses the ordered canonical Session assistant parts", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      assistantTextParts: [
        "Next action: run pnpm test -- --runInBand.",
        "Completed additional verification.",
      ],
    });

    expect(classification.actionability).toBe("runnable");
    expect(classification.nextAction).toBe(
      "run pnpm test -- --runInBand.",
    );
  });

  it("keeps approval requests out of automatic continuation", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      assistantTextParts: [
        "Next action: wait for board approval before continuing.",
      ],
    });

    expect(classification.livenessState).toBe("blocked");
    expect(classification.actionability).toBe("approval_required");
    expect(classification.nextAction).toBe(
      "wait for board approval before continuing.",
    );
  });

  it("routes production-sensitive next actions to manager review", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      assistantTextParts: [
        "Next action: deploy to production and verify live traffic.",
      ],
    });

    expect(classification.livenessState).toBe("needs_followup");
    expect(classification.actionability).toBe("manager_review");
    expect(classification.nextAction).toBe(
      "deploy to production and verify live traffic.",
    );
  });

  it("uses the typed background-task terminal reason", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      runStatus: "failed",
      failureFacts: {
        terminalReasonCode: "unmanaged_background_task_stopped",
        assistantErrors: [],
      },
    });

    expect(classification.livenessState).toBe("failed");
    expect(classification.livenessReason).toBe(
      "unmanaged background task stopped; no durable live path",
    );
  });

  it("derives failed-run detail from typed assistant error kinds", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      runStatus: "failed",
      failureFacts: {
        terminalReasonCode: "provider_error",
        assistantErrors: [
          { type: "AuthError" },
          { type: "AuthError" },
        ],
      },
    });

    expect(classification.livenessReason).toBe(
      "Run ended with failed (provider_error; assistant error AuthError)",
    );
  });

  it("marks unclear useful output as unknown actionability", () => {
    const classification = classifyRunLiveness({
      ...baseInput,
      assistantTextParts: [
        "Observed mixed output and left notes for a later pass.",
      ],
    });

    expect(classification.livenessState).toBe("needs_followup");
    expect(classification.actionability).toBe("unknown");
    expect(classification.nextAction).toBeNull();
  });
});
