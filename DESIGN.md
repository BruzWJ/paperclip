# Paperclip Design Principles

**Status:** v0.4 — anchor document for a shadcn-centered, Kibo- and AI Elements-backed board UI. Governs structure, not brand. Shadcn, Kibo, and AI Elements registry sources provide the default component appearance; Paperclip-owned adapters and screens express product semantics without forking their styling or behavior.

Changes from v0.2: token layer location corrected to the repo's real source (`apps/ui/src/index.css`); existing token tiers inventoried; snapshot-coverage scope bounded for Run 1; the canonical task terminology cutover moved out of the zero-visual-change run.

## What this document is for

Agents and humans modifying `apps/ui/` treat this file as the source of truth for design decisions. Storybook is the verification surface — it documents the system; it does not define it. If a change conflicts with this document, change this document first (with review) or change the code.

## Product stance

Paperclip is an operational control plane: org charts, tasks, heartbeat runs, budgets, approvals, audit logs. The user is an operator scanning state and making decisions. Every screen should answer, in order: _what is happening, does it need me, what do I do about it._ Density in service of scanning beats whitespace in service of aesthetics — but density comes from information, never from chrome.

## The token layer (where visual values live)

The single Paperclip-owned token source is **`apps/ui/src/index.css`** (Tailwind v4; there is no tailwind config file — tokens are CSS custom properties consumed via `@theme`). Do NOT create a parallel token source such as `apps/ui/src/tokens/` — that would produce two sources of truth. If index.css grows unwieldy, extracted values may live in a `tokens.css` **imported by index.css** so the pipeline still has one root.

`apps/ui/src/components/ui/**`, `apps/ui/src/components/kibo-ui/**`, and `apps/ui/src/components/ai-elements/**` are registry-owned source. Keep them aligned with the official shadcn, Kibo, and AI Elements registries and update them through their CLIs. The only Kibo exceptions are generic compatibility corrections and opt-in hooks documented in `apps/ui/src/components/kibo-ui/README.md`; upstream defaults must remain unchanged, and project-specific behavior belongs in gated adapters outside those directories. Registry source may contain upstream literal utilities that are intentionally outside Paperclip's token and hand-authored file-size gates; editing those values locally would create an unmaintainable fork.

Tailwind v4 gotcha: `@theme inline` bakes literal values at build time. Any token that must be runtime-tunable (theme editor, dark mode overrides) must be defined in a NON-inline block.

## UI source ownership

- `apps/ui/src/components/` contains neutral, reusable UI: the protected registry sources above and Paperclip-owned generic patterns. Paperclip-owned components must not depend on domain state or a route.
- `apps/ui/src/routes/` contains route entry modules and all route-owned Paperclip domain UI. Put a helper beside its direct route consumer; if several route branches share it, put it at their closest common route ancestor. Every non-route module must be in a file or directory whose basename starts with `-`, keeping it outside the generated route tree. Do not create a parallel feature or page layer.

Existing tiers already in index.css (~80+ tokens) — extraction maps to these on **exact value match** before minting anything new:

1. **Semantic tier** — shadcn core set: `--background`, `--foreground`, `--card`, `--primary`, `--secondary`, `--muted`, `--accent`, `--destructive`, `--border`, `--input`, `--ring`, `--sidebar-*`, `--chart-1..5` (OKLCH, light/dark overrides).
2. **Brand tier** — agent gradients `--agent-1a/1b..10a/10b` (fixed hex) and status hues `--status-task-*` / `--status-agent-*` (WCAG-tuned; see inline comments).
3. **Domain tier** — match-chip tokens `--chip-match-*`, annotation highlights `--paperclip-doc-annotation-highlight-*`, plus motion/typography tokens.

## Principles

