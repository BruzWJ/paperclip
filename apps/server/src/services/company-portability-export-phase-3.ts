import { decodeTaskDisposition } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { extractPortableProjectEnvInputs } from "./company-portability-manifest-types.js";
import { stripEmptyValues } from "./company-portability-selection.js";
import { dedupeEnvInputs, buildEnvInputMap } from "./company-portability-format-support.js";
import { isPlainRecord } from "./company-portability-format-support.js";
import { buildMarkdown } from "./company-portability-format-support.js";
import type { CompanyPortabilityOperationScope } from "./company-portability.js";

export async function runExportBundlePhase3(
  scope: CompanyPortabilityOperationScope,
  state: Record<string, any>,
) {
  for (const project of state.selectedProjectRows) {
    const slug = state.projectSlugById.get(project.id)!;
    const projectPath = `projects/${slug}/PROJECT.md`;
    const envInputsStart = state.envInputs.length;
    const exportedEnvInputs = extractPortableProjectEnvInputs(slug, project.env, state.warnings);
    state.envInputs.push(...exportedEnvInputs);
    const projectEnvInputs = dedupeEnvInputs(
      state.envInputs.slice(envInputsStart).filter((inputValue: any) => inputValue.projectSlug === slug),
    );
    state.files[projectPath] = buildMarkdown(
      {
        kind: "project",
        slug,
        name: project.name,
        description: project.description ?? null,
        owner: project.leadAgentId ? (state.idToSlug.get(project.leadAgentId) ?? null) : null,
      },
      project.description ?? "",
    );
    const extension = stripEmptyValues({
      leadAgentSlug: project.leadAgentId ? (state.idToSlug.get(project.leadAgentId) ?? null) : null,
      targetDate: project.targetDate ?? null,
      color: project.color ?? null,
      icon: project.icon ?? null,
      status: project.status,
    });
    if (isPlainRecord(extension) && projectEnvInputs.length > 0) {
      extension.inputs = {
        env: buildEnvInputMap(projectEnvInputs),
      };
    }
    state.paperclipProjectsOut[slug] = isPlainRecord(extension) ? extension : {};
  }

  for (const task of state.selectedTaskRows) {
    if (!task.request?.trim()) {
      throw unprocessable(
        `Task ${task.identifier} has no canonical immutable request and cannot be exported`,
      );
    }
    const taskSlug = state.taskSlugByTaskId.get(task.id)!;
    const projectSlug = task.projectId ? (state.projectSlugById.get(task.projectId) ?? null) : null;
    // All tasks go in top-level tasks/ folder, never nested under projects/
    const taskPath = `tasks/${taskSlug}/TASK.md`;
    const ownerSlug = task.ownerAgentId ? (state.idToSlug.get(task.ownerAgentId) ?? null) : null;
    if (!ownerSlug) {
      throw unprocessable(`Task ${task.identifier} has no portable agent owner and cannot be exported`);
    }
    const comments = await state.tasksSvc.listComments(task.id, {
      order: "asc",
    });
    state.files[taskPath] = buildMarkdown(
      {
        kind: "task",
        slug: taskSlug,
        name: task.title,
        project: projectSlug,
        owner: ownerSlug,
      },
      task.request,
    );
    const extension = stripEmptyValues({
      lifecycleStatus: task.lifecycleStatus,
      boardPresentationStatus: task.boardPresentationStatus,
      priority: task.priority,
      labelIds: task.labelIds ?? undefined,
      billingCode: task.billingCode ?? null,
      comments:
        comments.length > 0
          ? comments.map((comment: any) => ({
              body: comment.body,
              authorType: comment.authorType,
              authorAgentSlug: comment.authorAgentId
                ? (state.idToSlug.get(comment.authorAgentId) ?? null)
                : null,
              // Portable bundles preserve author kind, but not raw board user ids.
              authorUserId: null,
              presentation: comment.presentation,
              metadata: comment.metadata,
              createdAt:
                comment.createdAt instanceof Date
                  ? comment.createdAt.toISOString()
                  : new Date(comment.createdAt).toISOString(),
            }))
          : undefined,
    });
    if (isPlainRecord(extension) && task.disposition != null) {
      extension.disposition = decodeTaskDisposition(task.disposition);
    }
    state.paperclipTasksOut[taskSlug] = isPlainRecord(extension) ? extension : {};
  }

  for (const routine of state.selectedRoutineRows) {
    const taskSlug = state.taskSlugByRoutineId.get(routine.id)!;
    const projectSlug = routine.projectId ? (state.projectSlugById.get(routine.projectId) ?? null) : null;
    const taskPath = `tasks/${taskSlug}/TASK.md`;
    const ownerSlug = routine.assigneeAgentId ? (state.idToSlug.get(routine.assigneeAgentId) ?? null) : null;
    if (!ownerSlug) {
      throw unprocessable(`Routine ${routine.title} has no portable agent owner and cannot be exported`);
    }
    state.files[taskPath] = buildMarkdown(
      {
        kind: "task",
        slug: taskSlug,
        name: routine.title,
        project: projectSlug,
        owner: ownerSlug,
        recurring: true,
      },
      routine.description ?? "",
    );
    const taskExtension = stripEmptyValues({
      lifecycleStatus: "open",
      boardPresentationStatus: routine.status,
      priority: routine.priority !== "medium" ? routine.priority : undefined,
    });
    const routineExtension = stripEmptyValues({
      concurrencyPolicy:
        routine.concurrencyPolicy !== "coalesce_if_active" ? routine.concurrencyPolicy : undefined,
      catchUpPolicy: routine.catchUpPolicy !== "skip_missed" ? routine.catchUpPolicy : undefined,
      variables: (routine.variables ?? []).length > 0 ? routine.variables : undefined,
      triggers: routine.triggers.map((trigger: any) =>
        stripEmptyValues({
          kind: trigger.kind,
          label: trigger.label ?? null,
          enabled: trigger.enabled ? undefined : false,
          cronExpression: trigger.kind === "schedule" ? (trigger.cronExpression ?? null) : undefined,
          timezone: trigger.kind === "schedule" ? (trigger.timezone ?? null) : undefined,
          signingMode:
            trigger.kind === "webhook" && trigger.signingMode !== "bearer"
              ? (trigger.signingMode ?? null)
              : undefined,
          replayWindowSec:
            trigger.kind === "webhook" && trigger.replayWindowSec !== 300
              ? (trigger.replayWindowSec ?? null)
              : undefined,
        }),
      ),
    });
    state.paperclipTasksOut[taskSlug] = isPlainRecord(taskExtension) ? taskExtension : {};
    state.paperclipRoutinesOut[taskSlug] = isPlainRecord(routineExtension) ? routineExtension : {};
  }
}
