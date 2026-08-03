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
3. launches one conformance-approved ACP agent subprocess;
4. connects with stable ACP wire version 1 through the official TypeScript SDK;
5. creates or resumes the eligible native ACP session with a complete
   request-scoped Paperclip MCP capability binding;
6. sends exactly one prompt and consumes structured ACP updates plus its stop
   result; and
7. revokes the request capability and reaps the subprocess before another
   prompt can start.

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
- a human owner mention, typed system nudge, or the one finalization-bound
  same-agent liveness follow-up.

There is no generic manual invoke, provider-visible wake API, or model-producing
readiness probe. A retry may redeliver the same ref only when Paperclip can prove
that no prompt bytes were sent.

The other accepted reopen branch is `board_only`: it applies only to a
named-user or collective-board-owned system escalation and creates no ref,
run, adapter check, or provider dispatch. Every other preserved owner is
rejected without mutation.

## 3. What to configure per agent

### 3.1 ACP adapter choice

Every AI adapter is a data-only `acp-subprocess/v1` definition. A definition
selects an exact conformance-approved ACP launch, declares supported execution
targets, and maps operator choices to stable ACP session configuration. It does
not execute a provider request or parse provider output.

Paperclip uses ACPX only for its public agent-name-to-launch registry. Paperclip
checks the requested name against its own immutable approved catalog before
registry resolution, then its common official-SDK client launches the resolved
ACP endpoint. ACPX owns no Paperclip process, session, queue, prompt, tool, or
event state.

The initial built-in adapter is exact `codex`, backed by the pinned upstream
Codex ACP frontend. Other ACPX names are not selectable until their exact
frontend revision passes the same real-frontend conformance suite and enters the
approved catalog. Paperclip never infers an adapter, accepts a per-CLI alias, or
falls through to an arbitrary command.

### 3.2 Authentication and model configuration

Authenticate the selected AI CLI with that CLI's native login flow on the
execution target. Paperclip does not accept, store, copy, refresh, or probe AI
provider credentials.

Choose a model/profile and other supported values through the adapter's closed
configuration form. After every `session/new` or `session/resume`, the common
ACP client applies each required value through stable
`session/set_config_option`. There are no model flags, provider payload fields,
prompt overrides, environment-secret fallbacks, or default-adapter inference.

### 3.3 Runtime policy

Configure eligibility and limits as control-plane policy:

- lifecycle status and budgets;
- all nine context-dial cells, including `carry_context`;
- the six issue-action grants and explicit mention reach;
- explicitly selected company tools; and
- explicitly selected company skills through their one supported channel.

All context grants default to false. Tool presence is the model-visible
attention boundary; the server still reauthorizes every call.

### 3.4 Working directory and execution limits

- The issue-execution workspace binding supplies the validated ACP `cwd` and
  any explicitly authorized additional directories.
- The configured execution target owns local, SSH, sandbox, or plugin process
  mechanics.
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
  the entire prompt and Paperclip performs no history composition.
- **True with an eligible target:** the worker uses stable `session/resume` and
  still sends only the exact new source text.
- **True with no resumable target:** the worker uses `session/new` and sends
  only the exact current source text. The canonical Session log remains
  available for inspection but is not replayed, summarized, or injected.

The selected CLI owns its native history and native compaction while that ACP
session remains resumable. Paperclip has no Session-history compactor.
Operators cannot manually reset or rotate native continuity; epoch, target,
workspace, and authorization eligibility decide it automatically.

Provider-native session state stays opaque and provider-owned. Paperclip keeps
only an encrypted issue/epoch/agent/target-scoped ACP correlation and never
exposes its id through REST, UI, CLI, logs, tools, or environment variables.

## 5. Tools and steering

Every productive prompt gets a distinct request-scoped Paperclip MCP
connection. Its `tools/list` result is compiled from that run's effective
context dial, action grants, explicit company-tool selections, lifecycle
authority, and current target catalogs. A later resume receives a complete
replacement connection; it never accumulates a prior request's authority.

The AI CLI keeps its own built-in shell, file, browser, and other native tools.
Paperclip owns and audits only the dynamically supplied Paperclip/company-tool
catalog. A tool-free productive prompt still receives an isolated Paperclip MCP
server whose list is empty.

An authorized reply to an active run-progress comment steers that exact run.
Paperclip revokes the old capability, sends ACP `session/cancel`, settles and
reaps the current prompt, then starts a fresh subprocess and resumes the same
native session with the new exact message. If that target is no longer
resumable, the selected run invalidates the dead correlation and starts a fresh
ACP session for the same prompt identity with only the new exact message. It
does not create another Paperclip run. The UI uses the comment's
producing run; users never select or see a raw ACP session id.

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
an issue. A nonterminal issue that becomes idle is handled only by the bounded
post-finalization same-agent reply/liveness rule.

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

1. Confirm the exact adapter is registered and conformance-approved.
2. Confirm its pinned ACP frontend and target Node executable are available.
3. Run the selected CLI's native login on that execution target.
4. Verify every required stable ACP configuration value and model limit.
5. Verify the issue-execution workspace and execution target are ready.
6. Inspect the typed setup, protocol, process, and terminal-settlement error.
7. Pause the agent if repeated failures would consume budget or mutate work.

Typical failures include an unavailable executable, unauthenticated native CLI,
unsupported stable resume or MCP replacement, invalid session configuration,
stale workspace binding, protocol framing failure, or a stop result without the
required terminal occupancy.

Paperclip never converts an arbitrary resume error into a fresh session. Only a
missing local target or ACP `Resource not found` enters the documented
fresh-session branch; other errors fail the current attempt.

## 10. Minimal setup checklist

1. Install the conformance-approved CLI/frontend on the execution target.
2. Authenticate the AI CLI through its native login flow.
3. Select an exact registered adapter and complete its required stable ACP
   configuration.
4. Configure an execution-workspace policy.
5. Set explicit context dials, issue-action grants, and selected company
   tools/skills.
6. Create an issue with an immutable request and eligible owner.
7. Confirm the Session projection, progress comment, terminal state, and any
   valid accounting were recorded.
