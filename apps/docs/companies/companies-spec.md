# Agent Companies Specification

Version: `agentcompanies/v1-draft`

## 1. Purpose

An Agent Company package is a filesystem- and GitHub-native format for
describing a company, team, configured agent identity, project, starter task,
and related configuration using Markdown files with YAML frontmatter. The
portable filename is `TASK.md`; Paperclip imports it as a canonical task.

This specification is vendor-neutral. It is intended to be usable by any agent-company runtime, not only Paperclip.

The format is designed to:

- be readable and writable by humans
- work directly from a local folder or GitHub repository
- require no central registry
- support attribution and pinned references to upstream files
- be useful outside Paperclip

## 2. Core Principles

1. Markdown is canonical.
2. Git repositories are valid package containers.
3. Registries are optional discovery layers, not authorities.
4. External references must be pinnable to immutable Git commits.
5. Attribution and license metadata must survive import/export.
6. Slugs and relative paths are the portable identity layer, not database ids.
7. Conventional folder structure should work without verbose wiring.
8. Vendor-specific fidelity belongs in optional extensions, not the base package.

## 3. Package Kinds

A package root is identified by one primary markdown file:

- `COMPANY.md` for a company package
- `TEAM.md` for a team package
- `AGENTS.md` for an agent package
- `PROJECT.md` for a project package
- `TASK.md` for a portable starter-task package

A GitHub repo may contain one package at root or many packages in subdirectories.

## 4. Reserved Files And Directories

Common conventions:

```text
COMPANY.md
TEAM.md
AGENTS.md
PROJECT.md
TASK.md

agents/<slug>/AGENTS.md
teams/<slug>/TEAM.md
projects/<slug>/PROJECT.md
projects/<slug>/tasks/<slug>/TASK.md
tasks/<slug>/TASK.md
.paperclip.yaml

README.md
assets/
scripts/
references/
```

Rules:

- only markdown files are canonical content docs
- non-markdown directories like `assets/`, `scripts/`, and `references/` are allowed
- package tools may generate optional lock files, but lock files are not required for authoring

## 5. Common Frontmatter

Package docs may support these fields:

```yaml
schema: agentcompanies/v1
kind: company | team | agent | project | task
slug: my-slug
name: Human Readable Name
description: Short description
version: 0.1.0
license: MIT
authors:
  - name: Jane Doe
homepage: https://example.com
tags:
  - startup
  - engineering
metadata: {}
sources: []
```

Notes:

- `schema` is optional and should usually appear only at the package root
- `kind` is optional when file path and file name already make the kind obvious
- `slug` should be URL-safe and stable
- `sources` is for provenance and external references
- `metadata` is for tool-specific extensions
- exporters should omit empty or default-valued fields

## 6. COMPANY.md

`COMPANY.md` is the root entrypoint for a whole company package.

### Required fields

```yaml
name: Lean Dev Shop
description: Small engineering-focused AI company
slug: lean-dev-shop
schema: agentcompanies/v1
```

### Recommended fields

```yaml
version: 1.0.0
license: MIT
authors:
  - name: Example Org
goals:
  - Build and ship software products
includes:
  - https://github.com/example/shared-company-parts/blob/0123456789abcdef0123456789abcdef01234567/teams/engineering/TEAM.md
requirements:
  secrets:
    - OPENAI_API_KEY
```

### Semantics

- `includes` defines the package graph
- local package contents should be discovered implicitly by folder convention
- `includes` is optional and should be used mainly for external refs or nonstandard locations
- included items may be local or external references
- `COMPANY.md` may include agents directly, teams, projects, or tasks
- a company importer may render `includes` as the tree/checkbox import UI

## 7. TEAM.md

`TEAM.md` defines an org subtree.

### Example

```yaml
name: Engineering
description: Product and platform engineering team
schema: agentcompanies/v1
slug: engineering
manager: ../engineering-lead/AGENTS.md
includes:
  - ../platform-lead/AGENTS.md
  - ../frontend-lead/AGENTS.md
tags:
  - team
  - engineering
```

### Semantics

- a team package is a reusable subtree, not necessarily a runtime database table
- `manager` identifies the root agent of the subtree
- `includes` may contain child agents or child teams
- a team package can be imported into an existing company and attached under a target manager

## 8. AGENTS.md

`AGENTS.md` defines an agent.

### Example

```yaml
name: Engineering Lead
title: Engineering
reportsTo: null
```

### Semantics

- the base file carries portable identity; its body is empty and never becomes
  Paperclip model input
