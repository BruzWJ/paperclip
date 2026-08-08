import { MCP_LOCAL_CONFIG_WRITER_SCRIPT } from './board-mcp-local-config-writer-script.js'
import { MCP_TERMINAL_UI_SCRIPT } from './board-mcp-terminal-ui-script.js'

type McpInstallCommand = 'setup' | 'login'
export type McpInstallTarget =
  | 'claude'
  | 'cursor'
  | 'opencode'
  | 'codex'
  | 'antigravity'
  | 'gemini'
  | 'all'
export type McpInstallScriptFormat = 'sh' | 'powershell'

export interface McpInstallScriptOptions {
  command: McpInstallCommand
  target?: McpInstallTarget
  format?: McpInstallScriptFormat
}

/** Selection order mirrors the Context7 CLI agent registry. */
export const MCP_SETUP_AGENTS = [
  'claude',
  'cursor',
  'opencode',
  'codex',
  'antigravity',
  'gemini',
] as const

function getInitialTargets(target: McpInstallTarget | undefined) {
  if (!target) {
    return ''
  }

  return target === 'all' ? MCP_SETUP_AGENTS.join(' ') : target
}

function getInitialPowerShellTargets(target: McpInstallTarget | undefined) {
  if (!target) {
    return '@()'
  }

  const targets = target === 'all' ? [...MCP_SETUP_AGENTS] : [target]
  return `@(${targets.map((item) => `'${item}'`).join(', ')})`
}

