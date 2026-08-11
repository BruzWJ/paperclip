# Task Documents Plan

> Historical only. References to provider-exposed Paperclip operational skills and generic agent REST access were retired by the task-execution cutover; they have no runtime reader or supported installation path.

Status: Draft  
Owner: Backend + UI + Agent Protocol  
Date: 2026-03-13  
Primary task: `PAP-448`

## Summary

Add first-class **documents** to Paperclip as editable, revisioned, company-scoped text artifacts that can be linked to tasks.

The first required convention is a document with key `plan`.

This solves the immediate workflow problem in `PAP-448`:

- plans should stop living inside task descriptions as `<plan>` blocks
- agents and board users should be able to create/update task documents directly
- `GET /api/tasks/:id` should include the full `plan` document and expose the other available documents
- task detail should render documents under the description

This should be built as the **text-document slice** of the broader artifact system, not as a replacement for attachments/assets.

## Recommended Product Shape

### Documents vs attachments vs artifacts

- **Documents**: editable text content with stable keys and revision history.
- **Attachments**: uploaded/generated opaque files backed by storage (`assets` + `task_attachments`).
- **Artifacts**: later umbrella/read-model that can unify documents, attachments, and previews.

Recommendation:

- implement **task documents now**
- keep existing attachments as-is
- defer full artifact unification until there is a second real consumer beyond task documents + attachments

This keeps `PAP-448` focused while still fitting the larger artifact direction.

## Goals

1. Give tasks first-class keyed documents, starting with `plan`.
2. Make documents editable by board users and same-company agents with task access.
3. Preserve change history with append-only revisions.
4. Make the `plan` document automatically available in the normal task fetch used by agents/heartbeats.
5. Replace the current `<plan>`-in-description convention in skills/docs.
6. Keep the design compatible with a future artifact/deliverables layer.

## Non-Goals

- full collaborative doc editing
- binary-file version history
- browser IDE or run-directory editor
- full artifact-system implementation in the same change
- generalized polymorphic relations for every entity type on day one

## Product Decisions

### 1. Keyed task documents

Each task can have multiple documents. Each document relation has a stable key:

- `plan`
- `design`
- `notes`
- `report`
- custom keys later

Key rules:

- unique per task, case-insensitive
- normalized to lowercase slug form
- machine-oriented and stable
- title is separate and user-facing

The `plan` key is conventional and reserved by Paperclip workflow/docs.

### 2. Text-first v1

V1 documents should be text-first, not arbitrary blobs.

Recommended supported formats:

- `markdown`
- `plain_text`
- `json`
- `html`

Recommendation:

- optimize UI for `markdown`
- allow raw editing for the others
- keep PDFs/images/CSVs/etc as attachments/artifacts, not editable documents

### 3. Revision model

Every document update creates a new immutable revision.

The current document row stores the latest snapshot for fast reads.

### 4. Concurrency model

Do not use silent last-write-wins.

Updates should include `baseRevisionId`:

- create: no base revision required
- update: `baseRevisionId` must match current latest revision
- mismatch: return `409 Conflict`

This is important because both board users and agents may edit the same document.

### 5. Task fetch behavior

`GET /api/tasks/:id` should include:

- full `planDocument` when a `plan` document exists
- `documentSummaries` for all linked documents

It should not inline every document body by default.

This keeps task fetches useful for agents without making every task payload unbounded.

### 6. Legacy `<plan>` compatibility

If a task has no `plan` document but its description contains a legacy `<plan>` block:

- expose that as a legacy read-only fallback in API/UI
- mark it as legacy/synthetic
- prefer a real `plan` document when both exist

Recommendation:

- do not auto-rewrite old task descriptions in the first rollout
- provide an explicit import/migrate path later

## Proposed Data Model

Recommendation: make documents first-class, but keep task linkage explicit via a join table.

This preserves foreign keys today and gives a clean path to future `project_documents` or `company_documents` tables later.

## Tables

### `documents`

Canonical text document record.

Suggested columns:

- `id`
- `company_id`
- `title`
- `format`
- `latest_body`
- `latest_revision_id`
- `latest_revision_number`
- `created_by_agent_id`
- `created_by_user_id`
- `updated_by_agent_id`
- `updated_by_user_id`
- `created_at`
- `updated_at`

### `document_revisions`

Append-only history.

Suggested columns:

