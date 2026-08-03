import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  bootstrapDevRunnerWorktreeEnv,
  type WorktreeEnvBootstrapResult,
} from "./dev-runner-worktree.js";
import { loadRuntimeEnvironmentFiles } from "./runtime-environment.js";

type ServerModule = {
  startServer(): Promise<unknown>;
};

export type ServerRuntimeEntryDependencies = {
  bootstrapWorktreeEnv(
    rootDir: string,
    env: NodeJS.ProcessEnv,
  ): Promise<WorktreeEnvBootstrapResult>;
  loadEnvironmentFiles(
    environment: NodeJS.ProcessEnv,
    repositoryRoot: string,
  ): void;
  loadServer(): Promise<ServerModule>;
};

const runtimeEntryDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = path.resolve(
  runtimeEntryDirectory,
  "../..",
);

const productionDependencies: ServerRuntimeEntryDependencies = {
  bootstrapWorktreeEnv: (rootDir, env) =>
    bootstrapDevRunnerWorktreeEnv(rootDir, env),
  loadEnvironmentFiles: (environment, repositoryRoot) =>
    loadRuntimeEnvironmentFiles({
      environment,
      cwd: repositoryRoot,
    }),
  loadServer: () => import("./index.js"),
};

export async function startServerRuntime(input?: {
  repositoryRoot?: string;
  env?: NodeJS.ProcessEnv;
  dependencies?: ServerRuntimeEntryDependencies;
}): Promise<unknown> {
  const repositoryRoot = path.resolve(
    input?.repositoryRoot ?? defaultRepositoryRoot,
  );
  const env = input?.env ?? process.env;
  const dependencies = input?.dependencies ?? productionDependencies;

  const worktree = await dependencies.bootstrapWorktreeEnv(
    repositoryRoot,
    env,
  );
  if (worktree.missingEnv) {
    throw new Error(
      "Linked worktree is not provisioned. Discard it or create it with an explicit external PostgreSQL database.",
    );
  }

  dependencies.loadEnvironmentFiles(env, repositoryRoot);
  const server = await dependencies.loadServer();
  return server.startServer();
}

function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(path.resolve(entry)).href === metaUrl;
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) {
  void startServerRuntime().catch((error) => {
    const message =
      error instanceof Error ? error.message : String(error);
    console.error(`[paperclip] server failed to start: ${message}`);
    process.exitCode = 1;
  });
}
