import { createHash } from "node:crypto";

import {
  taskExecutionHistoryViews,
  taskExecutionRefs,
  taskSessionInputDispositions,
  taskSessionInputs,
} from "@paperclipai/db";

import { canonicalTaskSessionJson } from "./store.js";

export interface TaskSessionInputScope {
  companyId: string;
  taskId: string;
  sessionId: string;
  activeRefId: string;
  runId: string;
  ownershipEpoch: number;
  executionLineageId: string;
  adapterConfigRevisionId: string;
  historyViewId: string;
  contextGeneration: number;
}

export interface TaskSessionPreparedInputScope {
  companyId: string;
  taskId: string;
  sessionId: string;
  refId: string;
  ownershipEpoch: number;
  executionLineageId: string;
  adapterConfigRevisionId: string;
  historyViewId: string;
  contextGeneration: number;
}

export interface TaskSessionPendingState {
  steer: boolean;
  queue: boolean;
}

export type TaskSessionInputRecord = typeof taskSessionInputs.$inferSelect;

export interface TaskSessionInputService {
  /**
   * Promotes the held source of one freshly prepared ref before it can be
   * leased. Returns false when the locked ref needs no promotion.
   */
  promotePreparedInput(scope: TaskSessionPreparedInputScope): Promise<boolean>;
  /**
   * Captures the canonical event boundary for a completed provider turn.
   * Inputs admitted after this value must not be promoted at that boundary.
   */
  latestSequence(scope: TaskSessionInputScope): Promise<number>;
  hasPending(scope: TaskSessionInputScope): Promise<TaskSessionPendingState>;
  promoteSteers(scope: TaskSessionInputScope, cutoffSeq: number): Promise<TaskSessionInputRecord[]>;
  /**
   * Promotes one FIFO queue input only when no eligible steer is pending.
   * Returning null never licenses an empty provider turn.
   */
  promoteNextQueued(scope: TaskSessionInputScope): Promise<TaskSessionInputRecord | null>;
}

export type RefRow = typeof taskExecutionRefs.$inferSelect;

export type ViewRow = typeof taskExecutionHistoryViews.$inferSelect;

export type DispositionRow = typeof taskSessionInputDispositions.$inferSelect;

export interface ActiveExecution {
  ref: RefRow;
  view: ViewRow;
  runId: string | null;
}

export interface PendingCandidate {
  inbox: TaskSessionInputRecord;
  disposition: DispositionRow;
  ref: RefRow;
  view: ViewRow;
}

export interface ValidatedExecutionScope extends Omit<TaskSessionInputScope, "runId"> {
  runId: string | null;
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalTaskSessionJson(value)).digest("hex");
}

export { deterministicUuid } from "../deterministic-uuid.js";

export function sameNullableValue(left: string | number | null, right: string | number | null): boolean {
  return left === right;
}
