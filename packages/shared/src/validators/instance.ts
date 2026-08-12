import { z } from "zod";
import { canonicalUuidSchema } from "./canonical-uuid.js";

export const instanceGeneralSettingsSchema = z.object({
  censorUsernameInLogs: z.boolean().default(false),
  keyboardShortcuts: z.boolean().default(false),
  enableWorkspaceBranchReconcileForward: z.boolean().default(true),
  enableWorkspaceDirtyQuarantineRepair: z.boolean().default(true),
  enableServerInfoDebugView: z.boolean().default(false),
  autoRestartDevServerWhenIdle: z.boolean().default(false),
  enableWorktreeRunExecution: z.boolean().default(false),
  worktreeRunExecutionActivatedAt: z.string().datetime().nullable().default(null),
  worktreeRunExecutionActivationInstanceId: z.string().min(1).nullable().default(null),
}).strict();

export const patchInstanceGeneralSettingsSchema = instanceGeneralSettingsSchema
  .omit({
    worktreeRunExecutionActivatedAt: true,
    worktreeRunExecutionActivationInstanceId: true,
  })
  .partial();

export type InstanceGeneralSettings = z.infer<typeof instanceGeneralSettingsSchema>;
export type PatchInstanceGeneralSettings = z.infer<typeof patchInstanceGeneralSettingsSchema>;

export const instanceSettingsSchema = z.object({
  id: canonicalUuidSchema,
  general: instanceGeneralSettingsSchema,
  createdAt: z.union([z.date(), z.string().datetime()]),
  updatedAt: z.union([z.date(), z.string().datetime()]),
}).strict();
