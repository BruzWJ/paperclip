# CLI Reference

Paperclip CLI now supports both:

- instance setup/diagnostics (`onboard`, `doctor`, `configure`, `env`, `allowed-hostname`)
- control-plane client operations (tasks, approvals, agents, activity, dashboard)

## Base Usage

Use repo script in development:

```sh
pnpm paperclipai --help
```

First-time local bootstrap + run:

```sh
pnpm paperclipai run
```

Choose local instance:

```sh
pnpm paperclipai run --instance dev
```

## Reachability and authentication

Current CLI behavior:

- `paperclipai onboard` and `paperclipai configure --section server` configure
  bind and exposure
- every bind and exposure uses the same Better Auth signup/sign-in lifecycle
- `paperclipai run --bind <loopback|lan|tailnet>` passes a quickstart bind preset into first-run onboarding when config is missing

Canonical behavior is documented in `doc/DEPLOYMENT.md`.

Allow a private hostname (for example custom Tailscale DNS):

```sh
pnpm paperclipai allowed-hostname dotta-macbook-pro
```

All client commands support:

- `--data-dir <path>`
- `--api-base <url>`
- `--api-key <token>`
- `--context <path>`
- `--profile <name>`
- `--json`

Company-scoped commands also support `--company-id <id>`.

API base resolution order:

1. `--api-base <url>`
2. `PAPERCLIP_BOARD_API_URL`
3. selected context profile `apiBase`
4. local Paperclip config server port
5. `http://localhost:3100`

Connection failures include the attempted URL and a `GET /api/health` check hint.

## Connect Wizard

```sh
pnpm paperclipai connect
```

`connect` confirms the resolved API base, verifies `GET /api/health`, authenticates a concrete board user, creates a named board API key, and saves a board profile.

Profiles store token env-var names, not plaintext tokens. The wizard prints shell exports for the newly created token.

Use `--data-dir` on any CLI command to isolate all default local state (config/context/db/logs/storage/secrets) away from `~/.paperclip`:

```sh
pnpm paperclipai run --data-dir ./tmp/paperclip-dev
pnpm paperclipai task list --data-dir ./tmp/paperclip-dev
```

## Context Profiles

Store local defaults in `~/.paperclip/context.json`:

```sh
pnpm paperclipai context set --api-base http://localhost:3100 --company-id <company-id>
pnpm paperclipai context set --api-key-env-var-name PAPERCLIP_BOARD_API_KEY
pnpm paperclipai context show
pnpm paperclipai context list
pnpm paperclipai context use default
```

To avoid storing secrets in context, set `apiKeyEnvVarName` and keep the key in env:

```sh
pnpm paperclipai context set --api-key-env-var-name PAPERCLIP_BOARD_API_KEY
export PAPERCLIP_BOARD_API_KEY=...
```

## Company Commands

```sh
pnpm paperclipai company list
pnpm paperclipai company get <company-id>
pnpm paperclipai company current [--company-id <company-id>]
pnpm paperclipai company stats
pnpm paperclipai company create --payload-json '{...}'
pnpm paperclipai company update <company-id> --payload-json '{...}'
pnpm paperclipai company branding:update <company-id> --payload-json '{...}'
pnpm paperclipai company archive <company-id>
pnpm paperclipai company export <company-id> --out ./company --include company,agents,projects,tasks,skills
pnpm paperclipai company export:preview <company-id> --payload-json '{...}'
pnpm paperclipai company export:api <company-id> --payload-json '{...}'
pnpm paperclipai company import ./company --target new --new-company-name "Imported Company"
pnpm paperclipai company import:preview <company-id> --payload-json '{...}'
pnpm paperclipai company import:apply <company-id> --payload-json '{...}'
pnpm paperclipai company delete <company-id-or-prefix> --yes --confirm <same-id-or-prefix>
```

Examples:

```sh
pnpm paperclipai company delete PAP --yes --confirm PAP
pnpm paperclipai company delete 5cbe79ee-acb3-4597-896e-7662742593cd --yes --confirm 5cbe79ee-acb3-4597-896e-7662742593cd
```

Notes:

- `company list` and `company current` use the authenticated board user's memberships and optional profile company.
- `company create` requires board/instance-admin authentication because it is
  an instance-wide setup command.
- Deletion is server-gated by `PAPERCLIP_ENABLE_COMPANY_DELETION`.

