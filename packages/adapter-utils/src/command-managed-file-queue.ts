import path from "node:path";

import type { CommandManagedRuntimeRunner } from "./command-managed-runtime.js";
import { preferredShellForSandbox, shellCommandArgs } from "./sandbox-shell.js";
import { shellQuote } from "./ssh.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const BASE64_CHUNK_SIZE = 32 * 1024;

export interface CommandManagedFileQueue {
  makeDir(remotePath: string): Promise<void>;
  listJsonFiles(remotePath: string): Promise<string[]>;
  readTextFile(remotePath: string): Promise<string>;
  writeTextFile(remotePath: string, body: string): Promise<void>;
  remove(remotePath: string): Promise<void>;
}

function timeoutMs(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : DEFAULT_COMMAND_TIMEOUT_MS;
}

function base64Chunks(body: string): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < body.length; offset += BASE64_CHUNK_SIZE) {
    chunks.push(body.slice(offset, offset + BASE64_CHUNK_SIZE));
  }
  return chunks;
}

export function createCommandManagedFileQueue(input: {
  runner: CommandManagedRuntimeRunner;
  remoteCwd: string;
  timeoutMs?: number | null;
  shellCommand?: "bash" | "sh" | null;
}): CommandManagedFileQueue {
  const commandTimeoutMs = timeoutMs(input.timeoutMs);
  const shellCommand = preferredShellForSandbox(input.shellCommand);

  async function run(action: string, script: string) {
    const result = await input.runner.execute({
      command: shellCommand,
      args: shellCommandArgs(script),
      cwd: input.remoteCwd,
      env: {},
      timeoutMs: commandTimeoutMs,
    });
    if (!result.timedOut && result.exitCode === 0) return result;
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `${action}${result.timedOut ? " timed out" : ` failed with exit code ${result.exitCode ?? "null"}`}${detail ? `: ${detail}` : ""}`,
    );
  }

  return {
    async makeDir(remotePath) {
      await run(`Create ${remotePath}`, `mkdir -p ${shellQuote(remotePath)}`);
    },

    async listJsonFiles(remotePath) {
      const result = await run(
        `List ${remotePath}`,
        [
          `if [ -d ${shellQuote(remotePath)} ]; then`,
          `  for file in ${shellQuote(remotePath)}/*.json; do`,
          `    [ -f "$file" ] || continue`,
          `    basename "$file"`,
          "  done",
          "fi",
        ].join("\n"),
      );
      return result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right));
    },

    async readTextFile(remotePath) {
      const result = await run(
        `Read ${remotePath}`,
        `base64 < ${shellQuote(remotePath)}`,
      );
      return Buffer.from(result.stdout.replace(/\s+/g, ""), "base64").toString(
        "utf8",
      );
    },

    async writeTextFile(remotePath, body) {
      const remoteDir = path.posix.dirname(remotePath);
      const uploadPath = `${remotePath}.paperclip-upload.b64`;
      await run(
        `Prepare ${remotePath}`,
        `mkdir -p ${shellQuote(remoteDir)} && rm -f ${shellQuote(uploadPath)} && : > ${shellQuote(uploadPath)}`,
      );
      const encoded = Buffer.from(body, "utf8").toString("base64");
      for (const chunk of base64Chunks(encoded)) {
        await run(
          `Write ${remotePath}`,
          `printf '%s' ${shellQuote(chunk)} >> ${shellQuote(uploadPath)}`,
        );
      }
      await run(
        `Finalize ${remotePath}`,
        `base64 -d < ${shellQuote(uploadPath)} > ${shellQuote(remotePath)} && rm -f ${shellQuote(uploadPath)}`,
      );
    },

    async remove(remotePath) {
      await run(`Remove ${remotePath}`, `rm -rf ${shellQuote(remotePath)}`);
    },
  };
}
