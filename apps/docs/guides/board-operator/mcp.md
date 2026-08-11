---
title: Board MCP
summary: Connect a local coding agent to Paperclip as an authenticated Board user
---

Paperclip Board MCP lets a local coding agent such as Codex, Claude Code, or
Cursor operate Paperclip on behalf of the authenticated Board user.

It uses the normal Paperclip board API key. There is no second MCP credential
and no per-tool agent grant configuration.

## Install

Run the installer for a specific coding agent:

```sh
curl -fsSL https://paperclip.example/mcp/setup/codex | sh
```

Or choose targets interactively:

```sh
curl -fsSL https://paperclip.example/mcp/setup | sh
```

On PowerShell:

```powershell
irm https://paperclip.example/mcp/setup/codex | iex
```

The installer opens a browser approval page when it needs a board key, then
writes the matching local MCP client configuration. It supports Claude Code,
Cursor, OpenCode, Codex, Antigravity, Gemini CLI, or `all`.

It reuses the same local board-key store as the Paperclip CLI:
`~/.paperclip/auth.json` by default (or `PAPERCLIP_AUTH_STORE` / `PAPERCLIP_HOME`
when those are set). Installing MCP therefore does not create a second
credential or token lifecycle.

To print the endpoint and authorization header without writing a client
configuration:

```sh
curl -fsSL https://paperclip.example/mcp/login | sh
```

## MCP endpoint

The configured Streamable HTTP endpoint is:

```text
https://paperclip.example/api/mcp
```

It authenticates on every request with the normal board API key:

```text
Authorization: Bearer pcp_board_...
```

Keep the key in local credential storage only. Revoking the board key revokes
MCP access immediately.

## Companies and tools

During MCP initialization, Paperclip includes every company accessible to the
board user in the MCP instructions as a company name, ID, and membership role.
Use those `companyId` values when calling tools. There is deliberately no
`list_companies` tool.

Board MCP exposes the full Paperclip managed-tool catalog except
`mention_board`, because this MCP already acts as the Board:

- Context: `list_company_tasks`, `list_sub_tasks`,
  `read_task_comments`, `read_task_agent_run`
- Tasks: `task_create`, `task_assign`, `task_update`, `mention_agent`
- Agents: `agent_hire`, `agent_configure`, `list_agents`, `agent_read`

All context access is enabled and Board MCP does not consult agent action
grants, context dials, or mention-reach grants. The remaining boundary is the
board user's active company membership, plus Paperclip's canonical task
lifecycle and audit behavior.

`mention_agent` uses the same Board comment mention transaction as the UI, so
it targets the task's exact current owner and ownership epoch.

## When to use it

Use Board MCP for a human-approved local coding agent that should control a
company directly. Provider-run agents continue to receive only their
short-lived, task-scoped compiled tool interface; a provider execution never
receives a board key.