const MCP_INSTALLER_MAIN_SCRIPT = String.raw`const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const baseUrl = process.argv[2].replace(/\/+$/, '')
const command = process.argv[3]
const targets = process.argv[4] ? process.argv[4].split(/\s+/).filter(Boolean) : []
const mcpUrl = baseUrl + '/api/mcp'
const configWriterScript = ${JSON.stringify(MCP_LOCAL_CONFIG_WRITER_SCRIPT)}

const AGENT_NAMES = {
  claude: 'Claude Code',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  codex: 'Codex',
  antigravity: 'Antigravity',
  gemini: 'Gemini CLI',
}
const AGENT_ORDER = ['claude', 'cursor', 'opencode', 'codex', 'antigravity', 'gemini']
const AUTH_MODE_LABEL = 'Board API Key'

function fail(message) {
  console.error(pc.red(symbols.cross + ' ') + 'paperclip-mcp: ' + message)
  process.exit(1)
}

function requireFetch() {
  if (typeof fetch !== 'function') {
    fail('node 18 or newer is required to configure MCP auth.')
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function requestJson(url, init) {
  const headers = new Headers(init?.headers)
  if (init?.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  if (!headers.has('accept')) headers.set('accept', 'application/json')
  const response = await fetch(url, { ...(init || {}), headers })

  if (!response.ok) {
    const body = await response.json().catch(() => null)
    const detail = body && typeof body === 'object' && typeof body.error === 'string'
      ? body.error
      : 'HTTP ' + response.status
    throw new Error(url + ': ' + detail)
  }

  return response.headers.get('content-type')?.includes('application/json')
    ? response.json()
    : null
}

function runConfigWriter(args) {
  const result = spawnSync(process.execPath, ['-', ...args], {
    input: configWriterScript,
    encoding: 'utf8',
  })

  if (result.status !== 0) {
    throw new Error((result.stderr || 'Failed to run the MCP config writer.').trim())
  }

  return JSON.parse(result.stdout.trim())
}

function paperclipHome() {
  const configured = process.env.PAPERCLIP_HOME && process.env.PAPERCLIP_HOME.trim()
  if (!configured) return path.join(os.homedir(), '.paperclip')
  if (configured === '~') return os.homedir()
  if (configured.startsWith('~/') || configured.startsWith('~\\')) {
    return path.join(os.homedir(), configured.slice(2))
  }
  return path.resolve(configured)
}

function credentialsFile() {
  const override = process.env.PAPERCLIP_AUTH_STORE && process.env.PAPERCLIP_AUTH_STORE.trim()
  return override ? path.resolve(override) : path.join(paperclipHome(), 'auth.json')
}

function normalizedApiBase() {
  return baseUrl.replace(/\/+$/, '')
}

/** Read the exact board-key store shared with the Paperclip CLI login. */
function readStoredApiKey() {
  try {
    const raw = fs.readFileSync(credentialsFile(), 'utf8').trim()
    if (!raw) return null

    const parsed = JSON.parse(raw)
    const credentials = parsed && parsed.credentials && typeof parsed.credentials === 'object'
      ? parsed.credentials
      : null
    const stored = credentials && credentials[normalizedApiBase()]
    const token = stored && typeof stored.token === 'string' ? stored.token.trim() : ''
    return token || null
  } catch {
    return null
  }
}

function saveApiKey(token, userId) {
  try {
    const file = credentialsFile()
    let existing = { version: 1, credentials: {} }
    try {
      const raw = fs.readFileSync(file, 'utf8').trim()
      const parsed = raw ? JSON.parse(raw) : null
      if (parsed && parsed.credentials && typeof parsed.credentials === 'object') {
        existing = { version: 1, credentials: parsed.credentials }
      }
    } catch {}
    const now = new Date().toISOString()
    const apiBase = normalizedApiBase()
    const prior = existing.credentials[apiBase]
    existing.credentials[apiBase] = {
      apiBase,
      token,
      createdAt: prior && typeof prior.createdAt === 'string' ? prior.createdAt : now,
      updatedAt: now,
      userId: typeof userId === 'string' && userId.trim() ? userId.trim() : null,
    }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, JSON.stringify(existing, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    })
    fs.chmodSync(file, 0o600)
  } catch (error) {
    log.warn(
      'Could not save credentials to ' +
        credentialsFile() +
        ': ' +
        (error instanceof Error ? error.message : String(error))
    )
  }
}

/**
 * The MCP endpoint authenticates the bearer token on every request, so it
 * doubles as the validity check. The result is deliberately three-state: the
 * endpoint rate-limits before it authenticates, so a 429/503/500 says nothing
 * about the key and must never be read as success. Only a 2xx proves the key
 * still authenticates; only a 401 proves it does not.
 */
async function checkStoredApiKey(token) {
  let response
  try {
    response = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
  } catch (error) {
    return {
      state: 'unverified',
      detail: error instanceof Error ? error.message : String(error),
    }
  }

  if (response.status === 401) {
    return { state: 'invalid' }
  }
  if (response.ok) {
    return { state: 'valid' }
  }
  return { state: 'unverified', detail: 'HTTP ' + response.status }
}

/**
 * Reuses a still-valid saved key so repeat installs on the same machine do not
 * mint duplicate personal API keys, and only falls back to a browser login when
 * there is nothing usable on disk.
 */
async function resolveApiKey() {
  const stored = readStoredApiKey()

  if (stored) {
    const checking = spinner('Checking saved credentials...').start()
    const check = await checkStoredApiKey(stored)

    if (check.state === 'valid') {
      checking.succeed(pc.brand('Using saved Paperclip credentials'))
      return stored
    }

    // Stop rather than guess. Writing an unconfirmed token would leave every
    // configured client unable to authenticate, and signing in again would mint
    // a duplicate key for what is usually a transient outage.
    if (check.state === 'unverified') {
      checking.fail(pc.red('Could not verify saved credentials'))
      fail(
        'Paperclip could not confirm the saved credentials (' +
          check.detail +
          '). No configuration was changed; run the command again once Paperclip is reachable.'
      )
    }

    checking.stop()
    log.warn('Saved credentials are no longer valid, signing in again.')
  }

  const login = await authenticate()
  saveApiKey(login.token, login.userId)
  return login.token
}

/**
 * Rejects anything we can detect up front, so an unusable run fails before the
 * user is sent through a browser login rather than after it.
 */
function assertSetupIsPossible() {
  for (const target of targets) {
    if (!AGENT_NAMES[target]) {
      fail('Unsupported setup target: ' + target)
    }
  }

  if (targets.length === 0 && !process.stdin.isTTY) {
    fail('setup requires an interactive terminal or a target URL such as /mcp/setup/codex.')
  }
}

async function chooseTargets() {
  if (targets.length > 0) {
    return targets
  }

  log.blank()
  return checkbox({
    message: 'Which agents do you want to set up?',
    choices: AGENT_ORDER.map((name) => ({ name: AGENT_NAMES[name], value: name })),
  })
}

async function authenticate() {
  let spin = spinner('Preparing login...').start()
  const abort = (message) => {
    spin.fail(pc.red('Login failed'))
    fail(message)
  }
  const asMessage = (error) => (error instanceof Error ? error.message : String(error))

  const start = await requestJson(baseUrl + '/api/cli-auth/challenges', {
    method: 'POST',
    // This is the same-origin device entrypoint used by the Paperclip CLI.
    // Naming the origin also keeps an ambient browser session, if one is
    // supplied by a host fetch implementation, inside the mutation fence.
    headers: { origin: baseUrl },
    body: JSON.stringify({
      command: 'Paperclip MCP setup',
      clientName: 'Paperclip MCP',
      requestedAccess: 'board',
      requestedCompanyId: null,
    }),
  }).catch((error) => abort(asMessage(error)))

  const challengeId = String(start?.id || '')
  const challengeToken = String(start?.token || '')
  // This normal Board key stays only in this installer process until browser
  // approval. It is the same key used by Paperclip CLI and Board MCP.
  const pendingBoardApiKey = String(start?.boardApiToken || '')
  const approvalPath = String(start?.approvalPath || '')
  const authorizeUrl = String(start?.approvalUrl || (approvalPath ? baseUrl + approvalPath : ''))
  const pollPath = String(start?.pollPath || '')
  const expiresAt = String(start?.expiresAt || '')
  const pollMs = Math.max(500, Number(start?.suggestedPollIntervalMs) || 1000)
  const missing = !challengeId
    ? 'challenge id'
    : !challengeToken
      ? 'verification key'
      : !pendingBoardApiKey
        ? 'board API key'
        : !authorizeUrl
          ? 'authorization URL'
          : !pollPath
            ? 'poll path'
          : ''
  if (missing) abort('Paperclip did not return a login ' + missing)

  spin.stop()
  log.blank()
  log.plain('  ' + pc.dim('Open this link to approve MCP access:'))
  log.plain('  ' + pc.cyan(link(authorizeUrl, authorizeUrl)))
  log.blank()
  spin = spinner('Waiting for authorization...').start()

  const parsedExpiry = Date.parse(expiresAt)
  const deadline = Number.isFinite(parsedExpiry) ? parsedExpiry : Date.now() + 600000
  while (Date.now() < deadline) {
    const poll = await requestJson(
      baseUrl + '/api' + pollPath + '?token=' + encodeURIComponent(challengeToken),
    ).catch((error) => abort(asMessage(error)))
    const status = String(poll?.status || 'pending')

    if (status === 'approved') {
      const me = await requestJson(baseUrl + '/api/cli-auth/me', {
        headers: { authorization: 'Bearer ' + pendingBoardApiKey },
      }).catch((error) => abort(asMessage(error)))
      spin.succeed(pc.brand('Authorized'))
      return {
        token: pendingBoardApiKey,
        userId: typeof me?.userId === 'string'
          ? me.userId
          : typeof me?.user?.id === 'string'
            ? me.user.id
            : null,
      }
    }
    if (status === 'cancelled') abort('Login was cancelled. Run the command again.')
    if (status === 'expired') abort('Login expired. Run the command again.')
    if (status !== 'pending') abort('Unexpected login status: ' + status)

    await sleep(pollMs)
  }

  abort('Timed out waiting for browser approval')
}

function configureTarget(target, apiKey) {
  try {
    const written = runConfigWriter([target, mcpUrl, apiKey])
    return {
      agent: AGENT_NAMES[target],
      path: written.path,
      status: (written.alreadyExists ? 'reconfigured' : 'configured') + ' with ' + AUTH_MODE_LABEL,
    }
  } catch (error) {
    return {
      agent: AGENT_NAMES[target],
      path: '',
      status: 'failed: ' + (error instanceof Error ? error.message : String(error)),
    }
  }
}

function renderResults(results) {
  log.blank()
  for (const result of results) {
    log.plain('  ' + pc.bold(result.agent))
    const failed = result.status.startsWith('failed:')
    const icon = failed ? pc.red(symbols.cross) : pc.brand('+')
    log.plain('    ' + icon + ' MCP server ' + (failed ? 'failed' : result.status))
    if (failed) {
      log.plain('      ' + pc.red(result.status.slice('failed: '.length)))
    } else {
      log.plain('      ' + pc.dim(result.path))
    }
  }
  log.blank()
}

async function main() {
  requireFetch()

  if (command === 'login') {
    const apiKey = await resolveApiKey()

    log.blank()
    log.plain('  ' + pc.bold('MCP endpoint'))
    log.plain('    ' + pc.dim(mcpUrl))
    log.plain('  ' + pc.bold('MCP authorization header'))
    log.plain('    ' + pc.dim('Authorization: Bearer ' + apiKey))
    log.blank()
    return
  }

  if (command === 'setup') {
    assertSetupIsPossible()

    // Resolve credentials before prompting: the key is what the whole run
    // depends on, so a failed or abandoned login should not cost the user a
    // selection, and every target in this run shares the one key.
    const apiKey = await resolveApiKey()

    const selected = await chooseTargets()
    if (!selected || selected.length === 0) {
      log.warn('Setup cancelled')
      return
    }

    log.blank()
    const setupSpinner = spinner('Setting up Paperclip...').start()
    const results = []
    for (const target of selected) {
      setupSpinner.setText('Setting up ' + AGENT_NAMES[target] + '...')
      results.push(configureTarget(target, apiKey))
    }
    setupSpinner.succeed('Paperclip setup complete')

    renderResults(results)
    return
  }

  fail('Unknown command: ' + command)
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)))
`

const MCP_LOCAL_INSTALLER_SCRIPT = `${MCP_TERMINAL_UI_SCRIPT}\n${MCP_INSTALLER_MAIN_SCRIPT}`

export function buildMcpInstallScript(baseUrl: string, options: McpInstallScriptOptions) {
  return options.format === 'powershell'
    ? buildPowerShellInstallScript(baseUrl, options)
    : buildShellInstallScript(baseUrl, options)
}

function shellSingleQuote(value: string) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

function powerShellSingleQuote(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}

function buildShellInstallScript(baseUrl: string, options: McpInstallScriptOptions) {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '')
  const initialTargets = getInitialTargets(options.target)

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
`
}

function buildPowerShellInstallScript(baseUrl: string, options: McpInstallScriptOptions) {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '')
  const initialTargets = getInitialPowerShellTargets(options.target)

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
`
}