- `id`
- `company_id`
- `document_id`
- `revision_number`
- `body`
- `change_summary`
- `created_by_agent_id`
- `created_by_user_id`
- `created_at`

Constraints:

- unique `(document_id, revision_number)`

### `task_documents`

Task relation + workflow key.

Suggested columns:

- `id`
- `company_id`
- `task_id`
- `document_id`
- `key`
- `created_at`
- `updated_at`

Constraints:

- unique `(company_id, task_id, key)`
- unique `(document_id)` to keep one task relation per document in v1

## Why not use `assets` for this?

Because `assets` solves blob storage, not:

- stable keyed semantics like `plan`
- inline text editing
- revision history
- optimistic concurrency
- cheap inclusion in `GET /tasks/:id`

Documents and attachments should remain separate primitives, then meet later in a deliverables/artifact read-model.

## Shared Types and API Contract

## New shared types

Add:

- `DocumentFormat`
- `TaskDocument`
- `TaskDocumentSummary`
- `DocumentRevision`

Recommended `TaskDocument` shape:

```ts
type DocumentFormat = "markdown" | "plain_text" | "json" | "html";

interface TaskDocument {
  id: string;
  companyId: string;
  taskId: string;
  key: string;
  title: string | null;
  format: DocumentFormat;
  body: string;
  latestRevisionId: string;
  latestRevisionNumber: number;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
```

Recommended `TaskDocumentSummary` shape:

```ts
interface TaskDocumentSummary {
  id: string;
  key: string;
  title: string | null;
  format: DocumentFormat;
  latestRevisionId: string;
  latestRevisionNumber: number;
  updatedAt: Date;
}
```

## Task type enrichment

Extend `Task` with:

```ts
interface Task {
  ...
  planDocument?: TaskDocument | null;
  documentSummaries?: TaskDocumentSummary[];
  legacyPlanDocument?: {
    key: "plan";
    body: string;
    source: "task_description";
  } | null;
}
```

This directly satisfies the `PAP-448` requirement for heartbeat/API task fetches.

## API endpoints

Recommended endpoints:

- `GET /api/tasks/:taskId/documents`
- `GET /api/tasks/:taskId/documents/:key`
- `PUT /api/tasks/:taskId/documents/:key`
- `GET /api/tasks/:taskId/documents/:key/revisions`
- `DELETE /api/tasks/:taskId/documents/:key` optionally board-only in v1

Recommended `PUT` body:

```ts
{
  title?: string | null;
  format: "markdown" | "plain_text" | "json" | "html";
  body: string;
  changeSummary?: string | null;
  baseRevisionId?: string | null;
}
```

Behavior:

- missing document + no `baseRevisionId`: create
- existing document + matching `baseRevisionId`: update
- existing document + stale `baseRevisionId`: `409`

## Authorization and invariants

- all document records are company-scoped
- task relation must belong to same company
- board access follows existing task access rules
- agent access follows existing same-company task access rules
- every mutation writes activity log entries

Recommended delete rule for v1:

- board can delete documents
- agents can create/update, but not delete

That keeps automated systems from removing canonical docs too easily.

## UI Plan

## Task detail

Add a new **Documents** section directly under the task description.

Recommended behavior:

- show `plan` first when present
- show other documents below it
- render a gist-like header:
  - key
  - title
  - last updated metadata
  - revision number
- support inline edit
- support create new document by key
- support revision history drawer or sheet

Recommended presentation order:

1. Description
2. Documents
3. Attachments
4. Comments / activity / sub-tasks

This matches the request that documents live under the description while still leaving attachments available.

## Editing UX

Recommendation:

- use markdown preview + raw edit toggle for markdown docs
- use raw textarea editor for non-markdown docs in v1
- show explicit save conflicts on `409`
- show a clear empty state: "No documents yet"

## Legacy plan rendering

If there is no stored `plan` document but legacy `<plan>` exists:

- show it in the Documents section
- mark it `Legacy plan from description`
- offer create/import in a later pass

## Agent Protocol and Skills

Update the Paperclip agent workflow so planning no longer edits the task description.

Required changes:

- update `skills/paperclip/SKILL.md`
- replace the `<plan>` instructions with document creation/update instructions
- document the new endpoints in `apps/docs/api/tasks.md`
- update any internal planning docs that still teach inline `<plan>` blocks

New rule:

- when asked to make a plan for a task, create or update the task document with key `plan`
- leave a comment that the plan document was created/updated
- do not mark the task done

