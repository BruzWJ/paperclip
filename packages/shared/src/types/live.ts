import type { LiveEventType } from "../constants.js";

export type LiveEventPayloadMap = {
  [Type in LiveEventType]: Record<string, unknown>;
};

export type LiveEventOf<Type extends LiveEventType> = {
  [EventType in Type]: {
    id: number;
    companyId: string;
    type: EventType;
    createdAt: string;
    payload: LiveEventPayloadMap[EventType];
  };
}[Type];

export type LiveEvent = LiveEventOf<LiveEventType>;
