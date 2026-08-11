import { describe, expect, it } from "vitest";
import { createPaperclipRunToolsMcpServer } from "./run-tools.js";

describe("Paperclip request-scoped run-tools MCP descriptor", () => {
  it("uses the exact execution-target Node and target-local request files", () => {
    expect(
      createPaperclipRunToolsMcpServer({
        nodeExecutable: "/opt/paperclip/node/bin/node",
        proxyEntrypoint: "/workspace/.paperclip-runtime/run-tools-proxy.mjs",
        secretFile: "/workspace/.paperclip-runtime/run-tools.json",
      }),
    ).toEqual({
      name: "paperclip",
      command: "/opt/paperclip/node/bin/node",
      args: [
        "/workspace/.paperclip-runtime/run-tools-proxy.mjs",
        "/workspace/.paperclip-runtime/run-tools.json",
      ],
      env: [],
    });
  });

  it("rejects a PATH-resolved Node fallback", () => {
    expect(() =>
      createPaperclipRunToolsMcpServer({
        nodeExecutable: "node",
        proxyEntrypoint: "/runtime/run-tools-proxy.mjs",
        secretFile: "/runtime/run-tools.json",
      }),
    ).toThrow(/target Node executable must be an exact absolute path/);
  });
});
