---
name: Core Team
description: Default leadership and engineering team with an ordinary company lead, engineering lead, QA engineer, starter project, and priority-review routine.
schema: agentcompanies/v1
slug: core-exec-team
category: company-defaults
key: paperclipai/bundled/company-defaults/core-exec-team
manager: agents/company-lead/AGENTS.md
includes:
  - agents/engineering-lead/AGENTS.md
  - agents/qa/AGENTS.md
  - projects/first-project/PROJECT.md
defaultInstall: true
recommendedForCompanyTypes:
  - startup
  - software
  - generalist
tags:
  - default
  - leadership
  - engineering
  - qa
requiredSkills:
  - paperclipai/bundled/software-development/github-pr-workflow
  - paperclipai/bundled/quality/qa-acceptance
---

# Core Team

The Core Team is the bundled default install for a new company. It provides a small, ordinary reporting tree and a starter project without granting any identity special authority.

## Contents

- `Company Lead` — an ordinary root agent identity.
- `Engineering Lead` — an ordinary engineering agent that reports to Company Lead.
- `QA` — an ordinary verification agent that reports to Engineering Lead.
- `first-project` — starter project owned by Engineering Lead.
- `priority-review` — recurring issue definition for reviewing priorities and recording the next action.

## Migration notes

Agent files contain identity frontmatter only. The catalog does not author provider instructions, choose an adapter, infer a provider target, or grant authority from an agent's display name or position.
