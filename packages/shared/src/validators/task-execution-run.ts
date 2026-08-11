import { z } from "zod";
import { RUN_LIVENESS_STATES } from "../constants.js";
import {
  ACP_COST_CURSOR_STATES,
  TASK_EXECUTION_FINALIZATION_ACTIONS,
  TASK_EXECUTION_LANE_KINDS,
  TASK_EXECUTION_NATIVE_CORRELATION_PURPOSES,
  TASK_EXECUTION_NATIVE_CORRELATION_STATES,
  TASK_EXECUTION_PROMPT_OUTCOMES,
  TASK_EXECUTION_PROMPT_CAPABILITY_STATES,
  TASK_EXECUTION_PROMPT_TRANSMISSION_PHASES,
  TASK_EXECUTION_PROTOCOL_SETTLEMENT_STATES,
  TASK_EXECUTION_RUN_KINDS,
  TASK_EXECUTION_RUN_STATUSES,
  TASK_EXECUTION_RUN_TERMINAL_CLASSIFICATIONS,
  TASK_EXECUTION_STEERING_STATES,
} from "../types/task-execution-run.js";

const uuidSchema = z.string().uuid();

export const taskExecutionRunKindSchema = z.enum(
  TASK_EXECUTION_RUN_KINDS,
);

export const taskExecutionRunStatusSchema = z.enum(
  TASK_EXECUTION_RUN_STATUSES,
);

export const taskExecutionRunTerminalClassificationSchema = z.enum(
  TASK_EXECUTION_RUN_TERMINAL_CLASSIFICATIONS,
);

export const taskExecutionPromptTransmissionPhaseSchema = z.enum(
  TASK_EXECUTION_PROMPT_TRANSMISSION_PHASES,
);

export const taskExecutionProtocolSettlementStateSchema = z.enum(
  TASK_EXECUTION_PROTOCOL_SETTLEMENT_STATES,
);

export const taskExecutionPromptOutcomeSchema = z.enum(
  TASK_EXECUTION_PROMPT_OUTCOMES,
);

export const taskExecutionSteeringStateSchema = z.enum(
  TASK_EXECUTION_STEERING_STATES,
);

export const taskExecutionNativeCorrelationPurposeSchema = z.enum(
  TASK_EXECUTION_NATIVE_CORRELATION_PURPOSES,
);

export const taskExecutionNativeCorrelationStateSchema = z.enum(
  TASK_EXECUTION_NATIVE_CORRELATION_STATES,
);

export const taskExecutionLaneKindSchema = z.enum(
  TASK_EXECUTION_LANE_KINDS,
);

export const acpCostCursorStateSchema = z.enum(ACP_COST_CURSOR_STATES);

export const taskExecutionPromptCapabilityStateSchema = z.enum(
  TASK_EXECUTION_PROMPT_CAPABILITY_STATES,
);

export const taskExecutionFinalizationActionSchema = z.enum(
  TASK_EXECUTION_FINALIZATION_ACTIONS,
);

const activePromptSettlementSchema = z
  .object({
    promptTransmissionPhase: taskExecutionPromptTransmissionPhaseSchema,
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

export const taskExecutionPromptSettlementSchema = z.union([
  activePromptSettlementSchema,
  notSentPromptSettlementSchema,
  settledPromptSettlementSchema,
  incompletePromptSettlementSchema,
]);

export const taskExecutionRunLivenessFactSchema = z
  .object({
    livenessState: z.enum(RUN_LIVENESS_STATES),
    livenessReason: z.string().trim().min(1).max(500),
    continuationAttempt: z.number().int().nonnegative(),
    lastUsefulActionAt: z.string().datetime().nullable(),
    nextAction: z.string().trim().min(1).max(500).nullable(),
  })
  .strict();

export type TaskExecutionPromptSettlementInput = z.infer<
  typeof taskExecutionPromptSettlementSchema
>;

export type TaskExecutionRunLivenessFactInput = z.infer<
  typeof taskExecutionRunLivenessFactSchema
>;
