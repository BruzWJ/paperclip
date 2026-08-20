import { createHash } from "node:crypto";
import type { AcpPromptSettlement } from "@paperclipai/adapter-utils/acpx-runtime";
import {
  canonicalizeMoneyAmount,
  parseBudgetCurrency,
  type AcpCostCursor,
  type AcpCostSettlement,
  type BudgetCurrency,
  type TaskExecutionPromptOutcome,
} from "@paperclipai/shared";
import { type BudgetEnforcementScope } from "./budgets.js";

export const TERMINAL_STOP_REASONS = new Set([
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
]);

export class AcpPromptSettlementRejected extends Error {
  readonly code = "acp_prompt_settlement_rejected";

  constructor(message: string) {
    super(message);
    this.name = "AcpPromptSettlementRejected";
  }
}

export interface AcpPromptSettlementCommonIdentity {
  readonly companyId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly adapterConfigRevisionId: string;
}

export type AcpProductivePromptSettlementIdentity = AcpPromptSettlementCommonIdentity & {
  readonly runKind: "productive" | "consult";
  readonly refId: string;
  readonly runOrdinal: number;
};

export type AcpPromptSettlementIdentity = AcpProductivePromptSettlementIdentity;

/**
 * The fixed durable accounting bridge for one already-materialized assistant.
 * The event id/sequence and assistant id must have been reserved in this same
 * transaction before calling the settlement owner.
 */
export interface AcpPromptStepEndedPublication {
  readonly eventId: string;
  readonly eventSeq: number;
  readonly assistantMessageId: string;
  readonly snapshot?: string;
  readonly files?: readonly string[];
}

export interface SettleAcpPromptInTransactionInput {
  readonly identity: AcpPromptSettlementIdentity;
  readonly settlement: AcpPromptSettlement;
  readonly promptSettlementReferenceId: string;
  readonly terminalUsageReference: string;
  readonly terminalStopReference: string;
  readonly stepEnded: AcpPromptStepEndedPublication;
  readonly settledAt: Date;
}

export interface SettledAcpPromptResult {
  readonly promptSettlementReferenceId: string;
  readonly accountingId: string;
  readonly costEventId: string;
  readonly budgetCurrency: BudgetCurrency;
  /**
   * The model identifier only when ACPX exposed a portable selected model.
   * ACP does not require every frontend to publish this metadata.
   */
  readonly selectedModelId: string | null;
  readonly contextTokenLimit: number;
  readonly cost: AcpCostSettlement;
  readonly stepEndedEventId: string;
  /** Enforce only after the caller's outer settlement transaction commits. */
  readonly budgetSuspensionScopes: readonly BudgetEnforcementScope[];
}

export type ProductivePromptOwner = {
  readonly attemptId: string | null;
  readonly capabilityConnectionId: string | null;
  readonly capabilityGeneration: number | null;
  readonly promptTransmissionPhase: string;
  readonly protocolSettlementState: string | null;
  readonly settlementVersion: number;
};

export type AcpPromptAccountingModel = {
  readonly value: string;
} | null;

export function reject(message: string): never {
  throw new AcpPromptSettlementRejected(message);
}

/**
 * ACP reports terminal context occupancy for every settled prompt, but model
 * metadata is an optional ACPX extension. The observed terminal occupancy
 * window is the sole canonical accounting limit.
 */
export function resolveAcpPromptAccountingModel(
  model: AcpPromptAccountingModel,
  occupancySize: number,
): {
  readonly selectedModelId: string | null;
  readonly contextTokenLimit: number;
} {
  const selectedModelId = model?.value ?? null;
  return {
    selectedModelId,
    contextTokenLimit: occupancySize,
  };
}

export function requireCanonicalReference(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 500 || value !== value.trim()) {
    reject(`${label} must be a nonempty canonical string of at most 500 characters`);
  }
  return value;
}

