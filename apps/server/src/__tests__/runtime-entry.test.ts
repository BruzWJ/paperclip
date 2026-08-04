import { describe, expect, it, vi } from "vitest";

const databaseMocks = vi.hoisted(() => ({
  unexpectedAccess: vi.fn(() => {
    throw new Error("Unexpected database access from server runtime entry test");
  }),
}));

vi.mock("@paperclipai/db", () => ({
  assertDistinctDatabaseIdentities: databaseMocks.unexpectedAccess,
  assertSameDatabaseIdentity: databaseMocks.unexpectedAccess,
  probeDatabaseIdentity: databaseMocks.unexpectedAccess,
  redactExternalPostgresConnectionString: databaseMocks.unexpectedAccess,
  resolveDatabaseTarget: databaseMocks.unexpectedAccess,
}));

import {
  startServerRuntime,
  type ServerRuntimeEntryDependencies,
} from "../runtime-entry.js";

function dependencies(input?: {
  missingEnv?: boolean;
  calls?: string[];
  loadedEnvironment?: Array<{
    environment: NodeJS.ProcessEnv;
    repositoryRoot: string;
  }>;
}): ServerRuntimeEntryDependencies {
  const calls = input?.calls ?? [];
  return {
    async bootstrapWorktreeEnv() {
      calls.push("bootstrap");
      return input?.missingEnv
        ? {
            envPath: "/repo/.paperclip/.env",
            markerPath:
              "/repo/.paperclip/worktree-instance.json",
            missingEnv: true,
          }
        : {
            envPath: null,
            markerPath: null,
            missingEnv: false,
          };
    },
    loadEnvironmentFiles(environment, repositoryRoot) {
      calls.push("environment");
      input?.loadedEnvironment?.push({ environment, repositoryRoot });
    },
    async loadServer() {
      calls.push("import");
      return {
        async startServer() {
          calls.push("start");
          return "started";
        },
      };
    },
  };
}

describe("server runtime entry", () => {
  it("loads runtime environment files after worktree validation and before importing the server", async () => {
    const calls: string[] = [];
    const loadedEnvironment: Array<{
      environment: NodeJS.ProcessEnv;
      repositoryRoot: string;
    }> = [];
    const environment = {};

    await expect(
      startServerRuntime({
        repositoryRoot: "/repo",
        env: environment,
        dependencies: dependencies({ calls, loadedEnvironment }),
      }),
    ).resolves.toBe("started");

    expect(calls).toEqual(["bootstrap", "environment", "import", "start"]);
    expect(loadedEnvironment).toEqual([
      { environment, repositoryRoot: "/repo" },
    ]);
  });

  it("does not import or initialize the server for an unprovisioned worktree", async () => {
    const loadServer = vi.fn();
    const loadEnvironmentFiles = vi.fn();
    const runtimeDependencies = dependencies({
      missingEnv: true,
    });
    runtimeDependencies.loadServer = loadServer;
    runtimeDependencies.loadEnvironmentFiles = loadEnvironmentFiles;

    await expect(
      startServerRuntime({
        repositoryRoot: "/repo",
        env: {},
        dependencies: runtimeDependencies,
      }),
    ).rejects.toThrow(/explicit external PostgreSQL database/);

    expect(loadEnvironmentFiles).not.toHaveBeenCalled();
    expect(loadServer).not.toHaveBeenCalled();
  });
});
