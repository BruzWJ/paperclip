---
name: Content Machine
description: Optional content operations team with a lead agent, a recurring review issue, and a vendored local content planning skill.
schema: agentcompanies/v1
slug: content-machine
category: content
key: paperclipai/optional/content/content-machine
manager: agents/content-lead/AGENTS.md
includes:
  - skills/content-calendar/SKILL.md
  - projects/content-operations/PROJECT.md
defaultInstall: false
recommendedForCompanyTypes:
  - agency
  - marketing
tags:
  - content
  - marketing
  - routines
requiredSkills:
  - content-calendar
---

# Content Machine

This optional fixture proves local skill resolution and recurring issue inventory without introducing external source risk.

## Contents

- `ContentLead` — content operations lead responsible for calendar planning and publication workflow triage.
- `content-operations` project — rolling backlog for editorial planning and content production review.
- `weekly-content-review` routine — recurring content lead check-in to choose next posts and surface blocked publication work.

The agent file contains identity frontmatter only. Installing the local skill does not select it for an agent; company-skill selection remains an explicit board configuration.