## Task Commands

```sh
pnpm paperclipai task list --company-id <company-id> [--status open,blocked] [--owner-agent-id <agent-id>] [--match text]
pnpm paperclipai task get <task-id-or-identifier>
pnpm paperclipai task create --company-id <company-id> --request "..." --owner-agent-id <agent-id> [--title "..."] [--priority high]
pnpm paperclipai task title <task-id> --title "..."
pnpm paperclipai task reassign <task-id> --owner-agent-id <agent-id>
pnpm paperclipai task reopen <task-id> --reason "..."
pnpm paperclipai task comment <task-id> --message "..."
pnpm paperclipai task comments <task-id> [--limit 50]
pnpm paperclipai task comment:get <task-id> <comment-id>
pnpm paperclipai task runs <task-id-or-identifier>
```

Task creation requires an immutable request and an explicit agent owner. Title is
board-editable display metadata; reassignment and reopen are audited commands.
Reopen returns `agent_execution` with one ref for an invokable preserved agent,
or `board_only` with no ref/run for a named-user or collective-board-owned
system escalation; invalid preserved owners fail without mutation.
Provider-side task context and lifecycle actions are available only through the
run-scoped compiled interface, not these generic CLI routes.

```sh
pnpm paperclipai task child:create <task-id> --payload-json '{"request":"Child request","ownerAgentId":"<agent-id>","idempotencyKey":"<key>"}'
pnpm paperclipai task approvals <task-id>
pnpm paperclipai task approval:link <task-id> <approval-id>
pnpm paperclipai task approval:unlink <task-id> <approval-id>
pnpm paperclipai task read <task-id>
pnpm paperclipai task unread <task-id>
pnpm paperclipai task archive <task-id>
pnpm paperclipai task unarchive <task-id>
```

```sh
pnpm paperclipai task documents <task-id> [--include-system]
pnpm paperclipai task document:get <task-id> <key>
pnpm paperclipai task document:put <task-id> <key> --body-file ./plan.md [--title Plan]
pnpm paperclipai task document:lock <task-id> <key>
pnpm paperclipai task document:unlock <task-id> <key>
pnpm paperclipai task document:revisions <task-id> <key>
pnpm paperclipai task document:restore <task-id> <key> <revision-id>
pnpm paperclipai task document:delete <task-id> <key>
```

```sh
pnpm paperclipai task work-products <task-id>
pnpm paperclipai task work-product:create <task-id> --payload-json '{"type":"pull_request","provider":"github","title":"PR"}'
pnpm paperclipai task work-product:update <work-product-id> --payload-json '{"status":"archived"}'
pnpm paperclipai task work-product:delete <work-product-id>
```

```sh
pnpm paperclipai task tree-state <task-id>
pnpm paperclipai task tree-preview <task-id> --payload-json '{"mode":"pause"}'
pnpm paperclipai task tree-holds <task-id> [--status active] [--include-members]
pnpm paperclipai task tree-hold:create <task-id> --payload-json '{"mode":"pause","reason":"review"}'
pnpm paperclipai task tree-hold:get <task-id> <hold-id>
pnpm paperclipai task tree-hold:release <task-id> <hold-id> [--payload-json '{"reason":"done"}']
pnpm paperclipai task attachments <task-id>
pnpm paperclipai task attachment:upload <task-id> --company-id <company-id> --file ./artifact.txt
pnpm paperclipai task attachment:download <attachment-id> [--out ./artifact.txt]
pnpm paperclipai task attachment:delete <attachment-id>
pnpm paperclipai task label:list --company-id <company-id>
pnpm paperclipai task label:create --company-id <company-id> --name bug --color '#ff0000'
pnpm paperclipai task label:delete <label-id>
```

## Project Commands

```sh
pnpm paperclipai project list --company-id <company-id>
pnpm paperclipai project get <project-id-or-shortname> [--company-id <company-id>]
pnpm paperclipai project create --company-id <company-id> --name "Launch Site" [--goal-ids <id1,id2>] [--lead-agent-id <id>]
pnpm paperclipai project update <project-id-or-shortname> [--status in_progress] [--company-id <company-id>]
pnpm paperclipai project delete <project-id-or-shortname> --yes [--company-id <company-id>]
```

## Goal Commands

