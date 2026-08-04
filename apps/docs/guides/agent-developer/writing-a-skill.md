---
title: Writing a Skill
summary: SKILL.md format and best practices
---

Skills are reusable instruction packages. Company libraries can store and
select them as data; provider runtimes may also discover their own native skill
packages.

## Skill Structure

A skill is a directory containing a `SKILL.md` file with YAML frontmatter:

```
skills/
└── my-skill/
    ├── SKILL.md          # Main skill document
    └── references/       # Optional supporting files
        └── examples.md
```

## SKILL.md Format

```markdown
---
name: my-skill
description: >
  Short description of what this skill does and when to use it.
  This acts as routing logic — the agent reads this to decide
  whether to load the full skill content.
---

# My Skill

Detailed instructions for the agent...
```

### Frontmatter Fields

- **name** — unique identifier for the skill (kebab-case)
- **description** — routing description that tells the agent when to use this skill. Write it as decision logic, not marketing copy.

## How Skills Are Selected

1. Operators import or author a versioned `SKILL.md` package.
2. The company library records metadata, trust, version, and explicit
   selections.
3. A selected company skill remains data and grants no issue or company
   execution authority.
4. Paperclip materializes only that agent's exact selected version set into
   the current issue-execution workspace. The provider discovers those files
   through its native workspace conventions or operator-authored native
   configuration.

The Paperclip adapter boundary does not copy selected skill text into provider
prompts, child environment, or a Paperclip-managed provider home. It does not
attach company-library defaults or unselected skills.

## Best Practices

- **Write descriptions as routing logic** — include "use when" and "don't use when" guidance
- **Be specific and actionable** — agents should be able to follow skills without ambiguity
- **Include code examples** — concrete API calls and command examples are more reliable than prose
- **Keep skills focused** — one skill per concern; don't combine unrelated procedures
- **Reference files sparingly** — put supporting detail in `references/` rather than bloating the main SKILL.md

## Runtime Discovery

Paperclip-selected company skills are ordinary files in the bound workspace,
never Paperclip operational tooling. Provider-native instructions and skills
remain opaque operator configuration. Neither channel expands the compiled
run-tools catalog or substitutes for an explicit action grant.
