import { LIVE_EVENT_SOCKET_EVENT, LIVE_RUN_STREAM_SYNC_EVENT } from "../constants.js";
import type { TaskExecutionRunEnvelopeRecord } from "./task-execution-run.js";

export type ActivityLoggedLiveEventPayload = {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId: string | null;
  runId: string | null;
  taskId: string | null;
  responsibleUserId: string | null;
  details: Record<string, unknown> | null;
};

export type RunStreamAssistantMessage = {
  readonly id: string;
  readonly seq: number;
  readonly modelStateSeq: number;
  readonly type: "assistant";
  /** Canonical encoded data; incremental events omit content, sync snapshots retain it. */
  readonly data: Record<string, unknown>;
  readonly timeCreated: string;
  readonly timeUpdated: string;
};

export type RunStreamAssistantPart = {
  readonly id: string;
  readonly type: string;
  readonly [key: string]: unknown;
};

/**
 * Idempotent, committed transcript projection. Incremental events carry the
 * full current part; settlement carries one full canonical message snapshot.
 */
export type RunStreamLiveEventPayload =
  | {
      readonly kind: "part.upsert";
      readonly runId: string;
      readonly message: RunStreamAssistantMessage;
      readonly part: RunStreamAssistantPart;
    }
  | {
      readonly kind: "message.snapshot";
      readonly runId: string;
      readonly message: RunStreamAssistantMessage;
    };

export type RunStreamSyncRequest = {
  readonly runId: string;
  readonly afterSeq: number;
  /** Empty on the first page so every message tied at afterSeq is replayed. */
  readonly afterId: string;
};

export type RunStreamSyncResponse = {
  readonly runId: string;
  readonly run: TaskExecutionRunEnvelopeRecord | null;
  readonly messages: readonly RunStreamAssistantMessage[];
  readonly nextCursor: Pick<RunStreamSyncRequest, "afterSeq" | "afterId"> | null;
};

export type RunStateLiveEventPayload = {
  readonly run: TaskExecutionRunEnvelopeRecord;
};

export type LiveEventPayloadMap = {
  "activity.logged": ActivityLoggedLiveEventPayload;
  "run.stream": RunStreamLiveEventPayload;
  "run.state": RunStateLiveEventPayload;
};

export type LiveEventType = keyof LiveEventPayloadMap;

export type LiveEventOf<Type extends LiveEventType> = {
  [EventType in Type]: {
    companyId: string;
    type: EventType;
    payload: LiveEventPayloadMap[EventType];
  };
}[Type];

export type LiveEvent = LiveEventOf<LiveEventType>;

export type LiveEventSocketAuth = {
  companyId: string;
};

export type LiveEventServerToClientEvents = {
  [LIVE_EVENT_SOCKET_EVENT]: (event: LiveEvent) => void;
};

export type LiveEventClientToServerEvents = {
  [LIVE_RUN_STREAM_SYNC_EVENT]: (
    request: RunStreamSyncRequest,
    acknowledge: (response: RunStreamSyncResponse) => void,
  ) => void;
};