## Relationship to the Artifact Plan

This work should explicitly feed the broader artifact/deliverables direction.

Recommendation:

- keep documents as their own primitive in this change
- add `document` to any future `ArtifactKind`
- later build a deliverables read-model that aggregates:
  - task documents
  - task attachments
  - preview URLs

The artifact proposal currently has no explicit `document` kind. It should.

Recommended future shape:

```ts
type ArtifactKind =
  | "document"
  | "attachment"
  | "preview"
  | "report_link";
```

## Implementation Phases

## Phase 1: Shared contract and schema

Files:

- `packages/db/schema/documents.ts`
- `packages/db/schema/document_revisions.ts`
- `packages/db/schema/task_documents.ts`
- `packages/db/schema/index.ts`
- `packages/db/migrations/*`
- `packages/shared/src/types/task.ts`
- `packages/shared/src/validators/task.ts` or new document validator file
- `packages/shared/src/index.ts`

Acceptance:

- schema enforces one key per task
- revisions are append-only
- shared types expose plan/document fields on task fetch

## Phase 2: Server services and routes

Files:

- `apps/server/src/services/tasks.ts` or `apps/server/src/services/documents.ts`
- `apps/server/src/routes/tasks.ts`
- `apps/server/src/services/activity.ts` callsites

Behavior:

- list/get/upsert/delete documents
- revision listing
- `GET /tasks/:id` returns `planDocument` + `documentSummaries`
- company boundary checks match task routes

Acceptance:

- agents and board can fetch/update same-company task documents
- stale edits return `409`
- activity timeline shows document changes

## Phase 3: UI task documents surface

Files:

- `apps/ui/src/api/tasks.ts`
- `apps/ui/src/lib/queryKeys.ts`
- `apps/ui/src/pages/TaskDetail.tsx`
- new reusable document UI component if needed

Behavior:

- render plan + documents under description
- create/update by key
- open revision history
- show conflicts/errors clearly

Acceptance:

- board can create a `plan` doc from task detail
- updated plan appears immediately
- task detail no longer depends on description-embedded `<plan>`

## Phase 4: Skills/docs migration

Files:

- `skills/paperclip/SKILL.md`
- `apps/docs/api/tasks.md`
- `doc/SPEC-implementation.md`
- relevant plan/docs that mention `<plan>`

Acceptance:

- planning guidance references task documents, not inline task description tags
- API docs describe the new document endpoints and task payload additions

## Phase 5: Legacy compatibility and follow-up

Behavior:

- read legacy `<plan>` blocks as fallback
- optionally add explicit import/migration command later

Follow-up, not required for first merge:

- deliverables/artifact read-model
- project/company documents
- comment-linked documents
- diff view between revisions

## Test Plan

### Server

- document create/read/update/delete lifecycle
- revision numbering
- `baseRevisionId` conflict handling
- company boundary enforcement
- agent vs board authorization
- task fetch includes `planDocument` and document summaries
- legacy `<plan>` fallback behavior
- activity log mutation coverage

### UI

- task detail shows plan document
- create/update flows invalidate queries correctly
- conflict and validation errors are surfaced
- legacy plan fallback renders correctly

### Verification

Run before implementation is declared complete:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

## Open Questions

1. Should v1 documents be markdown-only, with `json/html/plain_text` deferred?
   Recommendation: allow all four in API, optimize UI for markdown only.

2. Should agents be allowed to create arbitrary keys, or only conventional keys?
   Recommendation: allow arbitrary keys with normalized validation; reserve `plan` as special behavior only.

3. Should delete exist in v1?
   Recommendation: yes, but board-only.

4. Should legacy `<plan>` blocks ever be auto-migrated?
   Recommendation: no automatic mutation in the first rollout.

5. Should documents appear inside a future Deliverables section or remain a top-level Task section?
   Recommendation: keep a dedicated Documents section now; later also expose them in Deliverables if an aggregated artifact view is added.

## Final Recommendation

Ship **task documents** as a focused, text-first primitive now.

Do not try to solve full artifact unification in the same implementation.

Use:

- first-class document tables
- task-level keyed linkage
- append-only revisions
- `planDocument` embedded in normal task fetches
- legacy `<plan>` fallback
- skill/docs migration away from description-embedded plans

This addresses the real planning workflow problem immediately and leaves the artifact system room to grow cleanly afterward.
