import type {
  AcpPromptAccountingRecord,
  TaskExecutionCostEventRecord,
  TaskExecutionSessionMessageRecord,
} from "@/api/runs";
import {
  TaskSession,
  addMoneyAmounts,
  canonicalizeMoneyAmount,
  type BudgetCurrency,
  type MoneyAmount,
  type TaskExecutionRunEnvelopeRecord,
  type TaskSessionMessage,
} from "@paperclipai/shared";

export type DecodedRunMessage =
  { message: TaskSessionMessage; error: null } | { message: null; error: Error };

export function decodeRunMessage(record: TaskExecutionSessionMessageRecord): DecodedRunMessage {
  try {
    return {
      message: TaskSession.decodeTaskSessionMessage({
        ...record.data,
        id: record.id,
        type: record.type,
      }),
      error: null,
    };
  } catch (cause) {
    return {
      message: null,
      error: cause instanceof Error ? cause : new Error("Unknown session message shape"),
    };
  }
}

export function humanizeRunValue(value: string): string {
  return value
    .replace(/^session\.next\./, "")
    .replace(/\.\d+$/, "")
    .replace(/[_\.\-]/g, " ");
}

export function runDurationMs(run: TaskExecutionRunEnvelopeRecord): number | null {
  if (!run.startedAt) return null;
  const startedAt = new Date(run.startedAt).getTime();
  const finishedAt = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now();
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) return null;
  return Math.max(0, finishedAt - startedAt);
}

export function latestAccountingRecord(
  records: readonly AcpPromptAccountingRecord[],
): AcpPromptAccountingRecord | null {
  return (
    [...records].sort(
      (left, right) =>
        new Date(right.settledAt).getTime() - new Date(left.settledAt).getTime() ||
        right.id.localeCompare(left.id),
    )[0] ?? null
  );
}

export interface KnownRunCost {
  amount: MoneyAmount;
  currency: BudgetCurrency;
  promptCount: number;
  unavailableCount: number;
}

export function summarizeRunCost(costs: readonly TaskExecutionCostEventRecord[]): KnownRunCost | null {
  const known = costs.filter(
    (event): event is TaskExecutionCostEventRecord & { knownDeltaAmount: MoneyAmount } =>
      event.kind === "known" && event.knownDeltaAmount !== null,
  );
  if (known.length === 0) return null;
  const currency = known[0]!.budgetCurrency;
  if (known.some((event) => event.budgetCurrency !== currency)) return null;
  const amount = known.reduce(
    (total, event) => addMoneyAmounts(total, event.knownDeltaAmount),
    canonicalizeMoneyAmount("0"),
  );
  return {
    amount,
    currency,
    promptCount: known.length,
    unavailableCount: costs.filter((event) => event.kind === "unavailable").length,
  };
}

export type RunOutputReference =
  | { kind: "workspace_path"; value: string }
  | { kind: "file_reference"; value: string; name?: string; mediaType: string };

export function collectRunOutputs(
  records: readonly TaskExecutionSessionMessageRecord[],
): RunOutputReference[] {
  const outputs = new Map<string, RunOutputReference>();
  const addWorkspacePath = (value: string) => {
    outputs.set(`workspace:${value}`, { kind: "workspace_path", value });
  };
  const addFileReference = (file: { uri: string; mime: string; name?: string }) => {
    outputs.set(`file:${file.uri}`, {
      kind: "file_reference",
      value: file.uri,
      name: file.name,
      mediaType: file.mime,
    });
  };
  for (const record of records) {
    const decoded = decodeRunMessage(record).message;
    if (decoded?.type !== "assistant") continue;
    for (const path of decoded.snapshot?.files ?? []) addWorkspacePath(path);
    for (const part of decoded.content) {
      if (part.type !== "tool" || part.state.status !== "completed") continue;
      for (const path of part.state.outputPaths ?? []) addWorkspacePath(path);
      for (const file of part.state.attachments ?? []) addFileReference(file);
      for (const content of part.state.content) {
        if (content.type === "file") addFileReference(content);
      }
    }
  }
  return [...outputs.values()].sort(
    (left, right) => left.kind.localeCompare(right.kind) || left.value.localeCompare(right.value),
  );
}
