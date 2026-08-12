import type { Db } from "@paperclipai/db";
import { companies, instanceSettings } from "@paperclipai/db";
import {
  instanceGeneralSettingsSchema,
  parseOptionalBooleanEnvironmentValue,
  parseOptionalExactNonEmptyEnvironmentValue,
  type InstanceGeneralSettings,
  type PatchInstanceGeneralSettings,
} from "@paperclipai/shared";
import { eq } from "drizzle-orm";

const DEFAULT_SINGLETON_KEY = "default";

export interface InstanceSettingsServiceOptions {
  runtimeEnv?: Record<string, string | undefined>;
  now?: () => Date;
}

type WorktreeRunExecutionSuppressedReason =
  | "not_worktree_runtime"
  | "setting_disabled"
  | "missing_cutoff"
  | "missing_instance_id"
  | "instance_id_mismatch"
  | "settings_read_error";

export type WorktreeRunExecutionActivationState =
  | {
      armed: true;
      cutoff: string;
      activationInstanceId: string;
      reason: null;
    }
  | {
      armed: false;
      cutoff: null;
      activationInstanceId: string | null;
      reason: WorktreeRunExecutionSuppressedReason;
    };

export function isWorktreeRuntimeEnvironment(value: string | undefined) {
  return (
    parseOptionalBooleanEnvironmentValue(value, "PAPERCLIP_IN_WORKTREE") ??
    false
  );
}

function getRuntimeInstanceId(env: Record<string, string | undefined>) {
  return (
    parseOptionalExactNonEmptyEnvironmentValue(
      env.PAPERCLIP_INSTANCE_ID,
      "PAPERCLIP_INSTANCE_ID",
    ) ?? null
  );
}

function stripServerManagedGeneralPatchFields(
  patch: PatchInstanceGeneralSettings | Record<string, unknown>,
): PatchInstanceGeneralSettings {
  const {
    worktreeRunExecutionActivatedAt: _ignoredActivatedAt,
    worktreeRunExecutionActivationInstanceId: _ignoredActivationInstanceId,
    ...patchable
  } = patch as Record<string, unknown>;
  return patchable as PatchInstanceGeneralSettings;
}

function suppressWorktreeRunExecution(
  reason: WorktreeRunExecutionSuppressedReason,
  activationInstanceId: string | null = null,
): WorktreeRunExecutionActivationState {
  return {
    armed: false,
    cutoff: null,
    activationInstanceId,
    reason,
  };
}

function normalizeGeneralSettings(raw: unknown): InstanceGeneralSettings {
  return instanceGeneralSettingsSchema.parse(raw ?? {});
}

export function applyGeneralSettingsPatch(
  current: unknown,
  patch: PatchInstanceGeneralSettings | Record<string, unknown>,
  options: InstanceSettingsServiceOptions = {},
): InstanceGeneralSettings {
  const previousGeneral = normalizeGeneralSettings(current);
  const patchable = stripServerManagedGeneralPatchFields(patch);
  const nextGeneral = normalizeGeneralSettings({
    ...previousGeneral,
    ...patchable,
  });
  const hasWorktreeRunExecutionPatch = Object.prototype.hasOwnProperty.call(
    patchable,
    "enableWorktreeRunExecution",
  );

  if (!hasWorktreeRunExecutionPatch) return nextGeneral;

  if (nextGeneral.enableWorktreeRunExecution !== true) {
    return {
      ...nextGeneral,
      worktreeRunExecutionActivatedAt: null,
      worktreeRunExecutionActivationInstanceId: null,
    };
  }

  if (previousGeneral.enableWorktreeRunExecution === true) return nextGeneral;

  const runtimeEnv = options.runtimeEnv ?? process.env;
  if (!isWorktreeRuntimeEnvironment(runtimeEnv.PAPERCLIP_IN_WORKTREE)) {
    return nextGeneral;
  }

  return {
    ...nextGeneral,
    worktreeRunExecutionActivatedAt: (options.now ?? (() => new Date()))()
      .toISOString(),
    worktreeRunExecutionActivationInstanceId: getRuntimeInstanceId(runtimeEnv),
  };
}

