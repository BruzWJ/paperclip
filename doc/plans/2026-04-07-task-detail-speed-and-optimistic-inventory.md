# 2026-04-07 Task Detail Speed And Optimistic Inventory

Status: Proposed
Date: 2026-04-07
Audience: Product and engineering
Related:
- `apps/ui/src/pages/TaskDetail.tsx`
- `apps/ui/src/components/TaskProperties.tsx`
- `apps/ui/src/api/tasks.ts`
- `apps/ui/src/lib/queryKeys.ts`
- `apps/server/src/routes/tasks.ts`
- `apps/server/src/services/tasks.ts`
- [PAP-1192](/PAP/tasks/PAP-1192)
- [PAP-1191](/PAP/tasks/PAP-1191)
- [PAP-1188](/PAP/tasks/PAP-1188)
- [PAP-1119](/PAP/tasks/PAP-1119)
- [PAP-945](/PAP/tasks/PAP-945)
- [PAP-1165](/PAP/tasks/PAP-1165)
- [PAP-890](/PAP/tasks/PAP-890)
- [PAP-254](/PAP/tasks/PAP-254)
- [PAP-138](/PAP/tasks/PAP-138)

## 1. Purpose

This note inventories the Paperclip tasks that point to the same UX class of problem:

- pages feel slow because they over-fetch or refetch too much
- actions feel slow because the UI waits for the round trip before reflecting obvious local intent
- optimistic updates exist in some places, but not in a consistent system

The immediate trigger is [PAP-1192](/PAP/tasks/PAP-1192): the task detail page now feels very slow.

## 2. Short Answer

The task detail page is not obviously blocked by one pathological endpoint. The main problem is the shape of the page:

- `TaskDetail` fans out into many independent queries on mount
- some of those queries fetch full company-wide collections for data that is local to one task
- common mutations invalidate almost every task-related query, which creates avoidable refetch storms
- the page has only a minimal top-level `Loading...` fallback and very little staged or sectional loading UX

Measured against the current assigned task (`PAP-1191`) on local dev, the slowest single request was the full company tasks list:

- `GET /api/tasks/:id` about `18ms`
- `GET /api/tasks/:id/comments|activity|approvals|attachments` about `6-8ms`
- `GET /api/companies/:companyId/agents|projects` about `9-11ms`
- `GET /api/companies/:companyId/tasks` about `76ms`

That strongly suggests the current pain is aggregate client fan-out plus over-broad invalidation, not one obviously broken endpoint.

## 3. Similar Task Inventory

## 3.1 Task-detail and task-action siblings

- [PAP-1192](/PAP/tasks/PAP-1192): task page feels like it loads forever
- [PAP-1188](/PAP/tasks/PAP-1188): assignee changes in the task properties pane were slow and needed optimistic UI
- [PAP-945](/PAP/tasks/PAP-945): optimistic comment rendering
- [PAP-1003](/PAP/tasks/PAP-1003): optimistic comments had duplicate draft/pending behavior
- [PAP-947](/PAP/tasks/PAP-947): follow-up breakage from optimistic comments
- [PAP-254](/PAP/tasks/PAP-254): long task threads become sluggish when adding comments
- [PAP-189](/PAP/tasks/PAP-189): comment semantics while a task has a live run

Pattern: the task page already has a history of needing both optimistic behavior and bounded thread/loading behavior. `PAP-1192` is the same family, not a new category.

## 3.2 Inbox and list-view siblings

- [PAP-1119](/PAP/tasks/PAP-1119): optimistic archive had fade-out then snap-back
- [PAP-1165](/PAP/tasks/PAP-1165): task search slow
- [PAP-890](/PAP/tasks/PAP-890): task search slow, make it very fast
- [PAP-138](/PAP/tasks/PAP-138): inbox loading feels stuck
- [PAP-470](/PAP/tasks/PAP-470): create-task save state felt slow and awkward

Pattern: Paperclip already has several places where the right fix was "show intent immediately, then reconcile," not "wait for refetch."

## 3.3 Broader app-loading siblings

- [PAP-472](/PAP/tasks/PAP-472): dashboard charts load very slowly
- [PAP-797](/PAP/tasks/PAP-797): reduce loading states through static generation/caching where possible
- [PAP-799](/PAP/tasks/PAP-799): embed company data at build time to eliminate loading states
- [PAP-703](/PAP/tasks/PAP-703): faster chat and better visual feedback

Pattern: the product has recurring pressure to reduce blank/loading states across the app, so the task-detail work should fit that broader direction.

## 4. Current Task Detail Findings

## 4.1 Mount query fan-out is high

`apps/ui/src/pages/TaskDetail.tsx` mounts all of these data sources up front:

- task detail
- comments
- activity
- linked runs
- linked approvals
- attachments
- live runs
- active run
- full company tasks list
- agents list
- auth session
- projects list
- feedback votes
- instance general settings
- plugin slots

This is too much for the initial view of a single task.

## 4.2 The page fetches full company task data just to derive child tasks

`TaskDetail` currently does:

- `tasksApi.list(selectedCompanyId!)`
- then filters client-side for `parentId === task.id`

That is expensive relative to the need.

Important detail:

- the server route already supports `parentId`
- `apps/server/src/services/tasks.ts` already supports `parentId`
- but `apps/ui/src/api/tasks.ts` does not expose `parentId` in the filter type

