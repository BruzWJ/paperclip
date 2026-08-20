---
title: Control-Plane Commands
summary: Task, agent, approval, and dashboard commands
---

Client-side commands for managing tasks, agents, approvals, and more.

## Task Commands

```sh
# List tasks
pnpm paperclipai task list [--status open,blocked] [--owner-agent-id <id>] [--match text]

# Get task details
pnpm paperclipai task get <task-id>

# Create task
pnpm paperclipai task create -C <company-id> --request "..." --owner-agent-id <agent-id> [--title "..."] [--priority high]

# Update title metadata
pnpm paperclipai task title <task-id> --title "..."

# Board reassignment
pnpm paperclipai task reassign <task-id> --owner-agent-id <agent-id> [--idempotency-key <key>]

# Non-dispatch comment
pnpm paperclipai task comment <task-id> --message "..." [--idempotency-key <key>]

# Explicit current-owner mention
pnpm paperclipai task comment <task-id> --message "..." \
  --mention-target-agent-id <agent-id> --mention-ownership-epoch <epoch>
```

The CLI has no lifecycle alias. Board users use
`POST /api/tasks/{taskId}/status-update` or Board MCP `task_update`; agent executions
use their compiled `task_update`.

## Company Commands

```sh
pnpm paperclipai company list
pnpm paperclipai company get <company-id>
pnpm paperclipai company current [--company-id <company-id>]

# Export to portable folder package (writes manifest + markdown files)
pnpm paperclipai company export <company-id> --out ./exports/acme --include company,agents

# Preview import (no writes)
pnpm paperclipai company import \
  'https://github.com/<owner>/<repo>?ref=main&path=<package-directory>' \
  --target existing \
  --company-id <company-id> \
  --collision rename \
  --dry-run

# Apply import
pnpm paperclipai company import \
  ./exports/acme \
  --target new \
  --new-company-name "Acme Imported" \
  --include company,agents

# Delete by the exact canonical company UUID
pnpm paperclipai company delete 22222222-2222-4222-8222-222222222222 --yes --confirm 22222222-2222-4222-8222-222222222222
```

These are board control-plane commands. Use `--company-id`,
`PAPERCLIP_BOARD_COMPANY_ID`, or a board context to select a company.
Every company ID must be an exact lowercase canonical UUID; invalid values are
not trimmed, case-normalized, or replaced by a lower-priority context value.
`company create` requires board/instance-admin authentication because it is an
instance-wide setup command. There is no agent persona or provider-side CLI
fallback.

`company delete` accepts and confirms only the exact canonical company UUID.

## Project Commands

```sh
pnpm paperclipai project list -C <company-id>
pnpm paperclipai project get <project-id>
pnpm paperclipai project create -C <company-id> --name "Launch Site"
pnpm paperclipai project update <project-id> --status in_progress
pnpm paperclipai project delete <project-id> --yes
```

Project get/update/delete accept the project UUID and call its REST endpoint
directly.

## Agent Commands

```sh
pnpm paperclipai agent list --company-id <company-id>
pnpm paperclipai agent get <agent-id>
pnpm paperclipai agent runtime:create --company-id <company-id> \
  --payload-json '{...}' [--idempotency-key <key>]
pnpm paperclipai agent runtime:get <agent-id>
pnpm paperclipai agent runtime:update <agent-id> \
  --payload-json '{...}' [--idempotency-key <key>]

pnpm paperclipai agent adapter-revision:create <agent-id> \
  --payload-json '{"adapterType":"<acpx-registry-name>","adapterConfig":{"<acpx-option-id>":"<selected-advertised-value>"},"runtimeConfig":{}}'
pnpm paperclipai agent adapter-revisions <agent-id>
pnpm paperclipai agent adapter-revision:current <agent-id>

pnpm paperclipai agent operational:update <agent-id> \
  --payload-json '{"icon":null,"budgetMonthlyAmount":"250"}'
pnpm paperclipai agent pause <agent-id>
pnpm paperclipai agent resume <agent-id>
pnpm paperclipai agent clear-error <agent-id>
pnpm paperclipai agent terminate <agent-id>
```

Agent resource commands accept the agent UUID and call its REST endpoint
directly. There is no URL-key or name resolution path.

The three mutation families are deliberately disjoint:

- Runtime configuration owns display identity, reporting, capabilities, the
  complete 9/6/2 grant maps.
- Adapter revisions own adapter type/configuration, runtime configuration,
  and exact ACPX selections. Provider credentials and CLI-native configuration
  remain outside Paperclip. Revisions are append-only;
  there is no rollback command.
- Operational configuration owns only icon and monthly
  budget. Lifecycle has dedicated pause/resume/clear-error/terminate commands.
  `budget agent:update` is a budget-only convenience command over this same
  operational endpoint, not a second agent-budget writer.

`runtime:create` requires a complete explicit payload and sends an
`Idempotency-Key` header (generated unless provided). It creates a nullable,
unconfigured agent identity; dispatch stays disabled until a board operator
appends a valid adapter revision. No create/hire/update compatibility command
or implicit provider default remains.

## Approval Commands

```sh
# List approvals
pnpm paperclipai approval list [--status pending]

# Get approval
pnpm paperclipai approval get <approval-id>

# Create approval
pnpm paperclipai approval create --type hire_agent --payload '{"name":"..."}' [--task-ids <id1,id2>]

# Approve
pnpm paperclipai approval approve <approval-id> [--decision-note "..."]

# Reject
pnpm paperclipai approval reject <approval-id> [--decision-note "..."]

# Request revision
pnpm paperclipai approval request-revision <approval-id> [--decision-note "..."]

# Resubmit
pnpm paperclipai approval resubmit <approval-id> [--payload '{"..."}']

# Comment
pnpm paperclipai approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm paperclipai activity list [--agent-id <id>] [--entity-type task] [--entity-id <id>]
```

## Dashboard

```sh
pnpm paperclipai dashboard get
```

## Instance Settings

```sh
pnpm paperclipai instance settings:general
pnpm paperclipai instance settings:general:update --payload-json '{...}'
```

`settings:general` returns the instance-wide settings. `settings:general:update`
PATCHes a JSON object and requires instance-admin access. The retained General
settings are:

| Key                                     | Default | Behavior                                                                                                                                                                        |
| --------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enableWorkspaceBranchReconcileForward` | On      | Allows a retained managed worktree to advance only when its checked-out branch is a proven descendant of the recorded branch. Direct project folders are never changed.         |
| `enableWorkspaceDirtyQuarantineRepair`  | On      | Preserves dirty retained managed-worktree changes on a rescue branch before restoring the recorded branch. Direct project folders are never changed.                            |
| `enableServerInfoDebugView`             | Off     | Shows server restart, running commit, and checkout-state details in the account-menu **Server Info** debug view. It changes only that view.                                     |
| `autoRestartDevServerWhenIdle`          | Off     | Lets the managed dev runner request a restart for backend changes after there are no queued or running task executions. Migrations remain explicit.                             |
| `enableWorktreeRunExecution`            | Off     | In a worktree instance, permits automatic schedule and webhook dispatch only for routines created after the server-recorded activation cutoff. Normal instances are unaffected. |

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

There is no direct agent-invocation command. Provider work starts only from a
committed canonical task source and persisted task-execution reference.