- `name` is identity, `title` is optional display text, and `reportsTo`
  references the direct parent agent slug
- vendor-specific adapter/runtime config should not live in the base package
- role, prompt/instruction, memory, provider-session, and ambient-permission
  fields are not portable agent data
- local absolute paths, machine-specific cwd values, and secret values must not be exported as canonical package data

## 9. PROJECT.md

`PROJECT.md` defines a lightweight project package.

### Example

```yaml
name: Q2 Launch
description: Ship the Q2 launch plan and supporting assets
owner: engineering-lead
```

### Semantics

- a project package groups related starter tasks and supporting markdown
- `owner` should reference an agent slug when there is a clear project owner
- a conventional `tasks/` subfolder should be discovered implicitly
- `includes` may contain `TASK.md` or supporting docs when explicit wiring is needed
- project packages are intended to seed planned work, not represent runtime task state

## 10. TASK.md

`TASK.md` is the external package name for a lightweight starter task.

### Example

```yaml
name: Monday Review
owner: engineering-lead
project: q2-launch
recurring: true
```

### Semantics

- body content is the task's canonical immutable `request`
- `owner` is required and references an agent slug inside the package
- `project` should reference a project slug when the task belongs to a `PROJECT.md`
- `recurring: true` marks the task as ongoing recurring work instead of a one-time starter task
- starter tasks are intentionally basic: title, immutable request, explicit
  agent owner, project linkage, and optional `recurring: true`
- tools may also support optional fields like `priority`, `labels`, or `metadata`, but they should not require them in the base package

### Recurring Tasks

- the base package only needs to say whether a task is recurring
- vendors may attach the actual schedule / trigger / runtime fidelity in a vendor extension such as `.paperclip.yaml`
- this keeps `TASK.md` portable while still allowing richer runtime systems to round-trip their own automation details

Example Paperclip extension:

```yaml
routines:
  monday-review:
    triggers:
      - kind: schedule
        cronExpression: "0 9 * * 1"
        timezone: America/Chicago
```

- vendors should ignore unknown recurring-task extensions they do not understand

## 11. Source References

A package may point to upstream content instead of vendoring it.

### Source object

```yaml
sources:
  - kind: github-file
    repo: owner/repo
    path: path/to/file.md
    commit: 0123456789abcdef0123456789abcdef01234567
    blob: abcdef0123456789abcdef0123456789abcdef01
    sha256: 3b7e...9a
    url: https://github.com/owner/repo/blob/0123456789abcdef0123456789abcdef01234567/path/to/file.md
    rawUrl: https://raw.githubusercontent.com/owner/repo/0123456789abcdef0123456789abcdef01234567/path/to/file.md
    attribution: Owner Name
    license: MIT
    usage: referenced
```

### Supported kinds

- `local-file`
- `local-dir`
- `github-file`
- `github-dir`
- `url`

### Usage modes

- `vendored`: bytes are included in the package
- `referenced`: package points to upstream immutable content
- `mirrored`: bytes are cached locally but upstream attribution remains canonical

### Rules

- `commit` is required for `github-file` and `github-dir` in strict mode
- `sha256` is strongly recommended and should be verified on fetch
- branch-only refs may be allowed in development mode but must warn
- exporters should default to `referenced` for third-party content unless redistribution is clearly allowed

## 12. Resolution Rules

Given a package root, an importer resolves in this order:

1. local relative paths
2. local absolute paths if explicitly allowed by the importing tool
3. pinned GitHub refs
4. generic URLs

For pinned GitHub refs:

1. resolve `repo + commit + path`
2. fetch content
3. verify `sha256` if present
4. verify `blob` if present
5. fail closed on mismatch

An importer must surface:

- missing files
- hash mismatches
- missing licenses
- referenced upstream content that requires network fetch
- executable content in scripts

## 13. Import Graph

A package importer should build a graph from:

- `COMPANY.md`
- `TEAM.md`
- `AGENTS.md`
- `PROJECT.md`
- `TASK.md`
- local and external refs

Suggested import UI behavior:

- render graph as a tree
- checkbox at entity level, not raw file level
- selecting an agent auto-selects its required documents
- selecting a team auto-selects its subtree
- selecting a project auto-selects its included tasks
- selecting a recurring task should make it clear that the import target is a routine / automation, not a one-time task
- selecting referenced third-party content shows attribution, license, and fetch policy

## 14. Vendor Extensions

Vendor-specific data should live outside the base package shape.

For Paperclip, the preferred fidelity extension is:

```text
.paperclip.yaml
```

