import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeAcpxInvocationFiles } from "./invocation-files.js";

const SECRET_CONTENT = '{"Authorization":"Bearer productive-run-secret"}\n';

describe("ACPX invocation files", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const directoryPath = cleanupDirs.pop();
      if (directoryPath) {
        await fs.rm(directoryPath, { recursive: true, force: true });
      }
    }
  });

  it("creates and idempotently cleans one mode-0600 bundle", async () => {
    const materialized = await materializeAcpxInvocationFiles({
      files: [
        { fileName: "run-tools.json", contents: SECRET_CONTENT },
        { fileName: "run-tools-proxy.mjs", contents: "process.exit(0);\n" },
      ],
    });
    const directoryPath = path.dirname(
      materialized.filePaths["run-tools.json"]!,
    );
    cleanupDirs.push(directoryPath);

    for (const filePath of Object.values(materialized.filePaths)) {
      expect(path.dirname(filePath)).toBe(directoryPath);
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    }
    expect((await fs.stat(directoryPath)).mode & 0o777).toBe(0o700);

    await materialized.cleanup();
    await materialized.cleanup();
    await expect(fs.access(directoryPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects path-bearing and duplicate file names before writing", async () => {
    await expect(materializeAcpxInvocationFiles({
      files: [{ fileName: "../mcp.json", contents: SECRET_CONTENT }],
    })).rejects.toThrow("simple file name");
    await expect(materializeAcpxInvocationFiles({
      files: [
        { fileName: "mcp.json", contents: "one" },
        { fileName: "mcp.json", contents: "two" },
      ],
    })).rejects.toThrow("duplicate file name");
  });
});
