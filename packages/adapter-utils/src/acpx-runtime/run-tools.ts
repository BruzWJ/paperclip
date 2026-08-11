import path from "node:path";
import type { AcpRuntimeOptions } from "acpx/runtime";

type AcpxMcpServer = NonNullable<AcpRuntimeOptions["mcpServers"]>[number];

function requireAbsoluteFile(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    !path.isAbsolute(value)
  ) {
    throw new Error(`${label} must be an exact absolute path`);
  }
  return value;
}

/**
 * Builds the only provider-visible Paperclip capability descriptor. The
 * endpoint and bearer remain in the target-local mode-0600 secret file and
 * never appear in ACP argv, environment, or metadata.
 */
export function createPaperclipRunToolsMcpServer(input: {
  readonly nodeExecutable: string;
  readonly proxyEntrypoint: string;
  readonly secretFile: string;
}): AcpxMcpServer {
  return {
    name: "paperclip",
    command: requireAbsoluteFile(
      input.nodeExecutable,
      "run-tools target Node executable",
    ),
    args: [
      requireAbsoluteFile(input.proxyEntrypoint, "run-tools proxy entrypoint"),
      requireAbsoluteFile(input.secretFile, "run-tools secret file"),
    ],
    env: [],
  };
}