Example uses:

- ACPX-selected adapter revision and generic configuration
- portable environment inputs and defaults
- runtime settings
- permissions
- budgets
- approval policies
- task Paperclip-only metadata

Rules:

- the base package must remain readable without the extension
- tools that do not understand a vendor extension should ignore it
- Paperclip tools may emit the vendor extension by default as a sidecar while keeping the base markdown clean

Suggested Paperclip shape:

```yaml
schema: paperclip/v1
agents:
  builder:
    adapterRevision:
      sourceRevisionId: 00000000-0000-4000-8000-000000000001
      adapterType: codex
      adapterConfig: {}
      runtimeConfig: {}
    inputs:
      env:
        EXAMPLE_API_KEY:
          kind: secret
          requirement: optional
          default: ""
        GH_TOKEN:
          kind: secret
          requirement: optional
    permissionGrants:
      - permissionKey: agents:configure
        scope: null
routines:
  monday-review:
    triggers:
      - kind: schedule
        cronExpression: "0 9 * * 1"
        timezone: America/Chicago
```

Additional rules for Paperclip exporters:

- never export an agent role, Paperclip prompt/instruction bundle,
  conversational memory, provider-session handle, or implicit/default
  permission
- do not export provider-specific secret bindings such as `secretId`, `version`, or `type: secret_ref`
- export env inputs as portable declarations with `required` or `optional` semantics and optional defaults
- reject provider launch commands and absolute `PATH` overrides; ACPX owns launch resolution
- omit empty and default-valued Paperclip fields when possible

## 15. Export Rules

A compliant exporter should:

- emit markdown roots and relative folder layout
- omit machine-local ids and timestamps
- omit secret values
- omit machine-specific paths
- preserve immutable task requests, explicit owners, and recurring
  declarations when exporting `TASK.md`
- omit empty/default fields
- default to the vendor-neutral base package
- Paperclip exporters should emit `.paperclip.yaml` as a sidecar by default
- preserve attribution and source references
- prefer `referenced` over silent vendoring for third-party content

## 16. Licensing And Attribution

A compliant tool must:

- preserve `license` and `attribution` metadata when importing and exporting
- distinguish vendored vs referenced content
- not silently inline referenced third-party content during export
- surface missing license metadata as a warning
- surface restrictive or unknown licenses before install/import if content is vendored or mirrored

## 17. Optional Lock File

Authoring does not require a lock file.

Tools may generate an optional lock file such as:

```text
company-package.lock.json
```

Purpose:

- cache resolved refs
- record final hashes
- support reproducible installs

Rules:

- lock files are optional
- lock files are generated artifacts, not canonical authoring input
- the markdown package remains the source of truth

## 18. Paperclip Mapping

Paperclip can map this spec to its runtime model like this:

- base package:
  - `COMPANY.md` -> company metadata
  - `TEAM.md` -> importable org subtree
  - `AGENTS.md` -> agent identity and direct reporting edge
  - `PROJECT.md` -> starter project definition
  - `TASK.md` -> starter task definition with immutable request and explicit
    agent owner, or recurring task template when `recurring: true`
  - `sources[]` -> provenance and pinned upstream refs
- Paperclip extension:
  - `.paperclip.yaml` -> adapter config, runtime config, env input declarations,
    exact permission grants, budgets, routine triggers, and other
    Paperclip-specific fidelity

Inline Paperclip-only metadata that must live inside a shared markdown file should use:

- `metadata.paperclip`

That keeps the base format broader than Paperclip.

This specification itself remains vendor-neutral and intended for any agent-company runtime, not only Paperclip.

## 19. Cutover

Paperclip should cut over to this markdown-first package model as the primary portability format.

`paperclip.manifest.json` does not need to be preserved as a compatibility requirement for the future package system.

For Paperclip, this should be treated as a hard cutover in product direction rather than a long-lived dual-format strategy.

## 20. Minimal Example

```text
lean-dev-shop/
├── COMPANY.md
├── agents/
│   ├── operations/AGENTS.md
│   └── engineering-lead/AGENTS.md
├── projects/
│   └── q2-launch/
│       ├── PROJECT.md
│       └── tasks/
│           └── monday-review/
│               └── TASK.md
├── teams/
│   └── engineering/TEAM.md
└── tasks/
    └── weekly-review/TASK.md
```

Optional:

```text
.paperclip.yaml
```

**Recommendation**
This is the direction I would take:

- make this the human-facing spec
- make `companies.sh` a discovery layer for repos implementing this spec, not a publishing authority
