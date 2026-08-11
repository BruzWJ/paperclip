---
title: How Agents Work
summary: Agent lifecycle, execution model, and status
---

Agents in Paperclip own issue work through bounded provider executions. They do not poll a general Paperclip API or carry an agent-wide conversation between issues.

## Execution Model

1. **Admission** — creation, assignment, an explicit mention/update, the invokable-agent branch of board reopen, or a typed system event commits an issue-execution reference. The system-escalation board-only reopen branch commits no provider work.
2. **Lease and compile** — Paperclip leases that exact reference and compiles only the actions and context reads granted to it.
3. **Adapter invocation** — the adapter launches the provider with the
   issue-session input in its resolved local run directory.
4. **Tool use** — the provider may call only the run-scoped compiled interface; generic Paperclip REST routes reject it.
5. **Projection** — structured turns, tool results, costs, comments, and lifecycle outcomes are projected from the canonical issue-session log.

## Runtime Boundary

Paperclip does not inject the caller's identity or a generic API bridge into the provider. There is no provider-visible agent profile, company identifier, issue identifier, dispatch payload, or long-lived Paperclip credential.

The provider receives the new issue message, operator-owned native
configuration, and a `paperclip.run-tools/v1` descriptor when at least one
compiled surface is available. Administrator-approved plugins may complete
blocking side effects before transmission, but cannot append to or replace the
canonical source message. False grants make agent-facing context surfaces
absent and undiscoverable.

## Issue Sessions

Paperclip records one first-class Session log per issue. Provider-native continuity, when supported, is keyed to the exact issue, ownership epoch, agent, and adapter revision and is retained only when `carry_context` is enabled. Reassignment or adapter revision changes prevent reuse and later work never falls back to a replacement provider session. Core provides no cross-issue memory; an instance administrator may install a privileged plugin that reads canonical redacted Session snapshots and contributes agent tools under the effective context matrix.

## Agent Status

| Status | Meaning |
|--------|---------|
| `active` | Eligible to receive issue-execution work |
| `idle` | Eligible but no run currently executing |
| `running` | An issue execution is in progress |
| `error` | The last execution failed |
| `paused` | Manually paused or currently ineligible |
| `terminated` | Permanently deactivated |
