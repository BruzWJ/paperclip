import { describe, expect, it } from "vitest";
import { createTestTask } from "../test-utils/task";
import {
  buildSubTaskDefaults,
  projectWorkspaceIdAfterProjectChange,
} from "./subTaskDefaults";

describe("sub-task defaults", () => {
  it("inherits only the parent's project codebase selector", () => {
    const defaults = buildSubTaskDefaults(createTestTask({
      id: "task-parent",
      projectId: "project-1",
      projectWorkspaceId: "workspace-1",
    }));

    expect(defaults).toMatchObject({
      parentId: "task-parent",
      projectId: "project-1",
      projectWorkspaceId: "workspace-1",
    });
    expect(defaults).not.toHaveProperty("executionWorkspaceId");
    expect(defaults).not.toHaveProperty("executionWorkspaceMode");
  });

  it("clears an inherited codebase when the sub-task moves to another project", () => {
    expect(
      projectWorkspaceIdAfterProjectChange(
        "project-1",
        "project-2",
        "workspace-1",
      ),
    ).toBe("");
    expect(
      projectWorkspaceIdAfterProjectChange(
        "project-1",
        "project-1",
        "workspace-1",
      ),
    ).toBe("workspace-1");
  });
});
