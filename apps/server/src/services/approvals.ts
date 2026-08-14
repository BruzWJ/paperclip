import { type Db, approvalComments, approvals } from "@paperclipai/db";
import { type AgentLifecycleCancellationService } from "./agents.js";

import {
  type HireRejectionAgentTerminationOwner,
  createApprovalsContext,
  type ApprovalsContext,
} from "./approval-lifecycle-foundation.js";

import { buildApprovalsApprovalHireValidation } from "./approval-hire-validation.js";
import { buildApprovalsApprovalResolution } from "./approval-resolution.js";

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { isCanonicalUuid, type ApprovalStatus } from "@paperclipai/shared";
import { conflict, unprocessable } from "../errors.js";
import { redactCurrentUserText } from "../log-redaction.js";
import {
  createRuntimeAgentConfigurationService,
  type RuntimeAgentConfigurationBoardActor,
} from "./runtime-agent-configuration.js";

export function buildApprovalsApprovalRevision(
  scope: ApprovalsContext &
    ReturnType<typeof buildApprovalsApprovalHireValidation> &
    ReturnType<typeof buildApprovalsApprovalResolution>,
) {
  const { db, lockAndAssertPendingHire, updateApprovalDecision, lockHireApprovalForUpdate } = scope;

  async function requestHireRevision(
    id: string,
    decidedByUserId: string,
    decisionNote: string | null | undefined,
  ) {
    return db.transaction(async (tx) => {
      const existing = await lockHireApprovalForUpdate(tx, id);
      if (existing.status !== "pending") {
        throw unprocessable("Only pending approvals can request revision");
      }
      await lockAndAssertPendingHire(tx, existing);

      const now = new Date();
      const updated = await updateApprovalDecision(tx, {
        id,
        expectedStatuses: ["pending"],
        status: "revision_requested",
        decidedByUserId,
        decisionNote,
        decidedAt: now,
      });
      if (!updated) {
        throw conflict("Hire approval revision request lost its locked transition", {
          code: "hire_approval_revision_conflict",
          approvalId: id,
        });
      }
      return updated;
    });
  }

  return { requestHireRevision };
}