```sh
pnpm paperclipai goal list --company-id <company-id>
pnpm paperclipai goal get <goal-id>
pnpm paperclipai goal create --company-id <company-id> --title "Grow revenue" [--level company] [--status active]
pnpm paperclipai goal update <goal-id> [--title "..."] [--status achieved]
pnpm paperclipai goal delete <goal-id> --yes
```

## Agent Commands

```sh
pnpm paperclipai agent list --company-id <company-id>
pnpm paperclipai agent get <agent-id>
pnpm paperclipai agent runtime:create --company-id <company-id> --payload-json '{...}' [--idempotency-key <key>]
pnpm paperclipai agent runtime:get <agent-id>
pnpm paperclipai agent runtime:update <agent-id> --payload-json '{"title":"Senior Builder"}' [--idempotency-key <key>]
pnpm paperclipai agent adapter-revision:create <agent-id> --payload-json '{"adapterType":"<acpx-registry-name>","adapterConfig":{"<acpx-option-id>":"<selected-advertised-value>"},"runtimeConfig":{},"companySkillPins":[]}'
pnpm paperclipai agent adapter-revisions <agent-id>
pnpm paperclipai agent adapter-revision:current <agent-id>
pnpm paperclipai agent operational:update <agent-id> --payload-json '{"budgetMonthlyAmount":"250"}'
pnpm paperclipai agent pause <agent-id>
pnpm paperclipai agent resume <agent-id>
pnpm paperclipai agent clear-error <agent-id>
pnpm paperclipai agent terminate <agent-id>
```

`runtime:create` requires every identity field, all nine context cells, all five
configurable Paperclip action-grant cells and both mention-reach cells. Nullable
values must be supplied as `null`; omitted values are not defaulted. Its payload
shape is:

```json
{
  "name": "Builder",
  "title": null,
  "capabilities": null,
  "reportsTo": null,
  "contextGrants": {
    "carry_context": false,
    "read_task_comments": false,
    "read_task_agent_run": false,
    "list_sub_tasks": false,
    "read_sub_task_comments": false,
    "read_sub_task_agent_run": false,
    "list_company_tasks": false,
    "read_company_task_comments": false,
    "read_company_task_agent_run": false
  },
  "actionGrants": {
    "task_create": false,
    "mention_board": false,
    "agent_hire": false,
    "agent_configure": false,
    "list_all_agents": false,
    "list_parent_agents": false
  },
  "mentionReachGrants": {
    "mention_any_descendant": false,
    "mention_any_ancestor": false
  }
}
```

`task_create` is the combined create-and-assign grant. It allows an exact
creator execution to create direct children and reassign eligible direct
children it created. Lifecycle reporting is relationship-derived rather than
configured: the current owner receives an active-task update and an exact
creator execution receives eligible direct-child updates. Both use canonical
`task_update({ message, status?, structuredResult?, taskId? })` and
automatically mention the owner/creator counterpart in that counterpart's task
context; agents do
not use a separate comment path for the same update. Omit `taskId` for the
active owned task; provide an eligible direct-child ID for a creator update.
Only the current owner may set terminal `done`/`cancelled` and
`structuredResult`; a creator update may send a message or set nonterminal
`open`/`blocked`.

Runtime identity/grants, immutable adapter/provider revisions, and operational
display/budget configuration are three non-overlapping owners. An agent created
through `runtime:create` remains unconfigured and cannot dispatch until
`adapter-revision:create` succeeds. Adapter revisions contain sorted immutable
company-skill pins; ACPX owns native skill discovery.
Provider credentials and CLI-native configuration stay
outside Paperclip. Existing runs
stay pinned to the revision they started with; there is no rollback writer, mixed agent update,
agent-wide session reset, conversational-session API, managed instruction bundle, generic
wake command, or local agent API-key bridge.

## Token Commands

Named board API keys use the board authorization model, support revocation and expiration metadata, and are audited server-side.

```sh
pnpm paperclipai token board create --company-id <company-id> --name external-admin
pnpm paperclipai token board create --name short-lived --ttl-days 7
pnpm paperclipai token board list
pnpm paperclipai token board revoke <key-id>
```

## Run Commands

`paperclipai run` without a subcommand still bootstraps and starts a local
Paperclip instance. The subcommands below inspect and control persisted
productive and consult task-execution runs.

