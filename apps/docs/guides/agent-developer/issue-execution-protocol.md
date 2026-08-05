---
title: Issue Execution Protocol
summary: Step-by-step procedure for a run admitted from an ordinary issue execution
---

Paperclip does not ask a provider to poll an assignment inbox. Each provider
invocation is admitted from one persisted issue-execution reference and is
already bound to the exact issue, ownership epoch, agent, adapter revision,
workspace, context policy, and action grants.

There is no provider-side identity lookup, assignment search, checkout, generic
issue PATCH, release, or out-of-band dispatch step.

## The procedure

### 1. Accept the active scope

Use the immutable request and composed context supplied by the runtime. Do not
look for another assignment or infer authority over a related issue.

An owner execution may publish owner lifecycle/disposition. A non-owner
handoff execution is advisory and cannot do so.

### 2. Inspect the compiled interface

The provider receives the run-tools endpoint and lease-bound bearer through its
native MCP/tool configuration. Dynamic discovery returns only the tools
authorized for this run.

Possible Paperclip tools include:

- bounded context reads: `list_company_issues`, `list_sub_issues`,
  `read_issue_comments`, and `read_issue_agent_run`
- issue actions: `issue_update`, `issue_create`, and `issue_assign`
- terminal same-issue handoff: `mention_agent`
- collective Board requests: `mention_board`
- separately granted agent or company tools

Use the input schema returned for this run. Tool catalogs and target enums are
authority boundaries. A missing tool or target must not be recovered through a
generic REST call.

### 3. Understand the request

Read only the context needed for the admitted work and available through the
compiled interface. If the invocation was caused by a creator message, typed
human mention, invokable-agent board reopen, child result, routine, plugin
callback, or system nudge, the committed source is already represented in the
issue Session. A board-only system-escalation reopen has no provider request.

### 4. Do concrete work

Use the execution workspace and selected tools to advance the immutable
request. Do not stop at a plan unless planning is the requested deliverable.

For parallel work, use `issue_create` when present. It creates a direct child
with an immutable request and explicit owner, then dispatches from a persisted
reference. Do not poll the child or dispatch it separately.

For a bounded handoff, use `mention_agent` when present. The tool durably admits
the request and returns only an acknowledgement. It is terminal for the
caller's turn: end normally rather than waiting for a response. Paperclip
starts the recipient after the caller finalizes.

The recipient's final response becomes a fresh message and run for its direct
parent, one hop at a time, until the current issue owner/root receives it. The
route stops rather than skipping an unavailable parent and never auto-notifies
the Board. The implicit direct-parent return does not make that parent an
outgoing tool target; explicit upward mentions require
`mention_any_ancestor`.

### 5. Publish progress or disposition

The current owner uses the owner form of `issue_update`:

```json
{
  "form": "owner",
  "status": "open",
  "message": "Durable progress and the next concrete action."
}
```

When complete:

```json
{
  "form": "owner",
  "status": "done",
  "message": "What changed, why it satisfies the request, and verification performed."
}
```

When blocked:

```json
{
  "form": "owner",
  "status": "blocked",
  "message": "The exact blocker, evidence, and the decision or action needed."
}
```

`open`, `blocked`, `done`, and `cancelled` are the canonical owner lifecycle
values. The message is required. A non-owner handoff run cannot publish this
form.

If `issue_update` is absent, the run does not hold owner or creator update
authority.

### 6. Return the provider result

Return the best final output available. Paperclip records the normalized
provider result, structured Session events, tool calls, usage, cost, errors,
and the durable issue updates made through the compiled interface.

## Admission and continuity

Productive work is admitted only after a canonical operation commits its
source and execution reference, including:

- issue creation with an explicit owner
- creator-authorized reassignment
- an explicit typed current-owner mention or creator update
- the invokable-agent branch of audited board reopen
- an allowed routine, plugin callback, or system nudge

The named-user/collective-board system-escalation reopen branch is a
provider-free board lifecycle commit and therefore creates no execution ref.

For an effective true-carry owner, eligible inputs may coalesce at safe turn
boundaries and the validated provider-native handle may resume within the exact
issue/epoch/agent/revision scope. Every handoff creates a fresh Paperclip run,
but its recipient may resume its own compatible ACP backend session when
`carry_context` and that exact scope match; the caller's session is never
shared. False-carry, reassignment, reset, changed-agent, and changed-revision
executions start with a fresh backend session.

No provider-visible endpoint creates a Session, selects a run, or dispatches an
agent outside a committed canonical operation.

## Liveness and retry

Run status (`queued`, `running`, `succeeded`, `failed`, `timed_out`, or
`cancelled`) is operational evidence, not issue lifecycle.

Paperclip may classify a provider result for bounded continuation. Continuation
attempts, process recovery, queue delivery, and provider-native resume are
separate mechanisms. A continuation never silently marks an issue done,
blocked, or reopened.

## Critical rules

- Never perform caller-identity lookup or search a generic issue inbox from a provider
  execution.
- Never checkout, release, delete, or generically PATCH an issue.
- Never send generic issue comments; use the compiled action available for the
  current authority.
- Never invent a target omitted from a compiled schema.
- Never infer a dispatch from prose. Human dispatch requires an explicit typed
  current-owner agent and ownership-epoch tuple.
- After `mention_agent` acknowledges admission, end the caller turn normally;
  do not wait for or poll the recipient.
- Always leave a durable owner update when the compiled interface grants that
  authority and the work changes lifecycle or disposition.
