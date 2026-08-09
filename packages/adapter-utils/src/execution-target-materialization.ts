import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionTarget } from "./execution-target.js";

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

/**
 * Materialize one invocation-scoped UTF-8 file bundle on the local host.
 * The generated directory is mode 0700 and every file is mode 0600. Callers
 * must await `cleanup()` in a `finally` block.
 */
export async function materializeAdapterExecutionTargetTextFiles(input: {
  target: AdapterExecutionTarget | null | undefined;
  files: readonly AdapterExecutionTargetTextFile[];
}): Promise<AdapterExecutionTargetMaterializedTextFiles> {
  validateTextFiles(input.files);
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
    filePaths: Object.freeze(filePaths),
    cleanup() {
      cleanupPromise ??= fs.rm(directoryPath, {
        recursive: true,
        force: true,
      });
      return cleanupPromise;
    },
  };
}

export async function materializeAdapterExecutionTargetTextFile(input: {
  target: AdapterExecutionTarget | null | undefined;
  fileName: string;
  contents: string;
}): Promise<AdapterExecutionTargetMaterializedTextFile> {
  const materialized = await materializeAdapterExecutionTargetTextFiles({
    target: input.target,
    files: [{
      fileName: input.fileName,
      contents: input.contents,
    }],
  });
  return {
    directoryPath: materialized.directoryPath,
    filePath: materialized.filePaths[input.fileName]!,
    cleanup: materialized.cleanup,
  };
}
