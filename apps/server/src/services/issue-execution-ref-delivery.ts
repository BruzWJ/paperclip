import { issueExecutionRefs } from "@paperclipai/db";
import { sql, type SQL } from "drizzle-orm";

export type IssueExecutionRefDeliveryState =
  | "user_awaiting_promotion"
  | "user_dispatchable"
  | "synthetic_dispatchable"
  | "invalid";

export type IssueExecutionRefDeliveryPurpose = "dispatch" | "reconcile";

type DeliveryShape = Pick<
  typeof issueExecutionRefs.$inferSelect,
  "messageKind" | "inputId" | "admittedSeq" | "promotedSeq"
>;

type BaseRecoveryDeliveryShape = {
  readonly ref: DeliveryShape & { readonly sourceMessageId: string };
  readonly memberInputId: string | null;
  readonly sourceMessageId: string;
  readonly sourceMessageKind: "user" | "synthetic";
  readonly sourceInput: {
    readonly id: string;
    readonly delivery: "queue" | "steer";
    readonly admittedSeq: number;
    readonly promotedSeq: number | null;
  } | null;
};

/**
 * The sole domain interpretation of an execution ref's user/synthetic source
 * tuple. Synthetic refs are direct canonical events; they never fabricate a
 * Session input or promotion sequence.
 */
export function classifyIssueExecutionRefDelivery(
  ref: DeliveryShape,
): IssueExecutionRefDeliveryState {
  if (ref.messageKind === "synthetic") {
    return ref.inputId === null &&
        ref.admittedSeq === null &&
        ref.promotedSeq === null
      ? "synthetic_dispatchable"
      : "invalid";
  }
  if (
    ref.messageKind !== "user" ||
    ref.inputId === null ||
    ref.admittedSeq === null ||
    !Number.isSafeInteger(ref.admittedSeq) ||
    ref.admittedSeq < 0
  ) {
    return "invalid";
  }
  if (ref.promotedSeq === null) return "user_awaiting_promotion";
  return Number.isSafeInteger(ref.promotedSeq) &&
      ref.promotedSeq >= ref.admittedSeq
    ? "user_dispatchable"
    : "invalid";
}

export function isIssueExecutionRefDeliveryEligible(
  ref: DeliveryShape,
  purpose: IssueExecutionRefDeliveryPurpose,
): boolean {
  const state = classifyIssueExecutionRefDelivery(ref);
  return purpose === "dispatch"
    ? state === "user_dispatchable" || state === "synthetic_dispatchable"
    : state !== "invalid";
}

/**
 * Cross-checks a segment-zero recovery projection against the ref tuple that
 * the canonical delivery classifier accepted for dispatch.
 */
export function isCanonicalIssueExecutionBaseRecoveryDelivery(
  input: BaseRecoveryDeliveryShape,
): boolean {
  const state = classifyIssueExecutionRefDelivery(input.ref);
  if (state === "user_dispatchable") {
    return input.ref.inputId !== null &&
      input.ref.admittedSeq !== null &&
      input.ref.promotedSeq !== null &&
      input.memberInputId === input.ref.inputId &&
      input.sourceMessageId === input.ref.sourceMessageId &&
      input.sourceMessageId === input.ref.inputId &&
      input.sourceMessageKind === "user" &&
      input.sourceInput?.id === input.ref.inputId &&
      input.sourceInput.delivery === "queue" &&
      input.sourceInput.admittedSeq === input.ref.admittedSeq &&
      input.sourceInput.promotedSeq === input.ref.promotedSeq;
  }
  return state === "synthetic_dispatchable" &&
    input.memberInputId === null &&
    input.sourceMessageId === input.ref.sourceMessageId &&
    input.sourceMessageKind === "synthetic" &&
    input.sourceInput === null;
}

/** SQL equivalent of the canonical domain predicate above. */
export function issueExecutionRefDeliveryEligibilitySql(
  purpose: IssueExecutionRefDeliveryPurpose,
): SQL {
  const userPromotion = purpose === "dispatch"
    ? sql`and ${issueExecutionRefs.promotedSeq} is not null
          and ${issueExecutionRefs.promotedSeq} >= ${issueExecutionRefs.admittedSeq}
          and ${issueExecutionRefs.promotedSeq} <= 9007199254740991`
    : sql`and (
          ${issueExecutionRefs.promotedSeq} is null
          or (
            ${issueExecutionRefs.promotedSeq} >= ${issueExecutionRefs.admittedSeq}
            and ${issueExecutionRefs.promotedSeq} <= 9007199254740991
          )
        )`;
  return sql`(
    (
      ${issueExecutionRefs.messageKind} = 'user'
      and ${issueExecutionRefs.inputId} is not null
      and ${issueExecutionRefs.admittedSeq} is not null
      and ${issueExecutionRefs.admittedSeq} >= 0
      and ${issueExecutionRefs.admittedSeq} <= 9007199254740991
      ${userPromotion}
    ) or (
      ${issueExecutionRefs.messageKind} = 'synthetic'
      and ${issueExecutionRefs.inputId} is null
      and ${issueExecutionRefs.admittedSeq} is null
      and ${issueExecutionRefs.promotedSeq} is null
    )
  )`;
}
