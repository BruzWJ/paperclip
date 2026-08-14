import { createHash } from "node:crypto";
import path from "node:path";
import {
  ROUTINE_CATCH_UP_POLICIES,
  ROUTINE_CONCURRENCY_POLICIES,
  ROUTINE_TRIGGER_SIGNING_MODES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type ROUTINE_STATUSES,
  type TaskStatus,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { appendCanonicalControlNotice, appendCanonicalUserComment } from "./task-session-producers.js";
import { routineService } from "./routines.js";
import { resolvePortableRoutineDefinition } from "./company-portability-extension-parser.js";
import { portableTaskDisplayLabel } from "./company-portability-manifest-types.js";
import { readPortableTextFile } from "./company-portability-selection.js";
import { createPortableCanonicalTask } from "./company-portability-task-persistence.js";
import { parseFrontmatterMarkdown } from "./company-portability-format-support.js";
import type { CompanyPortabilityOperationScope } from "./company-portability.js";

export async function runCompanyImportPhase4(
  scope: CompanyPortabilityOperationScope,
  state: Record<string, any>,
) {
  const { db, ordinaryTasks, secretsRuntime, resolveImportedOwnerAgentId, actorUserId } = scope;
  if (state.include.tasks) {
    const routines = routineService(db, {
      ordinaryTasks,
      secretsRuntime,
    });
    for (const manifestTask of state.sourceManifest.tasks) {
      const markdownRaw = readPortableTextFile(state.plan.source.files, manifestTask.path);
      const parsed = markdownRaw ? parseFrontmatterMarkdown(markdownRaw) : null;
      const request = parsed?.body || manifestTask.request;
      const ownerAgentId = resolveImportedOwnerAgentId(
        manifestTask.ownerAgentSlug,
        state.importedSlugToAgentId,
        state.existingSlugToAgentId,
        state.agentStatusById,
        state.warnings,
        `Task ${manifestTask.slug}`,
      );
      const projectId = manifestTask.projectSlug
        ? (state.importedSlugToProjectId.get(manifestTask.projectSlug) ??
          state.existingProjectSlugToId.get(manifestTask.projectSlug) ??
          null)
        : null;
      if (manifestTask.recurring) {
        if (!projectId) {
          throw unprocessable(
            `Recurring task ${manifestTask.slug} is missing the project required to create a routine.`,
          );
        }
        const resolvedRoutine = resolvePortableRoutineDefinition(manifestTask);
        if (resolvedRoutine.errors.length > 0) {
          throw unprocessable(
            `Recurring task ${manifestTask.slug} could not be imported as a routine: ${resolvedRoutine.errors.join("; ")}`,
          );
        }
        state.warnings.push(...resolvedRoutine.warnings);
        const routineDefinition = resolvedRoutine.routine ?? {
          concurrencyPolicy: null,
          catchUpPolicy: null,
          variables: null,
          triggers: [],
        };
        const createdRoutine = await routines.create(
          state.targetCompany.id,
          {
            projectId,
            goalId: null,
            parentTaskId: null,
            title: portableTaskDisplayLabel(manifestTask),
            description: request,
            assigneeAgentId: ownerAgentId,
            priority:
              manifestTask.priority && TASK_PRIORITIES.includes(manifestTask.priority as any)
                ? (manifestTask.priority as (typeof TASK_PRIORITIES)[number])
                : "medium",
            status: manifestTask.boardPresentationStatus as (typeof ROUTINE_STATUSES)[number],
            concurrencyPolicy:
              routineDefinition.concurrencyPolicy &&
              ROUTINE_CONCURRENCY_POLICIES.includes(routineDefinition.concurrencyPolicy as any)
                ? (routineDefinition.concurrencyPolicy as (typeof ROUTINE_CONCURRENCY_POLICIES)[number])
                : "coalesce_if_active",
            catchUpPolicy:
              routineDefinition.catchUpPolicy &&
              ROUTINE_CATCH_UP_POLICIES.includes(routineDefinition.catchUpPolicy as any)
                ? (routineDefinition.catchUpPolicy as (typeof ROUTINE_CATCH_UP_POLICIES)[number])
                : "skip_missed",
            variables: routineDefinition.variables ?? [],
          },
          state.secretMutationActor,
        );
        for (const trigger of routineDefinition.triggers) {
          if (trigger.kind === "schedule") {
            await routines.createTrigger(
              createdRoutine.id,
              {
                kind: "schedule",
                label: trigger.label,
                enabled: trigger.enabled,
                cronExpression: trigger.cronExpression!,
                timezone: trigger.timezone!,
              },
              state.secretMutationActor,
            );
            continue;
          }
          if (trigger.kind === "webhook") {
            await routines.createTrigger(
              createdRoutine.id,
              {
                kind: "webhook",
                label: trigger.label,
                enabled: trigger.enabled,
                signingMode:
                  trigger.signingMode && ROUTINE_TRIGGER_SIGNING_MODES.includes(trigger.signingMode as any)
                    ? (trigger.signingMode as (typeof ROUTINE_TRIGGER_SIGNING_MODES)[number])
                    : "bearer",
                replayWindowSec: trigger.replayWindowSec ?? 300,
              },
              state.secretMutationActor,
            );
            continue;
          }
          await routines.createTrigger(
            createdRoutine.id,
            {
              kind: "api",
              label: trigger.label,
              enabled: trigger.enabled,
            },
            state.secretMutationActor,
          );
        }
        continue;
      }
      if (!actorUserId) {
        throw unprocessable(`Task ${manifestTask.slug} requires a named importing board user`);
      }
      if (!ownerAgentId) {
        throw unprocessable(
          `Task ${manifestTask.slug} requires an invokable owner that exists in the target company`,
        );
      }
      const priority =
        manifestTask.priority && TASK_PRIORITIES.includes(manifestTask.priority as any)
          ? (manifestTask.priority as (typeof TASK_PRIORITIES)[number])
          : "medium";
      if (!TASK_STATUSES.includes(manifestTask.boardPresentationStatus as TaskStatus)) {
        throw unprocessable(`Task ${manifestTask.slug} requires a canonical task boardPresentationStatus`);
      }
      const boardPresentationStatus = manifestTask.boardPresentationStatus as TaskStatus;
      const createdTaskResult =
        manifestTask.lifecycleStatus === "open" && boardPresentationStatus === "todo"
          ? await ordinaryTasks.create({
              companyId: state.targetCompany.id,
              request,
              ownerAgentId,
              creator: {
                kind: "user/board",
                userId: actorUserId,
              },
              idempotencyKey: `company-portability:${state.targetCompany.id}:${manifestTask.slug}`,
              sourceKind: "task_request",
              projectId,
              title: manifestTask.title,
              priority,
              labelIds: manifestTask.labelIds ?? [],
              billingCode: manifestTask.billingCode,
            })
          : await createPortableCanonicalTask(db, {
              companyId: state.targetCompany.id,
              slug: manifestTask.slug,
              request,
              title: manifestTask.title,
              ownerAgentId,
              creatorUserId: actorUserId,
              projectId,
              lifecycleStatus: manifestTask.lifecycleStatus,
              boardPresentationStatus,
              disposition: manifestTask.disposition,
              priority,
              labelIds: manifestTask.labelIds ?? [],
              billingCode: manifestTask.billingCode,
            });
      const createdTask = createdTaskResult.task;
      for (const [commentIndex, comment] of (manifestTask.comments ?? []).entries()) {
        if (comment.authorType === "agent") {
          state.warnings.push(
            `Comment on task ${manifestTask.slug} from agent ${comment.authorAgentSlug ?? "<unknown>"} was imported with system provenance because the portable comment does not include the producing run and adapter revision required for canonical agent attribution.`,
          );
        }
        if (comment.authorType === "user" && !actorUserId) {
          state.warnings.push(
            `Comment on task ${manifestTask.slug} was imported as a system comment because no importing user was available.`,
          );
        }
        const authorType = comment.authorType === "user" && actorUserId ? "user" : "system";
        const sourceKey = createHash("sha256")
          .update(
            JSON.stringify({
              taskSlug: manifestTask.slug,
              commentIndex,
              body: comment.body,
              authorType,
              authorAgentSlug: comment.authorType === "agent" ? comment.authorAgentSlug : null,
              userId: authorType === "user" ? actorUserId : null,
              createdAt: comment.createdAt,
            }),
          )
          .digest("hex");
        if (authorType === "user" && actorUserId) {
          await appendCanonicalUserComment(db, {
            companyId: state.targetCompany.id,
            taskId: createdTask.id,
            sourceKind: "company_portability_import",
            immutableSourceKey: sourceKey,
            sourceRecordId: sourceKey,
            exactText: comment.body,
            userId: actorUserId,
            occurredAt: comment.createdAt,
          });
        } else {
          await appendCanonicalControlNotice(db, {
            companyId: state.targetCompany.id,
            taskId: createdTask.id,
            sourceKind: "company_portability_import",
            immutableSourceKey: sourceKey,
            sourceRecordId: sourceKey,
            exactText: comment.body,
            comment: {
              author: { kind: "system", source: "control" },
              producingRun: null,
            },
            occurredAt: comment.createdAt,
            allowTerminal: true,
          });
        }
      }
    }
  }
}
