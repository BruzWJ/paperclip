# Issue Execution Semantics

Status: current

This document defines how ordinary issue ownership becomes provider execution. It complements [SPEC.md](./SPEC.md) and the runtime contract in [spec/agent-runs.md](./spec/agent-runs.md).

## Ownership

Every ordinary issue has one explicit owner and a monotonically increasing ownership epoch. The owner may be an eligible agent or a permitted named user/board identity. The immutable creator is stored independently from the current owner.

Creation commits request, creator, owner, epoch, issue session, creator edge, workspace policy/binding, and any initial execution reference atomically. Reassignment is available only to the immutable creator (or board), selects from the same eligible catalog as creation, advances the epoch, revokes/cancels the former engagement, and starts the new owner fresh.

There is no provider checkout/release or generic owner/status patch. Run/execution lock columns are control-plane concurrency evidence only; they do not grant ownership.

## Lifecycle

The canonical lifecycle is:

- `open`
- `blocked`
- `done`
- `cancelled`

Only the current owner may submit owner-form lifecycle/disposition updates through a compiled `issue_update`. Terminal updates require a disposition, are ordered after any earlier same-run updates, and reject later updates.

The immutable creator may send message-only creator updates. Those cannot alter request, title, owner, lifecycle, dependencies, or metadata.

Board reopen is a separate audited command. Under the issue lock it changes a terminal issue to `open`, clears disposition, preserves request/owner/epoch/session/workspace, re-applies the native-continuity fence, and materializes or re-evaluates the current epoch's creator edge. A preserved invokable agent commits and dispatches exactly one new ref. A named-user or collective-board-owned system escalation commits the provider-free `board_only` branch with no ref or run. Every other owner is rejected. Reopen never revives an old terminal edge or acts as a fresh-session reset.

## Request and title

`request` is immutable and byte-preserved. It is the owner's first Paperclip-authored provider message on creation, reassignment, and an invokable-agent reopen. A board-only system-escalation reopen sends no provider message. Clarification uses the chronological thread; no actor rewrites the request.

`title` is optional board-editable display metadata with no routing, authority, or provider-input meaning.

## Admission and dispatch

An invocation-capable operation must atomically persist:

1. its typed source and exact message
2. the canonical Paperclip Session input/event
3. an `IssueExecutionRef`
4. any creator/counterpart delivery evidence

Only after commit may the internal dispatcher lease the ref. Immediately before launch it validates:

- company active state
- issue lifecycle and current ownership epoch
- target owner/consult identity and immutable authority
- adapter configuration revision
- workspace binding
- live context/action/mention/tool grants
- session input/view disposition
- ref and lease generation

Failure is terminal or held according to the typed source policy; the dispatcher never fabricates a replacement prompt or wake.

## Input ordering and continuity

The issue-session input inbox preserves causal admission order. Eligible
true-carry steers coalesce only at copied safe turn boundaries. False-carry
refs, new epochs, reset generations, adapter revisions, or any
agent/lane/workspace/context mismatch use independent fresh views. A consult
may resume only that recipient's own exact compatible true-carry correlation;
it never joins or inherits the caller's native carrier.

A fresh execution lowers:

`[authorized composition?] + [exact committed source messages] + [execution-owned output]`

The optional composition is nothing, the chronological thread, or full structured history according to the current-issue dial cells. It immediately precedes the source without rewriting canonical chronology.

## Comments and mentions

Every accepted human/board comment is a typed user input and durable chronological comment.

- no typed mention: non-dispatching, valid even on a terminal issue, never reopens
- typed mention: may target only the exact current agent owner and ownership epoch on a nonterminal issue

Paperclip never parses prose for names, mentions, assignments, approvals, or lifecycle. Document annotations and other freeform activity are evidence only; they do not create provider work.

Agent-to-agent same-issue assistance uses compiled `mention_agent`. An explicitly
granted owner may use `mention_board` to request information or direction from
the collective Board; this records a comment but creates no execution ref,
approval, review, or lifecycle transition. Delegation uses a direct child
issue. Owner reports and creator follow-ups use the two forms of `issue_update`;
no generic comment tool exists for providers.

## Workspace

Every provider attempt resolves the persisted `(company, issue, ownership epoch)` execution-workspace binding. Projectless issues are first-class and receive a bound workspace. A missing/stale/cross-company binding blocks before provider launch.

Local providers receive the resolved absolute path as process `cwd`. Remote providers receive a closed server-to-provider launch envelope containing only the repository/ref/environment selectors their native API requires. Neither path injects caller identity, issue metadata, workspace metadata, or a general Paperclip credential into provider context.

## Configuration readiness

Pre-dispatch readiness is distinct from runtime failure. Missing provider-native declarations, secret bindings, target availability, workspace binding, selected tool/skill integrity, or adapter capability block before a run starts. The issue retains explicit auditable waiting/recovery evidence.

An adapter configuration edit creates a new immutable revision. An active run finishes on its recorded revision; the edit itself does not cancel, reset, or invoke anything. A later invocation on the new revision cannot resume the old revision's native correlation.

## Dependencies and blocked work

First-class issue dependencies govern readiness independently of creator routing and system escalation. An unresolved blocker prevents productive dispatch. When the final blocker resolves, any continuation must enter through a canonical typed system/creator source and persisted ref; no raw dependency wake exists.

`blocked` requires a durable reason/disposition and owner/creator path. A comment or unmanaged local process does not make work live.

## Scheduled and external work

Scheduled work is represented by a routine execution issue with immutable request and explicit owner. External asynchronous work must have a durable monitor, dependency, issue, or named human action. A PID, detached shell, provider-native session, log file, or promise to check later is evidence only.

When a monitor becomes due, its typed system source may admit one current-owner execution ref according to the monitor's bounds. It cannot call a generic invoke path or silently recur.

## Recovery

Process-loss, transient-provider, and quota recovery re-lease only the original valid ref and persisted execution view. They never create a new source, prompt, session, idempotency key, or generic wake row.

Existing-issue automation records a typed system notice and may invoke only the current eligible owner through a canonical ref. If the immutable creator edge is still receivable, recovery uses it. Only structural or exhausted unreceivability creates/nudges one root-level system escalation per affected issue/epoch.

Escalation owner selection follows the locked creator/ancestor-user/board ladder. Manager relationships, CEO/root position, display title, ordered invokable agents, and budget reranking grant nothing. Escalation issues are not blockers or parents of the affected issue and never recursively escalate.

## Pause, termination, and fresh session

Pausing an agent prevents new leases and cancels/signals its active work according to control-plane policy; it does not rewrite history or transfer ownership.

Termination preserves a tombstone identity and immutable creator/owner/run/comment/session audit. It cancels live work, terminalizes creator edges, blocks open owned issues with a typed system record, and follows canonical creator recovery.

A board/user fresh-session command scopes to one issue execution. It cancels that execution's live run, increments its reset generation, drops Paperclip's native correlation only, and writes an audit record. Provider-owned storage is untouched.

## Output and finalization

Adapters stream normalized Paperclip Session events. The projector alone mutates materialized messages and chronological comments. Run summaries, telemetry, and UI transcripts are derived projections.

The outcome translator:

- persists the final assistant turn
- normalizes authorized zero-tool leaf completion
- routes owner updates to the immutable creator
- settles consult/counterpart invocations
- ensures exactly one comment of record where required
