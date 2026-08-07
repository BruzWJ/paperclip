# Agent Runtime Contract

Status: current

The user-facing runtime guide is [apps/docs/agents-runtime.md](../../apps/docs/agents-runtime.md). This file records the protocol boundary expected by the ACPX bridge and server implementations.

## Admission

A provider run may start only from a persisted, active `IssueExecutionRef` produced by a canonical issue operation. The dispatcher must lease and revalidate the exact company, issue, ownership epoch, target agent, adapter revision, authority, source, and session input immediately before launch.

There is no generic invoke, wake, timer ping, agent REST credential, or provider-side issue polling loop. Scheduled work is represented by a routine-created ordinary issue.

## Input

The Paperclip-authored user message is exactly the persisted canonical source
text. For an agent-reaching managed tool, that source is rendered once from a
closed contract containing the tool name, its immutable arguments, and locked
context. `issue_create`, `issue_assign`, `issue_update`, and `mention_agent`
each own their message shape; the request or message bytes remain unchanged as
the body after the envelope header. Other source kinds retain their own exact
request or follow-up text.

A fresh execution may prepend only the deterministic issue-session composition
authorized by the current-issue comment/run dial cells. With both false, no
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

The canonical record is the issue's Paperclip Session log. Effective
`carry_context` permits an encrypted opaque provider-native correlation only
for the same issue, ownership epoch, agent, and adapter configuration identity.
The owner/consult lane, execution target, and authorized context exposure must
also match exactly. Disabled carry, reassignment, reset, or any
scope/revision change runs fresh; one agent's correlation is never shared with
another agent.

Provider-native storage is opaque. Paperclip does not read, display, delete, derive, or migrate it, and never carries it across issues.

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

## Recovery

Process loss and retry re-lease the original persisted reference and resume its persisted execution view. They never create a replacement wake, prompt, session, or idempotency identity. Stale authority, epoch, revision, lease, input, or source causes terminal rejection.

ACPX receives a frozen resume operation when that eligible correlation exists.
If its frontend rejects the operation, the attempt fails closed; Paperclip does
not interpret provider-specific errors or replace it with a fresh session.
