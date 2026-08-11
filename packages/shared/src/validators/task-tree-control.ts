import { z } from "zod";
import {
  TASK_TREE_CONTROL_MODES,
  TASK_TREE_HOLD_RELEASE_POLICY_STRATEGIES,
} from "../constants.js";

export const taskTreeControlModeSchema = z.enum(TASK_TREE_CONTROL_MODES);

export const taskTreeHoldReleasePolicySchema = z
  .object({
    strategy: z.enum(TASK_TREE_HOLD_RELEASE_POLICY_STRATEGIES).default("manual"),
    note: z.string().trim().min(1).max(500).optional().nullable(),
  })
  .strict();

export const previewTaskTreeControlSchema = z
  .object({
    mode: taskTreeControlModeSchema,
    releasePolicy: taskTreeHoldReleasePolicySchema.optional().nullable(),
  })
  .strict();

export type PreviewTaskTreeControl = z.infer<typeof previewTaskTreeControlSchema>;

export const createTaskTreeHoldSchema = z
  .object({
    mode: taskTreeControlModeSchema,
    reason: z.string().trim().min(1).max(1000).optional().nullable(),
    releasePolicy: taskTreeHoldReleasePolicySchema.optional().nullable(),
    metadata: z.record(z.string(), z.unknown()).optional().nullable(),
  })
  .strict();

export type CreateTaskTreeHold = z.infer<typeof createTaskTreeHoldSchema>;

export const releaseTaskTreeHoldSchema = z
  .object({
    reason: z.string().trim().min(1).max(1000).optional().nullable(),
    releasePolicy: taskTreeHoldReleasePolicySchema.optional().nullable(),
    metadata: z.record(z.string(), z.unknown()).optional().nullable(),
  })
  .strict();

export type ReleaseTaskTreeHold = z.infer<typeof releaseTaskTreeHoldSchema>;
