import {
  issueSessionInputDispositions,
  issueSessionInputs,
  issueSessionMessages,
  type Db,
} from "@paperclipai/db";
import {
  encodeIssueSessionEvent,
  type DurableEvent,
} from "@paperclipai/shared/issue-session";
import { and, eq, isNull } from "drizzle-orm";
import {
  canonicalIssueSessionJson,
  IssueSessionInvariantError,
  IssueSessionLifecycleConflict,
} from "./store.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface IssueSessionInputBinding {
  sourceRefId: string | null;
  dispositionId: string;
}

function promptProjection(event: DurableEvent) {
  if (
    event.type !== "session.next.prompt.admitted" &&
    event.type !== "session.next.prompted"
  ) {
    throw new IssueSessionLifecycleConflict(
      "Issue Session input projection requires a prompt event",
      { eventType: event.type },
    );
  }
  if (!event.durable) {
    throw new IssueSessionLifecycleConflict(
      "Issue Session prompt event has no durable sequence",
      { eventType: event.type },
    );
  }
  const wire = encodeIssueSessionEvent(event);
  const data = wire.data as {
    messageID: string;
    sessionID: string;
    timestamp: number;
    prompt: Record<string, unknown>;
    delivery: "steer" | "queue";
  };
  return {
    id: data.messageID,
    sessionId: data.sessionID,
    prompt: data.prompt,
    delivery: data.delivery,
    timestamp: new Date(data.timestamp),
    seq: event.durable.seq,
  };
}

function sameInput(
  row: typeof issueSessionInputs.$inferSelect,
  input: ReturnType<typeof promptProjection>,
): boolean {
  return (
    row.id === input.id &&
    row.sessionId === input.sessionId &&
    row.delivery === input.delivery &&
    canonicalIssueSessionJson(row.prompt) ===
      canonicalIssueSessionJson(input.prompt) &&
    row.timeCreated.getTime() === input.timestamp.getTime()
  );
}

async function insertDisposition(
  transaction: Transaction,
  input: ReturnType<typeof promptProjection>,
  binding: IssueSessionInputBinding | undefined,
  scope: { companyId: string; issueId: string },
): Promise<void> {
  if (!binding) {
    throw new IssueSessionLifecycleConflict(
      "A new Issue Session input requires its Paperclip correlation binding",
      { sessionId: input.sessionId, inputId: input.id },
    );
  }
  await transaction.insert(issueSessionInputDispositions).values({
    id: binding.dispositionId,
    companyId: scope.companyId,
    issueId: scope.issueId,
    sessionId: input.sessionId,
    inputId: input.id,
    sourceRefId: binding.sourceRefId,
    state: "active",
  });
}

/** Applies one durable prompt lifecycle event to the physical input inbox. */
export async function projectIssueSessionInput(
  transaction: Transaction,
  input: {
    event: DurableEvent;
    companyId: string;
    issueId: string;
    binding?: IssueSessionInputBinding;
    rebuilding: boolean;
  },
): Promise<void> {
  const projection = promptProjection(input.event);
  const existingRows = await transaction
    .select()
    .from(issueSessionInputs)
    .where(
      and(
        eq(issueSessionInputs.companyId, input.companyId),
        eq(issueSessionInputs.issueId, input.issueId),
        eq(issueSessionInputs.sessionId, projection.sessionId),
        eq(issueSessionInputs.id, projection.id),
      ),
    )
    .limit(1);
  const existing = existingRows[0];

  if (input.event.type === "session.next.prompt.admitted") {
    const messages = await transaction
      .select({ id: issueSessionMessages.id })
      .from(issueSessionMessages)
      .where(
        and(
          eq(issueSessionMessages.sessionId, projection.sessionId),
          eq(issueSessionMessages.id, projection.id),
        ),
      )
      .limit(1);
    if (messages[0]) {
      throw new IssueSessionLifecycleConflict(
        "Prompt admission reused a projected message identity",
        { inputId: projection.id },
      );
    }
    if (existing) {
      if (
        !sameInput(existing, projection) ||
        existing.admittedSeq !== projection.seq ||
        existing.promotedSeq !== null
      ) {
        throw new IssueSessionLifecycleConflict(
          "Prompt admission changed an existing Issue Session input",
          { inputId: projection.id },
        );
      }
      return;
    }
    if (input.rebuilding) {
      throw new IssueSessionInvariantError(
        `Rebuild is missing admitted Issue Session input ${projection.id}`,
      );
    }
    const inserted = await transaction
      .insert(issueSessionInputs)
      .values({
        id: projection.id,
        companyId: input.companyId,
        issueId: input.issueId,
        sessionId: projection.sessionId,
        prompt: projection.prompt,
        delivery: projection.delivery,
        admittedSeq: projection.seq,
        promotedSeq: null,
        timeCreated: projection.timestamp,
      })
      .returning({ id: issueSessionInputs.id });
    if (!inserted[0]) {
      throw new IssueSessionInvariantError(
        `Issue Session input ${projection.id} was not admitted`,
      );
    }
    await insertDisposition(
      transaction,
      projection,
      input.binding,
      input,
    );
    return;
  }

  if (existing) {
    if (!sameInput(existing, projection)) {
      throw new IssueSessionLifecycleConflict(
        "Prompt promotion changed an existing Issue Session input",
        { inputId: projection.id },
      );
    }
    if (existing.promotedSeq === projection.seq) return;
    if (existing.promotedSeq !== null) {
      throw new IssueSessionLifecycleConflict(
        "Issue Session input was promoted at a different sequence",
        { inputId: projection.id },
      );
    }
    const updated = await transaction
      .update(issueSessionInputs)
      .set({ promotedSeq: projection.seq })
      .where(
        and(
          eq(issueSessionInputs.id, projection.id),
          isNull(issueSessionInputs.promotedSeq),
        ),
      )
      .returning({ id: issueSessionInputs.id });
    if (!updated[0]) {
      throw new IssueSessionLifecycleConflict(
        "Issue Session input promotion lost its lifecycle race",
        { inputId: projection.id },
      );
    }
    return;
  }

  const inserted = await transaction
    .insert(issueSessionInputs)
    .values({
      id: projection.id,
      companyId: input.companyId,
      issueId: input.issueId,
      sessionId: projection.sessionId,
      prompt: projection.prompt,
      delivery: projection.delivery,
      admittedSeq: projection.seq,
      promotedSeq: projection.seq,
      timeCreated: projection.timestamp,
    })
    .returning({ id: issueSessionInputs.id });
  if (!inserted[0]) {
    throw new IssueSessionInvariantError(
      `Issue Session input ${projection.id} was not promoted`,
    );
  }
  await insertDisposition(transaction, projection, input.binding, input);
}
