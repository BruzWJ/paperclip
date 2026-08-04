---
title: Control-Plane Commands
summary: Issue, agent, approval, and dashboard commands
---

Client-side commands for managing issues, agents, approvals, and more.

## Issue Commands

```sh
# List issues
pnpm paperclipai issue list [--status open,blocked] [--owner-agent-id <id>] [--match text]

# Get issue details
pnpm paperclipai issue get <issue-id-or-identifier>

# Create issue
pnpm paperclipai issue create -C <company-id> --request "..." --owner-agent-id <agent-id> [--title "..."] [--priority high]

# Update title metadata
pnpm paperclipai issue title <issue-id> --title "..."

# Creator-only reassignment
pnpm paperclipai issue reassign <issue-id> --owner-agent-id <agent-id> [--idempotency-key <key>]

# Audited board reopen
pnpm paperclipai issue reopen <issue-id> --reason "..." [--idempotency-key <key>]

# Non-dispatch comment
pnpm paperclipai issue comment <issue-id> --message "..." [--idempotency-key <key>]

# Explicit current-owner mention
pnpm paperclipai issue comment <issue-id> --message "..." \
  --mention-target-agent-id <agent-id> --mention-ownership-epoch <epoch>
```

The reopen command returns a discriminated dispatch result.
`agent_execution` contains the one persisted execution ref for an invokable
preserved agent; `board_only` applies only to a named-user or
collective-board-owned system escalation and performs no provider dispatch.
Invalid or non-invokable preserved owners are rejected without mutation.

## Company Commands

```sh
pnpm paperclipai company list
pnpm paperclipai company get <company-id>
pnpm paperclipai company current [--company-id <company-id>]

# Export to portable folder package (writes manifest + markdown files)
pnpm paperclipai company export <company-id> --out ./exports/acme --include company,agents

# Preview import (no writes)
pnpm paperclipai company import \
  <owner>/<repo>/<path> \
  --target existing \
  --company-id <company-id> \
  --ref main \
  --collision rename \
  --dry-run

# Apply import
pnpm paperclipai company import \
  ./exports/acme \
  --target new \
  --new-company-name "Acme Imported" \
  --include company,agents
```

These are board control-plane commands. Use `--company-id`,
`PAPERCLIP_BOARD_COMPANY_ID`, or a board context to select a company.
`company create` requires board/instance-admin authentication because it is an
instance-wide setup command. There is no agent persona or provider-side CLI
fallback.

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
  --payload-json '{"adapterType":"<acpx-registry-name>","adapterConfig":{"<acpx-option-id>":"<selected-advertised-value>"},"defaultEnvironmentId":"11111111-1111-4111-8111-111111111111","runtimeConfig":{},"companySkillPins":[],"skillChannel":"operator_native"}'
pnpm paperclipai agent adapter-revisions <agent-id>
pnpm paperclipai agent adapter-revision:current <agent-id>

pnpm paperclipai agent operational:update <agent-id> \
  --payload-json '{"icon":null,"budgetMonthlyAmount":"250"}'
pnpm paperclipai agent pause <agent-id>
pnpm paperclipai agent resume <agent-id>
pnpm paperclipai agent clear-error <agent-id>
pnpm paperclipai agent terminate <agent-id>
```

The three mutation families are deliberately disjoint:

- Runtime configuration owns display identity, reporting, capabilities, the
  complete 9/6/2 grant maps, and exact company-tool selections.
- Adapter revisions own adapter type/configuration, exact execution environment,
  runtime configuration, sorted immutable company-skill pins, and the exact
  `isolated_skills_home` or `operator_native` channel. Provider credentials and
  CLI-native configuration remain outside Paperclip. Revisions are append-only;
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

## Skills Commands

```sh
# Browse app-shipped catalog skills without changing company state
pnpm paperclipai skills browse [--kind bundled|optional] [--category software-development] [--query github]
pnpm paperclipai skills search "pull request" [--json]

# Inspect catalog metadata and file inventory before install
pnpm paperclipai skills inspect github-pr-workflow

# Install a catalog skill into the company skill library
# This does not attach the skill to any agent.
pnpm paperclipai skills install github-pr-workflow --company-id <company-id>
pnpm paperclipai skills install github-pr-workflow --as pr-flow --force --company-id <company-id>

# External sources still use import instead of catalog install
pnpm paperclipai skills import ./skills/my-skill --company-id <company-id>
pnpm paperclipai skills import owner/repo/path/to/skill --company-id <company-id>

```

Installing or importing changes only the company skill library. Select exact
skill keys/versions for an agent through the board agent-configuration surface;
there is no operational `skills agent sync` command or implicit attachment.

## Approval Commands

```sh
# List approvals
pnpm paperclipai approval list [--status pending]

# Get approval
pnpm paperclipai approval get <approval-id>

# Create approval
pnpm paperclipai approval create --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]

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
pnpm paperclipai activity list [--agent-id <id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard

```sh
pnpm paperclipai dashboard get
```

## Instance Settings

```sh
pnpm paperclipai instance settings:general
pnpm paperclipai instance settings:general:update --payload-json '{...}'
pnpm paperclipai instance settings:experimental
pnpm paperclipai instance settings:experimental:update --payload-json '{...}'
```

Experimental features are opt-in and are provided without compatibility guarantees. They may break, change, or be removed at any time. Use them at your own risk.

There is no direct agent-invocation command. Provider work starts only from a
committed canonical issue source and persisted issue-execution reference.
