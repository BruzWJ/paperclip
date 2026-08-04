import { describe, expect, it } from "vitest";
import {
  executionWorkspaceService,
  mergeExecutionWorkspaceConfig,
  readExecutionWorkspaceConfig,
} from "../services/execution-workspaces.js";
import { createMockDb } from "./helpers/mock-db.js";

describe("execution workspace config helpers", () => {
  it("reads typed config from persisted metadata", () => {
    expect(readExecutionWorkspaceConfig({
      source: "project_primary",
      config: {
        environmentId: "32e0464c-2a0b-4ce9-886d-2cc99e6f3e7b",
        provisionCommand: "bash ./scripts/provision-worktree.sh",
        teardownCommand: "bash ./scripts/teardown-worktree.sh",
        cleanupCommand: "pkill -f vite || true",
        workspaceRuntime: {
          services: [{ name: "web", command: "pnpm dev", port: 3100 }],
        },
      },
    })).toEqual({
      environmentId: "32e0464c-2a0b-4ce9-886d-2cc99e6f3e7b",
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
        environmentId: 42,
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
          environmentId: "32e0464c-2a0b-4ce9-886d-2cc99e6f3e7b",
          provisionCommand: "bash ./scripts/provision-worktree.sh",
          cleanupCommand: "pkill -f vite || true",
        },
      },
      {
        environmentId: "6286d5a9-9ea7-42b9-98b3-18ee904c26d7",
        teardownCommand: "bash ./scripts/teardown-worktree.sh",
        workspaceRuntime: {
          services: [{ name: "web", command: "pnpm dev" }],
        },
      },
    )).toEqual({
      source: "project_primary",
      createdByRuntime: false,
      config: {
        environmentId: "6286d5a9-9ea7-42b9-98b3-18ee904c26d7",
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
        config: { environmentId: "32e0464c-2a0b-4ce9-886d-2cc99e6f3e7b" },
      },
      { environmentId: null },
    )).toEqual({ source: "project_primary" });

    expect(mergeExecutionWorkspaceConfig(
      { source: "project_primary", config: { provisionCommand: "pnpm setup" } },
      null,
    )).toEqual({ source: "project_primary" });
  });
});

describe("executionWorkspaceService", () => {
  it("clears only matching environment selections in one transaction", async () => {
    const targetEnvironmentId = "00000000-0000-4000-8000-000000000001";
    const mock = createMockDb({
      select: [[
        {
          id: "workspace-target",
          metadata: {
            source: "project_primary",
            label: "keep-me",
            config: {
              environmentId: targetEnvironmentId,
              cleanupCommand: "pnpm cleanup",
            },
          },
        },
        {
          id: "workspace-other",
          metadata: {
            config: { environmentId: "00000000-0000-4000-8000-000000000002" },
          },
        },
      ]],
      update: [[]],
    });

    const cleared = await executionWorkspaceService(mock.db)
      .clearEnvironmentSelection("company-1", targetEnvironmentId);

    expect(cleared).toBe(1);
    const setCalls = mock.calls.filter((call) => call.operation === "update" && call.method === "set");
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]?.args[0]).toMatchObject({
      metadata: {
        source: "project_primary",
        label: "keep-me",
        config: {
          cleanupCommand: "pnpm cleanup",
        },
      },
    });
    expect(mock.remaining("select")).toBe(0);
    expect(mock.remaining("update")).toBe(0);
  });
});
