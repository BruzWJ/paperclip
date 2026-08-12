---
title: Board MCP
summary: Connect a local coding client to Paperclip as an authenticated Board user
---

Paperclip Board MCP lets a human-operated local coding client such as Codex,
Claude Code, Cursor, OpenCode, or Gemini CLI control Paperclip with the
authenticated Board user's authority.

Board MCP is a board-user interface, not an agent runtime. ACPX remains the
only contract Paperclip uses to launch provider agents, configure provider
sessions, send prompts, and resume executions. Provider-run agents receive
only their short-lived, task-scoped `/api/run-tools` capability.

Board MCP uses the normal Paperclip board API key. It creates neither a second
MCP credential nor a provider credential.

## Install

Run the installer for a specific local client:

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
writes that client's MCP configuration. It supports Claude Code, Cursor,
OpenCode, Codex, Antigravity, Gemini CLI, or `all`.

It reuses the same local board-key store as the Paperclip CLI:
`~/.paperclip/auth.json` by default, or `PAPERCLIP_AUTH_STORE` /
`PAPERCLIP_HOME` when configured. Installing Board MCP therefore does not
create another token lifecycle.

To print the endpoint and authorization header without writing a client
configuration:

```sh
curl -fsSL https://paperclip.example/mcp/login | sh
```

## Endpoint and authority

The configured Streamable HTTP endpoint is:

```text
https://paperclip.example/api/mcp
```

Every request authenticates with the normal board API key:

```text
Authorization: Bearer pcp_board_...
```

Keep the key in local credential storage only. Revoking the board key revokes
Board MCP access immediately.

During MCP initialization, Paperclip lists each company accessible to the
authenticated user, including its canonical company UUID and membership role.
Calls remain limited to the user's current active company memberships.

Board MCP exposes the Board projection of Paperclip's managed-tool registry:

- Context: `list_company_tasks`, `list_sub_tasks`, `read_task_comments`,
  `read_task_agent_run`
- Tasks: `task_create`, `task_assign`, `task_update`, `mention_agent`
- Agents: `agent_hire`, `agent_configure`, `list_agents`, `agent_read`

`mention_board` is omitted because this interface already acts as the Board.
Board authority does not use provider-agent grants, context dials, or mention
reach. Company tenancy, exact identifiers, canonical task lifecycle rules,
activity logging, and all domain invariants still apply.

Use Board MCP only for a human-approved local coding client that should act
with that Board user's authority. It is not available to provider executions
and is not a compatibility or fallback path for ACPX.
