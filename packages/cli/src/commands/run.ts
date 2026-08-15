import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as p from "@clack/prompts";
import { bootstrapDevRunnerWorktreeEnv } from "@paperclipai/server/worktree-bootstrap";
import pc from "picocolors";
import { onboard } from "./onboard.js";
import { doctor } from "./doctor.js";
import { loadPaperclipEnvironmentFiles } from "../config/env.js";
import { configExists, resolveConfigPath } from "../config/store.js";
import { readConfig } from "../config/store.js";
import {
  describeLocalInstancePaths,
  resolvePaperclipHomeDir,
  resolvePaperclipInstanceId,
} from "../config/home.js";

interface RunOptions {
  config?: string;
  instance?: string;
  bind?: "loopback" | "lan" | "tailnet";
}

interface StartedServer {
  apiUrl: string;
  host: string;
  listenPort: number;
}

export type RunCommandDependencies = {
  bootstrapWorktreeEnv: typeof bootstrapDevRunnerWorktreeEnv;
};

const productionRunCommandDependencies: RunCommandDependencies = {
  bootstrapWorktreeEnv: bootstrapDevRunnerWorktreeEnv,
};

export async function runCommand(
  opts: RunOptions,
  dependencies: RunCommandDependencies =
    productionRunCommandDependencies,
): Promise<void> {
  const worktreeBootstrap = await dependencies.bootstrapWorktreeEnv(
    process.cwd(),
    process.env,
  );
  if (worktreeBootstrap.missingEnv) {
    throw new Error(
      "This linked worktree has no immutable creation metadata. Create it with `paperclipai worktree init --database-url <new-empty-database-url>`.",
    );
  }

  const isPinnedWorktree = worktreeBootstrap.envPath !== null;
  if (
    isPinnedWorktree &&
    opts.instance?.trim() &&
    opts.instance.trim() !== process.env.PAPERCLIP_INSTANCE_ID
  ) {
    throw new Error(
      "--instance cannot override an immutable linked-worktree instance id.",
    );
  }
  const instanceId = resolvePaperclipInstanceId(opts.instance);
  process.env.PAPERCLIP_INSTANCE_ID = instanceId;

  const homeDir = resolvePaperclipHomeDir();
  fs.mkdirSync(homeDir, { recursive: true });

  const paths = describeLocalInstancePaths(instanceId);
  fs.mkdirSync(paths.instanceRoot, { recursive: true });

  const configPath = resolveConfigPath(opts.config);
  if (
    isPinnedWorktree &&
    path.resolve(configPath) !==
      path.resolve(process.env.PAPERCLIP_CONFIG!)
  ) {
    throw new Error(
      "--config cannot override an immutable linked-worktree config.",
    );
  }
  process.env.PAPERCLIP_CONFIG = configPath;
  if (!isPinnedWorktree) {
    loadPaperclipEnvironmentFiles(configPath);
  }

  p.intro(pc.bgCyan(pc.black(" paperclipai run ")));
  p.log.message(pc.dim(`Home: ${paths.homeDir}`));
  p.log.message(pc.dim(`Instance: ${paths.instanceId}`));
  p.log.message(pc.dim(`Config: ${configPath}`));

  if (!configExists(configPath)) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      p.log.error("No config found and terminal is non-interactive.");
      p.log.message(`Run ${pc.cyan("paperclipai onboard")} once, then retry ${pc.cyan("paperclipai run")}.`);
      process.exit(1);
    }

    p.log.step("No config found. Starting onboarding...");
    await onboard({ config: configPath, invokedByRun: true, bind: opts.bind });
  }

  p.log.step("Running doctor checks...");
  const summary = await doctor({ config: configPath });

  if (summary.failed > 0) {
    p.log.error("Doctor found blocking failures. Not starting server.");
    process.exit(1);
  }

  const config = readConfig(configPath);
  if (!config) {
    p.log.error(`No config found at ${configPath}.`);
    process.exit(1);
  }

  p.log.step("Starting Paperclip server...");
  await importServerEntry();
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    if (err.message && err.message.trim().length > 0) return err.message;
    return err.name;
  }
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function isModuleNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (code === "ERR_MODULE_NOT_FOUND") return true;
  return err.message.includes("Cannot find module");
}

