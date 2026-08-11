import { EventEmitter } from "node:events";
import type {
  LiveEvent,
  LiveEventOf,
  LiveEventPayloadMap,
  LiveEventType,
} from "@paperclipai/shared";

type LiveEventListener = (event: LiveEvent) => void;

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

let nextEventId = 0;

function toLiveEvent<Type extends LiveEventType>(input: {
  companyId: string;
  type: Type;
  payload: LiveEventPayloadMap[Type];
}): LiveEventOf<Type> {
  nextEventId += 1;
  return {
    id: nextEventId,
    companyId: input.companyId,
    type: input.type,
    createdAt: new Date().toISOString(),
    payload: input.payload,
  } as LiveEventOf<Type>;
}

export function publishLiveEvent<Type extends LiveEventType>(input: {
  companyId: string;
  type: Type;
  payload?: LiveEventPayloadMap[Type];
}): LiveEventOf<Type>;
export function publishLiveEvent(input: {
  companyId: string;
  type: LiveEventType;
  payload?: LiveEventPayloadMap[LiveEventType];
}): LiveEvent {
  const event = toLiveEvent({
    companyId: input.companyId,
    type: input.type,
    payload: input.payload ?? {},
  } as {
    companyId: string;
    type: LiveEventType;
    payload: LiveEventPayloadMap[LiveEventType];
  });
  emitter.emit(input.companyId, event);
  return event;
}

export function subscribeCompanyLiveEvents(companyId: string, listener: LiveEventListener) {
  emitter.on(companyId, listener);
  return () => emitter.off(companyId, listener);
}
