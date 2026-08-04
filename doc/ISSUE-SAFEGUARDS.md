# Issue safeguards

An issue safeguard is a board-enabled system check on one issue and its visible
descendants. When the watched subtree has no live execution path, Paperclip
persists a canonical `system_nudge` execution reference for the watched issue.
The ordinary issue runtime delivers that reference to the issue's current
owner.

The safeguard does not select or run a separate watchdog agent. It has no
custom prompt, generated review issue, special mutation scope, or authority
outside the ordinary issue contract.

## Configuration

Each issue can have one safeguard row. The board controls only whether it is
enabled:

```http
GET    /api/issues/:issueId/watchdog
PUT    /api/issues/:issueId/watchdog   {}
DELETE /api/issues/:issueId/watchdog
```

- `PUT` creates the row or changes its status to `active`.
- `DELETE` changes an active row to `disabled`.
- `GET` returns the active row or `null`.
- Mutations require board access. Agent REST callers receive no special
  safeguard authority.

The issue properties panel exposes the same **System safeguard** enable/disable
control when the issue-safeguards experimental setting is enabled. New-issue
creation does not configure a safeguard.

## Migration persistence

The canonical Drizzle schema owns `issue_watchdogs`, and ordinary generated
migrations create or evolve that table, its company/issue references, and its
indexes. Migrations create no issues or safeguard rows.

The schema has no separate generated-issue kind, relationship, seed, or
producer for watchdog-review or productivity-review issues. A freshly
provisioned database therefore starts with none of those generated issues, and
the runtime needs no compatibility filter to hide them. Safeguard action is
represented only by the canonical safeguard row, its `system_nudge` execution
reference, and ordinary issue/runtime records.

## Classifier

For every active safeguard, the server:

1. Loads the watched issue and its visible descendant tree.
2. Treats any queued, running, or scheduled-retry run as a live path.
3. Treats a pending persisted dispatch reference as a live path.
4. Applies a short first-run grace window to a newly created non-terminal issue
   that has never completed a run. This avoids classifying the create/dispatch
   commit race as stopped.
5. If no live path exists, computes a stable SHA-256 fingerprint from the
   stopped leaves, including their statuses, blockers, pending approvals, and
   latest material timestamps.

The classifier evaluates the canonical issue tree directly. It contains no
origin-kind exclusion or compatibility filter for generated watchdog-review or
productivity-review issues because generation zero cannot create them.

## Persisted nudge

When a stopped fingerprint differs from `lastObservedFingerprint`, the service
claims it with a compare-and-swap update and calls the canonical ordinary issue
runtime:

```text
sourceKind:     system_nudge
sourceRecordId: safeguard row id
idempotencyKey: safeguard row id + stopped fingerprint
issueId:        watched issue id
```

The runtime resolves the watched issue's current canonical owner and persists
the execution reference before dispatch. There is no direct wake payload and
no configured safeguard owner.

If dispatch notification fails after the reference was admitted, the service
recovers the persisted reference and keeps the evidence claim. If no admitted
reference exists, it restores the previous fingerprint so a later reconcile
can retry. A successful nudge records the reference id, fingerprint, stopped
leaves, trigger time, and trigger count in system activity.

An unchanged stopped fingerprint is `already_nudged`; it does not create a
second reference. A changed subtree produces a new fingerprint and may produce
a new nudge.

## Reconciliation

Reconciliation runs for active safeguards during the server's normal
maintenance cycle and after issue mutations that can change a watched issue or
one of its ancestors. Enabling a safeguard evaluates it immediately. Disabling
it remains a board control and prevents future evaluations.

Issue safeguards are separate from the output-silence watchdog for an already
running provider process. See
[`doc/execution-semantics.md`](execution-semantics.md) for run-liveness
semantics.

## Reference

| Topic | File |
| --- | --- |
| Database schema | `packages/db/schema/issue_watchdogs.ts` |
| Generated migrations | ordered `packages/db/migrations/*.sql` files emitted by `pnpm db:generate` |
| Classifier and nudge service | `apps/server/src/services/issue-watchdogs.ts` |
| HTTP routes | `apps/server/src/routes/issues.ts` |
| Shared API validator | `packages/shared/src/validators/issue.ts` |
| Board UI | `apps/ui/src/components/issue-properties/IssueProperties.tsx` |
