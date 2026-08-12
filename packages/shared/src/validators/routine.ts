import { z } from "zod";
import { canonicalUuidSchema } from "./canonical-uuid.js";
import { addValidationDetail } from "../validation-details.js";
import {
  TASK_PRIORITIES,
  ROUTINE_CATCH_UP_POLICIES,
  ROUTINE_CONCURRENCY_POLICIES,
  ROUTINE_STATUSES,
  ROUTINE_TRIGGER_KINDS,
  ROUTINE_TRIGGER_SIGNING_MODES,
  ROUTINE_VARIABLE_TYPES,
} from "../constants.js";
import { envConfigSchema } from "./secret.js";
import { isValidRoutineDateString } from "../routine-variables.js";

const routineVariableValueSchema = z.union([z.string(), z.number().finite(), z.boolean()]);

export const routineVariableSchema = z.object({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/),
  label: z.string().trim().max(120).optional().nullable(),
  type: z.enum(ROUTINE_VARIABLE_TYPES).optional().default("text"),
  defaultValue: routineVariableValueSchema.optional().nullable(),
  required: z.boolean().optional().default(true),
  options: z
    .array(
      z
        .string()
        .min(1)
        .max(120)
        .refine((option) => option.trim() === option),
    )
    .max(50)
    .optional()
    .default([]),
}).superRefine((value, ctx) => {
  if (value.type === "select" && value.options.length === 0) {
    addValidationDetail(ctx, {
      path: ["options"],
      message: "Select variables require at least one option",
    });
  }
  if (value.type !== "select" && value.options.length > 0) {
    addValidationDetail(ctx, {
      path: ["options"],
      message: "Only select variables can define options",
    });
  }
  if (new Set(value.options).size !== value.options.length) {
    addValidationDetail(ctx, {
      path: ["options"],
      message: "Select variable options must be unique",
    });
  }
  if (value.type === "select" && value.defaultValue != null) {
    if (typeof value.defaultValue !== "string" || !value.options.includes(value.defaultValue)) {
      addValidationDetail(ctx, {
        path: ["defaultValue"],
        message: "Select variable defaults must match one of the allowed options",
      });
    }
  }
  if (value.type === "date" && value.defaultValue != null) {
    if (typeof value.defaultValue !== "string" || !isValidRoutineDateString(value.defaultValue)) {
      addValidationDetail(ctx, {
        path: ["defaultValue"],
        message: "Date variable defaults must be valid YYYY-MM-DD calendar dates",
      });
    }
  }
});

export const createRoutineSchema = z.object({
  projectId: canonicalUuidSchema.optional().nullable(),
  folderId: canonicalUuidSchema.optional().nullable(),
  goalId: canonicalUuidSchema.optional().nullable(),
  parentTaskId: canonicalUuidSchema.optional().nullable(),
  title: z.string().trim().min(1).max(200),
  description: z.string().optional().nullable(),
  assigneeAgentId: canonicalUuidSchema.optional().nullable(),
  priority: z.enum(TASK_PRIORITIES).optional().default("medium"),
  status: z.enum(ROUTINE_STATUSES).optional().default("active"),
  concurrencyPolicy: z.enum(ROUTINE_CONCURRENCY_POLICIES).optional().default("coalesce_if_active"),
  catchUpPolicy: z.enum(ROUTINE_CATCH_UP_POLICIES).optional().default("skip_missed"),
  variables: z.array(routineVariableSchema).optional().default([]),
  env: envConfigSchema.optional().nullable(),
});

export type CreateRoutine = z.infer<typeof createRoutineSchema>;

export const updateRoutineSchema = createRoutineSchema.partial().extend({
  baseRevisionId: canonicalUuidSchema,
});
export type UpdateRoutine = z.infer<typeof updateRoutineSchema>;

