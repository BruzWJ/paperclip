import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  runAdapterExecutionTargetProcess,
  type AdapterExecutionTarget,
} from "./execution-target.js";
import { shellQuote } from "./ssh.js";

const MATERIALIZATION_ROOT = ".paperclip-runtime/provider-invocations";
const DEFAULT_MATERIALIZATION_TIMEOUT_SEC = 15;
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface AdapterExecutionTargetMaterializedTextFile {
  directoryPath: string;
  filePath: string;
  cleanup(): Promise<void>;
}

export interface AdapterExecutionTargetTextFile {
  fileName: string;
  contents: string;
}

export interface AdapterExecutionTargetMaterializedTextFiles {
  directoryPath: string;
  filePaths: Readonly<Record<string, string>>;
  cleanup(): Promise<void>;
}

function assertSafeFileName(fileName: string): void {
  if (
    !SAFE_FILE_NAME.test(fileName) ||
    fileName === "." ||
    fileName === ".."
  ) {
    throw new Error(
      "Execution-target materialization requires a simple file name.",
    );
  }
}

function requireSuccessfulMaterialization(
  result: Awaited<ReturnType<typeof runAdapterExecutionTargetProcess>>,
  action: string,
): void {
  if (!result.timedOut && result.exitCode === 0) return;
  throw new Error(
    `${action} failed on the execution target` +
      (result.timedOut
        ? " because the operation timed out."
        : ` with exit code ${result.exitCode ?? "null"}.`),
  );
}

function validateTextFiles(
  files: readonly AdapterExecutionTargetTextFile[],
): void {
  if (files.length === 0) {
    throw new Error(
      "Execution-target materialization requires at least one file.",
    );
  }
  const names = new Set<string>();
  for (const file of files) {
    assertSafeFileName(file.fileName);
    if (names.has(file.fileName)) {
      throw new Error(
        `Execution-target materialization received duplicate file name "${file.fileName}".`,
      );
    }
    names.add(file.fileName);
  }
}

async function materializeLocalTextFiles(input: {
  files: readonly AdapterExecutionTargetTextFile[];
}): Promise<AdapterExecutionTargetMaterializedTextFiles> {
  const directoryPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "paperclip-provider-invocation-"),
  );
  const filePaths = Object.fromEntries(
    input.files.map((file) => [
      file.fileName,
      path.join(directoryPath, file.fileName),
    ]),
  );
  try {
    await fs.chmod(directoryPath, 0o700);
    for (const file of input.files) {
      const filePath = filePaths[file.fileName]!;
      await fs.writeFile(filePath, file.contents, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await fs.chmod(filePath, 0o600);
    }
  } catch (error) {
    await fs.rm(directoryPath, {
      recursive: true,
      force: true,
    }).catch(() => undefined);
    throw error;
  }

  let cleanupPromise: Promise<void> | null = null;
  return {
    directoryPath,
    filePaths,
    cleanup() {
      cleanupPromise ??= fs.rm(directoryPath, {
        recursive: true,
        force: true,
      });
      return cleanupPromise;
    },
  };
}

async function runRemoteMaterializationCommand(input: {
  target: Exclude<AdapterExecutionTarget, { kind: "local" }>;
  script: string;
  stdin?: string;
  timeoutSec: number;
}) {
  return await runAdapterExecutionTargetProcess(
    randomUUID(),
    input.target,
    "sh",
    ["-c", input.script],
    {
      cwd: input.target.remoteCwd,
      env: {},
      stdin: input.stdin,
      timeoutSec: input.timeoutSec,
      graceSec: 2,
      onLog: async () => {},
    },
  );
}

async function materializeRemoteTextFiles(input: {
  target: Exclude<AdapterExecutionTarget, { kind: "local" }>;
  files: readonly AdapterExecutionTargetTextFile[];
  timeoutSec: number;
}): Promise<AdapterExecutionTargetMaterializedTextFiles> {
  const directoryPath = path.posix.join(
    input.target.remoteCwd,
    MATERIALIZATION_ROOT,
    randomUUID(),
  );
  const filePaths = Object.fromEntries(
    input.files.map((file) => [
      file.fileName,
      path.posix.join(directoryPath, file.fileName),
    ]),
  );
  const cleanupScript =
    `rm -rf ${shellQuote(directoryPath)}`;

  try {
    for (const file of input.files) {
      const filePath = filePaths[file.fileName]!;
      const writeScript = [
        "umask 077",
        `mkdir -p ${shellQuote(directoryPath)}`,
        `chmod 700 ${shellQuote(directoryPath)}`,
        `cat > ${shellQuote(filePath)}`,
        `chmod 600 ${shellQuote(filePath)}`,
      ].join("\n");
      requireSuccessfulMaterialization(
        await runRemoteMaterializationCommand({
          target: input.target,
          script: writeScript,
          stdin: file.contents,
          timeoutSec: input.timeoutSec,
        }),
        "Invocation-file materialization",
      );
    }
  } catch {
    await runRemoteMaterializationCommand({
      target: input.target,
      script: cleanupScript,
      timeoutSec: input.timeoutSec,
    }).catch(() => undefined);
    throw new Error(
      "Invocation-file materialization failed on the execution target.",
    );
  }

  let cleanupPromise: Promise<void> | null = null;
  return {
    directoryPath,
    filePaths,
    cleanup() {
      cleanupPromise ??= runRemoteMaterializationCommand({
        target: input.target,
        script: cleanupScript,
        timeoutSec: input.timeoutSec,
      })
        .then((result) => {
          requireSuccessfulMaterialization(
            result,
            "Invocation-file cleanup",
          );
        })
        .catch(() => {
          throw new Error(
            "Invocation-file cleanup failed on the execution target.",
          );
        });
      return cleanupPromise;
    },
  };
}

/**
 * Materializes one invocation-scoped UTF-8 file bundle on the selected
 * execution target. Contents travel only over process stdin, never argv,
 * environment, or logs. The generated directory is mode 0700 and every file is
 * mode 0600.
 *
 * Callers must await `cleanup()` in a `finally` block.
 */
export async function materializeAdapterExecutionTargetTextFiles(input: {
  target: AdapterExecutionTarget | null | undefined;
  files: readonly AdapterExecutionTargetTextFile[];
  timeoutSec?: number;
}): Promise<AdapterExecutionTargetMaterializedTextFiles> {
  validateTextFiles(input.files);
  if (!input.target || input.target.kind === "local") {
    return await materializeLocalTextFiles(input);
  }
  const timeoutSec =
    typeof input.timeoutSec === "number" &&
    Number.isFinite(input.timeoutSec) &&
    input.timeoutSec > 0
      ? input.timeoutSec
      : DEFAULT_MATERIALIZATION_TIMEOUT_SEC;
  return await materializeRemoteTextFiles({
    ...input,
    target: input.target,
    timeoutSec,
  });
}

export async function materializeAdapterExecutionTargetTextFile(input: {
  target: AdapterExecutionTarget | null | undefined;
  fileName: string;
  contents: string;
  timeoutSec?: number;
}): Promise<AdapterExecutionTargetMaterializedTextFile> {
  const materialized =
    await materializeAdapterExecutionTargetTextFiles({
      target: input.target,
      files: [{
        fileName: input.fileName,
        contents: input.contents,
      }],
      timeoutSec: input.timeoutSec,
    });
  return {
    directoryPath: materialized.directoryPath,
    filePath: materialized.filePaths[input.fileName]!,
    cleanup: materialized.cleanup,
  };
}
