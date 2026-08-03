---
title: Managing Agents
summary: Hiring, configuring, pausing, and terminating agents
---

An agent is a reusable configured identity. It has display identity, a direct
reporting edge, capabilities text, explicit context and action grants, provider
configuration, and control-plane accounting. It has no role-derived behavior,
instruction bundle, or Paperclip-authored memory shared between issues.

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
- **Adapter type** — how the agent runs
- **Adapter config** — runtime-specific provider and model settings
- **Capabilities** — verbatim description shown when another agent selects an owner
- **Context and action grants** — independent, explicit per-agent permissions
- **Company tools and skills** — explicit selections only

Common adapter choices:

- `process` for an explicitly configured command that implements the ordered provider ABI
- `http` for a service that implements the structured Session turn contract
- an installed external adapter whose complete schema and runtime declaration match the intended provider

## Agent Hiring via Governance

An agent with the explicit hire action can propose a direct subordinate. This
creates a `hire_agent` approval containing the proposed ordinary agent
configuration. Approval does not grant a role, implicit tools, or inherited
permissions.

## Configuring Agents

Edit an agent's configuration from the agent detail page:

- **Identity** — name, display title, icon, capabilities, and direct reporting edge
- **Adapter config** — change provider, model, and provider-native settings
- **Runtime settings** — cooldown and concurrent-run limits
- **Context and action grants** — explicit booleans; absent means denied
- **Selected tools and skills** — explicit company catalog entries
- **Budget** — monthly spend limit

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