export function assertSettlementInput(input: SettleAcpPromptInTransactionInput): void {
  const identity = input.identity;
  if (!Number.isSafeInteger(identity.runOrdinal) || identity.runOrdinal < 0) {
    reject("ACP prompt run ordinal must be a nonnegative safe integer");
  }
  if (input.settlement.kind !== "protocol_settled") {
    reject("Only a protocol-settled ACP prompt may enter accounting");
  }
  const occupancy = input.settlement.occupancy;
  if (
    !Number.isSafeInteger(occupancy.used) ||
    occupancy.used < 0 ||
    !Number.isSafeInteger(occupancy.size) ||
    occupancy.size <= 0 ||
    occupancy.used > occupancy.size
  ) {
    reject("ACP prompt terminal occupancy is invalid");
  }
  if (!TERMINAL_STOP_REASONS.has(input.settlement.stopReason)) {
    reject("ACP prompt terminal stop reason is invalid");
  }
  requireCanonicalReference(input.promptSettlementReferenceId, "ACP prompt settlement reference");
  requireCanonicalReference(input.terminalUsageReference, "ACP terminal usage reference");
  requireCanonicalReference(input.terminalStopReference, "ACP terminal stop reference");
  if (
    !(input.settledAt instanceof Date) ||
    !Number.isFinite(input.settledAt.getTime()) ||
    input.settledAt.getTime() < 0
  ) {
    reject("ACP prompt settlement timestamp is invalid");
  }
  if (typeof input.stepEnded.eventId !== "string" || !input.stepEnded.eventId.startsWith("evt_")) {
    reject("ACP Step.Ended event id is invalid");
  }
  if (!Number.isSafeInteger(input.stepEnded.eventSeq) || input.stepEnded.eventSeq < 0) {
    reject("ACP Step.Ended event sequence is invalid");
  }
  requireCanonicalReference(input.stepEnded.assistantMessageId, "ACP Step.Ended assistant message id");
}

export function outcomeForStopReason(
  stopReason: AcpPromptSettlement["stopReason"],
): TaskExecutionPromptOutcome {
  if (stopReason === "refusal") return "refused";
  if (stopReason === "cancelled") return "cancelled";
  return "succeeded";
}

export function cursorFromRow(row: {
  readonly costCursorState: "unanchored" | "known" | "unavailable";
  readonly costCursorAmount: string | null;
  readonly costCursorCurrency: string | null;
}): AcpCostCursor {
  if (row.costCursorState === "unanchored") {
    if (row.costCursorAmount !== null || row.costCursorCurrency !== null) {
      reject("Unanchored ACP cost cursor contains a value");
    }
    return { state: "unanchored" };
  }
  if (row.costCursorState === "unavailable") {
    if (row.costCursorAmount !== null || row.costCursorCurrency !== null) {
      reject("Unavailable ACP cost cursor contains a value");
    }
    return { state: "unavailable" };
  }
  if (row.costCursorAmount === null || row.costCursorCurrency === null) {
    reject("Known ACP cost cursor is incomplete");
  }
  return {
    state: "known",
    amount: canonicalizeMoneyAmount(row.costCursorAmount),
    currency: parseBudgetCurrency(row.costCursorCurrency),
  };
}

export function costCursorColumns(cursor: Exclude<AcpCostCursor, { state: "unanchored" }>) {
  return cursor.state === "known"
    ? {
        costCursorState: "known" as const,
        costCursorAmount: cursor.amount,
        costCursorCurrency: cursor.currency,
      }
    : {
        costCursorState: "unavailable" as const,
        costCursorAmount: null,
        costCursorCurrency: null,
      };
}

export function auditCursorColumns(cursor: AcpCostCursor) {
  return cursor.state === "known"
    ? {
        state: cursor.state,
        amount: cursor.amount,
        currency: cursor.currency,
      }
    : { state: cursor.state, amount: null, currency: null };
}

export function donorStepCost(cost: AcpCostSettlement): number | null {
  if (cost.kind !== "known") return null;
  // The adopted Session event codec intentionally retains its finite-number
  // cost field. MoneyAmount remains authoritative in cost_events; this value
  // is only the conditional donor projection required by Step.Ended.3.
  const projected = Number(cost.knownDeltaAmount);
  if (!Number.isFinite(projected) || projected < 0) {
    reject("Known ACP prompt cost cannot enter the finite Session projection");
  }
  return projected;
}

export function sourceIdentityDigest(input: {
  readonly identity: AcpPromptSettlementIdentity;
  readonly promptSettlementReferenceId: string;
  readonly accountingId: string;
  readonly costEventId: string;
  readonly eventId: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: "acp_prompt_settlement",
        companyId: input.identity.companyId,
        taskId: input.identity.taskId,
        sessionId: input.identity.sessionId,
        runId: input.identity.runId,
        runKind: input.identity.runKind,
        refId: input.identity.refId,
        runOrdinal: input.identity.runOrdinal,
        promptSettlementReferenceId: input.promptSettlementReferenceId,
        accountingId: input.accountingId,
        costEventId: input.costEventId,
        eventId: input.eventId,
      }),
    )
    .digest("hex");
}
