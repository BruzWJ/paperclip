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
│ Auth, issue authority, dispatcher, run interface │
├───────────────────────────────────────────┤
│ PostgreSQL + Drizzle                      │
│ Issues, Sessions, refs, runs, audit       │
├───────────────────────────────────────────┤
│ ACPX public-runtime bounded prompt bridge │
│ Dynamic local CLI discovery + execution  │
└───────────────────────────────────────────┘
```

## Repository Structure

```text
paperclip/
├── apps/
│   ├── server/                   # Express API and control-plane services
│   ├── ui/                       # React + Vite board interface
│   └── docs/                     # This published Mintlify documentation site
├── packages/
│   ├── cli/                      # Publishable board/control-plane CLI
│   ├── db/                       # Drizzle schema and ordered migrations
│   ├── shared/                   # Contracts, validators, and constants
│   ├── adapter-utils/            # ACPX runtime/discovery bridge
│   ├── adapters/                 # Adapter-authoring guidance
│   ├── skills-catalog/           # Bundled skill catalog and manifest builder
│   ├── *-mcp-server/             # MCP server packages and fixtures
│   └── plugins/                  # Plugin SDK, tooling, plugins, and examples
└── doc/                          # Internal product, engineering, and plan docs
```

`apps/docs/` and `doc/` serve different audiences. `apps/docs/` is the
published documentation application and contains `docs.json`; `doc/` contains
repository-internal specifications, runbooks, design records, and plans.
The orchestration smoke fixture under `packages/plugins/examples/` is
intentionally standalone rather than a pnpm root workspace.

## Canonical Issue-Execution Flow

1. An authorized source creates or updates an ordinary issue through a
   transaction that records the immutable causal input.
2. The dispatcher admits an `IssueExecutionRef` for the exact issue, ownership
   epoch, owner, adapter revision, mode, and source.
3. The context resolver computes effective grants and an immutable composition
   view. Context that is not granted is absent.
4. The runtime interface compiler creates the exact prompt-capability schema
   for that authenticated ref.
5. The server resolves the local run directory used for the attempt.
6. The worker uses the ACPX-discovered exact registry name to create a
   disposable ACPX runtime in that directory. ACPX, not Paperclip, supplies
   availability and launches the compatible CLI.
7. ACPX configures the provider backend session or performs the frozen resume
   operation, receives the request-scoped MCP server set and exact prompt, and
   returns structured updates for Paperclip to project into its Session graph.
   A rejected ACPX operation fails the attempt; Paperclip does not substitute a
   provider-specific fresh-session fallback.
   Projectors derive comments, lifecycle outcomes, costs, and audit views.
8. Worker loss or a retryable failure re-leases the existing valid ref. It
   never fabricates a generic wake, agent-wide session, or singleton run link
   on the issue.

Routines, plugin work, mentions, creator updates, and system nudges all enter
this same flow. There is no direct agent invoke/heartbeat endpoint, static
Paperclip MCP, provider-held Paperclip credential, issue checkout, or agent
polling loop.

## Session and Continuity Model

Each issue has one Session graph. Paperclip may retain a provider's opaque
native handle only for the same issue, ownership epoch, agent, and immutable
adapter revision when the effective `carry_context` grant is true. Reassignment,
revision change, or a false grant prevents reuse and never authorizes a
replacement session for later work.

Provider-native storage remains opaque and provider-owned. Paperclip stores no
model-visible cross-issue continuity state and never selects a handle from another issue.

## ACP Backend Model

Every ACPX-discovered agent becomes a data-only `acpx-runtime/v1` definition
with its exact registry name and advertised stable session configuration. It
contains no execution callback, provider client, parser, session state,
authentication hook, or tool implementation.

Paperclip uses ACPX as the sole dynamic agent/model/configuration supplier: it
enumerates ACPX's registry with its resolved launch overrides and does not
maintain an approved agent catalog of its own. A generic local-install fence
prevents package-backed shortcuts from materializing an absent CLI during
discovery; each remaining candidate must then pass an ACPX session probe. ACPX
owns the one request/control/event path to the provider CLI and its native
prompt/model/tool/history harness.
Paperclip owns durable authority, request MCP, redacted projection, and
accounting.
The current public ACPX runtime launches the provider CLI locally in the exact
working directory authorized for the issue. Generic process, HTTP, gateway,
raw-provider, or provider-specific execution adapters do not exist.

## Key Invariants

- Every provider attempt belongs to an admitted issue-execution ref.
- Issue creator and request are immutable; ownership changes advance the epoch.
- Agent org position, title, or creation order grants no authority.
- Context and actions are explicit and evaluated independently.
- The provider never receives generic Paperclip API credentials or ambient
  identity/run-directory environment variables.
- Comments are projected from typed Session events; generic writers are absent.
- Company archive and hard deletion fence and drain the complete Session/run
  graph before purge.