```sh
pnpm paperclipai run list --company-id <company-id> [--agent-id <agent-id>] [--limit 50]
pnpm paperclipai run get <run-id>
pnpm paperclipai run cancel <run-id>
```

## Routine Commands

`paperclipai routines disable-all` remains the local maintenance command. The singular `routine` group maps to the REST API.

```sh
pnpm paperclipai routine list --company-id <company-id> [--project-id <project-id>]
pnpm paperclipai routine create --company-id <company-id> --payload-json '{...}'
pnpm paperclipai routine get <routine-id>
pnpm paperclipai routine update <routine-id> --payload-json '{...}'
pnpm paperclipai routine revisions <routine-id>
pnpm paperclipai routine revision:restore <routine-id> <revision-id>
pnpm paperclipai routine runs <routine-id> [--limit 50]
pnpm paperclipai routine run <routine-id> [--payload-json '{...}']
pnpm paperclipai routine trigger:create <routine-id> --payload-json '{...}'
pnpm paperclipai routine trigger:update <trigger-id> --payload-json '{...}'
pnpm paperclipai routine trigger:delete <trigger-id>
pnpm paperclipai routine trigger:rotate-secret <trigger-id>
pnpm paperclipai routine trigger:fire <public-id> [--payload-json '{...}']
```

## Prompt Submission

Prompt submission creates Paperclip work. It does not create a chat session.

```sh
pnpm paperclipai board prompt --company-id <company-id> --agent <agent-name-or-id> "Prompt here"
```

By default the command creates an ordinary task whose immutable request is the submitted text and whose explicit owner is the target agent. `--task <task-id>` submits an ordinary board comment; a provider is invoked only when that comment carries a valid typed mention of the current owner.

## Skills Commands

`paperclipai skills` covers three distinct operations:

1. **Company install** — adds or updates a row in `company_skills` for the
   whole company. This is what `skills install`, `skills import`, and
   `skills create` do.
2. **Agent selection** — appends an immutable adapter revision containing the
   exact sorted company-skill version pins.
3. **Invocation exposure** — ACPX runs use `operator_native`; Paperclip does
   not materialize a skills home or inject skill content into the
   Paperclip-authored request.

Company skill mutations (`skills install`, `skills import`, and `skills create`)
are open to same-company actors by default. Missing
platform grants do not deny these commands; only an explicit company skill
policy restriction does. Core safety and company boundary checks still apply,
and `agents:create` remains required when a command also creates agents.

### Catalog (app-shipped skills)

The Paperclip app ships a curated catalog under `@paperclipai/skills-catalog`.
Browse and inspect commands never mutate company state; `install` adds a catalog
skill to the company library.

```sh
pnpm paperclipai skills browse [--kind bundled|optional] [--category <slug>] [--query <text>]
pnpm paperclipai skills search "<text>" [--kind bundled|optional] [--category <slug>]
pnpm paperclipai skills inspect <catalog-id-or-key-or-slug>
pnpm paperclipai skills install <catalog-id-or-key-or-slug> [--as <slug>] [--force] --company-id <company-id>
```

Catalog semantics:

- **Bundled** skills live in `packages/skills-catalog/catalog/bundled/<category>/<slug>`
  and ship with the application catalog. They use canonical key
  `paperclipai/bundled/<category>/<slug>`.
- **Optional** skills live in `packages/skills-catalog/catalog/optional/<category>/<slug>`
  and are domain-specific (browser, AWS ops, etc.). Same key
  shape with `optional` in place of `bundled`.
- `skills install` materializes the catalog files into a company-managed skill
  directory and records provenance (`catalogId`, `catalogKey`, `packageVersion`,
  `originHash`, …) so future updates and audit decisions stay consistent.
- `--as <slug>` overrides the company skill slug. `--force` may replace a
  same-key catalog-managed skill but never bypasses hard validation or hard-stop
  audit findings.

Examples:

```sh
pnpm paperclipai skills browse --kind bundled --company-id <company-id>
pnpm paperclipai skills search "pull request" --kind bundled
pnpm paperclipai skills inspect github-pr-workflow
pnpm paperclipai skills install github-pr-workflow --company-id <company-id>
pnpm paperclipai skills install paperclipai:optional:browser:agent-browser --company-id <company-id>
```

External GitHub, skills.sh, local-path, and URL sources still go through
`skills import`; catalog commands are for the app-shipped catalog only.

### Company library

