import { Schema } from "effect";

import * as EventDefinition from "./event.js";
import {
  All as EventSchema,
  DurableDefinitions,
  type DurableEvent,
  type Event as IssueSessionEvent,
  type Type as IssueSessionEventType,
} from "./session-event.js";
import {
  Message as MessageSchema,
  type Message as IssueSessionMessage,
} from "./session-message.js";
import {
  Prompt as PromptSchema,
  type Prompt as IssueSessionPrompt,
} from "./prompt.js";
import {
  Info as SessionInfoSchema,
  type Info as IssueSessionInfo,
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

export const isIssueSessionEvent = Schema.is(EventSchema);
export const isIssueSessionMessage = Schema.is(MessageSchema);

export const decodeIssueSessionEvent = (value: unknown): IssueSessionEvent =>
  decodeEvent(value);

export const encodeIssueSessionEvent = (value: IssueSessionEvent) =>
  encodeEvent(value);

export const decodeIssueSessionMessage = (
  value: unknown,
): IssueSessionMessage => decodeMessage(value);

export const encodeIssueSessionMessage = (value: IssueSessionMessage) =>
  encodeMessage(value);

export const decodeIssueSessionPrompt = (value: unknown): IssueSessionPrompt =>
  decodePrompt(value);

export const encodeIssueSessionPrompt = (value: IssueSessionPrompt) =>
  encodePrompt(value);

export const decodeIssueSessionInfo = (value: unknown): IssueSessionInfo =>
  decodeSessionInfo(value);

export const encodeIssueSessionInfo = (value: IssueSessionInfo) =>
  encodeSessionInfo(value);

export const versionedIssueSessionEventType = (
  type: IssueSessionEventType,
): string => {
  const definition = currentDurableDefinitions.get(type);
  if (!definition?.durable) {
    throw new Error(`Issue-session event is not durable: ${type}`);
  }
  return EventDefinition.versionedType(type, definition.durable.version);
};

export const issueSessionEventDefinition = (versionedType: string) =>
  versionedDurableDefinitions.get(versionedType);

export interface DurableIssueSessionEventRow {
  readonly id: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly type: string;
  readonly data: unknown;
}

export const decodeDurableIssueSessionEventRow = (
  row: DurableIssueSessionEventRow,
): DurableEvent => {
  const definition = issueSessionEventDefinition(row.type);
  if (!definition?.durable) {
    throw new Error(`Unknown durable issue-session event type: ${row.type}`);
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

export const encodeDurableIssueSessionEventRow = (
  event: DurableEvent,
): DurableIssueSessionEventRow => {
  if (!event.durable) {
    throw new Error(`Issue-session event is not durable: ${event.type}`);
  }
  const encoded = encodeIssueSessionEvent(event);
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
