---
title: Agent Configuration UI
summary: Canonical agent identity, explicit grants, provider configuration, and run history
---

## Principles

- Org position is display/delegation structure, not authority.
- No role, first-agent, root-agent, title, or manager default grants permissions.
- Paperclip does not manage prompt templates, instruction files/bundles, provider homes, generic API keys, or agent-wide sessions.
- Context, issue actions, mention reach, company tools, and genuine company skills are selected explicitly and default false/empty.
- Active runs stay on their recorded immutable adapter revision. A later edit affects only later issue executions and never cancels, resets, or invokes a provider by itself.

## Agent creation

The creation dialog contains:

### Identity

| Field | Required | Notes |
| --- | --- | --- |
| Name | yes | Company-unique display name |
| Title | no | Display-only; grants no authority |
| Reports to | no | Same-company org edge; roots are ordinary |
| Capabilities | no | Verbatim description used only in eligible target catalogs |

### Provider adapter

Select an adapter and configure only its supported operator-owned native fields. Authentication/configuration declarations are target-scoped and opaque. The form has no Paperclip prompt, bootstrap instructions, agent home, adapter-configured workspace fallback, session-key strategy, or general Paperclip credential.

### Runtime policy

- lifecycle eligibility and budget
- execution timeout/grace controls
- execution-workspace policy
- nine context-dial cells
- six issue-action grants
- two mention-reach grants
- selected company tools
- selected genuine company skills

The creation request writes explicit values. Missing grants resolve false and missing selections resolve empty; the UI never stamps privileged defaults for the first agent.

## Agent detail

### Header

Show name, optional title, lifecycle status, current run indicator, pause/resume, and terminate. There is no generic invoke, API-key creation, agent-wide session reset, or provider-session identifier.

### Overview

Show:

- adapter type and current immutable configuration revision
- readiness/ineligibility reason
- current-month spend and budget
- reporting parent and direct reports
- active issue executions and recent run outcomes

### Configuration

Board users can edit identity metadata, provider-native declaration, runtime limits, workspace policy, and explicit grants/selections. Present the nine context cells as a 3×3 matrix and the action/mention/tool/skill grants as independent controls.

Explain prospective behavior: narrowing a dial changes gateway acceptance immediately, but content already inside one live provider-native conversation remains there; the board/user issue-execution fresh-session action is required to discard it.

### Runs

List structured issue-execution and compaction runs. Show status, issue, epoch, adapter revision, model, timing, token/cost data, and structured transcript. Never display a provider-native session handle.

### Skills and tools

Skills list only the genuine company skills explicitly selected for this agent, including version/provenance. Tools list only explicit company-tool selections and their current readiness. Neither selection grants Paperclip issue authority.

## Issue-scoped controls

Fresh-session, reassignment, and reopen live on the issue/execution surface:

| Action | Contract |
| --- | --- |
| Fresh session | Board/user only; one issue execution; cancels its live run, drops Paperclip's correlation, audits actor/scope/reason |
| Reassign | Creator/board authority; advances ownership epoch and starts the new owner fresh |
| Reopen | Board-user audited command; preserves owner/epoch/session/workspace, clears terminal disposition, and returns either one invokable-agent execution ref or a provider-free system-escalation board-only result |

These are distinct operations. Editing agent configuration does not perform any of them.

## API surface

Board/operator APIs provide agent CRUD, lifecycle control, immutable config revisions, explicit grant/selection administration, and run inspection/cancellation. Provider executions cannot call those general routes; `agent_configure` is available only through a compiled run interface with a live grant and dynamic target authority.
