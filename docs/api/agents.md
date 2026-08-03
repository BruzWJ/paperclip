---
title: Agents
summary: Board-operated agent identity, grants, ACP configuration, lifecycle, and run readiness
---

Agent endpoints are board/operator control-plane routes. Productive ACP
subprocesses cannot call them and have no self-profile route or generic
Paperclip credential.

## List and get

```http
GET /api/companies/{companyId}/agents
GET /api/companies/{companyId}/issue-owner-catalog
GET /api/agents/{agentId}
GET /api/companies/{companyId}/org
```

Agent identity contains name, optional display title, capabilities, and
optional `reportsTo`. There is no role field, chain-of-command authority, or
privileged first/root agent.

The company-authorized issue-owner catalog is the picker projection for new
ownership. It returns only `id`, `name`, `title`, and `icon`, and omits any
paused, pending-approval, terminated, invalid-reporting-chain,
missing-revision, or unavailable-implementation agent through the canonical
invokable-owner resolver. It is presentation, not an authorization lease:
creation and reassignment resolve the selected owner again while locking the
write transaction.

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
    "read_issue_comments": false,
    "read_issue_agent_run": false,
    "list_sub_issues": false,
    "read_sub_issue_comments": false,
    "read_sub_issue_agent_run": false,
    "list_company_issues": false,
    "read_company_issue_comments": false,
    "read_company_issue_agent_run": false
  },
  "actionGrants": {
    "issue_create": false,
    "issue_assign": false,
    "issue_update": false,
    "mention_agent": false,
    "agent_hire": false,
    "agent_configure": false
  },
  "mentionReachGrants": {
    "mention_any_descendant": false,
    "mention_any_ancestor": false
  },
  "companyToolIds": []
}
```

Creation is explicit and does not accept adapter/provider configuration. It
does not mint a Paperclip credential, install an operational skill, create an
agent-wide session, or stamp role-derived grants. The complete context/action
and mention-reach maps make the all-false baseline unambiguous.

## Runtime identity and grants

```http
GET /api/agents/{agentId}/runtime-configuration
PATCH /api/agents/{agentId}/runtime-configuration
GET /api/agents/{agentId}/runtime-configuration/tool-options
```

Runtime configuration owns only identity, reporting structure, context/action
grants, mention reach, and explicit company-tool selection. Adapter, budget,
lifecycle, and provider-native state are separate owners.

## Immutable ACP adapter revisions

```http
GET /api/agents/{agentId}/adapter-config-revisions
GET /api/agents/{agentId}/adapter-config-revisions/current
POST /api/agents/{agentId}/adapter-config-revisions
```

Example for the initial conformance-approved built-in adapter:

```json
{
  "adapterType": "codex",
  "adapterConfig": {
    "model": "gpt-5.6"
  },
  "defaultEnvironmentId": "00000000-0000-4000-8000-000000000002",
  "runtimeConfig": {},
  "companySkillPins": [],
  "skillChannel": "operator_native"
}
```

The server resolves this data through the exact installed declarative
`acp-subprocess/v1` definition and stores an immutable non-secret revision.
The adapter definition selects an approved ACPX registry launch; Paperclip's
common official-SDK client owns all ACP process/session/event behavior. A
request cannot supply a command, argv, endpoint, provider payload, response
parser, native-session selector, or provider credential.

Provider authentication stays in the selected CLI's native login state on the
execution target. Paperclip neither stores nor probes it. There is no default
adapter inference or fallback to another registered name.

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

Termination preserves the immutable issue/Session/run/comment audit. It
cancels live work and follows canonical creator recovery for open owned issues.

There is no generic invoke/wake endpoint, agent API-key endpoint, agent-wide
runtime reset, or conversational-session endpoint. Work begins only through a
canonical issue-execution source.

## Models and structural readiness

```http
GET /api/companies/{companyId}/adapters/{adapterType}/models
```

The response is the exact model catalog declared by that registered data-only
ACP adapter. Structural readiness requires the approved registry entry and
frontend revision, execution-target/workspace binding, legal stable ACP
configuration selections, selected-tool/skill integrity, and the agent's live
eligibility/budget state. It never starts a model conversation or tests login
by sending a prompt.
