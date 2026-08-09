import {
  activityLog,
  authUsers,
  companyMemberships,
  issueExecutionWatchdogDecisions,
  issues,
  type Db,
} from "@paperclipai/db";
import {
  issueExecutionWatchdogDecisionInputSchema,
  type IssueExecutionWatchdogDecisionInput,
} from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import { badRequest, forbidden, notFound } from "../errors.js";
import {
  lockIssueExecutionRunInTransaction,
  resolveIssueExecutionRunIdentityById,
} from "./issue-execution-run-service.js";

export type IssueExecutionWatchdogDecisionActor =
  | { readonly kind: "user"; readonly userId: string }
  | {
      readonly kind: "agent";
      readonly agentId: string;
      readonly causalRunId: string;
    };

export interface RecordIssueExecutionWatchdogDecisionInput {
  readonly runId: string;
  readonly actor: IssueExecutionWatchdogDecisionActor;
  readonly decision: IssueExecutionWatchdogDecisionInput;
  readonly now?: Date;
}

function exactIdentifier(value: string, label: string): string {
  if (value.length === 0 || value !== value.trim()) {
    throw badRequest(`${label} must be exact and non-empty`);
  }
  return value;
}

function exactDate(value: Date, label: string): Date {
  if (!Number.isFinite(value.getTime())) {
    throw badRequest(`${label} must be a valid date`);
  }
  return value;
}

export function createIssueExecutionWatchdogDecisionService(db: Db) {
  return {
    async record(input: RecordIssueExecutionWatchdogDecisionInput) {
      const runId = exactIdentifier(input.runId, "run id");
      const actor =
        input.actor.kind === "user"
          ? {
              kind: "user" as const,
              userId: exactIdentifier(input.actor.userId, "user id"),
            }
          : {
              kind: "agent" as const,
              agentId: exactIdentifier(input.actor.agentId, "agent id"),
              causalRunId: exactIdentifier(
                input.actor.causalRunId,
                "causal run id",
              ),
            };
      const decision = issueExecutionWatchdogDecisionInputSchema.parse(
        input.decision,
      );
      const now = exactDate(input.now ?? new Date(), "decision time");
      const snoozedUntil =
        decision.snoozedUntil == null
          ? null
          : exactDate(new Date(decision.snoozedUntil), "snoozedUntil");
      if (
        decision.decision === "snooze" &&
        (!snoozedUntil || snoozedUntil.getTime() <= now.getTime())
      ) {
        throw badRequest("snoozedUntil must be in the future");
      }

      const identity = await resolveIssueExecutionRunIdentityById(db, runId);
      if (!identity) throw notFound("Issue execution run not found");

      return db.transaction(async (transaction) => {
        const run = await lockIssueExecutionRunInTransaction(
          transaction,
          identity,
        );
        const evaluationIssueId = decision.evaluationIssueId ?? null;
        const evaluationIssue = evaluationIssueId
          ? await transaction
              .select({
                id: issues.id,
                companyId: issues.companyId,
                lifecycleStatus: issues.lifecycleStatus,
                hiddenAt: issues.hiddenAt,
                ownerKind: issues.ownerKind,
                ownerAgentId: issues.ownerAgentId,
                affectedIssueId: issues.escalatedFromAffectedIssueId,
                triggeringRunId: issues.escalatedFromTriggeringRunId,
              })
              .from(issues)
              .where(
                and(
                  eq(issues.companyId, run.companyId),
                  eq(issues.id, evaluationIssueId),
                ),
              )
              .limit(1)
              .for("update")
              .then((rows) => rows[0] ?? null)
          : null;
        if (evaluationIssueId && !evaluationIssue) {
          throw notFound("Watchdog evaluation issue not found");
        }
        if (
          evaluationIssue &&
          (evaluationIssue.affectedIssueId !== run.issueId ||
            evaluationIssue.triggeringRunId !== run.runId)
        ) {
          throw forbidden(
            "Watchdog evaluation issue is not bound to the target run",
          );
        }

        if (actor.kind === "user") {
          const [user, membership] = await Promise.all([
            transaction
              .select({ id: authUsers.id })
              .from(authUsers)
              .where(eq(authUsers.id, actor.userId))
              .limit(1)
              .then((rows) => rows[0] ?? null),
            transaction
              .select({
                id: companyMemberships.id,
                status: companyMemberships.status,
                membershipRole: companyMemberships.membershipRole,
              })
              .from(companyMemberships)
              .where(
                and(
                  eq(companyMemberships.companyId, run.companyId),
                  eq(companyMemberships.principalType, "user"),
                  eq(companyMemberships.principalUserId, actor.userId),
                  eq(companyMemberships.status, "active"),
                ),
              )
              .limit(1)
              .then((rows) => rows[0] ?? null),
          ]);
          if (!user || !membership || membership.membershipRole === "viewer") {
            throw forbidden(
              "Watchdog decisions require active board write access",
            );
          }
        } else {
          if (
            !evaluationIssue ||
            evaluationIssue.hiddenAt !== null ||
            !["open", "blocked"].includes(
              evaluationIssue.lifecycleStatus,
            ) ||
            evaluationIssue.ownerKind !== "agent" ||
            evaluationIssue.ownerAgentId !== actor.agentId
          ) {
            throw forbidden(
              "Only the exact active recovery-issue owner may record an agent watchdog decision",
            );
          }
          const causalRun = await lockIssueExecutionRunInTransaction(
            transaction,
            {
              companyId: run.companyId,
              issueId: evaluationIssue.id,
              runId: actor.causalRunId,
            },
          );
          if (
            causalRun.kind !== "productive" ||
            causalRun.executionMode !== "owner" ||
            causalRun.targetAgentId !== actor.agentId ||
            causalRun.status !== "running"
          ) {
            throw forbidden(
              "Agent watchdog decision lacks its exact active causal owner run",
            );
          }
        }

        const rows = await transaction
          .insert(issueExecutionWatchdogDecisions)
          .values({
            companyId: run.companyId,
            runId: run.runId,
            evaluationIssueId,
            decision: decision.decision,
            snoozedUntil,
            reason: decision.reason ?? null,
            createdByAgentId:
              actor.kind === "agent" ? actor.agentId : null,
            createdByUserId: actor.kind === "user" ? actor.userId : null,
            createdByRunId:
              actor.kind === "agent" ? actor.causalRunId : null,
            createdAt: now,
          })
          .returning();
        const row = rows[0];
        if (!row) {
          throw new Error("Watchdog decision insert returned no row");
        }
        await transaction.insert(activityLog).values({
          companyId: run.companyId,
          actorType: actor.kind,
          actorId:
            actor.kind === "agent" ? actor.agentId : actor.userId,
          action: "issue_execution.watchdog_decision_recorded",
          entityType: "issue_execution_run",
          entityId: run.runId,
          agentId: actor.kind === "agent" ? actor.agentId : null,
          runId: run.runId,
          responsibleUserId:
            actor.kind === "user" ? actor.userId : null,
          details: {
            watchdogDecisionId: row.id,
            decision: row.decision,
            evaluationIssueId: row.evaluationIssueId,
            snoozedUntil: row.snoozedUntil?.toISOString() ?? null,
          },
          createdAt: now,
        });
        return row;
      });
    },
  };
}

export type IssueExecutionWatchdogDecisionService = ReturnType<
  typeof createIssueExecutionWatchdogDecisionService
>;
