import type { Approval, JoinRequest, TaskExecutionRunEnvelopeRecord } from "@paperclipai/shared";
import { parseMoneyAmount } from "@paperclipai/shared";

export const ZERO_AMOUNT = parseMoneyAmount("0");

export type CreatorOption = {
  id: string;
  label: string;
  kind: "agent" | "user";
  searchText?: string;
};

export function runFailureMessage(run: TaskExecutionRunEnvelopeRecord): string {
  return run.terminalReasonCode?.replace(/_/g, " ") ?? "Run exited with an error.";
}

export function approvalStatusLabel(status: Approval["status"]): string {
  return status.replaceAll("_", " ");
}

export function readTaskIdFromRun(run: TaskExecutionRunEnvelopeRecord): string {
  return run.taskId;
}

export function nonEmptyLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function formatJoinRequestInboxLabel(
  joinRequest: Pick<JoinRequest, "requestEmailSnapshot" | "requestingUserId"> & {
    requesterUser?: {
      name: string | null;
      email: string | null;
    } | null;
  },
) {
  const requesterName = nonEmptyLabel(joinRequest.requesterUser?.name);
  const requesterEmail =
    nonEmptyLabel(joinRequest.requesterUser?.email) ?? nonEmptyLabel(joinRequest.requestEmailSnapshot);
  const requesterId = nonEmptyLabel(joinRequest.requestingUserId);

  if (requesterName && requesterEmail) return `${requesterName} (${requesterEmail})`;
  if (requesterEmail) return requesterEmail;
  if (requesterName) return requesterName;
  if (requesterId) return requesterId;
  return "User join request";
}
