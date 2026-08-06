# Agent Runtime Guide

Status: User-facing guide
Last updated: 2026-08-01
Audience: Operators setting up and running agents in Paperclip

## 1. What this system does

Agents in Paperclip do not run continuously. They execute accepted work through
durable, issue-scoped runs in Paperclip's existing server + worker topology.

For each productive prompt, the worker:

1. selects one current persisted issue-execution ref or steering segment;
2. resolves its ownership epoch, immutable adapter revision, execution
   workspace, context dial, and action grants;
3. starts one disposable ACPX public-runtime session for the discovered local
   compatible CLI;
4. lets ACPX create or resume the eligible provider backend session;
5. supplies a complete request-scoped Paperclip MCP capability binding;
6. sends exactly one prompt and consumes structured ACP updates plus its stop
   result; and
7. revokes the request capability, closes ACPX, and deletes its temporary
   runtime state before another prompt can start.

The issue Session log is the canonical durable conversation and audit record.
The run row is only the control envelope around that work; it is not a second
transcript store.

## 2. How work is admitted

Provider work starts only after a canonical issue operation commits its source
and execution ref:

- issue creation with an explicit owner;
- creator-authorized reassignment;
- an explicit mention or creator/owner update;
- the `agent_execution` branch of audited board reopen for an invokable agent
  owner;
- an allowed routine or plugin-created issue;
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
issue session, queue, prompt authority, tools, and event projection.

### 3.2 Authentication and model configuration

Authenticate the selected AI CLI with that CLI's native login flow on the
execution target. Paperclip does not accept, store, copy, refresh, or probe AI
provider credentials.

Choose from the values ACPX advertises for that local agent. The generic form
can include a model, mode, reasoning effort, or other stable session option;
it shows none of those fields when ACPX does not advertise them. Paperclip saves
the choices as immutable ACPX session configuration selections with the adapter
revision. Before every prompt, ACPX validates and applies every saved value
through its generic configuration setter. There are no model flags, provider
payload fields, prompt overrides, environment-secret fallbacks, or
default-adapter inference.

Before saving, **Test Agent** resolves the same dynamic adapter contract and
applies every unsaved selection through ACPX's generic setter in a disposable,
no-prompt session. It creates no agent, revision, run, provider prompt, or
durable ACPX state. A successful result is an observation of local ACPX/session
configuration only, not a claim that a future execution workspace is ready.

### 3.3 Runtime policy

Configure eligibility and limits as control-plane policy:

- lifecycle status and budgets;
- all nine context-dial cells, including `carry_context`;
- the seven issue-action grants and explicit mention reach;
- explicitly selected company tools; and
- explicitly selected company skills through the `operator_native` channel.

All context grants default to false. Tool presence is the model-visible
context-access boundary; the server still reauthorizes every call.

### 3.4 Working directory and execution limits

- The issue-execution workspace binding supplies the validated ACPX session
  `cwd`. ACPX registry configuration is resolved at the Paperclip service
  scope, not from a per-issue workspace.
- The current ACPX public runtime owns local process mechanics only; Paperclip
  does not advertise SSH, sandbox, or plugin targets for ACPX agents.
- Runtime timeout and cancellation policy remain control-plane limits.
- Provider-native CLI configuration stays operator-owned and opaque.

Paperclip does not fall back to an agent home, an adapter-configured cwd, the
server process cwd, or a prior issue's workspace.

### 3.5 Provider instructions

Paperclip has no prompt template, bootstrap prompt, managed instruction bundle,
or caller-identity prompt. Configure any system/developer instructions directly
through operator-owned provider-native configuration. Empty instruction state
is valid.

## 4. Issue-session continuity

Paperclip records one canonical Session log per issue. `carry_context` controls
native continuity:

- **False:** every ordinary request uses `session/new`; its exact source text is
  the entire canonical input and Paperclip performs no built-in history
  composition.
- **True with an eligible stored target:** the worker asks ACPX to perform the
  frozen resume operation and still uses only the exact new canonical source.
- **True with no stored target:** the worker selects `session/new` before
  launch and uses only the exact current source text. The canonical Session
  log remains available for inspection but is not replayed, summarized, or
  injected by core.

An administrator-approved plugin may implement the generic blocking
before-prompt lifecycle. Paperclip gives that hook a bounded canonical Session
snapshot so it can complete required side effects, requires one exact `null`
acknowledgement, and sends the canonical source message to ACPX byte-for-byte.
A hook failure or concurrent plugin disable/upgrade fails before ACPX receives
the prompt.

If ACPX rejects a frozen resume because its frontend cannot resume that
provider session, the attempt fails through ACPX's normal runtime result.
Paperclip does not parse provider errors or silently replace a frozen resume
with a fresh session.

