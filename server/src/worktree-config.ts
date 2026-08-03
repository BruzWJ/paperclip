import fs from "node:fs";
import path from "node:path";
import {
  paperclipConfigSchema,
  type PaperclipConfig,
} from "@paperclipai/shared";

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function resolvePinnedWorktreeConfigPath(
  env: NodeJS.ProcessEnv,
): string | null {
  if (env.PAPERCLIP_IN_WORKTREE !== "true") return null;
  const configuredPath = nonEmpty(env.PAPERCLIP_CONFIG);
  if (!configuredPath) return null;

  const configPath = path.resolve(configuredPath);
  if (path.basename(configPath) !== "config.json") return null;
  if (path.basename(path.dirname(configPath)) !== ".paperclip") return null;
  return configPath;
}

function writeConfigFile(configPath: string, config: PaperclipConfig): void {
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
}

export function applyRuntimeServerPortSelectionToConfig(
  config: PaperclipConfig,
  input: { serverPort: number; allowServerPortWrite?: boolean },
): { config: PaperclipConfig; changed: boolean } {
  if (
    input.allowServerPortWrite === false ||
    config.server.port === input.serverPort
  ) {
    return { config, changed: false };
  }

  const nextConfig: PaperclipConfig = {
    ...config,
    server: {
      ...config.server,
      port: input.serverPort,
    },
  };
  return { config: nextConfig, changed: true };
}

export function maybePersistWorktreeServerPort(input: {
  serverPort: number;
}): void {
  const configPath = resolvePinnedWorktreeConfigPath(process.env);
  if (!configPath || !fs.existsSync(configPath)) return;

  let fileConfig: PaperclipConfig;
  try {
    fileConfig = paperclipConfigSchema.parse(
      JSON.parse(fs.readFileSync(configPath, "utf8")),
    );
  } catch {
    return;
  }

  const { config, changed } = applyRuntimeServerPortSelectionToConfig(
    fileConfig,
    {
      serverPort: input.serverPort,
      allowServerPortWrite: !nonEmpty(process.env.PORT),
    },
  );
  if (changed) {
    writeConfigFile(configPath, config);
  }
}
