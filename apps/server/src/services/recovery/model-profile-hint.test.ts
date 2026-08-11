import { describe, expect, it } from "vitest";
import {
  scrubRecoveryModelProfileHints,
  withRecoveryModelProfileHint,
} from "./model-profile-hint.js";

describe("recovery model profile policy", () => {
  it("allows cheap only for status-only recovery and adds guard context", () => {
    expect(withRecoveryModelProfileHint({ taskId: "task-1" }, "status_only")).toEqual({
      taskId: "task-1",
      recoveryIntent: "status_only",
      allowDeliverableWork: false,
      allowDocumentUpdates: false,
      resumeRequiresNormalModel: true,
      modelProfile: "cheap",
    });
  });

  it("scrubs inherited cheap hints from normal model source-work retries", () => {
    expect(withRecoveryModelProfileHint({
      taskId: "task-1",
      retryOfRunId: "run-1",
      modelProfile: "cheap",
      recoveryIntent: "status_only",
      allowDeliverableWork: false,
      allowDocumentUpdates: false,
      resumeRequiresNormalModel: true,
    }, "normal_model")).toEqual({
      taskId: "task-1",
      retryOfRunId: "run-1",
    });
  });

  it("can scrub copied downstream source-work contexts without applying a profile", () => {
    expect(scrubRecoveryModelProfileHints({
      sourceTaskId: "source-task",
      modelProfile: "cheap",
      paperclipModelProfile: { requested: "cheap" },
      allowDocumentUpdates: false,
    })).toEqual({ sourceTaskId: "source-task" });
  });
});
