# 2026-04-06 Sub-task Creation On Task Detail Plan

Status: Proposed
Date: 2026-04-06
Audience: Product and engineering
Related:
- `apps/ui/src/pages/TaskDetail.tsx`
- `apps/ui/src/components/TaskProperties.tsx`
- `apps/ui/src/components/NewTaskDialog.tsx`
- `apps/ui/src/context/DialogContext.tsx`
- `packages/shared/src/validators/task.ts`
- `apps/server/src/services/tasks.ts`

## 1. Purpose

This document defines the implementation plan for adding manual sub-task creation from the task detail page.

Requested UX:

- the `Sub-tasks` tab should always show an `Add sub-task` action, even when there are no children yet
- the properties pane should also expose a `Sub-tasks` section with the same `Add sub-task` entry point
- both entry points should open the existing new-task dialog in a "create sub-task" mode
- the dialog should only show sub-task-specific UI when it was opened from one of those entry points

This is a UI-first change. The backend already supports child task creation with `parentId`.

## 2. Current State

### 2.1 Existing child task display

`apps/ui/src/pages/TaskDetail.tsx` already derives `childTasks` by filtering the company task list on `parentId === task.id`.

Current limitation:

- the `Sub-tasks` tab only renders the empty state or the child task list
- there is no action to create a child task from that tab

### 2.2 Existing properties pane

`apps/ui/src/components/TaskProperties.tsx` shows `Blocked by`, `Blocking`, and `Parent`, but it has no sub-task section or child task affordance.

### 2.3 Existing dialog state

`apps/ui/src/context/DialogContext.tsx` can open the global new-task dialog with defaults such as status, priority, project, assignee, title, and description.

Current limitation:

- there is no way to pass sub-task context like `parentId`
- `apps/ui/src/components/NewTaskDialog.tsx` therefore cannot submit a child task or render parent-specific context

### 2.4 Backend contract already exists

The create-task validator already accepts `parentId`.

`apps/server/src/services/tasks.ts` already uses:

- `parentId` for parent-child task relationships

That means the required parent-child API behavior already exists. No server or schema change is required for the first pass.

## 3. Proposed Implementation

## 3.1 Extend dialog defaults for sub-task context

Extend `NewTaskDefaults` in `apps/ui/src/context/DialogContext.tsx` with:

- `parentId?: string`
- optional parent display metadata for the dialog header, for example:
  - `parentIdentifier?: string`
  - `parentTitle?: string`

This keeps the dialog self-contained and avoids re-fetching parent context purely for presentation.

## 3.2 Add task-detail entry points

Use `openNewTask(...)` from `apps/ui/src/pages/TaskDetail.tsx` in two places:

1. `Sub-tasks` tab
2. properties pane via props passed into `TaskProperties`

Both entry points should pass:

- `parentId: task.id`
- `parentIdentifier: task.identifier ?? task.id`
- `parentTitle: task.title`
- `projectId: task.projectId ?? undefined`

Using the current task's `projectId` preserves the common expectation that sub-tasks stay inside the same project unless the operator changes it in the dialog.

No special assignee default should be forced in V1.

## 3.3 Add a dedicated properties-pane section

Extend `TaskProperties` to accept:

- `childTasks: Task[]`
- `onCreateSubtask: () => void`

Render a new `Sub-tasks` section near `Blocked by` / `Blocking`:

- if children exist, show compact links or pills to the existing sub-tasks
- always show an `Add sub-task` button

This keeps the child task affordance visible in the property area without requiring a generic parent selector.

## 3.4 Update the sub-tasks tab layout

Refactor the `Sub-tasks` tab in `TaskDetail` to render:

- a small header row with child count
- an `Add sub-task` button
- the existing empty state or child task list beneath it

This satisfies the requirement that the action is visible whether or not sub-tasks already exist.

## 3.5 Add sub-task mode to the new-task dialog

Update `apps/ui/src/components/NewTaskDialog.tsx` so that when `newTaskDefaults.parentId` is present:

- the dialog submits `parentId`
- the header/button copy can switch to `New sub-task` / `Create sub-task`
- a compact parent context row is shown, for example `Parent: PAP-1150 add the ability...`

Important constraint:

- this parent context row should only render when the dialog was opened with sub-task defaults
- opening the dialog from global create actions should remain unchanged and should not expose a generic parent control

That preserves the requested UX boundary: sub-task creation is intentional, not part of the default create-task surface.

## 3.6 Query invalidation and refresh behavior

No new data-fetch path is needed.

The existing create success handler in `NewTaskDialog` already invalidates:

- `queryKeys.tasks.list(companyId)`
- task-related list badges

That should be enough for the parent `TaskDetail` view to recompute `childTasks` after creation because it derives children from the company task list query.

If the detail page ever moves away from the full company task list, this should be revisited, but it does not require additional work for the current architecture.

## 4. Implementation Order

1. Extend `DialogContext` task defaults with sub-task fields.
2. Wire `TaskDetail` to open the dialog in sub-task mode from the `Sub-tasks` tab.
3. Extend `TaskProperties` to display child tasks and the `Add sub-task` action.
4. Update `NewTaskDialog` submission and header UI for sub-task mode.
5. Add UI tests for the new entry points and payload behavior.

## 5. Testing Plan

Add focused UI tests covering:

1. `TaskDetail`
   - `Sub-tasks` tab shows `Add sub-task` when there are zero children
   - clicking the action opens the dialog with parent defaults

2. `TaskProperties`
   - the properties pane renders the sub-task section
   - `Add sub-task` remains available when there are no child tasks

3. `NewTaskDialog`
   - when opened with `parentId`, submit payload includes `parentId`
   - sub-task-specific copy appears only in that mode
   - when opened normally, no parent UI is shown and payload is unchanged

No backend test expansion is required unless implementation discovers a client/server contract gap.

## 6. Risks And Decisions

### 6.1 Parent metadata source

Decision: pass parent label metadata through dialog defaults instead of making `NewTaskDialog` fetch the parent task.

Reason:

- less coupling
- no loading state inside the dialog
- simpler tests

### 6.2 Project inheritance

Decision: prefill `projectId` from the parent task, but keep it editable.

Reason:

- matches expected operator behavior
- avoids silently moving a sub-task outside the current project by default

### 6.3 Keep parent selection out of the generic dialog

Decision: do not add a freeform parent picker in this change.

Reason:

- the request explicitly wants sub-task controls only when the flow starts from a sub-task action
- this keeps the default task creation surface simpler

## 7. Success Criteria

This plan is complete when an operator can:

1. open any task detail page
2. click `Add sub-task` from either the `Sub-tasks` tab or the properties pane
3. land in the existing new-task dialog with clear parent context
4. create the child task and see it appear under the parent without a page reload
