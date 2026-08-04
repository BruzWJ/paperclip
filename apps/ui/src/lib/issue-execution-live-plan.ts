import {
  decodeIssueExecutionPlanLiveEvent,
  type IssueExecutionLivePlanItem,
} from "@paperclipai/shared";

export interface VisibleActiveIssueExecutionPrompt {
  companyId: string;
  issueId: string;
  runId: string;
  refId: string;
  runOrdinal: number;
  segmentOrdinal: number;
  promptActive: true;
}

export interface IssueExecutionLivePlanSnapshot {
  eventId: number;
  companyId: string;
  issueId: string;
  runId: string;
  refId: string;
  runOrdinal: number;
  segmentOrdinal: number;
  replacement: readonly IssueExecutionLivePlanItem[];
}

export interface IssueExecutionLivePlanStore {
  getSnapshot(): IssueExecutionLivePlanSnapshot | null;
  subscribe(listener: () => void): () => void;
  registerVisiblePrompt(
    prompt: VisibleActiveIssueExecutionPrompt,
  ): () => void;
  acceptEvent(value: unknown): boolean;
  clearPlan(): void;
  clearVisibility(): void;
  resetConnection(): void;
}

function isCanonicalVisiblePrompt(
  prompt: VisibleActiveIssueExecutionPrompt,
): boolean {
  const identities = [
    prompt.companyId,
    prompt.issueId,
    prompt.runId,
    prompt.refId,
  ];
  return (
    prompt.promptActive === true &&
    identities.every(
      (identity) => identity.length > 0 && identity.trim() === identity,
    ) &&
    Number.isSafeInteger(prompt.runOrdinal) &&
    prompt.runOrdinal >= 1 &&
    Number.isSafeInteger(prompt.segmentOrdinal) &&
    prompt.segmentOrdinal >= 0
  );
}

function samePrompt(
  left: VisibleActiveIssueExecutionPrompt,
  right: VisibleActiveIssueExecutionPrompt,
): boolean {
  return (
    left.companyId === right.companyId &&
    left.issueId === right.issueId &&
    left.runId === right.runId &&
    left.refId === right.refId &&
    left.runOrdinal === right.runOrdinal &&
    left.segmentOrdinal === right.segmentOrdinal
  );
}

export function createIssueExecutionLivePlanStore(): IssueExecutionLivePlanStore {
  let visiblePrompt: VisibleActiveIssueExecutionPrompt | null = null;
  let snapshot: IssueExecutionLivePlanSnapshot | null = null;
  let latestObservedEventId = 0;
  let registrationId = 0;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of Array.from(listeners)) listener();
  };

  const clearSnapshot = () => {
    if (snapshot === null) return;
    snapshot = null;
    notify();
  };

  return {
    getSnapshot() {
      return snapshot;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    registerVisiblePrompt(prompt) {
      const ownRegistrationId = ++registrationId;
      if (!isCanonicalVisiblePrompt(prompt)) {
        visiblePrompt = null;
        clearSnapshot();
        return () => undefined;
      }
      if (!visiblePrompt || !samePrompt(visiblePrompt, prompt)) {
        visiblePrompt = { ...prompt };
        clearSnapshot();
      }
      return () => {
        if (registrationId !== ownRegistrationId) return;
        visiblePrompt = null;
        clearSnapshot();
      };
    },

    acceptEvent(value) {
      const event = decodeIssueExecutionPlanLiveEvent(value);
      if (!event || !visiblePrompt) return false;
      if (event.companyId !== visiblePrompt.companyId) return false;
      if (event.id <= latestObservedEventId) return false;
      latestObservedEventId = event.id;
      const payload = event.payload;
      if (
        payload.issueId !== visiblePrompt.issueId ||
        payload.runId !== visiblePrompt.runId ||
        payload.refId !== visiblePrompt.refId ||
        payload.runOrdinal !== visiblePrompt.runOrdinal ||
        payload.segmentOrdinal !== visiblePrompt.segmentOrdinal
      ) {
        return false;
      }
      snapshot = {
        eventId: event.id,
        companyId: payload.companyId,
        issueId: payload.issueId,
        runId: payload.runId,
        refId: payload.refId,
        runOrdinal: payload.runOrdinal,
        segmentOrdinal: payload.segmentOrdinal,
        replacement: payload.replacement.map((entry) => ({ ...entry })),
      };
      notify();
      return true;
    },

    clearPlan() {
      clearSnapshot();
    },

    clearVisibility() {
      registrationId += 1;
      visiblePrompt = null;
      clearSnapshot();
    },

    resetConnection() {
      latestObservedEventId = 0;
      clearSnapshot();
    },
  };
}
