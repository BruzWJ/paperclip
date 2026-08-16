import { companies, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  renderPaperclipCommentMention,
  type PaperclipManagedAgentMessage,
} from "./paperclip-agent-message.js";
import {
  RuntimeTaskActionConflict,
  RuntimeTaskActionDenied,
} from "./runtime-task-action-port-shared-part-1.js";
import type { TaskMentionRecipient } from "./runtime-task-action-port-shared-part-2.js";
import type { TaskFormCommitRuntimeOptions } from "./runtime-task-action-port-shared-part-4.js";
import {
  admitAgentTextInTransaction,
  admitManagedAgentMessageInTransaction,
  canDispatchAgentCounterpartTarget,
  mentionBoardInTransaction,
  sameTaskAgentTarget,
} from "./runtime-task-action-port-shared-part-5.js";
import {
  createTaskSessionAdmissionService,
  type TaskSessionAdmissionService,
  type TaskSessionExecutionActor,
  type TaskSessionProjectedCommentAttribution,
} from "./task-session/admission.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

type CanonicalTaskUpdateMessage =
  | {
      kind: "managed";
      delivery: PaperclipManagedAgentMessage<"task_update">;
    }
  | {
      kind: "system";
      body: string;
    };

export async function admitCounterpartTaskUpdate(
  sessionAdmission: TaskSessionAdmissionService,
  tx: TaskSessionDbTransaction,
  input: {
    companyId: string;
    target: TaskMentionRecipient;
    actor: TaskSessionExecutionActor;
    comment: TaskSessionProjectedCommentAttribution;
    counterpart?: {
      counterpartTaskId: string;
      counterpartAuthorityId: string;
      counterpartOwnershipEpoch: number;
    };
    sourceAgentTarget?: { taskId: string; agentId: string } | null;
    immutableSourceKey: string;
    sourceRecordId: string;
    sourceKind: "task_update";
    message: CanonicalTaskUpdateMessage;
  },
) {
  const counterpart = input.counterpart ?? {};
  const sourceKind = "task_update" as const;
  const rawMessage = input.message.kind === "managed" ? input.message.delivery.body : input.message.body;
  if ((input.message.kind === "system") !== (input.actor.kind === "system")) {
    throw new RuntimeTaskActionConflict(
      "System recovery text requires a system actor and managed task updates require a non-system actor",
    );
  }
  const selfTarget =
    input.target.kind === "agent" && sameTaskAgentTarget(input.sourceAgentTarget, input.target.target);
  const dispatchTarget =
    input.target.kind === "agent" &&
    !selfTarget &&
    (await canDispatchAgentCounterpartTarget(tx, input.companyId, input.target.target));
  if (dispatchTarget && input.target.kind === "agent") {
    const target = input.target.target;
    const dispatchScope = {
      companyId: input.companyId,
      taskId: target.taskId,
      sessionId: target.sessionId,
      ownershipEpoch: target.ownershipEpoch,
      targetAgentId: target.agentId,
      taskExecutionAuthorityId: target.authorityId,
      consultExecutionId: null,
      adapterConfigRevisionId: target.adapterConfigRevisionId,
      contextEpoch: target.contextGeneration,
      mode: "owner" as const,
      ...counterpart,
      immutableSourceKey: input.immutableSourceKey,
      sourceRecordId: input.sourceRecordId,
      comment: input.comment,
      idempotencyKey: input.immutableSourceKey,
    };
    if (input.message.kind === "system") {
      return admitAgentTextInTransaction(sessionAdmission, tx, {
        ...dispatchScope,
        sourceKind: "task_update",
        actor: input.actor,
        exactText: input.message.body,
        comment: {
          ...input.comment,
          body: renderPaperclipCommentMention(
            {
              kind: "agent",
              agent: { id: target.agentId, name: target.agentName },
            },
            input.message.body,
          ),
        },
      });
    }
    return admitManagedAgentMessageInTransaction(sessionAdmission, tx, {
      ...dispatchScope,
      sourceKind: "task_update",
      actor: input.actor,
      delivery: input.message.delivery,
      recipient: { id: target.agentId, name: target.agentName },
    });
  }
  if (input.actor.kind === "agent-execution" && (input.target.kind === "board" || !selfTarget)) {
    return mentionBoardInTransaction(sessionAdmission, tx, {
      companyId: input.companyId,
      target: input.target.target,
      actor: input.actor,
      comment: input.comment,
      counterpart: input.counterpart,
      sourceKind,
      immutableSourceKey: input.immutableSourceKey,
      sourceRecordId: input.sourceRecordId,
      message: rawMessage,
    });
  }
  const target = input.target.target;
  const commentBody = renderPaperclipCommentMention(
    input.target.kind === "agent"
      ? {
          kind: "agent",
          agent: {
            id: input.target.target.agentId,
            name: input.target.target.agentName,
          },
        }
      : { kind: "board" },
    rawMessage,
  );
  return sessionAdmission.appendNonDispatchControlNotice(
    {
      companyId: input.companyId,
      taskId: target.taskId,
      sessionId: target.sessionId,
      sourceKind,
      actor: input.actor,
      ...counterpart,
      immutableSourceKey: input.immutableSourceKey,
      sourceRecordId: input.sourceRecordId,
      exactText: commentBody,
      comment: {
        ...input.comment,
        body: commentBody,
      },
      allowTerminal: false,
    },
    tx,
  );
}

export async function lockReadyCompany(tx: TaskSessionDbTransaction, companyId: string): Promise<void> {
  const company = await tx
    .select()
    .from(companies)
    .where(eq(companies.id, companyId))
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (
    !company ||
    company.status !== "active" ||
    company.sessionIntegrityState !== "ready" ||
    company.hardDeleteFencedAt !== null
  ) {
    throw new RuntimeTaskActionDenied("Company Session lifecycle is not ready", "company_inactive");
  }
}

export function createTaskFormCommitRuntimeContext(db: Db, options: TaskFormCommitRuntimeOptions) {
  const clock = options.clock ?? (() => new Date());
  const sessionAdmission = createTaskSessionAdmissionService(db, { clock });
  return { db, options, clock, sessionAdmission };
}
