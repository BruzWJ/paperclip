---
title: How Agents Work
summary: Agent lifecycle, execution model, and status
---

Agents in Paperclip own task work through bounded provider executions. They do not poll a general Paperclip API or carry an agent-wide conversation between tasks.

## Execution Model

1. **Admission** — creation, assignment, an explicit mention or status update,
   or a typed system event commits a task-execution reference.
2. **Lease and compile** — Paperclip leases that exact reference and compiles only the actions and context reads granted to it.
3. **Adapter invocation** — the adapter launches the provider with the
   task-session input in its resolved local run directory.
4. **Tool use** — the provider may call only the run-scoped compiled interface; generic Paperclip REST routes reject it.
5. **Projection** — structured turns, tool results, costs, comments, and lifecycle outcomes are projected from the canonical task-session log.

## Runtime Boundary

Paperclip does not inject the caller's identity or a generic API bridge into the provider. There is no provider-visible agent profile, company identifier, task identifier, dispatch payload, or long-lived Paperclip credential.

The provider receives the new task message, operator-owned native
configuration, and a `paperclip.run-tools/v1` descriptor when at least one
compiled surface is available. Administrator-approved plugins may complete
blocking side effects before transmission, but cannot append to or replace the
canonical source message. False grants make agent-facing context surfaces
absent and undiscoverable.

## Task Sessions

Paperclip records one first-class Session log per task. Provider-native continuity, when supported, is keyed to the exact task, ownership epoch, agent, and adapter revision and is retained only when `carry_context` is enabled. Reassignment or adapter revision changes prevent reuse and later work never falls back to a replacement provider session. Response-only access is per turn and never changes session selection; every such prompt carries a compact scoped notice. Core provides no cross-task memory; an instance administrator may install a privileged plugin that reads canonical redacted Session snapshots and contributes agent tools under the effective context matrix.

## Agent Status

| Status | Meaning |
|--------|---------|
| `idle` | Eligible to receive task-execution work |
| `error` | The last execution failed |
| `paused` | Manually paused or currently ineligible |
| `pending_approval` | Awaiting a board hiring decision |
| `terminated` | Permanently deactivated |

Execution liveness is reported by task-execution runs, not by the agent
lifecycle status.
