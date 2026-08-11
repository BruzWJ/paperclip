# Low-Trust Review Contract

Date: 2026-06-03
Task: PAP-10217
Status: Proposed contract for CTO approval

## Objective

Lock the Phase 1 security contract for a `low_trust_review` execution preset before implementation starts.

This contract assumes the reviewer may process hostile PRs, diffs, comments, attachments, and generated output. Treat that content as untrusted prompt input and untrusted data.

## Decision Summary

1. `low_trust_review` must be deny-by-default and task-scoped.
2. Raw low-trust output must be quarantined from higher-trust agent heartbeat context.
3. Phase 1 can store the preset in `tasks.execution_policy` JSONB, but the shape must be app-typed and validator-locked, not free-form JSON.
4. Plugins, secrets, host execution controls, agent config, and cross-task reads are must-block surfaces for the first slice.

## Threat Model

### Protected assets

- Company secrets, secret refs, and provider-backed secret material
- Agent adapter/runtime config, instructions paths, session/runtime state
- Comments, documents, work products, and attachments outside the assigned review task
- Run directories, provider sessions, and host execution controls
- Plugin capabilities: outbound HTTP, local folders, DB namespaces, tool execution, secret resolution
- Higher-trust agent wake payloads, heartbeat context, and continuation summaries

### Attacker model

- A low-trust review agent receives hostile repository content or task content designed to trigger prompt injection.
- The attacker wants the review agent to exfiltrate secrets, pivot into host execution, tamper with other tasks, or poison a higher-trust agent's future wake context.

### Primary threat classes

- `OWASP LLM01 Prompt Injection`: hostile PR/comment output tries to steer the reviewer into tool abuse.
- `OWASP API BOLA / Broken Function-Level Authorization`: same-company agent reads or mutates resources outside its assigned review task.
- `OWASP A01 Broken Access Control`: reviewer reaches agent config, attachments, or runtime controls it does not need.
- `OWASP A10 SSRF / outbound abuse`: plugin or runtime surfaces create network reach.
- `STRIDE Information Disclosure`: secrets/config/artifacts leak through task reads, `GET /agents/me`, plugin configuration, or attachments.
- `STRIDE Elevation of Privilege`: reviewer uses plugin capabilities, execution controls, or wake/recovery APIs to act as a more trusted worker.
- `OWASP LLM02 Insecure Output Handling`: low-trust raw output is copied into higher-trust comments, wake payloads, or summaries.

## Current Surface Review

The current product default is company-wide visibility for agents. That is correct for normal trusted workers, but it is too broad for a hostile-content review preset.

Relevant current behavior:

- `apps/server/src/routes/tasks.ts`
  - Same-company agents can read `GET /tasks/:id`, `/heartbeat-context`, `/comments`, `/documents`, `/work-products`, `/attachments`, and `/attachments/:id/content` after `assertCompanyAccess`.
  - Mutations are mostly guarded by `assertAgentTaskMutationAllowed`, which protects against mutating another agent's active task but does not narrow reads to a review task.
- `apps/server/src/routes/agents.ts`
  - `GET /agents/me` returns full agent detail, including raw `adapterConfig` and `runtimeConfig`, while other config routes are access-gated or redacted.
- `apps/server/src/routes/plugins.ts` and `packages/plugins/sdk/src/host-client-factory.ts`
  - Plugin tools, plugin state, outbound HTTP, DB namespace access, and local folders exist as grantable capabilities.
- `apps/server/src/services/task-continuation-summary.ts`
  - Continuation summaries already prefer sanitized summaries over transcript copies.
- `apps/server/src/services/recovery/*` and `apps/server/src/__tests__/heartbeat-process-recovery.test.ts`
  - Recovery/transfer code already encodes a no-transcript-copy direction and redacts secret-bearing progress summaries.

## Contract: `low_trust_review`

### Core rules

