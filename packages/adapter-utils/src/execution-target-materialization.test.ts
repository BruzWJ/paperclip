import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  materializeAdapterExecutionTargetTextFile,
  materializeAdapterExecutionTargetTextFiles,
} from "./execution-target-materialization.js";

const SECRET_CONTENT =
  '{"Authorization":"Bearer productive-run-secret"}\n';

describe("local execution-target text-file materialization", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const directoryPath = cleanupDirs.pop();
      if (!directoryPath) continue;
      await fs.rm(directoryPath, {
        recursive: true,
        force: true,
      });
    }
  });

  it("creates and idempotently cleans a mode-0600 local file", async () => {
    const materialized = await materializeAdapterExecutionTargetTextFile({
      target: { kind: "local" },
      fileName: "mcp.json",
      contents: SECRET_CONTENT,
    });
    cleanupDirs.push(materialized.directoryPath);

    expect(await fs.readFile(materialized.filePath, "utf8")).toBe(
      SECRET_CONTENT,
    );
    expect((await fs.stat(materialized.directoryPath)).mode & 0o777).toBe(
      0o700,
    );
    expect((await fs.stat(materialized.filePath)).mode & 0o777).toBe(0o600);

    await materialized.cleanup();
    await materialized.cleanup();
    await expect(fs.access(materialized.filePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("owns one cleanup lifecycle for an invocation asset bundle", async () => {
    const materialized = await materializeAdapterExecutionTargetTextFiles({
      target: { kind: "local" },
      files: [
        { fileName: "run-tools.json", contents: SECRET_CONTENT },
        {
          fileName: "run-tools-proxy.mjs",
          contents: "process.exit(0);\n",
        },
      ],
    });
    cleanupDirs.push(materialized.directoryPath);

    for (const filePath of Object.values(materialized.filePaths)) {
      expect(path.dirname(filePath)).toBe(materialized.directoryPath);
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    }

    await materialized.cleanup();
    await expect(fs.access(materialized.directoryPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects path-bearing and duplicate file names before writing", async () => {
    await expect(
      materializeAdapterExecutionTargetTextFile({
        target: { kind: "local" },
        fileName: "../mcp.json",
        contents: SECRET_CONTENT,
      }),
    ).rejects.toThrow("simple file name");

    await expect(
      materializeAdapterExecutionTargetTextFiles({
        target: { kind: "local" },
        files: [
          { fileName: "mcp.json", contents: "one" },
          { fileName: "mcp.json", contents: "two" },
        ],
      }),
    ).rejects.toThrow("duplicate file name");
  });
});
