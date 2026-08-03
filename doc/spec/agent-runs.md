# Issue-Execution Runs

Status: current

Run rows are control-plane audit, accounting, cancellation, and recovery records around the canonical issue-session engine. They are not the conversation store and do not authorize work by themselves.

## Run kinds

- `productive` — an owner or isolated consult provider turn
- `compaction` — Paperclip Session maintenance

Both kinds use the ordinary run ledger, cost events, bounded recovery, and cancellation machinery. Compaction remains separately identifiable and writes no human comment.

## Causal chain

Every productive attempt has one exact chain:

1. A canonical issue operation commits a typed source and session input.
2. The same transaction persists an `IssueExecutionRef`.
3. The internal dispatcher leases that ref.
4. The attempt resolver revalidates issue, epoch, owner/consult, adapter revision, workspace binding, grants, session view, and lease.
5. The runtime compiler creates the run-scoped interface.
6. The adapter executes one provider turn or Session-runner continuation.
7. Session events project structured messages, costs, comments, and outcome.
8. Finalization compare-and-clears only control-plane locks still owned by that run.

A run id, old queue row, API request, provider process, or native session handle cannot substitute for the persisted ref.

## Input and session linkage

The run links to:

- company, issue, ownership epoch, and target agent
- immutable adapter configuration identity
- source/session input and execution-history view
- execution workspace binding
- issue-execution ref and current lease generation
- optional validated native correlation for effective-true-carry owner work

The provider sees none of those correlation fields. It receives only the lowered issue-session messages, provider-owned native configuration, and the compiled run-tools descriptor.

## Continuity

Provider-native continuity is retained only for the exact true-carry owner scope. Its envelope version is `issue-execution-native/v1`; its payload is validated and lowered only by the registered adapter codec. A first run, false-carry run, consult, ownership-epoch change, board/user fresh-session command, or adapter revision change cannot resume an earlier provider conversation.

No agent-wide or issue-key session state exists.

## Structured output

Adapters publish normalized Paperclip Session events for:

- step boundaries
- text and reasoning boundaries/deltas
- tool pending/running/completed/error transitions
- assistant completion/error
- cost, token, model, and timing fields

The durable event stream is append-only and secret-redacted before storage. The materialized message/comment projections are projector-owned and rebuildable. Provider-native handles and hidden reasoning are never persisted as visible run output.

## Compaction

Paperclip's production compaction behavior decides overflow using the active
model limits and company-level five-knob configuration. A compaction run
persists the canonical request/summary assistant pair, summary chaining, tail
boundary, costs, and failure state. Successful checkpoints govern later
lowering; failed overflow checkpoints hide no history and cannot loop
indefinitely.

## Cancellation and retry

Cancellation invalidates the matching lease/view/input disposition and signals the adapter. Late callbacks must revalidate their generation and cannot append events, comments, checkpoints, or outcomes after authority is lost.

Transient/process-loss recovery may re-lease only the original valid ref. It preserves the same admitted source and execution view. An invalid or stale ref terminalizes with audit evidence and does not create replacement work.

## API surface

Board/operator routes may inspect run rows/events/logs, cancel a live run, and request a scoped fresh issue-execution session. Providers cannot list or mutate runs through general REST. Their only Paperclip surface is the compiled run interface for the active lease.
