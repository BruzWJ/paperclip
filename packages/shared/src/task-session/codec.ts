import { Schema } from "effect";

import * as EventDefinition from "./event.js";
import {
  Durable as EventSchema,
  DurableDefinitions,
  type DurableEvent,
  type Event as TaskSessionEvent,
  type Type as TaskSessionEventType,
} from "./session-event.js";
import {
  Message as MessageSchema,
  type Message as TaskSessionMessage,
} from "./session-message.js";
import {
  Prompt as PromptSchema,
  type Prompt as TaskSessionPrompt,
} from "./prompt.js";
import {
  Info as SessionInfoSchema,
  type Info as TaskSessionInfo,
} from "./session.js";

const decodeEvent = Schema.decodeUnknownSync(EventSchema);
const encodeEvent = Schema.encodeSync(EventSchema);
const decodeMessage = Schema.decodeUnknownSync(MessageSchema);
const encodeMessage = Schema.encodeSync(MessageSchema);
const decodePrompt = Schema.decodeUnknownSync(PromptSchema);
const encodePrompt = Schema.encodeSync(PromptSchema);
const decodeSessionInfo = Schema.decodeUnknownSync(SessionInfoSchema);
const encodeSessionInfo = Schema.encodeSync(SessionInfoSchema);
const currentDurableDefinitions = EventDefinition.latest(DurableDefinitions);
const versionedDurableDefinitions =
  EventDefinition.durable(DurableDefinitions);

export const isTaskSessionEvent = Schema.is(EventSchema);
export const isTaskSessionMessage = Schema.is(MessageSchema);

export const decodeTaskSessionEvent = (value: unknown): TaskSessionEvent =>
  decodeEvent(value);

export const encodeTaskSessionEvent = (value: TaskSessionEvent) =>
  encodeEvent(value);

export const decodeTaskSessionMessage = (
  value: unknown,
): TaskSessionMessage => decodeMessage(value);

export const encodeTaskSessionMessage = (value: TaskSessionMessage) =>
  encodeMessage(value);

export const decodeTaskSessionPrompt = (value: unknown): TaskSessionPrompt =>
  decodePrompt(value);

export const encodeTaskSessionPrompt = (value: TaskSessionPrompt) =>
  encodePrompt(value);

export const decodeTaskSessionInfo = (value: unknown): TaskSessionInfo =>
  decodeSessionInfo(value);

export const encodeTaskSessionInfo = (value: TaskSessionInfo) =>
  encodeSessionInfo(value);

export const versionedTaskSessionEventType = (
  type: TaskSessionEventType,
): string => {
  const definition = currentDurableDefinitions.get(type);
  if (!definition?.durable) {
    throw new Error(`Task-session event is not durable: ${type}`);
  }
  return EventDefinition.versionedType(type, definition.durable.version);
};

export const taskSessionEventDefinition = (versionedType: string) =>
  versionedDurableDefinitions.get(versionedType);

export interface DurableTaskSessionEventRow {
  readonly id: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly type: string;
  readonly data: unknown;
}

export const decodeDurableTaskSessionEventRow = (
  row: DurableTaskSessionEventRow,
): DurableEvent => {
  const definition = taskSessionEventDefinition(row.type);
  if (!definition?.durable) {
    throw new Error(`Unknown durable task-session event type: ${row.type}`);
  }
  return Schema.decodeUnknownSync(definition)({
    id: row.id,
    type: definition.type,
    durable: {
      aggregateID: row.sessionId,
      seq: row.seq,
      version: definition.durable.version,
    },
    data: row.data,
  }) as DurableEvent;
};

export const encodeDurableTaskSessionEventRow = (
  event: DurableEvent,
): DurableTaskSessionEventRow => {
  if (!event.durable) {
    throw new Error(`Task-session event is not durable: ${event.type}`);
  }
  const encoded = encodeTaskSessionEvent(event);
  return {
    id: encoded.id,
    sessionId: event.durable.aggregateID,
    seq: event.durable.seq,
    type: EventDefinition.versionedType(
      event.type,
      event.durable.version,
    ),
    data: encoded.data,
  };
};