export function resolveWorktreeRunExecutionActivation(
  general: InstanceGeneralSettings,
  currentInstanceId: string | null | undefined,
): WorktreeRunExecutionActivationState {
  if (general.enableWorktreeRunExecution !== true) {
    return suppressWorktreeRunExecution(
      "setting_disabled",
      general.worktreeRunExecutionActivationInstanceId,
    );
  }
  if (!general.worktreeRunExecutionActivatedAt) {
    return suppressWorktreeRunExecution(
      "missing_cutoff",
      general.worktreeRunExecutionActivationInstanceId,
    );
  }
  if (!currentInstanceId) {
    return suppressWorktreeRunExecution(
      "missing_instance_id",
      general.worktreeRunExecutionActivationInstanceId,
    );
  }
  if (general.worktreeRunExecutionActivationInstanceId !== currentInstanceId) {
    return suppressWorktreeRunExecution(
      "instance_id_mismatch",
      general.worktreeRunExecutionActivationInstanceId,
    );
  }
  return {
    armed: true,
    cutoff: general.worktreeRunExecutionActivatedAt,
    activationInstanceId: currentInstanceId,
    reason: null,
  };
}

export async function resolveWorktreeRunExecutionActivationState(options: {
  getGeneral: () => Promise<InstanceGeneralSettings>;
  runtimeEnv?: Record<string, string | undefined>;
}): Promise<WorktreeRunExecutionActivationState> {
  const runtimeEnv = options.runtimeEnv ?? process.env;
  if (!isWorktreeRuntimeEnvironment(runtimeEnv.PAPERCLIP_IN_WORKTREE)) {
    return suppressWorktreeRunExecution("not_worktree_runtime");
  }
  try {
    return resolveWorktreeRunExecutionActivation(
      await options.getGeneral(),
      getRuntimeInstanceId(runtimeEnv),
    );
  } catch {
    return suppressWorktreeRunExecution("settings_read_error");
  }
}

function toInstanceSettings(row: typeof instanceSettings.$inferSelect) {
  return {
    id: row.id,
    general: normalizeGeneralSettings(row.general),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function instanceSettingsService(
  db: Db,
  options: InstanceSettingsServiceOptions = {},
) {
  async function getOrCreateRow() {
    const existing = await db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, DEFAULT_SINGLETON_KEY))
      .then((rows) => rows[0] ?? null);
    if (existing) return existing;

    const now = new Date();
    const [created] = await db
      .insert(instanceSettings)
      .values({
        singletonKey: DEFAULT_SINGLETON_KEY,
        general: {},
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [instanceSettings.singletonKey],
        set: {
          updatedAt: now,
        },
      })
      .returning();

    if (created) return created;

    const raced = await db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, DEFAULT_SINGLETON_KEY))
      .then((rows) => rows[0] ?? null);
    if (raced) return raced;

    throw new Error("Failed to initialize instance settings row");
  }

  return {
    getGeneral: async (): Promise<InstanceGeneralSettings> => {
      const row = await getOrCreateRow();
      return normalizeGeneralSettings(row.general);
    },

    updateGeneral: async (patch: PatchInstanceGeneralSettings) => {
      const current = await getOrCreateRow();
      const nextGeneral = applyGeneralSettingsPatch(
        current.general,
        patch,
        options,
      );
      const now = new Date();
      const [updated] = await db
        .update(instanceSettings)
        .set({
          general: { ...nextGeneral },
          updatedAt: now,
        })
        .where(eq(instanceSettings.id, current.id))
        .returning();
      return toInstanceSettings(updated ?? current);
    },

    listCompanyIds: async (): Promise<string[]> =>
      db
        .select({ id: companies.id })
        .from(companies)
        .then((rows) => rows.map((row) => row.id)),
  };
}
