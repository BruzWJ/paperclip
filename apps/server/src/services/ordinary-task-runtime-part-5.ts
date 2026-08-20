import { pluginWithdrawalOperations, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import * as runtime from "./ordinary-task-runtime-shared.js";
import type { OrdinaryPluginWithdrawalPrepareInput } from "./ordinary-task-runtime-shared-part-1.js";

export function createOrdinaryTaskRuntimePart5(db: Db) {
  return {
    async preparePluginWithdrawal(input: OrdinaryPluginWithdrawalPrepareInput) {
      const message = runtime.nonBlankPreservingBytes(input.message, "message");
      const operationId = runtime.exactNonBlank(input.operationId, "operationId");
      const identityDigest = createHash("sha256")
        .update(
          runtime.canonicalJson({
            companyId: input.companyId,
            taskId: input.taskId,
            message,
            operationId,
            pluginInstallationId: input.pluginInstallationId,
            pluginKey: input.pluginKey,
          }),
        )
        .digest("hex");
      const inserted = await db
        .insert(pluginWithdrawalOperations)
        .values({
          companyId: input.companyId,
          pluginInstallationId: input.pluginInstallationId,
          pluginKey: input.pluginKey,
          hostRpcOperationId: operationId,
          identityDigest,
          taskId: input.taskId,
          message,
          state: "pending",
          result: null,
          taskUpdateId: null,
          mutationCommentId: null,
        })
        .onConflictDoNothing()
        .returning()
        .then((rows) => rows[0] ?? null);
      const operation =
        inserted ??
        (await db
          .select()
          .from(pluginWithdrawalOperations)
          .where(
            and(
              eq(pluginWithdrawalOperations.pluginInstallationId, input.pluginInstallationId),
              eq(pluginWithdrawalOperations.hostRpcOperationId, operationId),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null));
      if (
        !operation ||
        operation.identityDigest !== identityDigest ||
        operation.companyId !== input.companyId ||
        operation.taskId !== input.taskId ||
        operation.pluginKey !== input.pluginKey ||
        operation.message !== message
      ) {
        throw new runtime.OrdinaryTaskRuntimeRejected(
          "Plugin withdrawal operation changed immutable input",
          "plugin_withdrawal_idempotency_conflict",
        );
      }
      return { operationId };
    },
  };
}
