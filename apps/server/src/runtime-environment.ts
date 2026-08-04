import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { resolvePaperclipEnvPath } from "./paths.js";

/**
 * Loads operator-owned environment files at an explicit process startup
 * boundary. Importing server configuration never calls this function.
 */
export function loadRuntimeEnvironmentFiles(input: {
  paperclipEnvFilePath?: string;
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
} = {}): void {
  const environment = input.environment ?? process.env;
  const paperclipEnvFilePath =
    input.paperclipEnvFilePath ?? resolvePaperclipEnvPath();

  if (existsSync(paperclipEnvFilePath)) {
    loadDotenv({
      path: paperclipEnvFilePath,
      override: false,
      quiet: true,
      processEnv: environment,
    });
  }

  const cwdEnvPath = resolve(input.cwd ?? process.cwd(), ".env");
  const isSameFile =
    existsSync(cwdEnvPath) && existsSync(paperclipEnvFilePath)
      ? realpathSync(cwdEnvPath) === realpathSync(paperclipEnvFilePath)
      : cwdEnvPath === paperclipEnvFilePath;
  if (!isSameFile && existsSync(cwdEnvPath)) {
    loadDotenv({
      path: cwdEnvPath,
      override: false,
      quiet: true,
      processEnv: environment,
    });
  }
}
