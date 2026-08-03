import { createHash } from "node:crypto";
import {
  creatorDeliveries,
  instanceSettings,
  issueCreatorEdgeReceivability,
  issueUpdates,
  pluginCreatorDeliveries,
} from "@paperclipai/db";
import { and, eq, max, sql } from "drizzle-orm";
import type { IssueSessionDbTransaction } from "./issue-session/event-store.js";

type DeliveryPolicy = NonNullable<
  typeof instanceSettings.$inferSelect.creatorDelivery
>;
type UpdateRow = typeof issueUpdates.$inferSelect;
type EdgeRow = typeof issueCreatorEdgeReceivability.$inferSelect;
type RecipientKind = EdgeRow["endpointKind"];

function deterministicUuid(namespace: string, key: string): string {
  const bytes = Buffer.from(
    createHash("sha256")
      .update(`${namespace}\0${key}`)
      .digest("hex")
      .slice(0, 32),
    "hex",
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function requiredString(
  value: unknown,
  field: string,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Creator delivery recipient is missing ${field}`);
  }
  return value;
}

export function creatorDeliveryCounterpartExecutionKey(
  recipientKind: RecipientKind,
  recipientRef: Record<string, unknown>,
): string {
  switch (recipientKind) {
    case "agent-execution":
      return `agent-execution:${requiredString(recipientRef.authorityId, "authorityId")}`;
    case "plugin":
      return [
        "plugin",
        requiredString(
          recipientRef.pluginInstallationId,
          "pluginInstallationId",
        ),
        requiredString(recipientRef.pluginKey, "pluginKey"),
        requiredString(recipientRef.callbackKey, "callbackKey"),
        requiredString(recipientRef.callbackVersion, "callbackVersion"),
      ].join(":");
    case "routine":
      return [
        "routine",
        requiredString(recipientRef.routineId, "routineId"),
        requiredString(recipientRef.routineDispatchId, "routineDispatchId"),
      ].join(":");
    case "user/board":
      return `user/board:${typeof recipientRef.userId === "string" ? recipientRef.userId : "company-board"}`;
    case "system":
      return `system:${requiredString(recipientRef.sourceId, "sourceId")}`;
  }
}

export async function enqueueCreatorDelivery(
  tx: IssueSessionDbTransaction,
  input: {
    update: UpdateRow;
    edge: EdgeRow;
    recipientKind: RecipientKind;
    recipientRef: Record<string, unknown>;
    counterpartRefId: string | null;
    policy: DeliveryPolicy;
    now: Date;
  },
) {
  const existing = await tx
    .select()
    .from(creatorDeliveries)
    .where(eq(creatorDeliveries.issueUpdateId, input.update.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (existing) return existing;

  const direction =
    input.update.form === "creator" ? "to_owner" : "to_creator";
  const counterpartExecutionKey =
    creatorDeliveryCounterpartExecutionKey(
      input.recipientKind,
      input.recipientRef,
    );
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${input.update.companyId}:creator-delivery:${counterpartExecutionKey}`}, 0))`,
  );
  const committedSequence = await tx
    .select({ value: max(creatorDeliveries.committedSequence) })
    .from(creatorDeliveries)
    .where(
      and(
        eq(creatorDeliveries.companyId, input.update.companyId),
        eq(
          creatorDeliveries.counterpartExecutionKey,
          counterpartExecutionKey,
        ),
      ),
    )
    .then((rows) => Number(rows[0]?.value ?? -1) + 1);

  const terminal = input.edge.state === "terminal";
  if (terminal && !input.edge.terminalReason) {
    throw new Error(
      "Terminal creator edge is missing its immutable terminal reason",
    );
  }
  const deliveryId = `creator_delivery:${input.update.id}`;
  const idempotencyKey =
    `issue_update:${input.update.gatewayInvocationId}`;
  const delivery = await tx
    .insert(creatorDeliveries)
    .values({
      id: deterministicUuid("creator-delivery", input.update.id),
      companyId: input.update.companyId,
      issueId: input.update.issueId,
      sessionId: input.update.sessionId,
      ownershipEpoch: input.update.ownershipEpoch,
      creatorEdgeId: input.edge.id,
      issueUpdateId: input.update.id,
      commentId: input.update.commentId,
      recipientKind: input.recipientKind,
      recipientRef: input.recipientRef,
      direction,
      counterpartExecutionKey,
      committedSequence,
      deliveryId,
      idempotencyKey,
      state: terminal ? "permanently_unreceivable" : "pending",
      policySnapshot: input.policy,
      firstQueuedAt: input.now,
      terminalAt: terminal ? input.now : null,
      terminalReason: terminal ? input.edge.terminalReason : null,
      counterpartRefId: input.counterpartRefId,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning()
    .then((rows) => rows[0] ?? null);
  if (!delivery) {
    throw new Error("Creator delivery intent was not persisted");
  }

  if (input.recipientKind === "plugin") {
    const pluginInstallationId = requiredString(
      input.recipientRef.pluginInstallationId,
      "pluginInstallationId",
    );
    const pluginKey = requiredString(
      input.recipientRef.pluginKey,
      "pluginKey",
    );
    const callbackKey = requiredString(
      input.recipientRef.callbackKey,
      "callbackKey",
    );
    const callbackVersion = requiredString(
      input.recipientRef.callbackVersion,
      "callbackVersion",
    );
    await tx.insert(pluginCreatorDeliveries).values({
      id: deterministicUuid(
        "plugin-creator-delivery",
        input.update.id,
      ),
      companyId: input.update.companyId,
      issueId: input.update.issueId,
      sessionId: input.update.sessionId,
      creatorDeliveryId: delivery.id,
      pluginInstallationId,
      pluginKey,
      callbackKey,
      callbackVersion,
      committedSequence,
      deliveryId,
      idempotencyKey,
      payload: {
        deliveryId,
        issueId: input.update.issueId,
        companyId: input.update.companyId,
        ownershipEpoch: input.update.ownershipEpoch,
        updateId: input.update.id,
        commentId: input.update.commentId,
        message: input.update.message,
        status: input.update.status,
        disposition: input.update.disposition,
        committedSequence,
      },
      state: terminal ? "permanently_unreceivable" : "pending",
      policySnapshot: input.policy,
      firstQueuedAt: input.now,
      terminalAt: terminal ? input.now : null,
      terminalReason: terminal ? input.edge.terminalReason : null,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  return delivery;
}
