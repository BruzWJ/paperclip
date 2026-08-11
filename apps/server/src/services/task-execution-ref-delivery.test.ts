import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  classifyTaskExecutionRefDelivery,
  isCanonicalTaskExecutionBaseRecoveryDelivery,
  isTaskExecutionRefDeliveryEligible,
  taskExecutionRefDeliveryEligibilitySql,
} from "./task-execution-ref-delivery.js";

const dialect = new PgDialect();

describe("canonical task-execution ref delivery eligibility", () => {
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
    expect(classifyTaskExecutionRefDelivery(user)).toBe("user_dispatchable");
    expect(classifyTaskExecutionRefDelivery(synthetic)).toBe(
      "synthetic_dispatchable",
    );
    expect(isTaskExecutionRefDeliveryEligible(user, "dispatch")).toBe(true);
    expect(isTaskExecutionRefDeliveryEligible(synthetic, "dispatch")).toBe(
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
    expect(classifyTaskExecutionRefDelivery(awaiting)).toBe(
      "user_awaiting_promotion",
    );
    expect(isTaskExecutionRefDeliveryEligible(awaiting, "reconcile")).toBe(
      true,
    );
    expect(isTaskExecutionRefDeliveryEligible(awaiting, "dispatch")).toBe(
      false,
    );
    expect(
      classifyTaskExecutionRefDelivery({
        messageKind: "synthetic",
        inputId: "fabricated-input",
        admittedSeq: null,
        promotedSeq: null,
      }),
    ).toBe("invalid");
  });

  it("rejects unsafe sequence numbers in both domain and SQL delivery predicates", () => {
    expect(
      classifyTaskExecutionRefDelivery({
        messageKind: "user",
        inputId: "input",
        admittedSeq: Number.MAX_SAFE_INTEGER + 1,
        promotedSeq: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toBe("invalid");
    for (const purpose of ["dispatch", "reconcile"] as const) {
      expect(
        dialect.sqlToQuery(
          taskExecutionRefDeliveryEligibilitySql(purpose),
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
      isCanonicalTaskExecutionBaseRecoveryDelivery(canonical),
    ).toBe(true);
    expect(
      isCanonicalTaskExecutionBaseRecoveryDelivery({
        ...canonical,
        sourceInput: { ...canonical.sourceInput, promotedSeq: 6 },
      }),
    ).toBe(false);
    expect(
      isCanonicalTaskExecutionBaseRecoveryDelivery({
        ...canonical,
        ref: { ...canonical.ref, promotedSeq: null },
        sourceInput: { ...canonical.sourceInput, promotedSeq: null },
      }),
    ).toBe(false);
    expect(
      isCanonicalTaskExecutionBaseRecoveryDelivery({
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
      isCanonicalTaskExecutionBaseRecoveryDelivery({
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
      taskExecutionRefDeliveryEligibilitySql("dispatch"),
    ).sql;
    const reconcile = dialect.sqlToQuery(
      taskExecutionRefDeliveryEligibilitySql("reconcile"),
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
