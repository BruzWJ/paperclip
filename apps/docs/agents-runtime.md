# Agent Runtime Guide

Status: User-facing guide
Last updated: 2026-08-10
Audience: Operators setting up and running agents in Paperclip

## 1. What this system does

Agents in Paperclip do not run continuously. They execute accepted work through
durable, task-scoped runs in Paperclip's existing server + worker topology.

For each productive prompt, the worker:

1. selects one current persisted task-execution ref or steering segment;
2. resolves its ownership epoch, immutable adapter revision, execution
   server-resolved run directory, context dial, configurable action grants, and relationship
   authority;
3. starts one disposable ACPX public runtime for the discovered local
   compatible CLI;
4. lets ACPX create or resume the eligible provider backend session;
5. supplies the exact request-scoped Paperclip runtime-tool capability;
6. sends that run's one canonical prompt and consumes structured ACP updates
   plus its stop result; and
7. revokes the request capability, closes ACPX, and deletes its temporary
   runtime state before another prompt can start.

The task Session log is the canonical durable conversation and audit record.
The run row is only the control envelope around that work; it is not a second
transcript store.

## 2. How work is admitted

Provider work starts only after a canonical task operation commits its source
and execution ref:

- task creation with an explicit owner;
- creator-authorized reassignment;
- an explicit mention or creator/owner update;
- the `agent_execution` branch of audited board reopen for an invokable agent
  owner;
- an allowed routine or plugin-created task;
- a human owner mention or typed system nudge.

There is no generic manual invoke, provider-visible wake API, or model-producing
readiness probe. A retry may redeliver the same ref only when Paperclip can prove
that no prompt bytes were sent.

The other accepted reopen branch is `board_only`: it applies only to a
named-user or collective-board-owned system escalation and creates no ref,
run, adapter check, or provider dispatch. Every other preserved owner is
rejected without mutation.

## 3. What to configure per agent

### 3.1 ACP adapter choice

Every AI adapter is an ephemeral data-only `acpx-runtime/v1` definition
derived from ACPX. It retains the exact ACPX registry name, declares the
ACPX-admitted local execution context, and maps ACPX-advertised choices to
stable ACPX session configuration. It does not execute a provider request or
parse provider output.

ACPX is the sole supplier of Paperclip's agent catalog. Paperclip enumerates the
ACPX registry and its resolved launch overrides, excludes candidates that would
need to materialize an absent local CLI, temporarily probes each remaining
candidate, and surfaces only candidates that initialize an ACPX session
successfully. A built-in name alone is not local availability. ACPX supplies
the agent name, model choices, configuration choices, and defaults; Paperclip
owns no parallel list of agents, models, frontends, or provider flags.

Paperclip checks the unchanged registry name before ACPX resolution, so it
never accepts an alias or arbitrary command fallback. ACPX owns the provider
process and its ephemeral runtime/session state; Paperclip owns the durable
task session, queue, prompt authority, tools, and event projection.

### 3.2 Authentication and model configuration

Authenticate the selected AI CLI with that CLI's native login flow. Paperclip
does not accept, store, copy, refresh, or probe AI provider credentials.

Choose from the values ACPX advertises for that local agent. The generic form
can include a model, mode, reasoning effort, or other stable session option;
it shows none of those fields when ACPX does not advertise them. Paperclip saves
the choices as immutable ACPX session configuration selections with the adapter
revision. Before every prompt, ACPX validates and applies every saved value
through its generic configuration setter. There are no model flags, provider
payload fields, prompt overrides, provider-credential fallbacks, or
default-adapter inference.

Before saving, **Test Agent** resolves the same dynamic adapter contract and
applies every unsaved selection through ACPX's generic setter in a disposable,
no-prompt session. It creates no agent, revision, run, provider prompt, or
durable ACPX state. A successful result is an observation of local ACPX/session
configuration only, not a claim that a future execution can start.

### 3.3 Runtime policy

Configure eligibility and limits as control-plane policy:

- lifecycle status and budgets;
- all nine context-dial cells, with active owners receiving the six
  current-task and sub-task cells automatically;
- five configurable action grants and explicit mention reach; `task_create`
  combines direct-child creation and reassignment.

The compiled prompt-capability interface is the model-visible context-access
boundary; the server still reauthorizes every call. An active owner receives
the current-task and sub-task context cells automatically; company cells stay
at the agent's configured grants. Lifecycle reporting is not a grant: the
current owner receives `task_update` for its active task, and an exact
creator execution receives it
for eligible direct children. The canonical update automatically mentions the
owner/creator counterpart in that counterpart's task context. Creator child
updates may send a message or set `open`/`blocked`; only the current owner may
set terminal `done`/`cancelled` or `structuredResult`.

### 3.4 Working directory and execution limits

- The server supplies the validated ACPX session `cwd`. ACPX registry
  configuration is resolved at the Paperclip service scope.
