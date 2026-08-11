# Issue-Execution Runs

Status: current

Run rows are control-plane audit, accounting, cancellation, and recovery records around the canonical issue-session engine. They are not the conversation store and do not authorize work by themselves.

## Run kinds

- `productive` — an owner provider turn
- `consult` — an isolated consult provider turn

Productive and consult runs use the ordinary run ledger, cost events, bounded
retry, and cancellation machinery.

## Causal chain

Every productive attempt has one exact chain:

1. A canonical issue operation commits a typed source and session input.
2. The same transaction persists an `IssueExecutionRef`.
3. The internal dispatcher leases that ref.
4. The attempt resolver revalidates issue, epoch, owner/consult, adapter
   revision, grants, session view, and lease.
5. The runtime compiler creates the run-scoped interface.
6. ACPX's public runtime executes one bounded provider turn.
7. Session events project structured messages, costs, comments, and outcome.
8. Finalization compare-and-clears only control-plane locks still owned by that run.

A run id, old queue row, API request, provider process, or native session handle cannot substitute for the persisted ref.

## Input and session linkage

The run links to:

- company, issue, ownership epoch, and target agent
- immutable adapter configuration identity
- source/session input and execution-history view
- issue-execution ref and current lease generation
- optional validated native correlation for effective-true-carry owner or
  consult work in the exact same scope

The provider sees none of those correlation fields. It receives only the exact
admitted source text, ACPX-applied generic session configuration, and the
request-scoped compiled run-tools descriptor.

## Continuity

Provider-native continuity is retained only for an exact true-carry owner or
consult scope. Its encrypted opaque correlation is handed only to ACPX's
public runtime. A false-carry later run, ownership-epoch change,
agent/lane/context mismatch, or adapter revision change cannot resume an
earlier provider conversation and does not fall back to a new one.

No agent-wide or issue-key session state exists.

## Structured output

The ACPX public-runtime bridge publishes normalized Paperclip Session events
for:

- step boundaries
- text and reasoning boundaries/deltas
- tool pending/running/completed/error transitions
- assistant completion/error
- cost, token, model, and timing fields

The durable event stream is append-only and secret-redacted before storage. The materialized message/comment projections are projector-owned and rebuildable. Provider-native handles and hidden reasoning are never persisted as visible run output.

## Cancellation and retry

Cancellation invalidates the matching lease/view/input disposition and requests
cancellation through ACPX's public runtime. The resulting turn outcome settles
through the canonical attempt path; late events or callbacks must revalidate
their generation and cannot append events, comments, checkpoints, or outcomes
after authority is lost.

The local `AbortController` delivers Paperclip's request; it does not prove that
ACPX or the provider stopped. `nativeCancellationSettledAt` is written only
when Paperclip observes an ACPX turn result with status `cancelled`. If that
result includes valid usage, the prompt settles as `cancelled` with its ordinary
accounting. Without usage, it settles as `cancelled` and `incomplete`, with no
fabricated occupancy, cost, or accounting row.

ACPX session setup and resume failures are ordinary pre-transmission errors;
Paperclip does not parse a provider-specific result or error code to choose a
second path. Only a transport failure during setup of a fresh `new` operation
may re-lease the original valid ref for bounded retry. A failed frozen `resume`
or `steer_resume` operation terminalizes without falling back to `new` or
creating replacement work. An invalid or stale ref likewise terminalizes with
audit evidence.

## API surface

Board/operator routes may inspect run rows/events/logs, cancel a live run, and request a scoped fresh issue-execution session. Providers cannot list or mutate runs through general REST. Their only Paperclip surface is the compiled run interface for the active lease.
