#!/usr/bin/env node
/**
 * check-pr-linked-ticket.mjs
 * Checks that a PR body either links an existing ticket/PR or inlines a
 * work-description-shaped description. Respects conventional commit prefixes —
 * skips check for docs/chore/build/ci/style/test/revert prefixed PRs.
 *
 * Exports:
 *   checkLinkedTicket(prBody, prTitle) → { passed, failures }
 *   hasInlineWorkDescription(prBody) → boolean
 */
import { fileURLToPath } from 'node:url';

const TICKET_PATTERNS = [
  /(?:fixes|closes|resolves|refs)\s+#\d+/i,
  /(?<!\w)#\d+/,
];

// Prefixes where neither a linked ticket nor an inline description is required
const SKIP_TICKET_PREFIXES = ['docs', 'chore', 'build', 'ci', 'style', 'test', 'revert'];

// Minimum number of template fields the PR body must match to count as an
// inline work description.
const INLINE_DESCRIPTION_MIN_FIELDS = 3;

// Per-template field labels. Each field is an array of accepted variants; the
// field counts as "present" if any variant appears as a markdown heading
// (`## Label`) or as a bolded/plain label on its own line (`**Label**` /
// `Label:`). Matching is case-insensitive.
const TEMPLATE_FIELDS = {
  bug: [
    ['What happened', 'What happened?'],
    ['Expected behavior', 'Expected behaviour'],
    ['Steps to reproduce', 'Reproduction steps', 'Repro steps'],
    ['Paperclip version', 'Paperclip version or commit', 'Version or commit', 'Version/commit'],
    ['Exposure and bind'],
  ],
  feature: [
    ['Problem or motivation', 'Problem', 'Motivation'],
    ['Proposed solution', 'Solution'],
    ['Alternatives considered', 'Alternatives'],
    ['Roadmap alignment', 'Roadmap'],
  ],
  adapter: [
    ['Agent or provider', 'Agent', 'Provider', 'Adapter'],
    ["Why this adapter is useful", "Why it's useful", 'Why useful', 'Use case'],
    ['How the agent is invoked', 'How it is invoked', "How it's invoked", 'Invocation'],
  ],
};

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countMatchedFields(body, fieldSet) {
  let matched = 0;
  for (const variants of fieldSet) {
    const hasMatch = variants.some(label => {
      const esc = escapeRegExp(label);
      // Accept markdown headings or bolded/plain labels on their own line.
      // Examples: "## What happened?", "**Expected behavior**", "Problem:".
      const pattern = new RegExp(
        `^\\s*(?:#{1,6}\\s+|\\*\\*\\s*|__\\s*)?${esc}(?:\\s*[:?])?(?:\\s*\\*\\*|\\s*__)?\\s*$`,
        'im'
      );
      return pattern.test(body);
    });
    if (hasMatch) matched += 1;
  }
  return matched;
}

export function hasInlineWorkDescription(body) {
  if (!body || !body.trim()) return false;
  for (const fieldSet of Object.values(TEMPLATE_FIELDS)) {
    if (countMatchedFields(body, fieldSet) >= INLINE_DESCRIPTION_MIN_FIELDS) {
      return true;
    }
  }
  return false;
}

function parsePrefix(title) {
  if (!title) return null;
  const match = title.match(/^([a-z]+)(?:\([^)]*\))?:/);
  return match ? match[1].toLowerCase() : null;
}

export function checkLinkedTicket(body, prTitle = '') {
  const prefix = parsePrefix(prTitle);

  if (prefix && SKIP_TICKET_PREFIXES.includes(prefix)) {
    return { passed: true, failures: [] };
  }

  if (!body || !body.trim()) {
    return { passed: false, failures: ['PR body is empty — please fill out the PR template'] };
  }

  const linked = TICKET_PATTERNS.some(p => p.test(body));
  const inlined = hasInlineWorkDescription(body);
  const passed = linked || inlined;

  return {
    passed,
    failures: passed ? [] : [
      'No linked ticket or inline work description found — either tag an existing ticket ' +
      'with `Fixes #NNN` / `Closes #NNN` / `Refs #NNN`, or describe the underlying work ' +
      'inline in the PR body using the bug, feature, or adapter fields in the PR template. ' +
      'See CONTRIBUTING.md → "Link Tickets or Describe Them In-PR".',
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const body = process.env.PR_BODY ?? '';
  const title = process.env.PR_TITLE ?? '';
  const result = checkLinkedTicket(body, title);
  console.log(JSON.stringify(result));
  process.exit(result.passed ? 0 : 1);
}
