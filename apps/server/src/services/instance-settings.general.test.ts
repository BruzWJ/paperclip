import { describe, expect, it } from "vitest";
import type { InstanceGeneralSettings } from "@paperclipai/shared";
import {
  applyGeneralSettingsPatch,
  resolveWorktreeRunExecutionActivation,
  resolveWorktreeRunExecutionActivationState,
} from "./instance-settings.js";

const baseGeneral: InstanceGeneralSettings = {
  censorUsernameInLogs: false,
  keyboardShortcuts: false,
  enableWorkspaceBranchReconcileForward: true,
  enableWorkspaceDirtyQuarantineRepair: true,
  enableServerInfoDebugView: false,
  autoRestartDevServerWhenIdle: false,
  enableWorktreeRunExecution: false,
  worktreeRunExecutionActivatedAt: null,
  worktreeRunExecutionActivationInstanceId: null,
};

describe("General worktree execution control", () => {
  it("arms only when enabled in the current worktree instance", () => {
    const enabled = applyGeneralSettingsPatch(
      baseGeneral,
      { enableWorktreeRunExecution: true },
      {
        runtimeEnv: {
          PAPERCLIP_IN_WORKTREE: "true",
          PAPERCLIP_INSTANCE_ID: "worktree-1",
        },
        now: () => new Date("2026-08-07T00:00:00.000Z"),
      },
    );

    expect(enabled).toMatchObject({
      enableWorktreeRunExecution: true,
      worktreeRunExecutionActivatedAt: "2026-08-07T00:00:00.000Z",
      worktreeRunExecutionActivationInstanceId: "worktree-1",
    });
    expect(resolveWorktreeRunExecutionActivation(enabled, "worktree-1")).toEqual({
      armed: true,
      cutoff: "2026-08-07T00:00:00.000Z",
      activationInstanceId: "worktree-1",
      reason: null,
    });
  });

  it("clears activation metadata when the control is disabled", () => {
    const disabled = applyGeneralSettingsPatch(
      {
        ...baseGeneral,
        enableWorktreeRunExecution: true,
        worktreeRunExecutionActivatedAt: "2026-08-07T00:00:00.000Z",
        worktreeRunExecutionActivationInstanceId: "worktree-1",
      },
      { enableWorktreeRunExecution: false },
    );

    expect(disabled).toMatchObject({
      enableWorktreeRunExecution: false,
      worktreeRunExecutionActivatedAt: null,
      worktreeRunExecutionActivationInstanceId: null,
    });
  });

  it("fails closed for a copied or unreadable setting", async () => {
    const copied = {
      ...baseGeneral,
      enableWorktreeRunExecution: true,
      worktreeRunExecutionActivatedAt: "2026-08-07T00:00:00.000Z",
      worktreeRunExecutionActivationInstanceId: "other-instance",
    };

    expect(resolveWorktreeRunExecutionActivation(copied, "worktree-1")).toEqual({
      armed: false,
      cutoff: null,
      activationInstanceId: "other-instance",
      reason: "instance_id_mismatch",
    });
    await expect(
      resolveWorktreeRunExecutionActivationState({
        getGeneral: async () => {
          throw new Error("database unavailable");
        },
        runtimeEnv: {
          PAPERCLIP_IN_WORKTREE: "true",
          PAPERCLIP_INSTANCE_ID: "worktree-1",
        },
      }),
    ).resolves.toMatchObject({
      armed: false,
      reason: "settings_read_error",
    });
  });
});
