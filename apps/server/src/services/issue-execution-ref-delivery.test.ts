import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  classifyIssueExecutionRefDelivery,
  isCanonicalIssueExecutionBaseRecoveryDelivery,
  isIssueExecutionRefDeliveryEligible,
  issueExecutionRefDeliveryEligibilitySql,
} from "./issue-execution-ref-delivery.js";

const dialect = new PgDialect();

describe("canonical issue-execution ref delivery eligibility", () => {
  it("keeps promoted user inputs and direct synthetic events as the only dispatchable shapes", () => {
    const user = {
      messageKind: "user" as const,
      inputId: "input",
      admittedSeq: 4,
      promotedSeq: 5,
    };
    const synthetic = {
      messageKind: "synthetic" as const,
      inputId: null,
      admittedSeq: null,
      promotedSeq: null,
    };
    expect(classifyIssueExecutionRefDelivery(user)).toBe("user_dispatchable");
    expect(classifyIssueExecutionRefDelivery(synthetic)).toBe(
      "synthetic_dispatchable",
    );
    expect(isIssueExecutionRefDeliveryEligible(user, "dispatch")).toBe(true);
    expect(isIssueExecutionRefDeliveryEligible(synthetic, "dispatch")).toBe(
      true,
    );
  });

  it("reconciles a user ref before or after promotion without accepting mixed shapes", () => {
    const awaiting = {
      messageKind: "user" as const,
      inputId: "input",
      admittedSeq: 4,
      promotedSeq: null,
    };
    expect(classifyIssueExecutionRefDelivery(awaiting)).toBe(
      "user_awaiting_promotion",
    );
    expect(isIssueExecutionRefDeliveryEligible(awaiting, "reconcile")).toBe(
      true,
    );
    expect(isIssueExecutionRefDeliveryEligible(awaiting, "dispatch")).toBe(
      false,
    );
    expect(
      classifyIssueExecutionRefDelivery({
        messageKind: "synthetic",
        inputId: "fabricated-input",
        admittedSeq: null,
        promotedSeq: null,
      }),
    ).toBe("invalid");
  });

  it("rejects unsafe sequence numbers in both domain and SQL delivery predicates", () => {
    expect(
      classifyIssueExecutionRefDelivery({
        messageKind: "user",
        inputId: "input",
        admittedSeq: Number.MAX_SAFE_INTEGER + 1,
        promotedSeq: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toBe("invalid");
    for (const purpose of ["dispatch", "reconcile"] as const) {
      expect(
        dialect.sqlToQuery(
          issueExecutionRefDeliveryEligibilitySql(purpose),
        ).sql,
      ).toContain("9007199254740991");
    }
  });

  it("binds base recovery to the exact classified ref and input sequences", () => {
    const canonical = {
      ref: {
        messageKind: "user" as const,
        inputId: "message",
        sourceMessageId: "message",
        admittedSeq: 4,
        promotedSeq: 5,
      },
      memberInputId: "message",
      sourceMessageId: "message",
      sourceMessageKind: "user" as const,
      sourceInput: {
        id: "message",
        delivery: "queue" as const,
        admittedSeq: 4,
        promotedSeq: 5,
      },
    };
    expect(
      isCanonicalIssueExecutionBaseRecoveryDelivery(canonical),
    ).toBe(true);
    expect(
      isCanonicalIssueExecutionBaseRecoveryDelivery({
        ...canonical,
        sourceInput: { ...canonical.sourceInput, promotedSeq: 6 },
      }),
    ).toBe(false);
    expect(
      isCanonicalIssueExecutionBaseRecoveryDelivery({
        ...canonical,
        ref: { ...canonical.ref, promotedSeq: null },
        sourceInput: { ...canonical.sourceInput, promotedSeq: null },
      }),
    ).toBe(false);
    expect(
      isCanonicalIssueExecutionBaseRecoveryDelivery({
        ref: {
          messageKind: "synthetic",
          inputId: null,
          sourceMessageId: "synthetic-message",
          admittedSeq: null,
          promotedSeq: null,
        },
        memberInputId: null,
        sourceMessageId: "synthetic-message",
        sourceMessageKind: "synthetic",
        sourceInput: null,
      }),
    ).toBe(true);
    expect(
      isCanonicalIssueExecutionBaseRecoveryDelivery({
        ref: {
          messageKind: "synthetic",
          inputId: null,
          sourceMessageId: "synthetic-message",
          admittedSeq: null,
          promotedSeq: null,
        },
        memberInputId: "fabricated-input",
        sourceMessageId: "synthetic-message",
        sourceMessageKind: "synthetic",
        sourceInput: null,
      }),
    ).toBe(false);
  });

  it("emits one closed SQL predicate for each lifecycle purpose", () => {
    const dispatch = dialect.sqlToQuery(
      issueExecutionRefDeliveryEligibilitySql("dispatch"),
    ).sql;
    const reconcile = dialect.sqlToQuery(
      issueExecutionRefDeliveryEligibilitySql("reconcile"),
    ).sql;
    for (const predicate of [dispatch, reconcile]) {
      expect(predicate).toContain("message_kind");
      expect(predicate).toContain("= 'user'");
      expect(predicate).toContain("= 'synthetic'");
      expect(predicate).toContain("9007199254740991");
    }
    expect(dispatch).toContain("promoted_seq\" is not null");
    expect(reconcile).toContain("promoted_seq\" is null");
  });
});
