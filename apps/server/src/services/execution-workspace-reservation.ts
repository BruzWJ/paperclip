import fs from "node:fs/promises";
import path from "node:path";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  executionWorkspaces,
  taskExecutionWorkspaceBindings,
  taskSessions,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import { resolvePaperclipInstanceRoot } from "@paperclipai/shared/home-paths";
import { createTaskSessionRootInTx } from "./task-session-root-postgres.js";
import { type TaskSessionDbTransaction } from "./task-session/event-store.js";
import { type ExecutionWorkspaceRow } from "./execution-workspace-branch-inspection.js";
import {
  absoluteProjectWorkspaceCwd,
  currentContextGeneration,
  deterministicWorkspaceUuid,
  publishSessionMovedForWorkspaceInTx,
  rejectWorkspaceReservation,
  resolveReservationParentSession,
  type ReserveTaskExecutionWorkspaceBindingInput,
} from "./execution-workspace-reservation-contracts.js";

/**
 * Sole production mutating owner for a task-execution workspace binding.
 *
 * The workspace is resolved automatically from the task's project on every
 * ownership epoch. Parent Sessions supply lineage only: neither a parent
 * binding nor a prior epoch cwd is an implicit workspace source.
 */
export async function reserveTaskExecutionWorkspaceBinding(
  tx: TaskSessionDbTransaction,
  input: ReserveTaskExecutionWorkspaceBindingInput,
) {
  if (!Number.isSafeInteger(input.task.ownershipEpoch) || input.task.ownershipEpoch < 1) {
    rejectWorkspaceReservation("Task ownership epoch must be positive", "ownership_epoch_invalid");
  }
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${[
      "task-workspace-reservation",
      input.task.companyId,
      input.task.id,
      input.task.ownershipEpoch,
    ].join(":")}, 0))`,
  );

  const existingBinding = await tx
    .select()
    .from(taskExecutionWorkspaceBindings)
    .where(
      and(
        eq(taskExecutionWorkspaceBindings.companyId, input.task.companyId),
        eq(taskExecutionWorkspaceBindings.taskId, input.task.id),
        eq(taskExecutionWorkspaceBindings.ownershipEpoch, input.task.ownershipEpoch),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (existingBinding) {
    if (existingBinding.sessionId !== input.session.id) {
      rejectWorkspaceReservation(
        "Task workspace reservation was retried with different immutable identity",
        "workspace_binding_conflict",
      );
    }
    const existingSession = await tx
      .select()
      .from(taskSessions)
      .where(
        and(
          eq(taskSessions.companyId, input.task.companyId),
          eq(taskSessions.taskId, input.task.id),
          eq(taskSessions.id, input.session.id),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!existingSession) {
      rejectWorkspaceReservation(
        "Persisted workspace binding has no canonical Session",
        "workspace_session_missing",
      );
    }
    const existingWorkspace = await tx
      .select({
        projectWorkspaceId: executionWorkspaces.projectWorkspaceId,
      })
      .from(executionWorkspaces)
      .where(
        and(
          eq(executionWorkspaces.companyId, input.task.companyId),
          eq(executionWorkspaces.id, existingBinding.executionWorkspaceId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!existingWorkspace) {
      rejectWorkspaceReservation(
        "Persisted workspace binding has no execution workspace",
        "execution_workspace_missing",
      );
    }
    return {
      binding: existingBinding,
      session: existingSession,
      contextEpochGeneration: await currentContextGeneration(tx, {
        companyId: input.task.companyId,
        taskId: input.task.id,
        sessionId: input.session.id,
      }),
      projectWorkspaceId: existingWorkspace.projectWorkspaceId,
      moved: false,
    };
  }

  const project = input.task.projectId
    ? await tx
        .select()
        .from(projects)
        .where(and(eq(projects.companyId, input.task.companyId), eq(projects.id, input.task.projectId)))
        .limit(1)
        .then((rows) => rows[0] ?? null)
    : null;
  if (input.task.projectId && !project) {
    rejectWorkspaceReservation("Task project is not in this company", "project_invalid");
  }
  const selectedProjectWorkspaceId = input.task.projectWorkspaceId ?? null;
  const selectedProjectWorkspace = input.task.projectId
    ? await tx
        .select()
        .from(projectWorkspaces)
        .where(
          and(
            eq(projectWorkspaces.companyId, input.task.companyId),
            eq(projectWorkspaces.projectId, input.task.projectId),
            selectedProjectWorkspaceId ? eq(projectWorkspaces.id, selectedProjectWorkspaceId) : sql`true`,
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null)
    : null;
  if (selectedProjectWorkspaceId && !selectedProjectWorkspace) {
    rejectWorkspaceReservation(
      "Selected project workspace is not in the task project",
      "project_workspace_invalid",
    );
  }
  let workspace: ExecutionWorkspaceRow;
  {
    const projectWorkspaceCwd = absoluteProjectWorkspaceCwd(selectedProjectWorkspace?.cwd);
    const perEpochRoot = path.join(
      resolvePaperclipInstanceRoot(),
      "task-workspaces",
      input.task.companyId,
      input.task.id,
      String(input.task.ownershipEpoch),
    );
    const absoluteCwd = projectWorkspaceCwd ?? perEpochRoot;
    await fs.mkdir(absoluteCwd, { recursive: true });
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${[
        "shared-execution-workspace",
        input.task.companyId,
        input.task.projectId ?? "global",
        selectedProjectWorkspace?.id ?? "projectless",
        absoluteCwd,
      ].join(":")}, 0))`,
    );
    const reusableShared = await tx
      .select()
      .from(executionWorkspaces)
      .where(
        and(
          eq(executionWorkspaces.companyId, input.task.companyId),
          input.task.projectId
            ? eq(executionWorkspaces.projectId, input.task.projectId)
            : isNull(executionWorkspaces.projectId),
          selectedProjectWorkspace?.id
            ? eq(executionWorkspaces.projectWorkspaceId, selectedProjectWorkspace.id)
            : isNull(executionWorkspaces.projectWorkspaceId),
          eq(executionWorkspaces.cwd, absoluteCwd),
        ),
      )
      .orderBy(asc(executionWorkspaces.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (reusableShared) {
      workspace = await tx
        .update(executionWorkspaces)
        .set({
          lastUsedAt: input.session.now,
        })
        .where(eq(executionWorkspaces.id, reusableShared.id))
        .returning()
        .then((rows) => rows[0] ?? reusableShared);
    } else {
      const inserted = await tx
        .insert(executionWorkspaces)
        .values({
          companyId: input.task.companyId,
          projectId: input.task.projectId,
          projectWorkspaceId: selectedProjectWorkspace?.id ?? null,
          cwd: absoluteCwd,
          repoUrl: selectedProjectWorkspace?.repoUrl ?? null,
          branchName: null,
          lastUsedAt: input.session.now,
          createdAt: input.session.now,
        })
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!inserted) {
        rejectWorkspaceReservation(
          "Execution workspace was not persisted",
          "execution_workspace_reservation_failed",
        );
      }
      workspace = inserted;
    }
  }

  if (!workspace.cwd || !path.isAbsolute(workspace.cwd)) {
    rejectWorkspaceReservation(
      "Reserved execution workspace has no valid absolute cwd",
      "execution_workspace_cwd_invalid",
    );
  }
  const absoluteCwd = path.resolve(workspace.cwd);
  const parentSessionId = await resolveReservationParentSession(tx, input);
  const existingSession = await tx
    .select()
    .from(taskSessions)
    .where(
      and(
        eq(taskSessions.companyId, input.task.companyId),
        eq(taskSessions.taskId, input.task.id),
        eq(taskSessions.id, input.session.id),
      ),
    )
    .for("update")
    .then((rows) => rows[0] ?? null);

  let session: typeof taskSessions.$inferSelect;
  let contextEpochGeneration: number;
  let moved = false;
  if (!existingSession) {
    const root = await createTaskSessionRootInTx(tx, {
      id: input.session.id,
      companyId: input.task.companyId,
      taskId: input.task.id,
      parentSessionId,
      projectId: input.task.projectId ?? "global",
      title: input.task.title?.trim() || `Task ${input.task.id}`,
      directory: absoluteCwd,
      now: input.session.now,
    });
    session = root.session;
    contextEpochGeneration = root.contextEpoch.generation;
  } else {
    if (existingSession.parentSessionId !== parentSessionId) {
      rejectWorkspaceReservation(
        "Existing Session parent does not match task lineage",
        "parent_session_mismatch",
      );
    }
    if (path.resolve(existingSession.directory) !== absoluteCwd) {
      await publishSessionMovedForWorkspaceInTx(tx, input, absoluteCwd);
      moved = true;
      const movedSession = await tx
        .select()
        .from(taskSessions)
        .where(eq(taskSessions.id, input.session.id))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!movedSession) {
        rejectWorkspaceReservation("Moved Session projection is missing", "workspace_session_missing");
      }
      session = movedSession;
    } else {
      session = existingSession;
    }
    contextEpochGeneration = await currentContextGeneration(tx, {
      companyId: input.task.companyId,
      taskId: input.task.id,
      sessionId: input.session.id,
    });
  }

  const binding = await tx
    .insert(taskExecutionWorkspaceBindings)
    .values({
      id: deterministicWorkspaceUuid(
        "task-workspace-binding",
        `${input.task.companyId}:${input.task.id}:${input.task.ownershipEpoch}`,
      ),
      companyId: input.task.companyId,
      taskId: input.task.id,
      sessionId: input.session.id,
      ownershipEpoch: input.task.ownershipEpoch,
      executionWorkspaceId: workspace.id,
      absoluteCwd,
      boundByAgentId: input.provenance?.agentId ?? null,
      boundByUserId: input.provenance?.userId ?? null,
      createdAt: input.session.now,
    })
    .returning()
    .then((rows) => rows[0] ?? null);
  if (!binding) {
    rejectWorkspaceReservation(
      "Task execution workspace binding was not persisted",
      "workspace_binding_missing",
    );
  }
  return {
    binding,
    session,
    contextEpochGeneration,
    projectWorkspaceId: workspace.projectWorkspaceId,
    moved,
  };
}