1. **One way to say each thing.** One component per job. One Button, one Card, one Badge, one Table, one EmptyState. Variants are props, not new components. Before creating a component, prove no existing one covers the job.
2. **Tokens are the only source of visual values.** All color, spacing, radius, type size/weight, shadow, and motion values come from the token layer. No hex, no raw px, no ad-hoc Tailwind arbitrary values (`p-[13px]`) in components. If a needed value doesn't exist, add a token — don't inline it. Tailwind palette classes (`bg-red-500`, `text-zinc-400`, etc.) ARE hardcoded values in spirit: they name a literal color, not a semantic role. They are in-scope debt scheduled for a dedicated future run (Run 4, cluster-by-cluster mapping to semantic tokens per doc/design/DECISION-SHEET.md B2) and are not currently gated by check-token-gates. Exception (doc/design/DECISION-SHEET.md B1 user ruling): first-party intentional one-off decoration on demo/UX-lab surfaces stays inline and allowlisted rather than minted as singleton tokens.
3. **Spacing routes through tokens; the scale comes later.** During simplification, extract every spacing and radius value verbatim into tokens — do not normalize, round, or invent a scale. The final scale is a design decision made by a human after reviewing the token audit. Structural rules apply now: vertical rhythm within a container uses one gap value, not per-element margins, and siblings never carry both margin and gap.
4. **Hierarchy through structure, not decoration.** Prefer position, size, and weight over borders, backgrounds, and dividers. Every border, divider, and background fill must justify itself; when in doubt, remove it. A screen should survive the removal of one visual layer.
5. **Status is systematic.** States like running / paused / blocked / awaiting-approval / over-budget map to a single semantic status token set used identically everywhere (badge, row, chart, log). An operator learns the vocabulary once.
6. **Machine values look machine-made.** IDs, costs, token counts, timestamps, and log output use the monospace token and consistent formatting helpers. Never format these ad hoc per screen.
7. **Words are part of the system.** One name per concept across the entire UI — the canonical work-object term is _task_ in copy, labels, and empty states. Buttons name the action ("Approve hire," not "Submit"). Errors say what happened and what to do. Empty states say what to do first.
8. **Agent-modifiable by design.** The system must be changeable via instructions: single token source, lint rules that enforce it, and this document kept current. A correct change should be expressible as "edit tokens + run checks," not "visit 40 files."

## Enforcement (what "compliant" means for the extraction run)

- **Visual changes are explicit:** registry adoption may intentionally reset a surface to the default shadcn, Kibo, or AI Elements appearance. Domain behavior and accessibility remain verified with focused tests, and intentional visual changes are reviewed in Storybook.
- **Baseline scope for Run 1:** the shared primitives in `apps/ui/src/components/ui/` (each gets a story if missing — there are only ~24) plus the ~46 existing stories under `apps/ui/storybook/stories/`. Do NOT attempt a story for every feature component (~277) in this run; full coverage is a later effort.
- Mechanical rewrites (value extraction, renames) are done via committed codemod scripts in `scripts/`, not hand-edits — reviewable once, repeatable forever.
- Token layer is the single source (`apps/ui/src/index.css`, per above) consumed via CSS variables / Tailwind theme — never values copied into components.
- Lint/grep gates pass: zero hardcoded hex values, zero arbitrary spacing values, zero raw font-size declarations in `apps/ui/src/components/**` and `apps/ui/src/routes/**` outside registry-owned source, the token layer, and a documented allowlist (third-party overrides, intentional opt-outs commented inline).
- `pnpm build`, `pnpm typecheck`, and `pnpm build-storybook` pass.
- AGENTS.md links here and states the token-only rule.

Aspirational (NOT gating this run): no duplicate components; every component has exactly one story covering its variants; all UI copy says "task".

## Refactor scope

Component consolidation, registry-backed composed components, and their required client dependencies are allowed when they remove duplicated UI contracts. Preserve product behavior and server contracts; default shadcn/Kibo styling does not need a Paperclip-specific compatibility layer.

## Prior art (read before auditing)

See `doc/design/PRIOR-ART.md` — a previous audit pass (PAP-280/283/284, on the `PAP-282-playground` branch, NOT on master) found that of ~220 hardcoded drift sites, only 6 were exact-value-mappable to existing tokens; expect the verbatim extraction to mint many new tokens that the human scale-collapse step later merges. It also drafted usage rules (radius tiers, CTA tiers, named type styles) that are good candidates for the post-audit scale decision.

How-to guide for day-to-day UI changes: see `doc/design/CHANGING-THE-UI.md`.
