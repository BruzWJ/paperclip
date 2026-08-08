import { Router, type Request, type Response } from "express";
import {
  MCP_SETUP_AGENTS,
  buildMcpInstallScript,
  type McpInstallScriptFormat,
  type McpInstallScriptOptions,
} from "../services/board-mcp-install-script.js";
import { requireRequestAuthority } from "../http/request-authority.js";

const SETUP_TARGETS = new Set<string>([...MCP_SETUP_AGENTS, "all"]);

function parseInstallOptions(command: string[]): McpInstallScriptOptions | null {
  if (command.length === 0) return { command: "setup" };
  if (command.length === 1 && command[0] === "login") {
    return { command: "login" };
  }
  if (command[0] === "setup") {
    if (command.length === 1) return { command: "setup" };
    const target = command[1];
    if (command.length === 2 && target && SETUP_TARGETS.has(target)) {
      return {
        command: "setup",
        target: target as McpInstallScriptOptions["target"],
      };
    }
  }
  return null;
}

function resolveScriptFormat(request: Request): McpInstallScriptFormat {
  const userAgent = request.header("user-agent") ?? "";
  return /\b(?:PowerShell|WindowsPowerShell|pwsh)\b/i.test(userAgent)
    ? "powershell"
    : "sh";
}

function sendInstaller(command: string[], req: Request, res: Response) {
  const options = parseInstallOptions(command);
  if (!options) {
    res
      .status(404)
      .set("Content-Type", "text/plain; charset=utf-8")
      .set("X-Content-Type-Options", "nosniff")
      .send("Unknown MCP installer command\n");
    return;
  }
  const format = resolveScriptFormat(req);
  const baseUrl = requireRequestAuthority(req).origin;
  res
    .status(200)
    .set("Cache-Control", "no-store")
    .set(
      "Content-Type",
      format === "powershell"
        ? "text/x-powershell; charset=utf-8"
        : "text/x-shellscript; charset=utf-8",
    )
    .set("X-Content-Type-Options", "nosniff")
    .send(buildMcpInstallScript(baseUrl, { ...options, format }));
}

/**
 * Direct Express port of TradingGoose's `/mcp/[[...command]]` installer
 * route. Its generated scripts use the existing Paperclip board-key device
 * approval endpoints rather than a new MCP credential type.
 */
export function boardMcpSetupRoutes() {
  const router = Router();
  router.get("/mcp", (req, res) => sendInstaller([], req, res));
  router.get("/mcp/:command", (req, res) =>
    sendInstaller([(req.params.command as string).trim()], req, res),
  );
  router.get("/mcp/:command/:target", (req, res) =>
    sendInstaller(
      [
        (req.params.command as string).trim(),
        (req.params.target as string).trim(),
      ],
      req,
      res,
    ),
  );
  return router;
}