So the client is missing an already-supported narrow query path.

## 4.3 Comments are still fetched as full-thread loads

`apps/server/src/routes/tasks.ts` and `apps/server/src/services/tasks.ts` already support:

- `after`
- `order`
- `limit`

But `TaskDetail` still calls `tasksApi.listComments(taskId)` with no cursor or limit and then re-invalidates the full thread after common comment actions.

That means we already have the server-side building blocks for incremental comment loading, but the page is not using them.

## 4.4 Cache invalidation is broader than necessary

`invalidateTask()` in `TaskDetail` invalidates:

- detail
- activity
- runs
- approvals
- feedback votes
- attachments
- documents
- live runs
- active run
- multiple task collections
- sidebar badges

That is acceptable for correctness, but it is expensive for perceived speed and makes optimistic work feel less stable because the page keeps re-painting from fresh network results.

## 4.5 Live run state is fetched twice

The page polls both:

- `tasks.liveRuns(taskId)` every 3s
- `tasks.activeRun(taskId)` every 3s

That is duplicate polling for closely related state.

## 4.6 Properties panel duplicates more list fetching

`apps/ui/src/components/TaskProperties.tsx` fetches:

- session
- agents list
- projects list
- labels
- and, when the blocker picker opens, the full company tasks list

The page and panel are each doing their own list work instead of sharing a narrower task-detail data model.

## 4.7 The perceived loading UX is too thin

`TaskDetail` only shows:

- plain `Loading...` while the main task query is pending

After that, many sub-sections can appear empty or incomplete until their own queries resolve. That makes the page feel slower than the raw request times suggest.

## 5. Recommended Plan

## 5.1 Phase 1: Fix perceived speed first

Ship UX changes that make the page feel immediate before deeper backend reshaping:

- replace the plain `Loading...` state with a task-detail skeleton
- give comments, activity, attachments, and sub-tasks their own skeleton/empty/loading states
- preserve visible stale data during refetch instead of clearing sections
- show explicit pending state for local actions that are already optimistic

Why first:

- it improves the user-facing feel immediately
- it reduces the chance that later data changes still feel slow because the page flashes blank

## 5.2 Phase 2: Stop fetching the full company tasks list for child tasks

Add `parentId` to the `tasksApi.list(...)` filter type and switch `TaskDetail` to:

- fetch child tasks only
- stop loading the full company task collection on page mount

This is the highest-confidence narrow win because the server path already exists.

## 5.3 Phase 3: Convert comments to a bounded + incremental model

Use the existing server support for:

- latest comment cursor from heartbeat context or task bootstrap
- incremental fetch with `after`
- bounded initial fetch with `limit`

Suggested behavior:

- first load: fetch the latest N comments
- offer `load earlier` for long threads
- after posting or on live updates: append incrementally instead of invalidating the whole thread

This should address the same performance family as [PAP-254](/PAP/tasks/PAP-254).

## 5.4 Phase 4: Reduce duplicate polling and invalidation

Tighten the runtime side of the page:

- collapse `liveRuns` and `activeRun` into one client source if possible
- stop invalidating unrelated task collections after mutations that only affect the current task
- merge server responses into cache where we already have enough information

Examples:

- posting a comment should not force a broad company task list refetch unless list-visible metadata changed
- attachment changes should not invalidate approvals or unrelated live-run queries

## 5.5 Phase 5: Consider a task-detail bootstrap contract

If the page is still too chatty after the client fixes, add one tailored bootstrap surface for the task detail page.

Potential bootstrap payload:

- task core data
- child task summaries
- latest comment cursor and recent comment page
- live run summary
- attachment summaries
- approval summaries
- any lightweight mention/selector metadata truly needed at first paint

This should happen after the obvious client overfetch fixes, not before.

## 6. Concrete Opportunities By Surface

## 6.1 Task detail page

- narrow child task fetch from full list to `parentId`
- stage loading by section instead of all-or-nothing perception
- bound initial comments payload
- reduce duplicate live-run polling
- replace broad invalidation with targeted cache writes

## 6.2 Task properties panel

- reuse page-level agents/projects data where possible
- fetch blockers lazily and narrowly
- keep local optimistic field updates without broad page invalidation

## 6.3 Thread/comment UX

- append optimistic comments directly into the visible thread
- keep queued/pending comment state stable during reconciliation
- fetch only new comments after the last known cursor

## 6.4 Cross-app optimistic consistency

The same standards should apply to:

- task archive/unarchive
- task property edits
- create task/sub-task flows
- comment posting
- attachment/document actions where the local result is obvious

## 7. Suggested Execution Order

1. `PAP-1192`: task-detail skeletons and staged loading
2. add `parentId` support to `apps/ui/src/api/tasks.ts` and switch child-task fetching to a narrow query
3. move comments to bounded initial load plus incremental updates
4. shrink invalidation and polling scope
5. only then decide whether a new task-detail bootstrap endpoint is still needed

## 8. Success Criteria

This inventory is successful if the follow-up implementation makes the task page behave like this:

1. navigating to a task shows a shaped skeleton immediately, not plain text
2. the page no longer fetches the full company task list just to render sub-tasks
3. long threads do not require full-thread fetches on every load or comment mutation
4. local actions feel immediate and do not snap back because of broad invalidation
5. the task page feels faster even when absolute backend timings are already reasonable
