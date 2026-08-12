import { LIVE_EVENT_SOCKET_EVENT, type LiveEventType } from "../constants.js";

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

export type LiveEventPayloadMap = {
  "activity.logged": ActivityLoggedLiveEventPayload;
};

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

export type LiveEventClientToServerEvents = Record<never, never>;
