# Agent Runtime Contract

Status: current

The user-facing runtime guide is [apps/docs/agents-runtime.md](../../apps/docs/agents-runtime.md). This file records the protocol boundary expected by the ACPX bridge and server implementations.

## Admission

A provider run may start only from a persisted, active `TaskExecutionRef` produced by a canonical task operation. The dispatcher must lease and revalidate the exact company, task, ownership epoch, target agent, adapter revision, authority, source, and session input immediately before launch.

There is no generic invoke, wake, timer ping, agent REST credential, or provider-side task polling loop. Scheduled work is represented by a routine-created ordinary task.

## Input

The Paperclip-authored user message is exactly the persisted canonical source
text. For an agent-reaching managed tool, that source is rendered once from a
closed contract containing the tool name, its immutable arguments, and locked
context. `task_create`, `task_assign`, `task_update`, and `mention_agent`
each own their message shape; the request or message bytes remain unchanged as
the body after the envelope header. Other source kinds retain their own exact
request or follow-up text.

A fresh execution may prepend only the deterministic task-session composition
authorized by the current-task comment/run dial cells. With both false, no
prefix exists. Paperclip supplies no ambient caller profile, company context,
goal ancestry, managed instructions, generic prompt template, run-directory
metadata, or generic REST bridge beyond fields deliberately rendered into that
canonical managed-tool source.

## Interface

Each lease receives a `paperclip.run-tools/v1` descriptor compiled from live
context/action/mention grants and dynamic owner/creator authority. Denied grants
make surfaces absent. The bearer is accepted only by the compiled endpoint and
expires with the lease.

## Session

The canonical record is the task's Paperclip Session log. Effective
`carry_context` permits an encrypted opaque provider-native correlation only
for the same task, ownership epoch, agent, and adapter configuration identity.
The owner/consult lane, execution target, and authorized context exposure must
also match exactly. Disabled carry, reassignment, or any scope/revision change
cannot silently create a replacement session; later work fails closed unless
it has the exact eligible resume source. One agent's correlation is never
shared with another agent.

Provider-native storage is opaque. Paperclip does not read, display, delete, derive, or migrate it, and never carries it across tasks.

## Run directory

The server resolves the local directory used by the bounded ACPX public-runtime
session. ACPX owns the underlying CLI process, and no declarative adapter
receives a process callback or alternate remote
transport. No agent-home, adapter-configured cwd, process cwd, prior
conversational session, or directory metadata is a fallback.

## Output

The ACPX public-runtime bridge normalizes its structured events into the
Paperclip Session event/message vocabulary. The projector derives structured
run history, chronological comments, telemetry, and lifecycle effects.
Provider-hidden state and credentials never enter the log.

A productive final always yields the canonical assistant turn. The outcome translator applies any authorized zero-tool completion or counterpart routing and writes at most one comment of record.

## Cancellation

Paperclip requests cancellation through the active ACPX turn. Delivery of the
local `AbortController` signal is only a request; it is not evidence that the
provider turn stopped. `nativeCancellationSettledAt` records the time Paperclip
observes ACPX return a cancelled turn.

A cancelled ACPX result with valid terminal usage settles as `cancelled` and is
accounted normally. A cancelled result without usage settles truthfully as
`cancelled` and `incomplete`; Paperclip does not invent occupancy, cost, or an
accounting record.

## Recovery

An eligible bounded retry re-leases the original persisted reference and its
persisted execution view. It never creates a replacement wake, prompt, session,
or idempotency identity. Stale authority, epoch, revision, lease, input, or
source causes terminal rejection.

ACPX session setup and resume failures are ordinary pre-transmission errors;
Paperclip does not parse provider result or error codes to select a recovery
path. A failed frozen `resume` or `steer_resume` operation is terminal and never
falls back to a new provider session. Only transport failure while setting up a
fresh `new` operation may enter the bounded retry path. Paperclip never
automatically replays, summarizes, or injects history into a replacement work
prompt.
