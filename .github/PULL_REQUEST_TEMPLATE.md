## Thinking Path

<!--
  Required. Trace your reasoning from the top of the project down to this
  specific change. Start with what Paperclip is, then narrow through the
  subsystem, the problem, and why this PR exists. Use blockquote style.
  Aim for 5–8 steps. See CONTRIBUTING.md for full examples.
-->

> - Paperclip is the open source app people use to manage AI agents for work
> - [Which subsystem or capability is involved]
> - [What problem or gap exists]
> - [Why it needs to be addressed]
> - This pull request ...
> - The benefit is ...

## Linked Tickets or Work Description

<!--
  Required. Pick ONE of the following two paths:

  (A) Ticket exists — tag each linked ticket with `Fixes: #123`, `Closes #123`,
      or `Refs #123`. Include duplicates and closely related tasks too.

  Only reference PUBLIC GitHub tickets/PRs here. Do NOT paste internal,
  instance-local Paperclip references — task ids like PAPA-123 / PAP-224,
  /PAP/tasks/... or agent://... links, or localhost/tailnet URLs. Other
  contributors cannot open them. See CONTRIBUTING.md → "No Internal Task
  References".

  (B) No ticket exists — describe the underlying problem here using the
      relevant field set:
        • Bug: what happened, expected behavior, reproduction, version, deployment
        • Feature: problem, proposed solution, alternatives, roadmap alignment
        • Adapter: agent/provider, why it is useful, how it is invoked

  See CONTRIBUTING.md → "Link Tickets or Describe Them In-PR".
-->

-

## What Changed

<!-- Bullet list of concrete changes. One bullet per logical unit. -->

-

## Verification

<!--
  How can a reviewer confirm this works? Include test commands, manual
  steps, or both.
-->

-

## Risks

<!--
  What could go wrong? Mention migration safety, breaking changes,
  behavioral shifts, or "Low risk" if genuinely minor.
-->

-

> For core feature work, check [`ROADMAP.md`](https://github.com/paperclipai/paperclip/blob/master/ROADMAP.md) first and discuss it in `#dev` before opening the PR. Feature PRs that overlap with planned core work may need to be redirected — check the roadmap first. See `CONTRIBUTING.md`.

## Model Used

<!--
  Required. Specify which AI model was used to produce or assist with
  this change. Be as descriptive as possible — include:
    • Provider and model name (e.g., Claude, GPT, Gemini, Codex)
    • Exact model ID or version (e.g., claude-opus-4-6, gpt-4-turbo-2024-04-09)
    • Context window size if relevant (e.g., 1M context)
    • Reasoning/thinking mode if applicable (e.g., extended thinking, chain-of-thought)
    • Any other relevant capability details (e.g., tool use, code execution)
  If no AI model was used, write "None — human-authored".
-->

-

## Checklist

- [ ] I have included a thinking path that traces from project context to this change
- [ ] I have specified the model used (with version and capability details)
- [ ] I have checked ROADMAP.md and confirmed this PR does not duplicate planned core work
- [ ] I have searched GitHub for duplicate or related PRs and linked them above
- [ ] I have either (a) linked existing tickets with `Fixes: #` / `Closes #` / `Refs #` OR (b) described the work in-PR using the relevant field set
- [ ] I have not referenced internal/instance-local Paperclip tasks or links (only public GitHub `#NNN` references or PR URLs)
- [ ] My branch name describes the change (e.g. `docs/...`, `fix/...`) and contains no internal Paperclip task ID or instance-derived details
- [ ] I have run tests locally and they pass
- [ ] I have added or updated tests where applicable
- [ ] I have updated relevant documentation to reflect my changes
- [ ] I have considered and documented any risks above
- [ ] All Paperclip CI gates are green
- [ ] Greptile is 5/5 with no open P2s, recommendations, or follow-ups
- [ ] I will address all Greptile and reviewer comments before requesting merge
