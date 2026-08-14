import { MCP_LOCAL_INSTALLER_SCRIPT } from "./board-mcp-install-runtime-script.js";

export type McpInstallCommand = "setup" | "login";

export type McpInstallTarget = "claude" | "cursor" | "opencode" | "codex" | "antigravity" | "gemini" | "all";

export type McpInstallScriptFormat = "sh" | "powershell";

export interface McpInstallScriptOptions {
  command: McpInstallCommand;
  target?: McpInstallTarget;
  format?: McpInstallScriptFormat;
}

/** Selection order mirrors the Context7 CLI agent registry. */
export const MCP_SETUP_AGENTS = ["claude", "cursor", "opencode", "codex", "antigravity", "gemini"] as const;

export function getInitialTargets(target: McpInstallTarget | undefined) {
  if (!target) {
    return "";
  }

  return target === "all" ? MCP_SETUP_AGENTS.join(" ") : target;
}

export function getInitialPowerShellTargets(target: McpInstallTarget | undefined) {
  if (!target) {
    return "@()";
  }

  const targets = target === "all" ? [...MCP_SETUP_AGENTS] : [target];
  return `@(${targets.map((item) => `'${item}'`).join(", ")})`;
}

export function buildMcpInstallScript(baseUrl: string, options: McpInstallScriptOptions) {
  return options.format === "powershell"
    ? buildPowerShellInstallScript(baseUrl, options)
    : buildShellInstallScript(baseUrl, options);
}

export function shellSingleQuote(value: string) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function powerShellSingleQuote(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function buildShellInstallScript(baseUrl: string, options: McpInstallScriptOptions) {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const initialTargets = getInitialTargets(options.target);

  return `#!/bin/sh
set -eu

BASE_URL=${shellSingleQuote(normalizedBaseUrl)}
COMMAND="${options.command}"
TARGETS="${initialTargets}"

usage() {
  cat <<'USAGE'
Paperclip MCP setup

Usage:
  curl -fsSL <paperclip-url>/mcp/setup | sh
  curl -fsSL <paperclip-url>/mcp/setup/codex | sh
  curl -fsSL <paperclip-url>/mcp/login | sh

PowerShell:
  irm <paperclip-url>/mcp/setup | iex
  irm <paperclip-url>/mcp/setup/codex | iex
  irm <paperclip-url>/mcp/login | iex

Commands:
  login   Print the MCP endpoint and authorization header, authenticating when needed.
  setup   Write MCP config, authenticating when needed.

Targets:
  claude, cursor, opencode, codex, antigravity, gemini, all

Options:
  -h, --help        Show this help.
USAGE
}

fail() {
  echo "paperclip-mcp: $*" >&2
  exit 1
}

# The installer is written to a temp file rather than piped to "node -" so that
# node's stdin stays free for the interactive target picker. Under "curl | sh"
# the shell's own stdin is the curl pipe, so we hand node the controlling
# terminal explicitly.
run_installer() {
  command -v node >/dev/null 2>&1 || fail "node is required to configure MCP auth and write config."

  tmp_dir=$(mktemp -d 2>/dev/null || mktemp -d -t paperclip-mcp) || fail "unable to create a temporary directory."
  trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

  cat >"$tmp_dir/installer.js" <<'NODE'
${MCP_LOCAL_INSTALLER_SCRIPT}
NODE

  # A -r test on /dev/tty only checks permission bits and still passes when the
  # process has no controlling terminal, so probe by actually opening it. The
  # probe runs in a subshell because ":" is a special builtin, and a redirection
  # failure on one of those aborts the whole script under POSIX sh.
  if (: </dev/tty) 2>/dev/null; then
    node "$tmp_dir/installer.js" "$BASE_URL" "$COMMAND" "$TARGETS" </dev/tty
  else
    node "$tmp_dir/installer.js" "$BASE_URL" "$COMMAND" "$TARGETS"
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown option: $1"
      ;;
  esac
  shift
done

case "$COMMAND" in
  setup|login)
    run_installer
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    fail "Unknown command: $COMMAND"
    ;;
esac
`;
}

export function buildPowerShellInstallScript(baseUrl: string, options: McpInstallScriptOptions) {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const initialTargets = getInitialPowerShellTargets(options.target);

  return `$ErrorActionPreference = 'Stop'

# Box-drawing and spinner glyphs need a UTF-8 console on legacy Windows hosts.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$BaseUrl = ${powerShellSingleQuote(normalizedBaseUrl)}
$Command = '${options.command}'
$Targets = ${initialTargets}

function Show-Usage {
  @'
Paperclip MCP setup

Usage:
  irm <paperclip-url>/mcp/setup | iex
  irm <paperclip-url>/mcp/setup/codex | iex
  irm <paperclip-url>/mcp/login | iex

POSIX shell:
  curl -fsSL <paperclip-url>/mcp/setup | sh
  curl -fsSL <paperclip-url>/mcp/setup/codex | sh
  curl -fsSL <paperclip-url>/mcp/login | sh

Commands:
  login   Print the MCP endpoint and authorization header, authenticating when needed.
  setup   Write MCP config, authenticating when needed.

Targets:
  claude, cursor, opencode, codex, antigravity, gemini, all

Options:
  -h, --help        Show this help.
'@ | Write-Output
}

function Fail([string] $Message) {
  Write-Error "paperclip-mcp: $Message"
  exit 1
}

# Written to a temp file rather than piped to "node -" so node's stdin stays
# attached to the console for the interactive target picker.
function Run-Installer {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail 'node is required to configure MCP auth and write config.'
  }

  $TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ('paperclip-mcp-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $TempDir -Force | Out-Null

  try {
    $ScriptPath = Join-Path $TempDir 'installer.js'
    $NodeScript = @'
${MCP_LOCAL_INSTALLER_SCRIPT}
'@
    Set-Content -LiteralPath $ScriptPath -Value $NodeScript -Encoding UTF8
    & node $ScriptPath $BaseUrl $Command ($Targets -join ' ')
    if ($LASTEXITCODE -ne 0) {
      exit $LASTEXITCODE
    }
  } finally {
    Remove-Item -LiteralPath $TempDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

for ($Index = 0; $Index -lt $args.Count; $Index++) {
  switch ($args[$Index]) {
    '-h' {
      Show-Usage
      exit 0
    }
    '--help' {
      Show-Usage
      exit 0
    }
    default {
      Fail "Unknown option: $($args[$Index])"
    }
  }
}

switch ($Command) {
  'setup' {
    Run-Installer
  }
  'login' {
    Run-Installer
  }
  default {
    Fail "Unknown command: $Command"
  }
}
`;
}
export * from "./board-mcp-install-runtime-script.js";
