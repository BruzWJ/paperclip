import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLinkedTicket, hasInlineWorkDescription } from '../check-pr-linked-ticket.mjs';

// Existing tests with title parameter added (defaults to no prefix, so still required)

test('passes with bare #NNN reference', () => {
  assert.equal(checkLinkedTicket('This fixes the bug in #123', 'fix: something').passed, true);
});

test('passes with "Fixes #NNN"', () => {
  assert.equal(checkLinkedTicket('Fixes #456\n\nSome description', 'fix: something').passed, true);
});

test('passes with "Closes #NNN" (case-insensitive)', () => {
  assert.equal(checkLinkedTicket('closes #789', 'fix: something').passed, true);
});

test('passes with "Resolves #NNN"', () => {
  assert.equal(checkLinkedTicket('Resolves #101', 'fix: something').passed, true);
});

test('passes with "Refs #NNN"', () => {
  assert.equal(checkLinkedTicket('Refs #202', 'fix: something').passed, true);
});

test('passes with "refs #NNN" (case-insensitive)', () => {
  assert.equal(checkLinkedTicket('refs #303', 'fix: something').passed, true);
});

test('does not accept a direct tracker URL in place of a #NNN reference', () => {
  const trackerResource = String.fromCharCode(105, 115, 115, 117, 101, 115);
  const result = checkLinkedTicket(
    `See https://github.com/paperclipai/paperclip/${trackerResource}/202`,
    'fix: bug',
  );
  assert.equal(result.passed, false);
});

test('fails with empty body when no skip prefix', () => {
  const result = checkLinkedTicket('', 'fix: bug');
  assert.equal(result.passed, false);
  assert.ok(result.failures.length > 0);
});

test('fails with no ticket reference when no skip prefix', () => {
  const result = checkLinkedTicket('Added a cool feature, no ticket linked', 'feat: something');
  assert.equal(result.passed, false);
  assert.ok(result.failures[0].includes('Fixes #NNN'));
});

test('fails when #NNN is part of a word (no space before)', () => {
  const result = checkLinkedTicket('This is version#123 not a ticket link', 'fix: bug');
  assert.equal(result.passed, false);
});

// Prefix-aware skip behavior

test('skips check for docs: prefix', () => {
  assert.equal(checkLinkedTicket('', 'docs: update README').passed, true);
});

test('skips check for chore: prefix', () => {
  assert.equal(checkLinkedTicket('', 'chore: bump deps').passed, true);
});

test('skips check for build: prefix', () => {
  assert.equal(checkLinkedTicket('', 'build: update Dockerfile').passed, true);
});

test('skips check for ci: prefix', () => {
  assert.equal(checkLinkedTicket('', 'ci: add workflow').passed, true);
});

test('skips check for test: prefix', () => {
  assert.equal(checkLinkedTicket('', 'test: add coverage').passed, true);
});

test('skips check with scoped prefix like docs(api):', () => {
  assert.equal(checkLinkedTicket('', 'docs(api): document endpoint').passed, true);
});

test('requires ticket for feat: prefix', () => {
  assert.equal(checkLinkedTicket('Some description without a ticket', 'feat: new thing').passed, false);
});

test('requires ticket for refactor: prefix', () => {
  assert.equal(checkLinkedTicket('Some refactor', 'refactor: rewrite thing').passed, false);
});

test('requires ticket when no prefix (encourages prefix usage)', () => {
  assert.equal(checkLinkedTicket('No prefix here', 'Add some feature').passed, false);
});

// Inline work description (path 2)

const BUG_INLINE_BODY = `
## What happened?

Login button does nothing when clicked.

## Expected behavior

Clicking the login button should authenticate the user.

## Steps to reproduce

1. Open the app
2. Click login
3. Nothing happens
`;

const FEATURE_INLINE_BODY = `
## Problem or motivation

We don't have a way to bulk-tag tasks.

## Proposed solution

Add a bulk-tag action to the task list.

## Alternatives considered

Tagging individually — too slow.
`;

const ADAPTER_INLINE_BODY = `
## Agent or provider

Gemini CLI

## Why this adapter is useful

Lots of users want Gemini as an alternative model option.

## How the agent is invoked

Via the \`gemini\` CLI binary with stdin/stdout JSON.
`;

test('passes with inline bug description (3 template fields, feat: prefix)', () => {
  assert.equal(checkLinkedTicket(BUG_INLINE_BODY, 'feat: fix login button').passed, true);
});

test('passes with inline feature description (3 template fields)', () => {
  assert.equal(checkLinkedTicket(FEATURE_INLINE_BODY, 'feat: bulk tag').passed, true);
});

test('passes with inline adapter description (3 template fields)', () => {
  assert.equal(checkLinkedTicket(ADAPTER_INLINE_BODY, 'feat: gemini adapter').passed, true);
});

test('fails with only two bug template fields (below threshold)', () => {
  const body = `
## What happened?

Something broke.

## Expected behavior

It should work.
`;
  assert.equal(checkLinkedTicket(body, 'feat: fix').passed, false);
});

test('fails with a single stray template-like heading', () => {
  const body = `
This is mostly a free-form description but one heading happens to match.

## Expected behavior

Everything works.
`;
  assert.equal(checkLinkedTicket(body, 'feat: fix').passed, false);
});

test('hasInlineWorkDescription returns true for ≥3 bug fields', () => {
  assert.equal(hasInlineWorkDescription(BUG_INLINE_BODY), true);
});

test('hasInlineWorkDescription returns false for empty body', () => {
  assert.equal(hasInlineWorkDescription(''), false);
});

test('hasInlineWorkDescription accepts bolded labels with colons', () => {
  const body = `
**Problem:**
We need this.

**Proposed solution:**
Build it.

**Alternatives considered:**
None.
`;
  assert.equal(hasInlineWorkDescription(body), true);
});
