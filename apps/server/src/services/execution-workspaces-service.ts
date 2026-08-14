import path from "node:path";
import { and, desc, eq, ne, or, sql } from "drizzle-orm";
import { type Db, executionWorkspaces, taskExecutionWorkspaceBindings, tasks } from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../errors.js";
import { appendCanonicalControlNotice } from "./task-session-producers.js";
import { resolveCurrentTaskOwnerRunLinkages } from "./productive-run-linkage.js";
import * as branchInspection from "./execution-workspace-branch-inspection.js";

export function executionWorkspaceService(db: Db) {
  async function listCurrentBindingsForWorkspace(
    executionWorkspaceId: string,
    options: { companyId?: string; taskId?: string } = {},
  ): Promise<branchInspection.ExecutionWorkspaceCurrentBinding[]> {
    const conditions = [
      eq(taskExecutionWorkspaceBindings.executionWorkspaceId, executionWorkspaceId),
      eq(taskExecutionWorkspaceBindings.companyId, tasks.companyId),
      eq(taskExecutionWorkspaceBindings.taskId, tasks.id),
      eq(taskExecutionWorkspaceBindings.ownershipEpoch, tasks.ownershipEpoch),
    ];
    if (options.companyId) {
      conditions.push(eq(taskExecutionWorkspaceBindings.companyId, options.companyId));
    }
    if (options.taskId) {
      conditions.push(eq(taskExecutionWorkspaceBindings.taskId, options.taskId));
    }

    return db
      .select({
        id: taskExecutionWorkspaceBindings.id,
        companyId: taskExecutionWorkspaceBindings.companyId,
        taskId: taskExecutionWorkspaceBindings.taskId,
        sessionId: taskExecutionWorkspaceBindings.sessionId,
        ownershipEpoch: taskExecutionWorkspaceBindings.ownershipEpoch,
        executionWorkspaceId: taskExecutionWorkspaceBindings.executionWorkspaceId,
        absoluteCwd: taskExecutionWorkspaceBindings.absoluteCwd,
        taskNumber: tasks.taskNumber,
        taskIdentifier: tasks.identifier,
        taskTitle: tasks.title,
        taskStatus: tasks.boardPresentationStatus,
        taskUpdatedAt: tasks.updatedAt,
      })
      .from(taskExecutionWorkspaceBindings)
      .innerJoin(
        tasks,
        and(
          eq(tasks.companyId, taskExecutionWorkspaceBindings.companyId),
          eq(tasks.id, taskExecutionWorkspaceBindings.taskId),
          eq(tasks.ownershipEpoch, taskExecutionWorkspaceBindings.ownershipEpoch),
        ),
      )
      .where(and(...conditions))
      .orderBy(desc(tasks.updatedAt), desc(taskExecutionWorkspaceBindings.createdAt));
  }

  async function resolveCurrentBindingForWorkspace(
    executionWorkspaceId: string,
    companyId: string,
    taskId?: string | null,
  ): Promise<branchInspection.ExecutionWorkspaceCurrentBinding> {
    const bindings = await listCurrentBindingsForWorkspace(executionWorkspaceId, {
      companyId,
      ...(taskId ? { taskId } : {}),
    });
    if (bindings.length === 0) {
      throw unprocessable(
        taskId
          ? "Execution workspace is not bound to the task's current ownership epoch"
          : "Execution workspace has no current ownership-epoch binding",
      );
    }
    if (!taskId && bindings.length > 1) {
      throw conflict(
        "Execution workspace has multiple current task bindings; select the task whose ownership epoch should be reconciled",
        {
          executionWorkspaceId,
          taskIds: bindings.map((binding) => binding.taskId),
        },
      );
    }
    return bindings[0]!;
  }

  return {
    findGitWorktreeContention: async (input: {
      companyId: string;
      worktreePath: string;
      liveBranchName: string | null;
      excludingExecutionWorkspaceId?: string | null;
    }): Promise<branchInspection.ExecutionWorkspaceGitWorktreeContention> => {
      const resolvedWorktreePath = path.resolve(input.worktreePath);
      const pathOrBranchConditions = [eq(executionWorkspaces.cwd, input.worktreePath)];
      if (input.liveBranchName) {
        pathOrBranchConditions.push(eq(executionWorkspaces.branchName, input.liveBranchName));
      }

      const candidates = await db
        .select({
          id: executionWorkspaces.id,
          cwd: executionWorkspaces.cwd,
          branchName: executionWorkspaces.branchName,
        })
        .from(executionWorkspaces)
        .where(
          and(
            eq(executionWorkspaces.companyId, input.companyId),
            input.excludingExecutionWorkspaceId
              ? ne(executionWorkspaces.id, input.excludingExecutionWorkspaceId)
              : sql`true`,
            or(...pathOrBranchConditions),
          ),
        )
        .orderBy(desc(executionWorkspaces.lastUsedAt), desc(executionWorkspaces.createdAt))
        .limit(20);

      for (const candidate of candidates) {
        const matchesPath = path.resolve(candidate.cwd) === resolvedWorktreePath;
        const matchesBranch = Boolean(input.liveBranchName && candidate.branchName === input.liveBranchName);
        if (!matchesPath && !matchesBranch) continue;

        const linkedTasks = await listCurrentBindingsForWorkspace(candidate.id, {
          companyId: input.companyId,
        });
        if (linkedTasks.length === 0) continue;

        const linkages = await resolveCurrentTaskOwnerRunLinkages(db, {
          companyId: input.companyId,
          taskIds: linkedTasks.map((task) => task.taskId),
        });
        const linkage =
          [...linkages.values()].sort(
            (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
          )[0] ?? null;
        const activeTask = linkage
          ? (linkedTasks.find((task) => task.taskId === linkage.taskId) ?? null)
          : null;
        if (linkage && !activeTask) {
          throw conflict("Active execution references an unavailable task workspace binding");
        }
        const claimedTask = activeTask ?? linkedTasks[0]!;

        return {
          claimedByWorkspaceId: candidate.id,
          claimedByTaskId: claimedTask.taskId,
          claimedByTaskIdentifier: claimedTask.taskIdentifier,
          activeRun: linkage
            ? {
                id: linkage.runId,
                status: "running",
                taskId: activeTask!.taskId,
                taskNumber: activeTask!.taskNumber,
                taskIdentifier: activeTask!.taskIdentifier,
              }
            : null,
        };
      }

      return null;
    },

    reconcileExecutionWorkspaceBranch: async (
      id: string,
      input: {
        mode: branchInspection.ExecutionWorkspaceBranchReconcileMode;
        taskId?: string | null;
        reason?: string | null;
        actor: branchInspection.ExecutionWorkspaceBranchReconcileActor;
      },
    ): Promise<branchInspection.ExecutionWorkspaceBranchReconcileResult> => {
      const existingRow = await db
        .select()
        .from(executionWorkspaces)
        .where(eq(executionWorkspaces.id, id))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!existingRow) throw notFound("Execution workspace not found");

      const existing = branchInspection.toExecutionWorkspace(existingRow);
      const currentBinding = await resolveCurrentBindingForWorkspace(
        existing.id,
        existing.companyId,
        input.taskId,
      );
      const inspection = await branchInspection.inspectExecutionWorkspaceBranchForReconcile(
        existing,
        currentBinding.taskId,
      );
      if (inspection.fromBranch === inspection.toBranch) {
        throw unprocessable("Execution workspace already records the checked-out branch", { inspection });
      }
      if (inspection.ancestryVerdict !== "ancestor") {
        throw unprocessable(
          "Forward branch reconciliation requires the recorded branch to be an ancestor of the checked-out branch",
          { inspection },
        );
      }
      branchInspection.assertBranchReconcileWorkspaceIsSafe({ inspection });

      const reason = branchInspection.readNullableString(input.reason);
      return db.transaction(async (tx) => {
        const lockedRow = await tx
          .select()
          .from(executionWorkspaces)
          .where(eq(executionWorkspaces.id, existing.id))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!lockedRow) throw notFound("Execution workspace not found");

        const lockedBinding = await tx
          .select({
            id: taskExecutionWorkspaceBindings.id,
            companyId: taskExecutionWorkspaceBindings.companyId,
            taskId: taskExecutionWorkspaceBindings.taskId,
            sessionId: taskExecutionWorkspaceBindings.sessionId,
            ownershipEpoch: taskExecutionWorkspaceBindings.ownershipEpoch,
            executionWorkspaceId: taskExecutionWorkspaceBindings.executionWorkspaceId,
          })
          .from(taskExecutionWorkspaceBindings)
          .innerJoin(
            tasks,
            and(
              eq(tasks.companyId, taskExecutionWorkspaceBindings.companyId),
              eq(tasks.id, taskExecutionWorkspaceBindings.taskId),
              eq(tasks.ownershipEpoch, taskExecutionWorkspaceBindings.ownershipEpoch),
            ),
          )
          .where(
            and(
              eq(taskExecutionWorkspaceBindings.id, currentBinding.id),
              eq(taskExecutionWorkspaceBindings.companyId, lockedRow.companyId),
              eq(taskExecutionWorkspaceBindings.taskId, currentBinding.taskId),
              eq(taskExecutionWorkspaceBindings.executionWorkspaceId, lockedRow.id),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (
          !lockedBinding ||
          lockedBinding.sessionId !== currentBinding.sessionId ||
          lockedBinding.ownershipEpoch !== currentBinding.ownershipEpoch
        ) {
          throw conflict(
            "Execution workspace ownership binding changed during branch reconciliation; retry with the current task epoch",
            {
              executionWorkspaceId: lockedRow.id,
              taskId: currentBinding.taskId,
              ownershipEpoch: currentBinding.ownershipEpoch,
            },
          );
        }

        branchInspection.assertLockedBranchReconcileWorkspaceStillMatchesInspection({
          lockedRow,
          inspectedRow: existingRow,
          inspection,
        });

        const updatedRow = await tx
          .update(executionWorkspaces)
          .set({ branchName: inspection.toBranch })
          .where(
            and(
              eq(executionWorkspaces.id, lockedRow.id),
              eq(executionWorkspaces.companyId, lockedRow.companyId),
              eq(executionWorkspaces.branchName, inspection.fromBranch),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updatedRow) {
          throw conflict(
            "Execution workspace branch changed during reconciliation; retry with a fresh inspection",
            { inspection },
          );
        }

        const auditNotice = await appendCanonicalControlNotice(
          db,
          {
            companyId: lockedRow.companyId,
            taskId: lockedBinding.taskId,
            sourceKind: "workspace_branch_reconciled",
            immutableSourceKey: [inspection.fingerprint, input.mode].join(":"),
            sourceRecordId: inspection.fingerprint,
            exactText: branchInspection.formatBranchReconcileAuditComment({
              mode: input.mode,
              reason,
              workspaceId: existing.id,
              inspection,
            }),
            comment: {
              author: { kind: "system", source: "control" },
              producingRun: null,
            },
            allowTerminal: true,
          },
          tx,
        );

        return {
          workspace: branchInspection.toExecutionWorkspace(updatedRow),
          boundTaskId: lockedBinding.taskId,
          boundOwnershipEpoch: lockedBinding.ownershipEpoch,
          inspection,
          auditCommentId: auditNotice.comment?.id ?? null,
        };
      });
    },
  };
}
