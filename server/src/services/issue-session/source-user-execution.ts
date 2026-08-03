import { issueSessionSourceUserExecutions } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import type { IssueSessionDbTransaction } from "./event-store.js";
import { IssueSessionLifecycleConflict } from "./store.js";

/**
 * The model/agent that produced an ordinary user-shaped boundary is immutable
 * provenance.  Several writers can retry the same durable boundary, but none
 * may silently replace that provenance with data inferred from a later turn.
 */
export interface IssueSessionSourceUserExecutionInput {
  companyId: string;
  issueId: string;
  sessionId: string;
  messageId: string;
  sourceAgentId: string;
  providerId: string;
  modelId: string;
  variant: string | null;
  createdAt?: Date;
}

export async function insertOrAssertIssueSessionSourceUserExecution(
  transaction: IssueSessionDbTransaction,
  input: IssueSessionSourceUserExecutionInput,
): Promise<typeof issueSessionSourceUserExecutions.$inferSelect> {
  await transaction
    .insert(issueSessionSourceUserExecutions)
    .values({
      companyId: input.companyId,
      issueId: input.issueId,
      sessionId: input.sessionId,
      messageId: input.messageId,
      sourceAgentId: input.sourceAgentId,
      providerId: input.providerId,
      modelId: input.modelId,
      variant: input.variant,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    })
    .onConflictDoNothing();

  const existing = await transaction
    .select()
    .from(issueSessionSourceUserExecutions)
    .where(eq(issueSessionSourceUserExecutions.messageId, input.messageId))
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!existing) {
    throw new IssueSessionLifecycleConflict(
      "Issue Session source-user execution was not durable after insertion",
      { messageId: input.messageId },
    );
  }
  if (
    existing.companyId !== input.companyId ||
    existing.issueId !== input.issueId ||
    existing.sessionId !== input.sessionId ||
    existing.messageId !== input.messageId ||
    existing.sourceAgentId !== input.sourceAgentId ||
    existing.providerId !== input.providerId ||
    existing.modelId !== input.modelId ||
    existing.variant !== input.variant
  ) {
    throw new IssueSessionLifecycleConflict(
      "Issue Session source-user execution retry diverges from immutable provenance",
      {
        messageId: input.messageId,
        existing: {
          companyId: existing.companyId,
          issueId: existing.issueId,
          sessionId: existing.sessionId,
          sourceAgentId: existing.sourceAgentId,
          providerId: existing.providerId,
          modelId: existing.modelId,
          variant: existing.variant,
        },
        attempted: {
          companyId: input.companyId,
          issueId: input.issueId,
          sessionId: input.sessionId,
          sourceAgentId: input.sourceAgentId,
          providerId: input.providerId,
          modelId: input.modelId,
          variant: input.variant,
        },
      },
    );
  }
  return existing;
}
