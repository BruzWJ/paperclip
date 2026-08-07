import { describe, expect, it } from "vitest";
import {
  mergeExecutionWorkspaceConfig,
  readExecutionWorkspaceConfig,
} from "../services/execution-workspaces.js";

describe("execution workspace config helpers", () => {
  it("reads typed config from persisted metadata while ignoring retired environment selection", () => {
    expect(readExecutionWorkspaceConfig({
      source: "project_primary",
      config: {
        provisionCommand: "bash ./scripts/provision-worktree.sh",
        teardownCommand: "bash ./scripts/teardown-worktree.sh",
        cleanupCommand: "pkill -f vite || true",
        workspaceRuntime: {
          services: [{ name: "web", command: "pnpm dev", port: 3100 }],
        },
      },
    })).toEqual({
      provisionCommand: "bash ./scripts/provision-worktree.sh",
      teardownCommand: "bash ./scripts/teardown-worktree.sh",
      cleanupCommand: "pkill -f vite || true",
      desiredState: null,
      serviceStates: null,
      workspaceRuntime: {
        services: [{ name: "web", command: "pnpm dev", port: 3100 }],
      },
    });
  });

  it("ignores malformed config values at the persistence boundary", () => {
    expect(readExecutionWorkspaceConfig({
      config: {
        provisionCommand: ["unsafe"],
        workspaceRuntime: "not-an-object",
      },
    })).toBeNull();
  });

  it("merges config patches without dropping unrelated metadata", () => {
    expect(mergeExecutionWorkspaceConfig(
      {
        source: "project_primary",
        createdByRuntime: false,
        config: {
          provisionCommand: "bash ./scripts/provision-worktree.sh",
          cleanupCommand: "pkill -f vite || true",
        },
      },
      {
        teardownCommand: "bash ./scripts/teardown-worktree.sh",
        workspaceRuntime: {
          services: [{ name: "web", command: "pnpm dev" }],
        },
      },
    )).toEqual({
      source: "project_primary",
      createdByRuntime: false,
      config: {
        provisionCommand: "bash ./scripts/provision-worktree.sh",
        teardownCommand: "bash ./scripts/teardown-worktree.sh",
        cleanupCommand: "pkill -f vite || true",
        desiredState: null,
        serviceStates: null,
        workspaceRuntime: {
          services: [{ name: "web", command: "pnpm dev" }],
        },
      },
    });
  });

  it("removes empty nested config while retaining unrelated metadata", () => {
    expect(mergeExecutionWorkspaceConfig(
      {
        source: "project_primary",
        config: { provisionCommand: "pnpm setup" },
      },
      { provisionCommand: null },
    )).toEqual({ source: "project_primary" });

    expect(mergeExecutionWorkspaceConfig(
      { source: "project_primary", config: { provisionCommand: "pnpm setup" } },
      null,
    )).toEqual({ source: "project_primary" });
  });
});