```sh
pnpm paperclipai skills list --company-id <company-id>
pnpm paperclipai skills show <skill-id-or-key-or-slug> --company-id <company-id>
pnpm paperclipai skills file <skill-id-or-key-or-slug> [--path SKILL.md] --company-id <company-id>
pnpm paperclipai skills import <source> --company-id <company-id>
pnpm paperclipai skills create --name "Review PRs" [--slug review-prs] [--description "..."] [--body-file SKILL.md] --company-id <company-id>
pnpm paperclipai skills check [skill-id-or-key-or-slug] --company-id <company-id>
pnpm paperclipai skills update <skill-id-or-key-or-slug> [--force] --company-id <company-id>
pnpm paperclipai skills update --all [--force] --company-id <company-id>
pnpm paperclipai skills audit [skill-id-or-key-or-slug] --company-id <company-id>
pnpm paperclipai skills reset <skill-id-or-key-or-slug> [--yes] [--force] --company-id <company-id>
pnpm paperclipai skills remove <skill-id-or-key-or-slug> --yes --company-id <company-id>
```

`skills import <source>` accepts a skills.sh URL, the equivalent
`<owner>/<repo>/<skill>` shorthand, a GitHub URL, a local path, or an
`npx skills add …` command. See `references/company-skills.md` in the agent
skill bundle for the source-type table.

`skills check`, `skills update`, `skills audit`, and `skills reset` are the
maintenance loop for catalog-installed skills:

- `check` reports whether each skill's installed bytes match its pinned origin
  (`hasUpdate`, `installedHash`, `originHash`, `updateHoldReason`,
  `auditVerdict`).
- `update` installs the pinned update through the existing install-update API.
  `--all` checks every company skill and updates only those with
  `hasUpdate=true`. `--force` discards local-modification or soft-audit holds;
  hard-stop audit findings still block the update.
- `audit` re-scans installed bytes and reports findings without executing
  anything.
- `reset` reinstalls a catalog-managed skill from its pinned origin, discarding
  local edits. Prompts in a TTY; requires `--yes` for non-interactive use.

### Notes

- Skill references accept company skill `id`, canonical `key`, or unique
  `slug`; catalog references accept catalog `id`, `key`, or unique `slug`.
- `skills file` prints raw file content in human mode so it can be piped.
- `skills create --body-file -` reads the skill markdown body from stdin.
- `skills remove` and `skills reset` prompt in a TTY and require `--yes` in
  non-interactive use.
- `--json` prints the raw API result for each command.

## Secrets Commands

```sh
pnpm paperclipai secrets list --company-id <company-id>
pnpm paperclipai secrets declarations --company-id <company-id> [--include company,projects] [--kind secret]
pnpm paperclipai secrets create --company-id <company-id> --name anthropic-api-key --value-env ANTHROPIC_API_KEY
pnpm paperclipai secrets link --company-id <company-id> --name prod-stripe-key --provider aws_secrets_manager --external-ref <provider-ref>
pnpm paperclipai secrets doctor --company-id <company-id>
pnpm paperclipai secrets provider-configs --company-id <company-id>
pnpm paperclipai secrets provider-config:create --company-id <company-id> --payload-json '{...}'
pnpm paperclipai secrets provider-config:discovery-preview --company-id <company-id> --payload-json '{...}'
pnpm paperclipai secrets provider-config:get <config-id>
pnpm paperclipai secrets provider-config:update <config-id> --payload-json '{...}'
pnpm paperclipai secrets provider-config:default <config-id>
pnpm paperclipai secrets provider-config:health <config-id>
pnpm paperclipai secrets provider-config:delete <config-id>
pnpm paperclipai secrets remote-import:preview --company-id <company-id> --payload-json '{...}'
pnpm paperclipai secrets remote-import --company-id <company-id> --payload-json '{...}'
```

Secret listing and declarations never print secret values. `create` accepts
`--value-env` so shell history does not capture the value. `link` records
provider-owned references without copying the secret value into Paperclip.
For AWS-backed secrets, `secrets doctor` reports missing non-secret provider
env and the expected AWS SDK runtime credential source; do not store AWS
bootstrap credentials in Paperclip secrets.

