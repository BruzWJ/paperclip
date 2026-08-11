import {
  issueBoardLifecycleCommands,
  type IssueBoardLifecycleCommand,
} from "@paperclipai/db";
import type { IssueBoardLifecycleCommandSubtype } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import type { IssueSessionDbTransaction } from "./issue-session/event-store.js";

export interface NamedBoardLifecycleAffectedIssue {
  readonly id: string;
  readonly ownershipEpoch: number;
}

export interface RecordNamedBoardLifecycleCommandInput {
  readonly companyId: string;
  readonly affectedIssues: readonly NamedBoardLifecycleAffectedIssue[];
  readonly actorUserId: string;
  readonly subtype: IssueBoardLifecycleCommandSubtype;
  readonly sourceCommandId: string;
  readonly idempotencyKey: string;
  readonly committedAt: Date;
}

function sameInstant(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime();
}

function assertExistingCommand(
  row: IssueBoardLifecycleCommand,
  input: RecordNamedBoardLifecycleCommandInput,
  issue: NamedBoardLifecycleAffectedIssue,
): void {
  if (
    row.companyId !== input.companyId ||
    row.issueId !== issue.id ||
    row.ownershipEpoch !== issue.ownershipEpoch ||
    row.actorUserId !== input.actorUserId ||
    row.subtype !== input.subtype ||
    row.sourceCommandId !== input.sourceCommandId ||
    row.idempotencyKey !== input.idempotencyKey ||
    !sameInstant(row.committedAt, input.committedAt)
  ) {
    throw new Error(
      "Board lifecycle command source was retried with different immutable facts",
    );
  }
}

/**
 * Appends one typed liveness source for every issue actually mutated by one
 * directly authenticated named-user board command. Callers derive every
 * field from locked domain rows; request payloads never choose a subtype,
 * source id, epoch, or commit time.
 */
export async function recordNamedBoardLifecycleCommandInTransaction(
  tx: IssueSessionDbTransaction,
  input: RecordNamedBoardLifecycleCommandInput,
): Promise<readonly IssueBoardLifecycleCommand[]> {
  const affectedById = new Map<string, NamedBoardLifecycleAffectedIssue>();
  for (const issue of input.affectedIssues) {
    const previous = affectedById.get(issue.id);
    if (previous && previous.ownershipEpoch !== issue.ownershipEpoch) {
      throw new Error(
        "One board lifecycle command cannot target two epochs of one issue",
      );
    }
    affectedById.set(issue.id, issue);
  }

  const rows: IssueBoardLifecycleCommand[] = [];
  for (const issue of [...affectedById.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const existing = await tx
      .select()
      .from(issueBoardLifecycleCommands)
      .where(
        and(
          eq(issueBoardLifecycleCommands.companyId, input.companyId),
          eq(issueBoardLifecycleCommands.issueId, issue.id),
          eq(
            issueBoardLifecycleCommands.sourceCommandId,
            input.sourceCommandId,
          ),
        ),
      )
      .limit(1)
      .then((found) => found[0] ?? null);

    const row =
      existing ??
      (await tx
        .insert(issueBoardLifecycleCommands)
        .values({
          companyId: input.companyId,
          issueId: issue.id,
          ownershipEpoch: issue.ownershipEpoch,
          actorUserId: input.actorUserId,
          subtype: input.subtype,
          sourceCommandId: input.sourceCommandId,
          idempotencyKey: input.idempotencyKey,
          committedAt: input.committedAt,
        })
        .returning()
        .then((inserted) => inserted[0] ?? null));
    if (!row) {
      throw new Error("Board lifecycle command source was not persisted");
    }
    assertExistingCommand(row, input, issue);
    rows.push(row);
  }
  return rows;
}
