---
name: Product Engineering
description: Bundled engineering team that pairs an engineering lead with a senior coder and a QA engineer for implementation and verification work.
schema: agentcompanies/v1
slug: product-engineering
category: software-development
key: paperclipai/bundled/software-development/product-engineering
manager: agents/engineering-lead/AGENTS.md
includes:
  - agents/senior-coder/AGENTS.md
  - agents/qa/AGENTS.md
  - projects/product-engineering/PROJECT.md
defaultInstall: false
recommendedForCompanyTypes:
  - software
  - startup
  - product
tags:
  - engineering
  - delivery
  - qa
  - code-review
requiredSkills:
  - paperclipai/bundled/software-development/github-pr-workflow
  - paperclipai/bundled/quality/qa-acceptance
  - paperclipai/bundled/docs/doc-maintenance
---

# Product Engineering

An optional engineering pod for companies that want a small implementation and verification reporting tree. Install it under an explicitly selected existing manager or as a standalone package.

## Contents

- `Engineering Lead` — ordinary team root identity.
- `senior-coder` — primary implementer. Picks up engineering issues, ships PRs, and asks QA for verification.
- `QA` — verifies fixes and captures acceptance evidence.
- `product-engineering` project — the rolling backlog this pod works against.
- `weekly-engineering-sync` routine — recurring Engineering Lead-owned issue definition.

## Skill rationale

- `github-pr-workflow` keeps logical commits, branch hygiene, and merge discipline consistent across the pod.
- `qa-acceptance` gives QA a structured pass/fail format coders can act on.
- `doc-maintenance` keeps docs aligned with shipped changes — install if the company has any user-facing docs surface.

## Migration notes

Agent files contain identity frontmatter only. The operator must explicitly select each imported agent's adapter and provider target configuration; the catalog supplies neither a default nor a fallback.
