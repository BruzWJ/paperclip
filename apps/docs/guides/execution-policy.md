# Execution policies

Execution policies are board control-plane rules for review and approval. They
are enforced by the server and audited independently of provider prompts.

They do not create provider interaction cards, inject lifecycle instructions, or
invoke an agent merely because a gate was resolved. Provider work still enters
through the ordinary task-execution path with a required current owner.

## Policy shape

A task may define an ordered list of review and approval stages:

```ts
interface TaskExecutionPolicy {
  mode: "normal" | "auto";
  commentRequired: boolean;
  stages: TaskExecutionStage[];
}

interface TaskExecutionStage {
  id: string;
  type: "review" | "approval";
  approvalsNeeded: 1;
  participants: TaskExecutionStageParticipant[];
}

interface TaskExecutionStageParticipant {
  id: string;
  type: "agent" | "user";
  agentId?: string | null;
  userId?: string | null;
}
```

Participants are explicitly selected agents or board users. Agent titles,
reporting position, and creation order confer no review or approval authority.

The board may keep richer presentation stages while an agent sees only the
canonical task lifecycle: `open`, `blocked`, `done`, or `cancelled`. Review
routing never expands an agent's authority.

## Decisions and state

The server keeps the current stage, selected participant, completed stages,
return owner, and most recent outcome as task execution state. Every accepted
decision is also appended to `task_execution_decisions` with:

- the company, task, stage, and stage type;
- the deciding agent or user;
- `approved` or `changes_requested`;
- the required explanatory message;
- the originating run, when applicable; and
- its creation timestamp.

The decision log is the audit source. Historical thread-interaction records are
read-only archives and do not participate in execution-policy behavior.

## Workflow

When the current owner submits a terminal completion and stages remain, the
server applies the existing execution-policy transition instead of treating the
task as finally complete. It selects an eligible participant for the next
stage and records the pending state.

An approval advances to the next stage. Approval of the final stage completes
the policy and permits the task's terminal completion.

A change request records the decision and returns the task to its recorded
work owner. Resubmission returns to the same pending stage rather than
restarting the whole policy. All owner changes use the canonical owner
transition and ownership-epoch rules; no assignee compatibility field is
written.

Stages with several participants still represent one required decision. The
server chooses an eligible participant using the policy's existing deterministic
selection rules and prevents self-review where that rule applies.

## Control-plane boundary

Execution policy is separate from other retained board gates, including change
consent and formal approvals. Resolving a gate permits only its recorded
control-plane effect. Resolution does not create a provider card, append
provider-directed prose, fabricate a comment, resume a native session, or queue
an arbitrary wake.

If a later transition requires provider work, it must enter through an ordinary,
valid task source and persisted `TaskExecutionRef`. It is subject to current
ownership, lifecycle, adapter revision, context controls, and compiled
run-interface checks.

## Comments and successful runs

The chronological task thread is the durable human-facing output. A successful
`task_update` writes its exact message once in the counterpart Session; it does
not add a source-side duplicate. When a run commits no update, its trailing
final response can become the single comment of record.

There is no missing-comment retry wake. Transactional run finalization and the
task-session projector guarantee the comment-of-record invariant or record the
run failure explicitly.

## Board usage

Board task creation and editing may configure review and approval stages by
selecting named agents or users. Task creation must still provide:

- immutable `request`;
- required current agent owner;
- immutable creator attribution; and
- any optional execution policy.

Agent providers do not use generic task REST mutation routes. An authorized
owner or exact creator uses the compiled `task_update` action. Board mutations
use the board control plane and the same canonical owner and policy invariants.

Removing a policy clears only its policy-owned pending state according to the
existing one-shot transition rules. It does not rewrite the immutable request,
restore a retired owner epoch, revive a cancelled run, or schedule a replacement
invocation.

## Invariants

- Policy is enforced by server state, never prompt text.
- Every stage decision is authorized, one-shot, and append-only audited.
- A policy decision cannot grant authority, ownership, or generic API access.
- Provider interaction cards and continuation policies are absent.
- Gate resolution alone causes no provider message or wake.
- Current owner terminology is canonical; no assignee aliases survive.
- The task Session remains per task, and policy transitions never create
  cross-task memory.
