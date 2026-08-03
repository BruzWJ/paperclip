---
title: Architecture
summary: Stack overview, issue-execution flow, and adapter model
---

Paperclip is a TypeScript monorepo built around a PostgreSQL control plane.

## Stack Overview

```text
┌───────────────────────────────────────────┐
│ React UI + CLI                            │
│ Board control, issue/session inspection  │
├───────────────────────────────────────────┤
│ Express API + runtime services            │
│ Auth, issue authority, dispatcher, tools │
├───────────────────────────────────────────┤
│ PostgreSQL + Drizzle                      │
│ Issues, Sessions, refs, runs, audit       │
├───────────────────────────────────────────┤
│ Worker-supervised ACP subprocess          │
│ Official SDK client + approved frontend  │
└───────────────────────────────────────────┘
```

## Repository Structure

```text
paperclip/
├── ui/                         # React board interface
├── server/                     # Express routes and control-plane services
├── packages/
│   ├── db/                     # Drizzle schema and ordered migrations
│   ├── shared/                 # Contracts, validators, and constants
│   ├── adapter-utils/          # Common ACP client and target bridge
│   ├── adapters/               # Declarative approved ACP backends
│   └── plugins/                # Plugin SDK, examples, and first-party plugins
├── cli/                        # Board/control-plane CLI
└── docs/ and doc/              # User and engineering documentation
```

## Canonical Issue-Execution Flow

1. An authorized source creates or updates an ordinary issue through a
   transaction that records the immutable causal input.
2. The dispatcher admits an `IssueExecutionRef` for the exact issue, ownership
   epoch, owner, adapter revision, mode, and source.
3. The context resolver computes effective grants and an immutable composition
   view. Context that is not granted is absent.
4. The runtime interface compiler creates the exact Paperclip/company tool
   schema for that authenticated ref.
5. Workspace resolution binds the run to the issue/epoch execution-workspace
   record; projectless work receives an absolute issue-owned cwd.
6. The worker validates the declarative backend against Paperclip's immutable
   launch catalog and ACPX's registry, then supervises the approved ACP agent
   subprocess on the selected execution target.
7. The common official-SDK client configures the ACP session, supplies the
   request-scoped MCP server set, sends the exact prompt, and projects
   structured ACP updates into the issue's Paperclip Session graph.
   Projectors derive comments, lifecycle outcomes, costs, and audit views.
8. Process loss or a retryable failure re-leases the existing valid ref. It
   never fabricates a generic wake, agent-wide session, or singleton run link
   on the issue.

Board Chat, routines, plugin work, mentions, creator updates, and system nudges
all enter this same flow. There is no direct agent invoke/heartbeat endpoint,
static Paperclip MCP, provider-held Paperclip credential, issue checkout, or
agent polling loop.

## Session and Continuity Model

Each issue has one Session graph. Paperclip may retain a provider's opaque
native handle only for the same issue, ownership epoch, agent, and immutable
adapter revision when the effective `carry_context` grant is true. Reassignment,
revision change, explicit fresh-session action, or a false grant prevents reuse.

Provider-native storage remains opaque and provider-owned. Paperclip stores no
model-visible agent memory and never selects a handle from another issue.

## ACP Backend Model

Every built-in or external adapter is a data-only `acp-subprocess/v1`
definition selecting an already approved ACP launch and closed stable session
configuration. It contains no execution callback, provider client, parser,
session state, authentication hook, or tool implementation.

Paperclip uses ACPX only for public agent-name-to-launch registry lookup after
the submitted name passes its immutable approved catalog. The common worker and
official TypeScript SDK own the one request/control/event path over supervised
subprocess stdio. The selected CLI or pinned upstream ACP frontend owns
provider authentication and its native prompt/model/tool/history harness.
Local, SSH, sandbox, and plugin are execution-target drivers on this same path,
not alternate adapters. Generic process, HTTP, gateway, raw-provider, or
provider-specific execution adapters do not exist.

## Key Invariants

- Every provider attempt belongs to an admitted issue-execution ref.
- Issue creator and request are immutable; ownership changes advance the epoch.
- Agent org position, title, or creation order grants no authority.
- Context and actions default false and are evaluated independently.
- The provider never receives generic Paperclip API credentials or ambient
  identity/workspace environment variables.
- Comments are projected from typed Session events; generic writers are absent.
- Company archive and hard deletion fence and drain the complete Session/run
  graph before purge.
