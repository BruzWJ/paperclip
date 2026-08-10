import { z } from "zod";
import { RUN_LIVENESS_STATES } from "../constants.js";
import {
  ACP_COST_CURSOR_STATES,
  ISSUE_EXECUTION_FINALIZATION_ACTIONS,
  ISSUE_EXECUTION_LANE_KINDS,
  ISSUE_EXECUTION_NATIVE_CORRELATION_PURPOSES,
  ISSUE_EXECUTION_NATIVE_CORRELATION_STATES,
  ISSUE_EXECUTION_PROMPT_OUTCOMES,
  ISSUE_EXECUTION_PROMPT_CAPABILITY_STATES,
  ISSUE_EXECUTION_PROMPT_TRANSMISSION_PHASES,
  ISSUE_EXECUTION_PROTOCOL_SETTLEMENT_STATES,
  ISSUE_EXECUTION_RUN_KINDS,
  ISSUE_EXECUTION_RUN_STATUSES,
  ISSUE_EXECUTION_RUN_TERMINAL_CLASSIFICATIONS,
  ISSUE_EXECUTION_STEERING_STATES,
} from "../types/issue-execution-run.js";

const uuidSchema = z.string().uuid();

export const issueExecutionRunKindSchema = z.enum(
  ISSUE_EXECUTION_RUN_KINDS,
);

export const issueExecutionRunStatusSchema = z.enum(
  ISSUE_EXECUTION_RUN_STATUSES,
);

export const issueExecutionRunTerminalClassificationSchema = z.enum(
  ISSUE_EXECUTION_RUN_TERMINAL_CLASSIFICATIONS,
);

export const issueExecutionPromptTransmissionPhaseSchema = z.enum(
  ISSUE_EXECUTION_PROMPT_TRANSMISSION_PHASES,
);

export const issueExecutionProtocolSettlementStateSchema = z.enum(
  ISSUE_EXECUTION_PROTOCOL_SETTLEMENT_STATES,
);

export const issueExecutionPromptOutcomeSchema = z.enum(
  ISSUE_EXECUTION_PROMPT_OUTCOMES,
);

export const issueExecutionSteeringStateSchema = z.enum(
  ISSUE_EXECUTION_STEERING_STATES,
);

export const issueExecutionNativeCorrelationPurposeSchema = z.enum(
  ISSUE_EXECUTION_NATIVE_CORRELATION_PURPOSES,
);

export const issueExecutionNativeCorrelationStateSchema = z.enum(
  ISSUE_EXECUTION_NATIVE_CORRELATION_STATES,
);

export const issueExecutionLaneKindSchema = z.enum(
  ISSUE_EXECUTION_LANE_KINDS,
);

export const acpCostCursorStateSchema = z.enum(ACP_COST_CURSOR_STATES);

export const issueExecutionPromptCapabilityStateSchema = z.enum(
  ISSUE_EXECUTION_PROMPT_CAPABILITY_STATES,
);

export const issueExecutionFinalizationActionSchema = z.enum(
  ISSUE_EXECUTION_FINALIZATION_ACTIONS,
);

const activePromptSettlementSchema = z
  .object({
    promptTransmissionPhase: issueExecutionPromptTransmissionPhaseSchema,
    protocolSettlementState: z.null(),
    outcome: z.null(),
    outcomeReferenceId: z.null(),
    accountingId: z.null(),
    costEventId: z.null(),
    settlementVersion: z.literal(0),
  })
  .strict();

const notSentPromptSettlementSchema = z
  .object({
    promptTransmissionPhase: z.literal("not_transmitted"),
    protocolSettlementState: z.literal("not_sent"),
    outcome: z.literal("released_unsent"),
    outcomeReferenceId: uuidSchema,
    accountingId: z.null(),
    costEventId: z.null(),
    settlementVersion: z.number().int().positive(),
  })
  .strict();

const settledPromptSettlementSchema = z
  .object({
    promptTransmissionPhase: z.literal("transmitted"),
    protocolSettlementState: z.literal("settled"),
    outcome: z.enum(["succeeded", "refused", "failed", "cancelled"]),
    outcomeReferenceId: uuidSchema,
    accountingId: uuidSchema,
    costEventId: uuidSchema,
    settlementVersion: z.number().int().positive(),
  })
  .strict();

const incompletePromptSettlementSchema = z
  .object({
    promptTransmissionPhase: z.literal("transmitted"),
    protocolSettlementState: z.literal("incomplete"),
    outcome: z.enum(["failed", "ambiguous", "cancelled"]),
    outcomeReferenceId: uuidSchema,
    accountingId: z.null(),
    costEventId: z.null(),
    settlementVersion: z.number().int().positive(),
  })
  .strict();

export const issueExecutionPromptSettlementSchema = z.union([
  activePromptSettlementSchema,
  notSentPromptSettlementSchema,
  settledPromptSettlementSchema,
  incompletePromptSettlementSchema,
]);

export const issueExecutionRunLivenessFactSchema = z
  .object({
    livenessState: z.enum(RUN_LIVENESS_STATES),
    livenessReason: z.string().trim().min(1).max(500),
    continuationAttempt: z.number().int().nonnegative(),
    lastUsefulActionAt: z.string().datetime().nullable(),
    nextAction: z.string().trim().min(1).max(500).nullable(),
  })
  .strict();

export type IssueExecutionPromptSettlementInput = z.infer<
  typeof issueExecutionPromptSettlementSchema
>;

export type IssueExecutionRunLivenessFactInput = z.infer<
  typeof issueExecutionRunLivenessFactSchema
>;
