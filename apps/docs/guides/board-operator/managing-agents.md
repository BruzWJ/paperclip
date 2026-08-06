---
title: Managing Agents
summary: Hiring, configuring, pausing, and terminating agents
---

An agent is a reusable configured identity. It has display identity, a direct
reporting edge, capabilities text, explicit context and action grants, provider
configuration, and control-plane accounting. It has no role-derived behavior,
instruction bundle, or built-in Paperclip memory shared between issues.
Instance administrators can separately install privileged infrastructure
plugins that observe the generic before-prompt lifecycle and contribute agent
tools; those plugins do not add prompt content, per-agent memory settings, or
authority.

## Agent States

| Status | Meaning |
|--------|---------|
| `active` | Ready to receive work |
| `idle` | Available with no active issue execution |
| `running` | Currently executing issue work |
| `error` | The most recent execution failed |
| `pending_approval` | Waiting for a board decision on creation |
| `paused` | Manually paused or budget-paused |
| `terminated` | Permanently deactivated (irreversible) |

## Creating Agents

Create agents from the Agents page. Each agent requires:

- **Name** — unique identifier (used for @-mentions)
- **Title** — optional display text with no authorization meaning
- **Reports to** — the agent's direct parent in the org chart
- **Local agent runtime** — an installed local CLI that passed the runtime probe
- **Adapter config** — only the model and session settings that ACPX advertises
- **Capabilities** — verbatim description shown when another agent selects an owner
- **Context and action grants** — independent, explicit per-agent permissions
- **Company tools and skills** — explicit selections only

The agent picker is dynamic. Install and authenticate a compatible local CLI.
When the runtime can initialize that local entry, Paperclip surfaces its exact
name and advertised settings automatically. An ACPX `agents` entry is needed
only for a custom launch override. Paperclip does not provide an explicit
command field, HTTP-provider adapter, external adapter package, or static
agent/model list.

## Agent Hiring via Governance

An agent with the explicit hire action can propose a direct subordinate. This
creates a `hire_agent` approval containing the proposed ordinary agent
configuration. Approval does not grant a role, implicit tools, or inherited
permissions.

## Configuring Agents

Edit an agent's configuration from the agent detail page:

- **Identity** — name, display title, icon, capabilities, and direct reporting edge
- **Adapter config** — change only the model and session choices currently
  advertised by ACPX (including reasoning effort when the selected agent
  advertises it)
- **Runtime settings** — cooldown and concurrent-run limits
- **Context and action grants** — explicit booleans; absent means denied
- **Selected tools and skills** — explicit company catalog entries
- **Budget** — monthly spend limit

Use **Test Agent** before saving to apply the exact unsaved model and other
advertised settings through a disposable, no-prompt ACPX session. The test
persists no agent, revision, run, or ACPX state. It verifies the local ACPX
runtime and selected session settings only; execution-workspace readiness is
still evaluated for the persisted run.

Configuration changes produce a new immutable adapter revision for later issue
executions. A run already in progress stays on the revision it started with.

## Pausing and Resuming

Pause an agent to prevent new issue executions:

```
POST /api/agents/{agentId}/pause
```

Resume to allow eligible issue work to dispatch again:

```
POST /api/agents/{agentId}/resume
```

Agents are also auto-paused when they hit 100% of their monthly budget.

## Terminating Agents

Termination is permanent and irreversible:

```
POST /api/agents/{agentId}/terminate
```

Only terminate agents you're certain you no longer need. Consider pausing first.
