import { describe, expect, it } from "vitest";
import {
  MCP_SETUP_AGENTS,
  buildMcpInstallScript,
} from "../services/board-mcp-install-script.js";

describe("Board MCP installer", () => {
  it("keeps the TradingGoose-style setup flow on the canonical board-key lifecycle", () => {
    const script = buildMcpInstallScript("https://paperclip.example/", {
      command: "setup",
      target: "codex",
      format: "sh",
    });

    expect(script).toContain("https://paperclip.example");
    expect(script).toContain("/api/mcp");
    expect(script).toContain("/api/cli-auth/challenges");
    expect(script).toContain("/api/cli-auth/me");
    expect(script).toContain("PAPERCLIP_AUTH_STORE");
    expect(script).toContain("PAPERCLIP_HOME");
    expect(script).toContain("auth.json");
    expect(script).not.toContain("/api/auth/mcp/");
    expect(script).not.toContain("PAPERCLIP_CONFIG_DIR");
    expect(script).toContain("mcpServerName = 'Paperclip'");
    expect(script).toContain('TARGETS="codex"');
  });

  it("keeps the supported local coding-agent targets aligned across installers", () => {
    expect(MCP_SETUP_AGENTS).toEqual([
      "claude",
      "cursor",
      "opencode",
      "codex",
      "antigravity",
      "gemini",
    ]);

    const script = buildMcpInstallScript("https://paperclip.example", {
      command: "setup",
      target: "codex",
      format: "powershell",
    });
    expect(script).toContain("$Targets = @('codex')");
    expect(script).toContain("Authorization: Bearer");
  });
});