Per-company provider vaults (multiple vault instances per provider, default
vault selection, coming-soon GCP/Vault) can be configured from the board UI under
`Company Settings → Secrets → Provider vaults` or through the provider-config CLI
commands above. See the
[secrets deploy guide](../apps/docs/deploy/secrets.md#provider-vaults) and
[API reference](../apps/docs/api/secrets.md#provider-vaults) for the contract.

## Approval Commands

```sh
pnpm paperclipai approval list --company-id <company-id> [--status pending]
pnpm paperclipai approval get <approval-id>
pnpm paperclipai approval create --company-id <company-id> --type hire_agent --payload '{"name":"..."}' [--task-ids <id1,id2>]
pnpm paperclipai approval approve <approval-id> [--decision-note "..."]
pnpm paperclipai approval reject <approval-id> [--decision-note "..."]
pnpm paperclipai approval request-revision <approval-id> [--decision-note "..."]
pnpm paperclipai approval resubmit <approval-id> [--payload '{"...":"..."}']
pnpm paperclipai approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm paperclipai activity list --company-id <company-id> [--agent-id <agent-id>] [--entity-type task] [--entity-id <id>]
pnpm paperclipai activity create --company-id <company-id> --payload-json '{...}'
pnpm paperclipai activity task <task-id>
```

## Dashboard Commands

```sh
pnpm paperclipai dashboard get --company-id <company-id>
```

## Org And Agent Config Commands

```sh
pnpm paperclipai whoami
pnpm paperclipai openapi
pnpm paperclipai org get --company-id <company-id>
pnpm paperclipai org svg --company-id <company-id> [--out org.svg]
pnpm paperclipai org png --company-id <company-id> [--out org.png]
pnpm paperclipai agent-config list --company-id <company-id>
```

## Access, Profile, And Instance Commands

```sh
pnpm paperclipai profile session
pnpm paperclipai profile get
pnpm paperclipai profile update --payload-json '{...}'
pnpm paperclipai profile company-user <user-slug> --company-id <company-id>
pnpm paperclipai invite list --company-id <company-id>
pnpm paperclipai invite create --company-id <company-id> --payload-json '{...}'
pnpm paperclipai invite revoke <invite-id>
pnpm paperclipai invite show <token>
pnpm paperclipai invite accept <token> [--payload-json '{...}']
pnpm paperclipai invite onboarding:text <token>
pnpm paperclipai join list --company-id <company-id> [--status pending_approval]
pnpm paperclipai join approve <request-id> --company-id <company-id>
pnpm paperclipai join reject <request-id> --company-id <company-id>
pnpm paperclipai member list --company-id <company-id>
pnpm paperclipai member update <member-id> --company-id <company-id> --payload-json '{...}'
pnpm paperclipai member role-and-grants <member-id> --company-id <company-id> --payload-json '{...}'
pnpm paperclipai member permissions <member-id> --company-id <company-id> --payload-json '{...}'
pnpm paperclipai member archive <member-id> --company-id <company-id> [--payload-json '{...}']
pnpm paperclipai admin user list [--query <text>]
pnpm paperclipai admin user promote <user-id>
pnpm paperclipai admin user demote <user-id>
pnpm paperclipai admin user company-access <user-id>
pnpm paperclipai admin user company-access:update <user-id> --payload-json '{...}'
```

CLI auth challenge endpoints are also exposed for tooling that needs the raw challenge lifecycle:

```sh
pnpm paperclipai auth challenge create --payload-json '{...}'
PAPERCLIP_CHALLENGE_SECRET=<challenge-secret> pnpm paperclipai auth challenge get <challenge-id> --token-env PAPERCLIP_CHALLENGE_SECRET
PAPERCLIP_CHALLENGE_SECRET=<challenge-secret> pnpm paperclipai auth challenge approve <challenge-id> --token-env PAPERCLIP_CHALLENGE_SECRET
PAPERCLIP_CHALLENGE_SECRET=<challenge-secret> pnpm paperclipai auth challenge cancel <challenge-id> --token-env PAPERCLIP_CHALLENGE_SECRET
pnpm paperclipai auth revoke-current
```

`--token <challenge-secret>` is still supported for compatibility, but `--token-env` avoids putting challenge secrets in shell history or process arguments.

## Instance Settings Commands

```sh
pnpm paperclipai instance settings:general
pnpm paperclipai instance settings:general:update --payload-json '{...}'
```

`settings:general` returns the instance-wide settings. `settings:general:update`
PATCHes a JSON object and requires instance-admin access. The retained General
settings are:

| Key | Default | Behavior |
| --- | --- | --- |
| `enableWorkspaceBranchReconcileForward` | On | Allows a clean worktree to advance only when its checked-out branch is a proven descendant of the recorded branch. |
| `enableWorkspaceDirtyQuarantineRepair` | On | Preserves dirty foreign-branch work on a rescue branch before restoring the recorded branch. |
| `enableServerInfoDebugView` | Off | Shows server restart, running commit, and checkout-state details in the account-menu **Server Info** debug view. It changes only that view. |
| `autoRestartDevServerWhenIdle` | Off | Lets the managed dev runner request a restart for backend changes after there are no queued or running task executions. Migrations remain explicit. |
| `enableWorktreeRunExecution` | Off | In a worktree instance, permits automatic schedule and webhook dispatch only for routines created after the server-recorded activation cutoff. Normal instances are unaffected. |

For the worktree dispatch control, the server—not the client—controls the
returned `worktreeRunExecutionActivatedAt` and
`worktreeRunExecutionActivationInstanceId` metadata. They cannot be sent in an
update payload; a worktree is armed only when that state matches its running
instance, and missing, copied, mismatched, or unreadable state fails closed.

For example:

```sh
pnpm paperclipai instance settings:general:update \
  --payload-json '{"autoRestartDevServerWhenIdle":true}'
```

```sh
pnpm paperclipai sidebar preferences
pnpm paperclipai sidebar preferences:update --payload-json '{...}'
pnpm paperclipai sidebar project-preferences --company-id <company-id>
pnpm paperclipai sidebar project-preferences:update --company-id <company-id> --payload-json '{...}'
pnpm paperclipai sidebar badges --company-id <company-id>
pnpm paperclipai inbox dismissals --company-id <company-id>
pnpm paperclipai inbox dismiss --company-id <company-id> --payload-json '{"itemKey":"run:<run-id>"}'
pnpm paperclipai llm agent-configuration
pnpm paperclipai llm agent-configuration:adapter <adapter-type>
pnpm paperclipai llm agent-icons
```

## Adapter, Asset, And Skill Commands

```sh
pnpm paperclipai adapter list
pnpm paperclipai adapter get <adapter-type>
pnpm paperclipai adapter config-schema <adapter-type>
pnpm paperclipai adapter models <adapter-type> --company-id <company-id>
pnpm paperclipai adapter model-profiles <adapter-type> --company-id <company-id>
```

ACPX is the only local-agent availability, identity, model, session-settings,
and execution-contract authority. The adapter list includes non-selectable ACPX
probe diagnostics when a registry-listed local agent cannot initialize.

```sh
pnpm paperclipai asset image:upload --company-id <company-id> --file ./image.png [--namespace docs] [--alt "..."]
pnpm paperclipai asset logo:upload --company-id <company-id> --file ./logo.svg
pnpm paperclipai asset content <asset-id> --out ./asset.bin
```

```sh
pnpm paperclipai skill list --company-id <company-id>
pnpm paperclipai skill get <skill-id> --company-id <company-id>
pnpm paperclipai skill file <skill-id> --company-id <company-id> [--path SKILL.md]
pnpm paperclipai skill create --company-id <company-id> --payload-json '{...}'
pnpm paperclipai skill file:update <skill-id> --company-id <company-id> --payload-json '{...}'
pnpm paperclipai skill import --company-id <company-id> --payload-json '{"source":"github:owner/repo/path"}'
pnpm paperclipai skill update-status <skill-id> --company-id <company-id>
pnpm paperclipai skill install-update <skill-id> --company-id <company-id>
pnpm paperclipai skill delete <skill-id> --company-id <company-id>
```

## Cost, Finance, And Budget Commands

```sh
pnpm paperclipai cost summary --company-id <company-id>
pnpm paperclipai cost by-agent --company-id <company-id>
pnpm paperclipai cost by-project --company-id <company-id>
pnpm paperclipai cost events --company-id <company-id>
pnpm paperclipai cost task <task-id>
pnpm paperclipai cost window-spend --company-id <company-id>
pnpm paperclipai cost task <task-id>
pnpm paperclipai cost event:create --company-id <company-id> --payload-json '{...}'
```

```sh
pnpm paperclipai finance event:create --company-id <company-id> --payload-json '{...}'
pnpm paperclipai finance events --company-id <company-id>
pnpm paperclipai finance summary --company-id <company-id>
pnpm paperclipai finance by-biller --company-id <company-id>
pnpm paperclipai finance by-kind --company-id <company-id>
pnpm paperclipai budget overview --company-id <company-id>
pnpm paperclipai budget policy:upsert --company-id <company-id> --payload-json '{...}'
pnpm paperclipai budget company:update --company-id <company-id> --payload-json '{...}'
pnpm paperclipai budget agent:update <agent-id> --payload-json '{"budgetMonthlyAmount":"250"}'
pnpm paperclipai budget incident:resolve <incident-id> --company-id <company-id> [--payload-json '{...}']
```

## Plugin Commands

Plugin lifecycle commands include `plugin init`, `list`, `install`, `uninstall`,
`enable`, `disable`, and `inspect`. From a Paperclip source checkout, instance
admins can also build and install the trusted plugin packages under
`packages/plugins/` from **Instance settings → Plugins**. The CLI continues to
install an explicit local path or npm package and does not expose that
checkout-local catalog.

```sh
pnpm paperclipai plugin init <package-name> --category <connector|workspace|automation|ui>
pnpm paperclipai plugin list
pnpm paperclipai plugin install <npm-package-name> [--version <version>]
pnpm paperclipai plugin install --local <path>
pnpm paperclipai plugin inspect <plugin-installation-id>
pnpm paperclipai plugin enable <plugin-installation-id>
pnpm paperclipai plugin disable <plugin-installation-id>
pnpm paperclipai plugin uninstall <plugin-installation-id>
pnpm paperclipai plugin ui-contributions
pnpm paperclipai plugin logs <plugin-installation-id>
pnpm paperclipai plugin upgrade <plugin-installation-id> [--version <version>]
pnpm paperclipai plugin config <plugin-installation-id>
pnpm paperclipai plugin config:set <plugin-installation-id> --payload-json '{"configJson":{...}}'
pnpm paperclipai plugin config:test <plugin-installation-id> --payload-json '{"configJson":{...}}'
pnpm paperclipai plugin jobs <plugin-installation-id>
pnpm paperclipai plugin job:runs <plugin-installation-id> <job-id>
pnpm paperclipai plugin job:trigger <plugin-installation-id> <job-id> [--payload-json '{...}']
pnpm paperclipai plugin webhook <plugin-installation-id> <endpoint-key> [--payload-json '{...}']
pnpm paperclipai plugin dashboard <plugin-installation-id>
pnpm paperclipai plugin local-folders <plugin-installation-id> --company-id <company-id>
pnpm paperclipai plugin local-folder:status <plugin-installation-id> <folder-key> --company-id <company-id>
pnpm paperclipai plugin local-folder:validate <plugin-installation-id> <folder-key> --company-id <company-id> [--payload-json '{...}']
pnpm paperclipai plugin local-folder:set <plugin-installation-id> <folder-key> --company-id <company-id> --payload-json '{...}'
```

## Local Storage Defaults

Local Paperclip data lives under the selected instance root. `PAPERCLIP_HOME` chooses the home directory and `PAPERCLIP_INSTANCE_ID` chooses the instance.

```text
~/.paperclip/                                     # PAPERCLIP_HOME
└── instances/
    └── default/                                  # instance root (PAPERCLIP_INSTANCE_ID)
        ├── config.json                           # runtime config
        ├── .env                                  # instance env file
        ├── data/
        │   └── storage/                          # local_disk uploads
        ├── logs/
        ├── secrets/
        │   └── master.key                        # local_encrypted master key
```

Default paths for the canonical install:

- config: `~/.paperclip/instances/default/config.json`
- database: configured external PostgreSQL URL
- logs: `~/.paperclip/instances/default/logs`
- storage: `~/.paperclip/instances/default/data/storage`
- secrets key: `~/.paperclip/instances/default/secrets/master.key`

Override base home or instance with env vars:

```sh
PAPERCLIP_HOME=/custom/home PAPERCLIP_INSTANCE_ID=dev pnpm paperclipai run
```

## Storage Configuration

Configure storage provider and settings:

```sh
pnpm paperclipai configure --section storage
```

Supported providers:

- `local_disk` (default; local single-user installs)
- `s3` (S3-compatible object storage)