1. The preset is task-scoped, not company-scoped.
2. The reviewer may only operate on its assigned review task and current run directory.
3. The reviewer gets no ambient authority from org position, current company visibility defaults, plugin manifests, or existing agent grants.
4. Safe defaults win: any unspecified API surface is denied.

### Allowed / denied matrix

| API area | Allowed in `low_trust_review` | Denied in `low_trust_review` | Why |
|---|---|---|---|
| Assigned task core | Read assigned task title, description, status, parent identifier/title, goal/project labels, own checkout state | Read arbitrary other tasks, subtree reads, blocker traversal beyond minimal identifiers, company task search/list outside assignee inbox entry | Least Privilege, Complete Mediation |
| Task comments | Read and create comments on the assigned review task only | Comment on other tasks; use `reopen`, `resume`, or `interrupt`; create comments that auto-flow into higher-trust wake context | Prevent tampering and prompt-injection pivot |
| Task documents | Read/write documents on the assigned review task only | Read/write documents on any other task; lock/unlock/delete system docs; alter plans on higher-trust tasks | Keep outputs local to quarantine boundary |
| Work products | Create/update/list work products on the assigned review task only | Cross-task work products; provider actions outside the review task | Same trust boundary as documents |
| Attachments | Upload/list attachments on the assigned review task only | Read attachment bytes from unrelated tasks; browse company attachment inventory | Information disclosure risk |
| Task status | Move assigned review task between `todo`, `in_progress`, `in_review`, `done`, `blocked` within preset rules | Change assignee, blockers, execution policy, approvals, recovery actions, or other tasks' status | Prevent authority expansion |
| Agent identity | Read redacted self identity only: id, name, role, companyId | Raw `adapterConfig`, `runtimeConfig`, session info, instructions paths, env bindings, config revisions | `GET /agents/me` is a current must-block leak |
| Other agents / org | Optional read-only labels needed for mention rendering | Agent configuration routes, session routes, skill sync, agent wake/invoke, pause/resume | Avoid lateral movement |
| Plugins | None in Phase 1 | Plugin tools, plugin bridge routes, plugin state, DB namespace, local folders, outbound HTTP, webhooks, jobs | Plugin capability model is too broad for low trust |
| Secrets / env | None | Secret routes, provider health, direct secret-ref materialization, env/lease introspection | Secrets are outside review scope |
| Host execution | None | Alter provider launch, inspect host execution state, or change run-directory handling | Prevent runtime pivot and SSRF |
| Recovery controls | None except passive viewing of the review task's own status notices | Resolve recovery actions, interrupt active runs, schedule monitors, wake other agents | Too much control-plane authority |
| Interactions / approvals / child tasks | None in Phase 1 | Create approvals, interactions, child tasks, blocker graphs | Reviewer should report findings, not orchestrate the company |

## Raw-output quarantine rule

### Decision

Raw output from a `low_trust_review` run is quarantined and must not be injected into a higher-trust agent's heartbeat context automatically.

### Quarantined content

- Raw transcript text
- Tool-call arguments/results
- Stdout/stderr excerpts
- Generated comments or markdown copied verbatim from hostile input
- Attachment bodies and rendered previews
- Machine-generated summaries derived directly from hostile content unless explicitly marked sanitized

### Allowed cross-trust payload

Only a sanitized derivative may cross from low trust to higher trust:

- structured verdict: `pass`, `fail`, `needs_human_review`
- finding metadata: vulnerability class, file path, line hint, severity, confidence
- bounded redacted summary text
- counts, status, timestamps, artifact ids

### Enforcement rule

When a higher-trust agent is woken on a related task, its wake payload and `heartbeat-context` may include:

- the existence of a low-trust review result
- sanitized structured findings
- a pointer to a quarantined artifact

They may not include:

- the low-trust raw comment body
- raw transcript excerpts
- raw attachment bytes or previews
- raw tool output copied into continuation summaries or system notices

### Rationale

This blocks the most likely confused-deputy chain:

