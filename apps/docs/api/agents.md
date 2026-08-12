---
title: Agents
summary: Board-operated agent identity, grants, ACP configuration, lifecycle, and run readiness
---

Agent endpoints are board/operator control-plane routes. Productive
ACPX-backed provider runs cannot call them and have no self-profile route or
generic Paperclip credential.

## List and get

```http
GET /api/companies/{companyId}/agents
GET /api/companies/{companyId}/task-owner-catalog
GET /api/agents/{agentId}
GET /api/companies/{companyId}/org
```

Agent identity contains name, optional display title, capabilities, optional
board-owned `instruction`, and optional `reportsTo`. There is no role field,
chain-of-command authority, or privileged first/root agent.

The company-authorized task-owner catalog is the picker projection for new
ownership. It returns only `id`, `name`, `title`, and `icon`, and omits any
paused, pending-approval, terminated, invalid-reporting-chain,
or missing-revision agent through the canonical invokable-owner resolver.
Executable readiness is evaluated when a run launches, not by this picker. It
is presentation, not an authorization lease: creation and reassignment resolve
the selected owner again while locking the write transaction.

## Create an ordinary agent

```http
POST /api/companies/{companyId}/runtime-agents
Content-Type: application/json

{
  "name": "Engineer",
  "title": "Software Engineer",
  "reportsTo": "00000000-0000-4000-8000-000000000001",
  "capabilities": "Full-stack development",
  "contextGrants": {
    "carry_context": false,
    "read_task_comments": false,
    "read_task_agent_run": false,
    "list_sub_tasks": false,
    "read_sub_task_comments": false,
    "read_sub_task_agent_run": false,
    "list_company_tasks": false,
    "read_company_task_comments": false,
    "read_company_task_agent_run": false
  },
  "actionGrants": {
    "task_create": false,
    "mention_board": false,
    "agent_hire": false,
    "agent_configure": false,
    "list_all_agents": false,
    "list_parent_agents": false
  },
  "mentionReachGrants": {
    "mention_any_descendant": false,
    "mention_any_ancestor": false
  }
}
```

Creation is explicit and does not accept adapter/provider configuration. It
does not mint a Paperclip credential, install a provider instruction package, create an
agent-wide session, or stamp role-derived grants. The complete context/action
and mention-reach maps make the all-false baseline unambiguous.

`task_create` is the combined create-and-assign grant: it permits an exact
creator execution to create direct children and reassign its eligible direct
children. `task_update` is not a configured grant. The current owner receives
an active-task update automatically, and the exact creator execution receives
an eligible-child update automatically. Both use the same canonical
`task_update({ message, status?, structuredResult?, taskId? })` path, which
delivers the update message to the owner/creator counterpart; there is no
separate agent comment path for that update. Omit `taskId` for the active owned
task; provide an eligible direct-child ID for a creator update. The current
owner alone may set terminal `done`/`cancelled` and `structuredResult`; a
creator update may send a message or set nonterminal `open`/`blocked`.

## Runtime identity and grants

```http
GET /api/agents/{agentId}/runtime-configuration
PATCH /api/agents/{agentId}/runtime-configuration
```

Runtime configuration owns only identity, reporting structure, context/action
grants, and mention reach. Adapter, budget, lifecycle, and provider-native
state are separate owners.

## Immutable ACP adapter revisions

```http
GET /api/agents/{agentId}/adapter-config-revisions
GET /api/agents/{agentId}/adapter-config-revisions/current
POST /api/agents/{agentId}/adapter-config-revisions
```

Example template; obtain the exact `adapterType` and `adapterConfig` fields from
the live ACPX-backed adapter catalog before creating a revision:

```json
{
  "adapterType": "<acpx-registry-name>",
  "adapterConfig": {
    "<acpx-option-id>": "<selected-advertised-value>"
  },
  "runtimeConfig": {}
}
```

The server resolves this data through the current ACPX-discovered declarative
`acpx-runtime/v1` definition and stores an immutable non-secret revision.
ACPX supplies the exact registry name and advertised option values, then owns
the local CLI process/session/event behavior through its public runtime. A
request cannot supply a command, argv, endpoint, provider payload, response
parser, native-session selector, or provider credential.

If ACPX advertises a reasoning-effort configuration option, include its exact
option id and one advertised value in `adapterConfig`. Paperclip stores that
selection in the revision and applies it at session setup; it never creates a
provider-specific reasoning field on its own.

Provider authentication stays in the selected CLI's native login state.
Paperclip neither stores nor probes it. There is no default adapter inference
or fallback to another registered name.

## Operational configuration

```http
PATCH /api/agents/{agentId}/operational-configuration
```

Display icon and monthly budget belong to this board-only contract. Adapter
revisions, runtime grants, lifecycle, spend, and Session state are not generic
agent-patch fields.

## Lifecycle

```http
POST /api/agents/{agentId}/pause
POST /api/agents/{agentId}/resume
POST /api/agents/{agentId}/clear-error
POST /api/agents/{agentId}/terminate
```

Termination preserves the immutable task/Session/run/comment audit. It
cancels live work and follows canonical creator recovery for open owned tasks.

There is no generic invoke/wake endpoint, agent API-key endpoint, agent-wide
runtime reset, or conversational-session endpoint. Work begins only through a
canonical task-execution source.

## Structural readiness

```http
POST /api/companies/{companyId}/adapters/{adapterType}/test-configuration
```

Structural readiness requires current ACPX registry membership, legal stable
ACPX configuration selections, and the agent's live eligibility/budget state.
It uses a disposable no-prompt ACPX probe and never sends a model conversation.

The configuration-test endpoint accepts the exact unsaved generic ACPX
selection object:

```json
{
  "adapterConfig": {
    "<acpx-option-id>": "<selected-advertised-value>"
  }
}
```

It requires board authority with `agents:create`, applies the canonical ACPX
configuration resolver, and opens a strictly disposable no-prompt ACPX session
in a fresh temporary directory. The response is only a `ready` or sanitized
`failed` observation. It creates no agent, revision, or run and does not claim
that a future execution can start.