function getMissingModuleSpecifier(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const packageMatch = err.message.match(/Cannot find package '([^']+)' imported from/);
  if (packageMatch?.[1]) return packageMatch[1];
  const moduleMatch = err.message.match(/Cannot find module '([^']+)'/);
  if (moduleMatch?.[1]) return moduleMatch[1];
  return null;
}

function maybeEnableUiDevMiddleware(entrypoint: string): void {
  if (process.env.PAPERCLIP_UI_DEV_MIDDLEWARE !== undefined) return;
  const normalized = entrypoint.replaceAll("\\", "/");
  if (normalized.endsWith("/server/src/index.ts") || normalized.endsWith("@paperclipai/server/src/index.ts")) {
    process.env.PAPERCLIP_UI_DEV_MIDDLEWARE = "true";
  }
}

function ensureDevWorkspaceBuildDeps(projectRoot: string): void {
  const buildScript = path.resolve(projectRoot, "scripts/ensure-plugin-build-deps.mjs");
  if (!fs.existsSync(buildScript)) return;

  const result = spawnSync(process.execPath, [buildScript], {
    cwd: projectRoot,
    stdio: "inherit",
    timeout: 120_000,
  });

  if (result.error) {
    throw new Error(
      `Failed to prepare workspace build artifacts before starting the Paperclip dev server.\n${formatError(result.error)}`,
    );
  }

  if ((result.status ?? 1) !== 0) {
    throw new Error(
      "Failed to prepare workspace build artifacts before starting the Paperclip dev server.",
    );
  }
}

async function importServerEntry(): Promise<StartedServer> {
  // Dev mode: try local workspace path (monorepo with tsx)
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  const devEntry = path.resolve(projectRoot, "apps/server/src/index.ts");
  if (fs.existsSync(devEntry)) {
    ensureDevWorkspaceBuildDeps(projectRoot);
    maybeEnableUiDevMiddleware(devEntry);
    const mod = await import(pathToFileURL(devEntry).href);
    return await startServerFromModule(mod, devEntry);
  }

  // Production mode: import the published @paperclipai/server package
  try {
    const mod = await import("@paperclipai/server");
    return await startServerFromModule(mod, "@paperclipai/server");
  } catch (err) {
    const missingSpecifier = getMissingModuleSpecifier(err);
    const missingServerEntrypoint = !missingSpecifier || missingSpecifier === "@paperclipai/server";
    if (isModuleNotFoundError(err) && missingServerEntrypoint) {
      throw new Error(
        `Could not locate a Paperclip server entrypoint.\n` +
          `Tried: ${devEntry}, @paperclipai/server\n` +
          `${formatError(err)}`,
      );
    }
    throw new Error(
      `Paperclip server failed to start.\n` +
        `${formatError(err)}`,
    );
  }
}

async function startServerFromModule(mod: unknown, label: string): Promise<StartedServer> {
  const serverModule = mod as {
    loadRuntimeEnvironmentFiles?: (input?: {
      environment?: NodeJS.ProcessEnv;
    }) => void;
    startServer?: () => Promise<StartedServer>;
  };
  const loadEnvironmentFiles = serverModule.loadRuntimeEnvironmentFiles;
  if (typeof loadEnvironmentFiles !== "function") {
    throw new Error(
      `Paperclip server entrypoint did not export loadRuntimeEnvironmentFiles(): ${label}`,
    );
  }
  loadEnvironmentFiles({ environment: process.env });

  const startServer = serverModule.startServer;
  if (typeof startServer !== "function") {
    throw new Error(`Paperclip server entrypoint did not export startServer(): ${label}`);
  }
  return await startServer();
}