- ACPX owns the local provider process mechanics and launches it in the exact
  project or task working directory selected by Paperclip.
- Runtime timeout and cancellation policy remain control-plane limits.
- Provider-native CLI configuration stays operator-owned and opaque.

Paperclip does not fall back to an agent home, an adapter-configured cwd, the
server process cwd, or a prior task's working directory.

### 3.5 Board-owned agent instruction

`agents.instruction` is optional canonical board-owned role text. For a new
task, Paperclip admits it as a bootstrap run immediately before the unchanged
work run. Both follow the ordinary task queue and have independent authority,
events, and settlement; the work run resumes the bootstrap run's exact provider
session. It grants no authority and is not a provider system prompt or
work-message prefix. A null instruction has no bootstrap run. If that frozen
resume cannot be set up, the work run fails terminal instead of starting a new
provider session.

Agent-reaching managed actions do have canonical source-message contracts.
Each producer supplies its tool name, immutable tool arguments, and locked
task/source context; admission then selects that tool's renderer exactly once:

| Managed tool | Canonical source shape | Exact body |
| --- | --- | --- |
| `mention_agent` | `[Paperclip agent message]` with task and sender identity | `message` |
| `task_create` | `[Paperclip task assignment]`, action `Created and assigned`, task, sender, owner, and status | `request` |
| `task_assign` | `[Paperclip task assignment]`, action `Reassigned`, task, sender, owner, and status | immutable task `request` |
| `task_update` | `[Paperclip task update]` with updated task, sender role/identity, and effective status | `message` |

That rendered text is simultaneously the canonical Session comment and
execution-ref message. The ACPX path consumes it as the same canonical source;
a separately governed before-prompt prelude may compose around that source but
does not rebuild or switch on tool prompts. `mention_board` invokes no agent
and therefore has no ACPX prompt contract.

## 4. Task-session continuity

Paperclip records one canonical Session log per task. Exactly one genuine
initial task start may use `session/new`: the instruction bootstrap when the
owner has a nonblank Instruction, or the task work itself when it does not.
An instructed task's immediately following work turn resumes the bootstrap's
exact provider session.

Every later base turn must resume one eligible exact-scope correlation with
effective `carry_context`; otherwise it fails closed before ACPX launch.
Steering likewise requires its exact active source. Paperclip never substitutes
`session/new`, replays the canonical Session log, or injects reconstructed
history when a correlation is absent or rejected.

ACPX session setup and resume failures are ordinary pre-transmission errors;
Paperclip does not inspect provider result or error codes to choose a recovery
path. A failed frozen `resume` is terminal and never falls back to a new
provider session. Only transport failure while setting up a fresh `new`
operation may enter the bounded retry path. Paperclip does not automatically
retrieve, summarize, or prefix history into a replacement work message.

An administrator-approved plugin may implement the generic blocking
before-prompt lifecycle. Paperclip gives that hook a bounded canonical Session
snapshot so it can complete required side effects, requires one exact `null`
acknowledgement, and sends the canonical source message to ACPX byte-for-byte.
A hook failure or concurrent plugin disable/upgrade fails before ACPX receives
the prompt.

The selected CLI owns its native history and native compaction while its
provider backend session remains resumable. Paperclip has no Session-history
compactor and does not retain ACPX runtime records.
Operators cannot manually reset or rotate native continuity; epoch, target, and
authorization eligibility decide it automatically.

Provider-native session state stays opaque and provider-owned. Paperclip keeps
only an encrypted task/epoch/agent/target-scoped ACP correlation and never
exposes its id through REST, UI, CLI, logs, tools, or environment variables.

## 5. Tools and steering

Every productive prompt gets a distinct request-scoped Paperclip runtime-tool
capability. Its exact turn projection is compiled from that run's effective
context dial, configurable action grants, owner/creator relationship authority,
current target catalogs, and ready plugin tools. It never
accumulates a prior request's authority.

An instruction bootstrap exposes only plugin tools declared `bootstrapEnabled`.
The work turn exposes its dynamically authorized managed tools and all ready
plugin tools. Discovery and invocation use the same turn projection.
Provider-native tools remain provider-owned.

The AI CLI keeps its own built-in shell, file, browser, and other native tools.
Paperclip owns and audits only the dynamically supplied prompt-capability
interface. A tool-free productive prompt still receives an isolated Paperclip
MCP server whose list is empty.

An authorized reply to an active run-progress comment steers that exact run.
Paperclip revokes the old capability, requests cancellation through ACPX,
settles the current prompt, then invokes the frozen ACPX operation for the new
exact message. ACPX decides whether that operation can resume the opaque
provider backend session; failed `steer_resume` setup is terminal and never
falls back to a new session. The UI uses the comment's producing run; users
never select or see a provider session id.