1. hostile PR injects the low-trust reviewer
2. reviewer emits poisoned freeform output
3. Paperclip copies that output into a higher-trust assignee wake
4. higher-trust agent executes with broader capabilities

## Must-block surfaces

These surfaces must be explicitly denied or specially filtered for `low_trust_review`:

1. the retired generic agent-profile REST bridge
   Reason: current route returns raw `adapterConfig` and `runtimeConfig`.

2. Same-company task read fanout
   Surfaces: `GET /api/tasks/:id`, `/comments`, `/documents`, `/work-products`, `/attachments`, `/attachments/:id/content`
   Reason: current reads are company-scoped, not review-task-scoped.

3. Plugin execution and bridge surfaces
   Surfaces: `/api/plugins/tools`, `/api/plugins/tools/execute`, plugin bridge/state/DB/local-folder capabilities
   Reason: HTTP, DB, filesystem, and tool pivot risk.

4. Secret resolution
   Surfaces: secret routes and provider-bound secret references
   Reason: plaintext secret disclosure is catastrophic and unrelated to review scope.

5. Host execution management
   Surfaces: provider launch and run-directory control
   Reason: lets hostile content turn a reviewer into an infrastructure operator.

6. Recovery and wake control
   Surfaces: recovery resolution, active-run interruption, wake/monitor creation, status-changing comment flags
   Reason: control-plane tampering and DoS.

## Storage recommendation: JSON policy, validator-locked

### Recommendation

Phase 1 should store the preset in `tasks.execution_policy` JSONB.

### Why JSON policy is enough for the first slice

- The repo already has a normalized execution-policy contract in shared types/validators and route logic.
- The low-trust preset is execution behavior on a specific task, not yet a global analytics/reporting dimension.
- Using the existing policy object avoids a migration for a contract that will likely change once more than one restricted preset exists.

### Required constraint

Do not store an open-ended policy blob. Extend the app-typed policy schema with a locked shape such as:

```ts
reviewPreset: {
  id: "low_trust_review";
  version: 1;
  rawOutputDisposition: "quarantine";
}
```

and keep the actual allow/deny matrix in server code, not user-editable JSON.

### Not recommended for Phase 1

- New typed SQL columns for every deny/allow bit
- Operator-editable per-task capability lists
- Reusing company-wide action grants as the trust-containment source

### When typed columns become justified

Add typed columns only if one of these becomes a real requirement:

- SQL-level filtering/reporting by trust preset
- more than one preset with materially different enforcement
- board UI needs indexed preset queries across large task sets

## Implementation constraints for downstream coding tasks

1. Enforce the preset server-side on every route. Do not rely on prompt text, agent instructions, or UI hiding.
2. Treat low-trust output as untrusted data at rest and in transit. No automatic copy into higher-trust comments, wake payloads, or summaries.
3. Low-trust review must not inherit existing agent role powers such as CEO runtime-service control.
4. Low-trust self-inspection must return a restricted agent view, not the raw `GET /agents/me` payload.
5. If a route cannot prove the target resource belongs to the assigned review task, deny it.
6. Plugin capability grants do not pierce the preset. `low_trust_review` beats plugin capability allowlists.
7. Any future exception must be explicit, small, and separately reviewed by security plus CTO.

## Residual risk

- Hostile review output can still mislead a human board operator if the sanitized summary is poor.
- Repository content in the run directory remains hostile; this contract narrows Paperclip API authority, not the semantic risk of reading bad code.
- A future plugin or runtime integration could silently widen the surface unless the preset enforcement layer sits above per-feature route checks.

## Follow-up tasks implied by this contract

1. Add a centralized `low_trust_review` enforcement layer for route access and mutation filtering.
2. Add a restricted self-view path so `GET /agents/me` does not expose raw config under the preset.
3. Add content-trust tagging or equivalent filter so low-trust comments/documents never auto-populate higher-trust wake payloads.
4. Add regression tests for denied plugin, secret, runtime-service, cross-task read, and self-config access paths.
