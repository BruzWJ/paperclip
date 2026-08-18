import { EventEmitter } from "node:events";
import type {
  LiveEvent,
  LiveEventOf,
  LiveEventPayloadMap,
  LiveEventType,
} from "@paperclipai/shared";

type LiveEventListener = (event: LiveEvent) => void;

const emitter = new EventEmitter();
const allLiveEvents = Symbol("allLiveEvents");

export function publishLiveEvent<Type extends LiveEventType>(input: {
  companyId: string;
  type: Type;
  payload: LiveEventPayloadMap[Type];
}): LiveEventOf<Type> {
  const event = {
    companyId: input.companyId,
    type: input.type,
    payload: input.payload,
  } as LiveEventOf<Type>;
  emitter.emit(allLiveEvents, event);
  return event;
}

export function subscribeLiveEvents(listener: LiveEventListener) {
  emitter.on(allLiveEvents, listener);
  return () => emitter.off(allLiveEvents, listener);
}