export const routineRevisionSnapshotRoutineV1Schema = z.object({
  id: canonicalUuidSchema,
  companyId: canonicalUuidSchema,
  projectId: canonicalUuidSchema.nullable(),
  folderId: canonicalUuidSchema.nullable().optional(),
  goalId: canonicalUuidSchema.nullable(),
  parentTaskId: canonicalUuidSchema.nullable(),
  title: z.string().trim().min(1).max(200),
  description: z.string().nullable(),
  assigneeAgentId: canonicalUuidSchema.nullable(),
  priority: z.enum(TASK_PRIORITIES),
  status: z.enum(ROUTINE_STATUSES),
  concurrencyPolicy: z.enum(ROUTINE_CONCURRENCY_POLICIES),
  catchUpPolicy: z.enum(ROUTINE_CATCH_UP_POLICIES),
  variables: z.array(routineVariableSchema),
  env: envConfigSchema.nullable().default(null),
  responsibleUserId: z.string().nullable().default(null),
}).strict();

export const routineRevisionSnapshotTriggerV1Schema = z.object({
  id: canonicalUuidSchema,
  kind: z.enum(ROUTINE_TRIGGER_KINDS),
  label: z.string().nullable(),
  enabled: z.boolean(),
  cronExpression: z.string().nullable(),
  timezone: z.string().nullable(),
  publicId: z.string().nullable(),
  signingMode: z.enum(ROUTINE_TRIGGER_SIGNING_MODES).nullable(),
  replayWindowSec: z.number().int().min(30).max(86_400).nullable(),
}).strict();

export const routineRevisionSnapshotV1Schema = z.object({
  version: z.literal(1),
  routine: routineRevisionSnapshotRoutineV1Schema,
  triggers: z.array(routineRevisionSnapshotTriggerV1Schema),
}).strict();

const baseTriggerSchema = z.object({
  label: z.string().trim().max(120).optional().nullable(),
  enabled: z.boolean().optional().default(true),
});

export const createRoutineTriggerSchema = z.discriminatedUnion("kind", [
  baseTriggerSchema.extend({
    kind: z.literal("schedule"),
    cronExpression: z.string().trim().min(1),
    timezone: z.string().trim().min(1).default("UTC"),
  }),
  baseTriggerSchema.extend({
    kind: z.literal("webhook"),
    signingMode: z.enum(ROUTINE_TRIGGER_SIGNING_MODES).optional().default("bearer"),
    replayWindowSec: z.number().int().min(30).max(86_400).optional().default(300),
  }),
  baseTriggerSchema.extend({
    kind: z.literal("api"),
  }),
]);

export type CreateRoutineTrigger = z.infer<typeof createRoutineTriggerSchema>;

export const updateRoutineTriggerSchema = z.object({
  label: z.string().trim().max(120).optional().nullable(),
  enabled: z.boolean().optional(),
  cronExpression: z.string().trim().min(1).optional().nullable(),
  timezone: z.string().trim().min(1).optional().nullable(),
  signingMode: z.enum(ROUTINE_TRIGGER_SIGNING_MODES).optional().nullable(),
  replayWindowSec: z.number().int().min(30).max(86_400).optional().nullable(),
});

export type UpdateRoutineTrigger = z.infer<typeof updateRoutineTriggerSchema>;

export const runRoutineSchema = z.object({
  triggerId: canonicalUuidSchema.optional().nullable(),
  payload: z.record(z.string(), z.unknown()).optional().nullable(),
  variables: z.record(z.string(), routineVariableValueSchema).optional().nullable(),
  projectId: canonicalUuidSchema.optional().nullable(),
  assigneeAgentId: canonicalUuidSchema.optional().nullable(),
  idempotencyKey: z.string().min(1).max(255).refine(
    (value) => value.trim() === value,
    { message: "Idempotency key must not contain surrounding whitespace" },
  ).optional().nullable(),
  source: z.enum(["manual", "api"]).optional().default("manual"),
});

export type RunRoutine = z.infer<typeof runRoutineSchema>;

export const rotateRoutineTriggerSecretSchema = z.object({});
export type RotateRoutineTriggerSecret = z.infer<typeof rotateRoutineTriggerSecretSchema>;
