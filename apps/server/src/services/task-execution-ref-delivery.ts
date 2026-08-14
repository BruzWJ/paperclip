import { taskExecutionRefs } from "@paperclipai/db";
import { sql, type SQL } from "drizzle-orm";

export type TaskExecutionRefDeliveryState =
  "user_awaiting_promotion" | "user_dispatchable" | "synthetic_dispatchable" | "invalid";

export type TaskExecutionRefDeliveryPurpose = "dispatch" | "reconcile";

type DeliveryShape = Pick<
  typeof taskExecutionRefs.$inferSelect,
  "messageKind" | "inputId" | "admittedSeq" | "promotedSeq"
>;

/**
 * The sole domain interpretation of an execution ref's user/synthetic source
 * tuple. Synthetic refs are direct canonical events; they never fabricate a
 * Session input or promotion sequence.
 */
export function classifyTaskExecutionRefDelivery(ref: DeliveryShape): TaskExecutionRefDeliveryState {
  if (ref.messageKind === "synthetic") {
    return ref.inputId === null && ref.admittedSeq === null && ref.promotedSeq === null
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
  return Number.isSafeInteger(ref.promotedSeq) && ref.promotedSeq >= ref.admittedSeq
    ? "user_dispatchable"
    : "invalid";
}

export function isTaskExecutionRefDeliveryEligible(
  ref: DeliveryShape,
  purpose: TaskExecutionRefDeliveryPurpose,
): boolean {
  const state = classifyTaskExecutionRefDelivery(ref);
  return purpose === "dispatch"
    ? state === "user_dispatchable" || state === "synthetic_dispatchable"
    : state !== "invalid";
}

/** SQL equivalent of the canonical domain predicate above. */
export function taskExecutionRefDeliveryEligibilitySql(purpose: TaskExecutionRefDeliveryPurpose): SQL {
  const userPromotion =
    purpose === "dispatch"
      ? sql`and ${taskExecutionRefs.promotedSeq} is not null
          and ${taskExecutionRefs.promotedSeq} >= ${taskExecutionRefs.admittedSeq}
          and ${taskExecutionRefs.promotedSeq} <= 9007199254740991`
      : sql`and (
          ${taskExecutionRefs.promotedSeq} is null
          or (
            ${taskExecutionRefs.promotedSeq} >= ${taskExecutionRefs.admittedSeq}
            and ${taskExecutionRefs.promotedSeq} <= 9007199254740991
          )
        )`;
  return sql`(
    (
      ${taskExecutionRefs.messageKind} = 'user'
      and ${taskExecutionRefs.inputId} is not null
      and ${taskExecutionRefs.admittedSeq} is not null
      and ${taskExecutionRefs.admittedSeq} >= 0
      and ${taskExecutionRefs.admittedSeq} <= 9007199254740991
      ${userPromotion}
    ) or (
      ${taskExecutionRefs.messageKind} = 'synthetic'
      and ${taskExecutionRefs.inputId} is null
      and ${taskExecutionRefs.admittedSeq} is null
      and ${taskExecutionRefs.promotedSeq} is null
    )
  )`;
}
