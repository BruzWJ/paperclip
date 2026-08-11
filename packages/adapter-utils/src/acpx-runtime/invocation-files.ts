import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface AcpxInvocationTextFile {
  fileName: string;
  contents: string;
}

interface MaterializedAcpxInvocationFiles {
  filePaths: Readonly<Record<string, string>>;
  cleanup(): Promise<void>;
}

function validateTextFiles(files: readonly AcpxInvocationTextFile[]): void {
  if (files.length === 0) {
    throw new Error("ACPX invocation requires at least one file");
  }
  const names = new Set<string>();
  for (const file of files) {
    if (
      !SAFE_FILE_NAME.test(file.fileName) ||
      file.fileName === "." ||
      file.fileName === ".."
    ) {
      throw new Error("ACPX invocation requires a simple file name");
    }
    if (names.has(file.fileName)) {
      throw new Error(
        `ACPX invocation received duplicate file name "${file.fileName}"`,
      );
    }
    names.add(file.fileName);
  }
}

/** Materializes one request-scoped UTF-8 file bundle for an ACPX invocation. */
export async function materializeAcpxInvocationFiles(input: {
  files: readonly AcpxInvocationTextFile[];
}): Promise<MaterializedAcpxInvocationFiles> {
  validateTextFiles(input.files);
  const directoryPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "paperclip-acpx-invocation-"),
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
    await fs.rm(directoryPath, { recursive: true, force: true })
      .catch(() => undefined);
    throw error;
  }

  let cleanupPromise: Promise<void> | null = null;
  return {
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
