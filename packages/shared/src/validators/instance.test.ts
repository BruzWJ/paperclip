import { describe, expect, it } from "vitest";
import {
  instanceGeneralSettingsSchema,
  patchInstanceGeneralSettingsSchema,
} from "./instance.js";

describe("instance general settings validation", () => {
  it("defaults General safeguards and server controls safely", () => {
    expect(instanceGeneralSettingsSchema.parse({})).toMatchObject({
      enableWorkspaceBranchReconcileForward: true,
      enableWorkspaceDirtyQuarantineRepair: true,
      enableServerInfoDebugView: false,
      autoRestartDevServerWhenIdle: false,
      enableWorktreeRunExecution: false,
      worktreeRunExecutionActivatedAt: null,
      worktreeRunExecutionActivationInstanceId: null,
    });
  });

  it("rejects unknown public settings fields", () => {
    expect(instanceGeneralSettingsSchema.safeParse({ unexpected: true }).success).toBe(false);
    expect(
      patchInstanceGeneralSettingsSchema.safeParse({
        feedbackDataSharingPreference: "allowed",
      }).success,
    ).toBe(false);
  });

  it("does not allow clients to write server-managed worktree metadata", () => {
    expect(
      patchInstanceGeneralSettingsSchema.safeParse({
        worktreeRunExecutionActivatedAt: "2026-08-07T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});