The selected CLI owns its native history and native compaction while its
provider backend session remains resumable. Paperclip has no Session-history
compactor and does not retain ACPX runtime records.
Operators cannot manually reset or rotate native continuity; epoch, target,
workspace, and authorization eligibility decide it automatically.

Provider-native session state stays opaque and provider-owned. Paperclip keeps
only an encrypted issue/epoch/agent/target-scoped ACP correlation and never
exposes its id through REST, UI, CLI, logs, tools, or environment variables.

## 5. Tools and steering

Every productive prompt gets a distinct request-scoped Paperclip MCP
connection. Its `tools/list` result is compiled from that run's effective
context dial, action grants, explicit company-tool selections, lifecycle
authority, and current target catalogs. Paperclip supplies that MCP server set
when it creates the bounded ACPX runtime for the prompt; it never accumulates
a prior request's authority.

The AI CLI keeps its own built-in shell, file, browser, and other native tools.
Paperclip owns and audits only the dynamically supplied Paperclip/company-tool
catalog. A tool-free productive prompt still receives an isolated Paperclip MCP
server whose list is empty.

An authorized reply to an active run-progress comment steers that exact run.
Paperclip revokes the old capability, requests cancellation through ACPX,
settles the current prompt, then invokes the frozen ACPX operation for the new
exact message. ACPX decides whether that operation can resume the opaque
provider backend session; a rejected operation fails closed rather than
silently changing context semantics. The UI uses the comment's producing run;
users never select or see a provider session id.

## 6. Logs, status, and run history

For each issue-execution run, Paperclip exposes a joined read over:

- the typed `issue_execution_runs` control envelope;
- canonical issue Session messages and events stamped with that run/ref/segment;
- typed attempt, lease, cancellation, accounting, cost, tool-decision,
  workspace-operation, and audit records; and
- the run's one stable progress comment projection.

Structured ACP text, redacted display-approved thought/reasoning, tool calls,
tool results, and terminal state live in the Session record. Stable ACP plan
updates are live-only replacement state and may disappear on reconnect or
restart. ACP stdout is protocol framing; bounded redacted stderr is diagnostic
only. Neither stream becomes an assistant transcript or durable run-log store.

A prompt owns accounting only when its terminal response has both a stop result
and the immediately preceding valid ACP context occupancy (`used` / `size`).
Cost remains optional. Missing or malformed accounting does not become zero.

## 7. Issue output and lifecycle

The chronological issue comment stream is the durable human-facing output.
Each active run has one stable progress-comment root, which may become its final
output comment or settle as a folded progress card. Replies are grouped under
that root in canonical sequence.

No tool-free final closes an issue or invokes another agent. The current owner
must call `issue_update` with `done` or `cancelled` and a final message to close
an issue. A nonterminal issue that becomes idle remains idle until a canonical
input explicitly admits more work.

## 8. Common operating patterns

### 8.1 Issue-driven execution

1. Create an issue with an immutable request and explicit eligible owner.
2. Grant only the actions and context depth needed for that work.
3. Let the owner report progress or disposition through `issue_update`.
4. Inspect the durable issue thread and bounded structured run history.

### 8.2 Scheduled work

Use a routine whose occurrence creates an ordinary execution issue with an
explicit owner and immutable request. The routine does not invoke an agent
directly.

### 8.3 Safety-first loop

1. Start with narrow context and action grants.
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
3. Run the selected CLI's native login on that execution target.
4. Verify every saved stable ACPX configuration value is still advertised by the
   selected CLI; Paperclip does not infer model limits ACPX does not provide.
5. Verify the issue-execution workspace and execution target are ready.
6. Inspect the typed setup, protocol, process, and terminal-settlement error.
7. Pause the agent if repeated failures would consume budget or mutate work.

Typical failures include an unavailable executable, unauthenticated native CLI,
an ACPX session setup/resume/control failure, invalid session configuration,
stale workspace binding, protocol framing failure, or a stop result without the
required terminal occupancy.

Paperclip never retains or reconstructs ACPX runtime state. Each run uses a
bounded, single-prompt ACPX runtime; a setup, resume, or turn error fails that
attempt and any later retry re-evaluates the current immutable request.

## 10. Minimal setup checklist

1. Install an ACPX-compatible CLI on the execution target.
2. Authenticate the AI CLI through its native login flow.
3. Refresh the local agent catalog. Add and verify an ACPX `agents` entry only
   when the CLI needs a custom name or launch override.
4. Select the exact discovered adapter and complete its required stable ACPX
   configuration.
5. Configure an execution-workspace policy.
6. Set explicit context dials, issue-action grants, and selected company
   tools/skills.
7. Create an issue with an immutable request and eligible owner.
8. Confirm the Session projection, progress comment, terminal state, and any
   valid accounting were recorded.