## 6. Logs, status, and run history

For each task-execution run, Paperclip exposes a joined read over:

- the typed `task_execution_runs` control envelope;
- canonical task Session messages and events stamped with that run/ref/segment;
- typed attempt, lease, cancellation, accounting, cost, tool-decision,
  execution and audit records; and
- the run's one stable progress comment projection.

Structured ACP text, redacted display-approved thought/reasoning, tool calls,
tool results, and terminal state live in the Session record. Stable ACP plan
updates are live-only replacement state and may disappear on reconnect or
restart. ACP stdout is protocol framing; bounded redacted stderr is diagnostic
only. Neither stream becomes an assistant transcript or durable run-log store.

A prompt owns accounting only when its terminal response has both a stop result
and the immediately preceding valid ACP context occupancy (`used` / `size`).
Cost remains optional. A cancelled ACPX result with valid occupancy settles as
`cancelled` and is accounted normally. Without occupancy it settles truthfully
as `cancelled` and `incomplete`; Paperclip does not fabricate usage, cost, or
accounting. `nativeCancellationSettledAt` records the observed ACPX cancelled
result, not delivery of Paperclip's local `AbortController` signal.

## 7. Task output and lifecycle

The chronological task comment stream is the durable human-facing output.
Each active run has one stable progress-comment root, which may become its final
output comment or settle as a folded progress card. Replies are grouped under
that root in canonical sequence.

No tool-free final closes a task or invokes another agent. The current owner
must call `task_update` with `done` or `cancelled` and a final message to close
its active task, omitting `taskId`. An exact creator execution can update an
eligible direct child only with a message or nonterminal `open`/`blocked`. A
nonterminal task that becomes idle remains idle until a canonical input
explicitly admits more work.

## 8. Common operating patterns

### 8.1 Task-driven execution

1. Create a task with an immutable request and explicit eligible owner.
2. Grant only the configurable actions and context depth needed for that work;
   lifecycle reporting follows the eventual owner/creator relationship.
3. Let the owner report progress or disposition through the canonical
   `task_update`; its canonical comment automatically mentions the creator.
4. Let the exact creator update an eligible direct child through the same
   canonical action when needed; it may send a message or set `open`/`blocked`,
   and its canonical comment automatically mentions the child owner.
5. Inspect the durable task thread and bounded structured run history.

### 8.2 Scheduled work

Use a routine whose occurrence creates an ordinary execution task with an
explicit owner and immutable request. The routine does not invoke an agent
directly.

### 8.3 Safety-first loop

1. Start with narrow context and configurable action grants.
2. Configure conservative runtime and budget limits.
3. Monitor the stable run-progress comment and cancel quickly when needed.
4. Change adapter/session configuration only through a new immutable revision;
   later work will re-evaluate native-session eligibility automatically.

## 9. Troubleshooting

If runs fail repeatedly:

1. Confirm the selected CLI executable is installed on the Paperclip service
   host and visible on its `PATH`.
2. Refresh the ACPX-backed catalog and confirm that local candidate passes its
   temporary session probe. For a custom ACPX launch override, also run
   `acpx config show --format json` at the Paperclip service scope and confirm
   the exact override is resolved.
3. Run the selected CLI's native login on the Paperclip service host.
4. Verify every saved stable ACPX configuration value is still advertised by the
   selected CLI; Paperclip does not infer model limits ACPX does not provide.
5. Verify the agent's persisted configuration and local runtime are ready.
6. Inspect the typed setup, protocol, process, and terminal-settlement error.
7. Pause the agent if repeated failures would consume budget or mutate work.

Typical failures include an unavailable executable, unauthenticated native CLI,
an ACPX session setup/resume/control failure, invalid session configuration,
protocol framing failure, or a stop result without the required terminal
occupancy.

Paperclip never retains or reconstructs ACPX runtime state. Each run uses a
bounded ACPX runtime and sends exactly one queued prompt. An instructed new
task has a bootstrap run followed by a work run on the same provider session.
Setup and resume failures remain ordinary pre-transmission errors. Only fresh
`new` setup may receive a bounded transport retry; frozen `resume` and
`steer_resume` failures are terminal and never switch to a new session.

## 10. Minimal setup checklist

1. Install an ACPX-compatible CLI on the Paperclip service host.
2. Authenticate the AI CLI through its native login flow.
3. Refresh the local agent catalog. Add and verify an ACPX `agents` entry only
   when the CLI needs a custom name or launch override.
4. Select the exact discovered adapter and complete its required stable ACPX
   configuration.
5. Set agent context dials and the five configurable action grants. Active
   owners receive current-task and sub-task context automatically; lifecycle
   reporting needs no separate grant.
6. Create a task with an immutable request and eligible owner.
7. Confirm the Session projection, progress comment, terminal state, and any
   valid accounting were recorded.
