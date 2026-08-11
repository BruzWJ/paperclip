---
title: Agent Configuration UI
summary: Canonical agent identity, explicit grants, provider configuration, and run history
---

## Principles

- Org position is display/delegation structure, not authority.
- No role, first-agent, root-agent, title, or manager default grants permissions.
- Paperclip has no generic prompt template, provider home, generic API key, or
  agent-wide session. Its optional board-owned Instruction is delivered once
  as the first queued run for a new issue.
- Context grants, five configurable action grants, mention reach, and genuine
  company skills are selected explicitly.
  Issue updates are relationship-derived: the owner receives its active-issue
  update and an exact creator execution receives eligible-child updates. Both
  use one canonical comment with an automatic counterpart mention. A creator may
  send a message or set `open`/`blocked` on an eligible child; only its current
  owner may apply terminal `done`/`cancelled` updates.
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
| Instruction | no | Canonical board-owned role text; queued before a new issue's work run |

### Provider adapter

Select an adapter and configure only its supported operator-owned native fields. Authentication/configuration declarations are target-scoped and opaque. Apart from the optional board-owned Instruction, the form has no Paperclip prompt, agent home, adapter-configured run-directory fallback, session-key strategy, or general Paperclip credential.

### Runtime policy

- lifecycle eligibility and budget
- execution timeout/grace controls
- nine context-dial cells
- five configurable action grants, including one combined create-and-assign
  grant
- two mention-reach grants
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

Board users can edit identity metadata, the canonical instruction,
provider-native declaration, runtime limits, and explicit grants/selections.
Present the nine context cells as a 3×3
matrix and the action/mention/skill grants as independent controls. Do not
render separate assign or lifecycle controls: create-and-assign is one grant,
while the canonical lifecycle/creator update follows the issue owner/creator
relationship and automatically mentions its counterpart.

Explain prospective behavior: narrowing a dial changes gateway acceptance immediately, but content already inside one live provider-native conversation remains provider-owned. Later work must have an exact eligible correlation under the new grant or fail closed; Paperclip exposes no reset path that silently creates a replacement session.

Changing Instruction affects only a later new issue; it is not
prepended to work messages or replayed into an existing session.

### Runs

List structured productive and consult issue-execution runs. Show status, issue, epoch, adapter revision, model, timing, token/cost data, and structured transcript. Never display a provider-native session handle.

### Skills and tools

Skills list only the genuine company skills explicitly selected for this agent,
including version/provenance. Skill selection grants no Paperclip issue
authority.

## Issue-scoped controls

Fresh-session, reassignment, and reopen live on the issue/execution surface:

| Action | Contract |
| --- | --- |
| Fresh session | Board/user only; one issue execution; cancels its live run, drops Paperclip's correlation, audits actor/scope/reason |
| Reassign | Creator/board authority; advances ownership epoch and starts the new owner fresh |
| Reopen | Board-user audited command; preserves owner/epoch/session/run-directory binding, clears terminal disposition, and returns either one invokable-agent execution ref or a provider-free system-escalation board-only result |

These are distinct operations. Editing agent configuration does not perform any of them.

## API surface

Board/operator APIs provide agent CRUD, lifecycle control, immutable config revisions, explicit grant/selection administration, and run inspection/cancellation. Provider executions cannot call those general routes; `agent_configure` is available only through a compiled run interface with a live grant and dynamic target authority.