export function createApprovalsMethods1(
  scope: ApprovalsContext &
    ReturnType<typeof buildApprovalsApprovalHireValidation> &
    ReturnType<typeof buildApprovalsApprovalResolution> &
    ReturnType<typeof buildApprovalsApprovalRevision>,
) {
  const {
    db,
    instanceSettings,
    resolvableStatuses,
    redactApprovalComment,
    getExistingApproval,
    updateApprovalDecision,
    resolveApproval,
    resolveHireApproval,
    requestHireRevision,
  } = scope;

  type ApprovalRecord = typeof approvals.$inferSelect;

  type ResolutionResult = { approval: ApprovalRecord; applied: boolean };

  type ApprovalTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

  return {
    list: (companyId: string, status?: ApprovalStatus) => {
      const conditions = [eq(approvals.companyId, companyId)];
      if (status) conditions.push(eq(approvals.status, status));
      return db
        .select()
        .from(approvals)
        .where(and(...conditions));
    },

    getById: (id: string) => {
      if (!isCanonicalUuid(id)) return Promise.resolve(null);
      return db
        .select()
        .from(approvals)
        .where(eq(approvals.id, id))
        .then((rows) => rows[0] ?? null);
    },

    findOpenHireApprovalForAgent: async (companyId: string, agentId: string) => {
      const rows = await db
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.companyId, companyId),
            eq(approvals.type, "hire_agent"),
            inArray(approvals.status, resolvableStatuses),
            sql`${approvals.payload} ->> 'agentId' = ${agentId}`,
          ),
        );
      return rows[0] ?? null;
    },

    create: (companyId: string, data: Omit<typeof approvals.$inferInsert, "companyId">) => {
      if (data.type === "hire_agent") {
        throw unprocessable("Hire approvals are created only by the canonical runtime-agent transaction");
      }
      return db
        .insert(approvals)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]);
    },

    approve: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const existing = await getExistingApproval(id);
      if (existing.type === "hire_agent") {
        return resolveHireApproval(id, "approved", decidedByUserId, decisionNote);
      }
      const { approval: updated, applied } = await resolveApproval(
        id,
        "approved",
        decidedByUserId,
        decisionNote,
      );
      return { approval: updated, applied };
    },

    reject: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const existing = await getExistingApproval(id);
      if (existing.type === "hire_agent") {
        return resolveHireApproval(id, "rejected", decidedByUserId, decisionNote);
      }
      const { approval: updated, applied } = await resolveApproval(
        id,
        "rejected",
        decidedByUserId,
        decisionNote,
      );
      return { approval: updated, applied };
    },

    requestRevision: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const existing = await getExistingApproval(id);
      if (existing.type === "hire_agent") {
        return requestHireRevision(id, decidedByUserId, decisionNote);
      }
      if (existing.status !== "pending") {
        throw unprocessable("Only pending approvals can request revision");
      }

      const now = new Date();
      const updated = await updateApprovalDecision(db, {
        id,
        expectedStatuses: ["pending"],
        status: "revision_requested",
        decidedByUserId,
        decisionNote,
        decidedAt: now,
      });
      if (!updated) {
        throw unprocessable("Only pending approvals can request revision");
      }
      return updated;
    },

    resubmit: async (id: string, payload?: Record<string, unknown>) => {
      const existing = await getExistingApproval(id);
      if (existing.status !== "revision_requested") {
        throw unprocessable("Only revision requested approvals can be resubmitted");
      }
      if (existing.type === "hire_agent") {
        throw unprocessable(
          "Hire approvals require the exact runtime-agent audit/digest resubmission contract",
        );
      }

      const now = new Date();
      return db
        .update(approvals)
        .set({
          status: "pending",
          payload: payload ?? existing.payload,
          decisionNote: null,
          decidedByUserId: null,
          decidedAt: null,
          updatedAt: now,
        })
        .where(eq(approvals.id, id))
        .returning()
        .then((rows) => rows[0]);
    },

    resubmitHire: async (input: {
      approvalId: string;
      actor: RuntimeAgentConfigurationBoardActor;
      agentId: string;
      runtimeAgentConfigurationAuditId: string;
      runtimeAgentConfigurationRequestDigest: string;
      configuration: unknown;
    }) => {
      await createRuntimeAgentConfigurationService(db).resubmitHireApproval({
        approvalId: input.approvalId,
        actor: input.actor,
        expectedAgentId: input.agentId,
        expectedAuditId: input.runtimeAgentConfigurationAuditId,
        expectedRequestDigest: input.runtimeAgentConfigurationRequestDigest,
        configuration: input.configuration,
      });
      return getExistingApproval(input.approvalId);
    },

    listComments: async (approvalId: string) => {
      const existing = await getExistingApproval(approvalId);
      const { censorUsernameInLogs } = await instanceSettings.getGeneral();
      return db
        .select()
        .from(approvalComments)
        .where(
          and(
            eq(approvalComments.approvalId, approvalId),
            eq(approvalComments.companyId, existing.companyId),
          ),
        )
        .orderBy(asc(approvalComments.createdAt))
        .then((comments) => comments.map((comment) => redactApprovalComment(comment, censorUsernameInLogs)));
    },

    addComment: async (approvalId: string, body: string, actor: { agentId?: string; userId?: string }) => {
      const existing = await getExistingApproval(approvalId);
      const currentUserRedactionOptions = {
        enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
      };
      const redactedBody = redactCurrentUserText(body, currentUserRedactionOptions);
      return db
        .insert(approvalComments)
        .values({
          companyId: existing.companyId,
          approvalId,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
          body: redactedBody,
        })
        .returning()
        .then((rows) => redactApprovalComment(rows[0], currentUserRedactionOptions.enabled));
    },
  };
}

export {
  type ApprovalLifecycleTransaction,
  type HireRejectionAgentTerminationInput,
  type HireRejectionAgentTerminationOwner,
  withdrawOpenHireApprovalForAgentInTransaction,
} from "./approval-lifecycle-foundation.js";

export function approvalService(
  db: Db,
  options: {
    taskExecutionCancellation: AgentLifecycleCancellationService;
    terminateHireRejectionAgentInTransaction: HireRejectionAgentTerminationOwner;
    dispatchRef(refId: string): Promise<void>;
  },
) {
  const context = createApprovalsContext(db, options);
  const helpers1 = buildApprovalsApprovalHireValidation(context);
  const scope1 = { ...context, ...helpers1 };
  const helpers2 = buildApprovalsApprovalResolution(scope1);
  const scope2 = { ...scope1, ...helpers2 };
  const helpers3 = buildApprovalsApprovalRevision(scope2);
  const scope3 = { ...scope2, ...helpers3 };
  const scope = scope3;
  const methods1 = createApprovalsMethods1(scope);
  return { ...methods1 };
}
